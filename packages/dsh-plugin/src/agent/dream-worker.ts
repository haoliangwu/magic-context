/**
 * agent/dream-worker — Dreamer tool workers (Phase 4 follow-up slice).
 *
 * Tool-requiring dream agents (curate / maintain-docs / refresh-primers /
 * map-memories / verify / verify-broad) cannot run through the direct-LLM
 * facade: their prompts expect an agentic loop with tools. This module wires
 * the existing Magic worker seam (`worker.ts` → `ctx.subagents.start("spawn")`
 * + `toolFilter` allowlist + delegated approval pinned to 'never') into the
 * dreamer, mirroring the Pi plugin's `PiSubagentRunner`-backed facade:
 *
 *   - `DREAM_WORKER_PROFILES` — per-agent tool allowlists (DSH tool names,
 *     mirroring core `agents/dreamer.ts` constants).
 *   - `AgentPresence` — live top-level Magic agents observed via
 *     `agent/created`. DSH's one-shot spawn REQUIRES a parent Agent (workspace,
 *     lineage, delegation depth all derive from it), and the dreamer timer has
 *     none — so a tool worker borrows a live top-level agent as its parent.
 *     Directory match preferred (the child inherits the parent's workspace).
 *   - `runDreamToolWorker` — one worker run: persona = the task's system
 *     prompt, prompt = the task text, allow = the agent profile, plus
 *     completed-tool-call reconstruction from the child session log (the Pi
 *     facade's `completedToolCalls` mirror — curate's
 *     `inspectCurateMemoryOperations` reads these off the synthetic message
 *     list).
 *
 * Deviations from OpenCode (documented, equivalence-preserving):
 *   - OpenCode registers hidden agents in the host agent registry and runs
 *     them as real child sessions with step ceilings. DSH has no agent
 *     registry and `SubagentStartRequest` exposes no step cap — the task's
 *     timeout signal (the core executor's abort) plus a generous 30-minute
 *     wall ceiling are the authority, exactly like the Pi facade.
 *   - aft_outline/aft_zoom/aft_search (OpenCode code-navigation tools) have no
 *     DSH equivalent; `fs_search` substitutes (same read-only investigation
 *     surface, no privilege change).
 *   - If no live top-level agent exists when a tool task fires, the facade
 *     throws a transient-marked error — the core scheduler hot-retries, and a
 *     later tick (with a session live) picks the task up.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { textBlock } from "../compat/dsh-0.1/session";
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  magicWorkerRequest,
  subagentsOf,
  type SubagentStartRequest,
} from "../compat/dsh-0.1/subagent";
import { isMagicChildSession } from "./worker";
import { sessionEventsOf } from "./session-events";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";

/** One completed (non-error) tool call, Pi `CompletedSubagentToolCall` mirror. */
export interface DreamCompletedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Result of one dream tool worker run. */
export interface DreamToolWorkerResult {
  readonly text: string;
  readonly durationMs: number;
  /** Total tool invocations (all outcomes — the grounding-gate counter). */
  readonly toolCallCount: number;
  /** Completed non-error tool calls (curate's memory-operation inspection). */
  readonly completedToolCalls: readonly DreamCompletedToolCall[];
}

/**
 * Per-agent tool allowlists, mirroring core `agents/dreamer.ts`:
 *   - dreamer (curate)                    → ctx_memory only (DREAMER_CURATE_ALLOWED_TOOLS)
 *   - dreamer-docs (maintain-docs)        → read-only source tools (DREAMER_DOCS_ALLOWED_TOOLS)
 *   - dreamer-primer-investigator         → read-only source tools + ctx_search
 *   - dreamer-memory-mapper (map/verify)  → read-only source tools, NO ctx_search
 * DSH substitutions: fs_search for the aft_* navigation trio.
 */
export const DREAM_WORKER_PROFILES: Readonly<Record<string, readonly string[]>> = {
  dreamer: ["ctx_memory", "ctx_memory_list"],
  "dreamer-docs": ["read", "grep", "glob", "fs_search"],
  "dreamer-primer-investigator": ["read", "grep", "glob", "fs_search", "ctx_search"],
  "dreamer-memory-mapper": ["read", "grep", "glob", "fs_search"],
};

/**
 * Label prefix every dream tool worker carries in its durable
 * `subagent/descriptor` event (see {@link magicWorkerRequest}). Primary
 * sessions have no descriptor, so the label is the DSH equivalent of
 * OpenCode's `toolContext.agent === DREAMER_AGENT` identity check.
 */
export const MAGIC_DREAM_WORKER_LABEL_PREFIX = "magic-dream-";

/**
 * The subagent descriptor label carried by an agent's session log, when the
 * session is a subagent child with a persisted one-shot/continuable label
 * (dsh-subagent writes exactly one `subagent/descriptor` per child).
 */
export function subagentLabelOf(agent: Agent | undefined): string | undefined {
  if (agent === undefined) return undefined;
  for (const raw of sessionEventsOf(agent.session)) {
    if (!isRecord(raw)) continue;
    if ((raw as { type?: string }).type !== "subagent/descriptor") continue;
    const label = (raw as { data?: { label?: unknown } }).data?.label;
    if (typeof label === "string" && label.length > 0) return label;
    return undefined;
  }
  return undefined;
}

/** True when the agent is a Magic dream tool worker (curate/maintenance). */
export function isMagicDreamerAgent(agent: Agent | undefined): boolean {
  return subagentLabelOf(agent)?.startsWith(MAGIC_DREAM_WORKER_LABEL_PREFIX) === true;
}

/** Dream agents whose prompts REQUIRE tools (profile keys). */
export const TOOL_REQUIRING_DREAM_AGENTS: ReadonlySet<string> = new Set(
  Object.keys(DREAM_WORKER_PROFILES),
);

/** Read-only fallback when an unknown agent id reaches the worker path. */
const READONLY_FALLBACK_TOOLS: readonly string[] = ["read", "grep", "glob", "fs_search"];

/* ─────────────────────────── agent presence ───────────────────────────── */

/** Live-agent registry fed by `agent/created` (borrowed worker parents). */
export class AgentPresence {
  private readonly entries: Array<{
    ref: WeakRef<Agent>;
    directory: string;
  }> = [];
  /**
   * projectIdentity → workspace directory map for the periodic sweeps that
   * need a REAL directory (git log, config load). `session_projects` rows
   * store the resolved `git:<sha>`/`dir:<hash>` identity only, and the shared
   * schema carries no identity→directory table, so the DSH side keeps this
   * in-process map: an identity without a live observation simply waits for
   * the next session to open in that workspace (fail-open skip).
   */
  private readonly directoryByIdentity = new Map<string, string>();

  /** Observe one created agent (child sessions skipped — recursion isolation). */
  register(agent: Agent): void {
    if (isMagicChildSession(agent)) return;
    if (this.entries.some((entry) => entry.ref.deref() === agent)) return;
    this.prune();
    const directory = agentDirectory(agent) ?? "";
    this.entries.push({
      ref: new WeakRef(agent),
      directory,
    });
    this.observeDirectory(directory);
  }

  /** Resolve the workspace directory observed for a project identity. */
  directoryOf(projectIdentity: string): string | undefined {
    return this.directoryByIdentity.get(projectIdentity);
  }

  /** All (identity, directory) pairs observed so far. */
  observedProjects(): Array<{ identity: string; directory: string }> {
    return [...this.directoryByIdentity.entries()].map(([identity, directory]) => ({
      identity,
      directory,
    }));
  }

  /** Resolve + cache identity → directory (the core resolver memoizes probes). */
  observeDirectory(directory: string): void {
    if (directory.length === 0) return;
    const identity = resolveProjectIdentityForSession(directory);
    if (!identity) return;
    // Last write wins: a moved repo re-resolves to a new identity anyway.
    this.directoryByIdentity.set(identity, directory);
    if (this.directoryByIdentity.size > 64) {
      const oldest = this.directoryByIdentity.keys().next().value;
      if (oldest !== undefined) this.directoryByIdentity.delete(oldest);
    }
  }

  /**
   * Pick a live parent agent, preferring a workspace-directory match. Dead
   * references are pruned lazily; a stale pick fails at spawn time and the
   * facade classifies the error as transient (retry next tick).
   */
  pick(directory?: string): Agent | undefined {
    this.prune();
    const live = this.entries
      .map((entry) => ({ agent: entry.ref.deref(), directory: entry.directory }))
      .filter((entry): entry is { agent: Agent; directory: string } => entry.agent !== undefined);
    if (live.length === 0) return undefined;
    if (directory !== undefined && directory.length > 0) {
      const match = live.find((entry) => sameDirectory(entry.directory, directory));
      if (match !== undefined) return match.agent;
    }
    return live[0].agent;
  }

  private prune(): void {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].ref.deref() === undefined) this.entries.splice(i, 1);
    }
  }
}

function agentDirectory(agent: Agent): string | undefined {
  const cwd = (agent.session?.header as { cwd?: string } | undefined)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length > 1 && b.length > 1 && (a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
}

const presenceByCtx = new WeakMap<Context, AgentPresence>();

/**
 * Resolve (creating once per ctx) the agent-presence registry and subscribe it
 * to `agent/created`. Idempotent per context; the listener is ctx-owned.
 */
export function agentPresenceOf(ctx: Context): AgentPresence {
  const existing = presenceByCtx.get(ctx);
  if (existing !== undefined) return existing;
  const presence = new AgentPresence();
  presenceByCtx.set(ctx, presence);
  ctx.on("agent/created", async (payload: { agent: Agent }) => {
    presence.register(payload.agent);
  });
  return presence;
}

/* ─────────────────────────── tool worker run ──────────────────────────── */

/** Wall ceiling for one dream worker run (the abort signal is the authority). */
const DREAM_WORKER_CEILING_MS = 30 * 60 * 1000;

export interface DreamToolWorkerDeps {
  /** Borrowed live parent agent (workspace + lineage + policy source). */
  readonly parent: Agent;
  /** Core dream agent id (selects the tool profile). */
  readonly agent: string;
  /** The task's system prompt (worker persona). */
  readonly system?: string;
  /** The task prompt text (worker user turn). */
  readonly userText: string;
  /** Per-attempt model override from the executor (body.model). */
  readonly model?: { provider: string; model: string };
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}

/**
 * Run one dream tool worker. Throws (never returns null) so the facade can
 * surface failure to the core executor with its own classification; errors are
 * marked transient when a later tick could succeed.
 */
export async function runDreamToolWorker(
  ctx: Context,
  deps: DreamToolWorkerDeps,
): Promise<DreamToolWorkerResult> {
  const log = deps.log ?? (() => {});
  const subagents = subagentsOf(ctx);
  if (subagents === undefined) {
    throw transient(new Error("magic-context: subagents service unavailable (dreamer tool worker)"));
  }
  const allow = DREAM_WORKER_PROFILES[deps.agent] ?? READONLY_FALLBACK_TOOLS;
  const started = Date.now();

  const base = {
    label: `magic-dream-${deps.agent}`,
    prompt: [textBlock(deps.userText)] as ContentBlock[],
    allow,
    maxDepth: 0,
    signal: deps.signal ?? new AbortController().signal,
    ...(deps.system !== undefined ? { persona: deps.system } : {}),
  };

  let run: Awaited<ReturnType<typeof subagents.start>>;
  try {
    run = await subagents.start("spawn", buildRequest(deps.parent, base, deps.model));
  } catch (error) {
    // agentOptions capability rejection (or spawn failure) — retry once with
    // the parent's own route before giving up.
    if (deps.model === undefined) throw transient(asError(error));
    log(`[dream-worker] spawn with agentOptions failed, retrying on parent route: ${brief(error)}`);
    try {
      run = await subagents.start("spawn", buildRequest(deps.parent, base, undefined));
    } catch (retryError) {
      throw transient(asError(retryError));
    }
  }

  // Delegated policy pinning (approval 'never' + sandbox inheritance) — same
  // contract as runMagicWorker, applied before the run proceeds.
  const childSession = (run as unknown as { localAgent?: { session?: unknown } }).localAgent
    ?.session;
  if (childSession !== undefined) {
    try {
      appendDelegatedPolicyOverrides(
        childSession as never,
        captureDelegatedPolicyOverrides(deps.parent),
      );
    } catch (error) {
      log(`[dream-worker] delegated policy pinning failed (continuing): ${brief(error)}`);
    }
  }

  const result = await Promise.race([
    run.result,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => {
        void run.dispose();
        resolve(null);
      }, DREAM_WORKER_CEILING_MS);
      deps.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          void run.dispose();
          resolve(null);
        },
        { once: true },
      );
    }),
  ]);
  if (result === null) {
    throw transient(new Error("magic-context: dream tool worker timed out or was aborted"));
  }
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw transient(
      new Error(`magic-context: dream tool worker ended (${result.stopReason}): ${result.diagnostic ?? ""}`),
    );
  }
  if (result.stopReason === "refusal") {
    throw new Error("magic-context: dream tool worker refused the task");
  }

  const toolCalls = collectToolCalls(
    (run as unknown as { localAgent?: Agent }).localAgent,
  );
  const text = result.output
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
  if (text.length === 0 && toolCalls.completedToolCalls.length === 0) {
    // Curate may legitimately end text-less when its ctx_memory operations
    // carry the result (the executor's parse() accepts that); every other
    // agent must produce final text.
    if (deps.agent !== "dreamer") {
      throw new Error("magic-context: dream tool worker produced no assistant output");
    }
  }
  return {
    text,
    durationMs: Date.now() - started,
    toolCallCount: toolCalls.toolCallCount,
    completedToolCalls: toolCalls.completedToolCalls,
  };
}

function buildRequest(
  parent: Agent,
  base: {
    label: string;
    prompt: ContentBlock[];
    allow: readonly string[];
    maxDepth: number;
    signal: AbortSignal;
    persona?: string;
  },
  model: { provider: string; model: string } | undefined,
): SubagentStartRequest {
  return magicWorkerRequest(parent, {
    ...base,
    ...(model !== undefined
      ? { agentOptions: { provider: model.provider, model: model.model } }
      : {}),
  });
}

/* ─────────────────── child-session tool-call reconstruction ─────────────── */

interface ToolCallWalk {
  readonly toolCallCount: number;
  readonly completedToolCalls: readonly DreamCompletedToolCall[];
}

/**
 * Walk the child session's durable log and reconstruct completed tool calls:
 * `tool/call` carries {callId, name, arguments (raw JSON)}; a paired
 * `tool/result` without `data.error` marks completion. Mirrors the Pi
 * runner's transcript reconstruction (`completedToolCalls`).
 */
export function collectToolCalls(childAgent: Agent | undefined): ToolCallWalk {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const completedCallIds = new Set<string>();
  let toolCallCount = 0;
  if (childAgent === undefined) return { toolCallCount, completedToolCalls: [] };
  for (const raw of sessionEventsOf(childAgent.session)) {
    const event = raw as
      | {
          type?: string;
          data?: {
            callId?: unknown;
            name?: unknown;
            arguments?: unknown;
            error?: unknown;
          };
        }
      | null;
    if (event === null || typeof event !== "object") continue;
    if (event.type === "tool/call" && event.data) {
      toolCallCount += 1;
      const { callId, name, arguments: args } = event.data;
      if (typeof callId === "string" && callId.length > 0 && typeof name === "string") {
        calls.set(callId, { name, args: parseArguments(args) });
      }
    } else if (event.type === "tool/result" && event.data) {
      const { callId, error } = event.data;
      if (typeof callId === "string" && error === undefined) completedCallIds.add(callId);
    }
  }
  const completedToolCalls: DreamCompletedToolCall[] = [];
  for (const callId of completedCallIds) {
    const call = calls.get(callId);
    if (call !== undefined) {
      completedToolCalls.push({ name: call.name, arguments: call.args });
    }
  }
  return { toolCallCount, completedToolCalls };
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/* ─────────────────────────── error helpers ─────────────────────────────── */

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Mark an error transient — the core executor hot-retries transient failures. */
function transient(error: Error): Error {
  (error as Error & { transient?: boolean }).transient = true;
  return error;
}

function brief(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
