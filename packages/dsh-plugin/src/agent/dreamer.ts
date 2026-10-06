/**
 * agent/dreamer — Phase 4 slice P1: Dreamer wiring (design docs/phase4-design.md §2.1).
 *
 * The Dreamer core owns the scheduler/lease/gate/telemetry chain; its ONLY
 * injection point is `TaskExecutor`, which drives a `DreamTimerClient`-shaped
 * session facade (`session.create/prompt/messages/list/delete`). This module
 * supplies the DSH half of that boundary:
 *
 *   1. `createDshDreamClient(ctx, deps)` — the client facade. `prompt` runs one
 *      direct `ctx.llm.stream` turn (system + user; `purpose` omitted — an
 *      ordinary auxiliary call). Dream agents whose prompts REQUIRE tools
 *      (curate / maintain-docs / refresh-primers / map-memories / verify /
 *      verify-broad) run through the dream tool worker
 *      (`dream-worker.ts`: borrowed live parent agent + ctx.subagents.start
 *      spawn + toolFilter allowlist + persona system prompt). `messages`
 *      returns the synthetic OpenCode-shaped message list for the turn (text
 *      result + synthetic tool parts from the worker's completed tool calls —
 *      the Pi facade's trick, so curate's `inspectCurateMemoryOperations` sees
 *      the applied ctx_memory operations).
 *
 *   2. `registerDshDreamer(ctx, deps)` — project discovery from
 *      `session_projects` (deduped, DSH-harness only) + one fiber-owned
 *      interval per project running the core scheduler pass
 *      (`runDueTasksForProject` with the shared facade). Call from the agent
 *      plane apply.
 *
 *   3. `dshDreamSeams(ctx, deps)` — the `CtxCommandSeams["dreamer"]` object
 *      `/ctx-dream` consumes (`tasks` / `executor` / `runnable` /
 *      `scheduleSummary`). Wire it into `registerCtxCommands`' options.
 *
 * Recorded deviations from the Phase 4 design:
 *
 *   - The design reuses core's process-wide `startDreamScheduleTimer`
 *     singleton. DSH self-builds ctx-owned intervals instead: the core
 *     singleton opens the DEFAULT shared DB path (unusable for per-test DBs and
 *     surprising when the bootstrap opened an overridden path), drags in
 *     OpenCode-only maintenance sweeps (opencode.db orphan sweeps), and its
 *     module-level timer state is not fiber-owned. Each DSH interval drives the
 *     exact same scheduler pass the singleton's tick runs for the dream
 *     portion (`runDueTasksForProject` → lease/gate/telemetry). The
 *     singleton's extra maintenance lanes are mirrored DSH-side per tick
 *     (`runDshPeriodicMaintenance`: embedding registration + identity
 *     maintenance, git-commit indexing, compiled smart-note checks; the
 *     OpenCode-session orphan sweep stays out — see that function's doc).
 *   - Tool workers run through the borrowed-parent seam (`dream-worker.ts`);
 *     see that module's header for the OpenCode/DSH deviations (no agent
 *     registry, no per-agent step cap — the abort signal is the authority).
 *   - `createDshDreamClient`'s `db` parameter is accepted per contract but
 *     reserved (the facade is in-memory, exactly like the Pi facade); `log` is
 *     used for diagnostics.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "../compat/dsh-0.1/session";
import { DSH_HARNESS } from "../shared/dsh-harness";
import { loadPluginConfig } from "@magic-context/core/config";
import {
  acquireGitSweepLease,
  GIT_SWEEP_LEASE_RENEWAL_MS,
  markGitSweepSuccessAndRelease,
  parkGitSweepNonIndexable,
  releaseGitSweepLease,
  renewGitSweepLease,
} from "@magic-context/core/features/magic-context/git-commits/sweep-coordinator";
import {
  embedUnembeddedCommits,
  indexCommitsForProject,
} from "@magic-context/core/features/magic-context/git-commits/indexer";
import {
  drainCommitBacklogForProject,
  drainProjectEmbeddingIdentityMaintenance,
  drainStaleEmbeddingIdentitiesForProject,
  embedUnembeddedMemoriesForProject,
  getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/project-embedding-registry";
import { beginBootQuietPeriod, scheduleAfterBootQuiet } from "@magic-context/core/plugin/boot-quiet";
import { runDueCompiledSmartNoteChecks } from "@magic-context/core/features/magic-context/smart-notes/runner";
import {
  acquireLease,
  releaseLease,
} from "@magic-context/core/features/magic-context/dreamer/lease";
import { leaseKeyFor } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import { ensureProjectRegisteredFromDshDirectory } from "./embedding-bootstrap";
import {
  DreamerConfigSchema,
  type DreamerConfig,
} from "@magic-context/core/config/schema/magic-context";
import {
  buildDreamTaskRuntimeConfigs,
  summarizeDreamSchedule,
  userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "@magic-context/core/features/magic-context/dreamer/task-executor";
import { runDueTasksForProject } from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { describeError } from "@magic-context/core/shared/error-message";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { DshStorageBootstrap } from "../host/bootstrap";
import type { CtxCommandSeams } from "./commands";
import {
  TOOL_REQUIRING_DREAM_AGENTS,
  agentPresenceOf,
  runDreamToolWorker,
  transient,
  AgentPresence,
  type DreamCompletedToolCall,
} from "./dream-worker";
import { existsSync } from "node:fs";

/** Default dream tick (mirrors core's DREAM_TIMER_INTERVAL_MS: 15 minutes). */
export const DEFAULT_DREAM_TICK_MS = 15 * 60 * 1000;

/** Startup-pass stagger slot (mirrors core's BOOT_PROJECT_JITTER_SLOT_MS). */
const BOOT_PROJECT_JITTER_SLOT_MS = 1_000;

/** Test seam for the startup-pass stagger (0 = no stagger). */
let startupJitterSlotMs = BOOT_PROJECT_JITTER_SLOT_MS;

/**
 * Dream agents whose prompts REQUIRE tools — a direct single-turn LLM call
 * cannot produce a valid result for them. Re-exported from `dream-worker.ts`
 * (single source of truth with DREAM_WORKER_PROFILES); see that module for the
 * per-agent tool profiles and the remaining zero-tool dream agents
 * (classifier / smart-note-compiler / reviewer / retrospective).
 */
// (TOOL_REQUIRING_DREAM_AGENTS imported above from ./dream-worker)

/** Magic-owned message source marker for dreamer LLM turns. */
const DREAM_SOURCE = { kind: "magic-context" } as const;

/** Wiring deps for {@link registerDshDreamer}. */
export interface DreamerWiringDeps {
  /** The host service (ready + canonical session-key derivation). */
  readonly host: {
    readonly ready: Promise<DshStorageBootstrap>;
    canonicalKey(id: string): string;
  };
  /** Agent-plane workspace directory (the executor's `sessionDirectory`). */
  readonly directory?: string;
  /** DSH dreamer config. `enabled` gates both the timer and the /ctx-dream
   *  seam (`runnable`); `tickMs` defaults to 15 minutes. */
  readonly config?: { enabled?: boolean; tickMs?: number };
  /** Parsed core DreamerConfig (from magic-context.jsonc `dreamer` section). */
  readonly coreConfig?: unknown;
  readonly log?: (message: string) => void;
}

/** Deps for {@link createDshDreamClient}. */
export interface DshDreamClientDeps {
  /** Reserved (per contract): the facade is in-memory like the Pi facade;
   *  `db` is accepted for signature stability / future persistence. */
  readonly db: Database;
  /** Live-agent registry for tool-worker parents (defaults to the ctx-owned
   *  `agentPresenceOf(ctx)` subscription). */
  readonly presence?: AgentPresence;
  readonly log?: (message: string) => void;
}

/* ─────────────────────────── client facade ────────────────────────────── */

/** `session.prompt` args as the core executor builds them. */
export interface DreamFacadePromptArgs {
  path: { id: string };
  query?: { directory?: string };
  body?: {
    agent?: string;
    system?: string;
    model?: { providerID: string; modelID: string };
    parts?: Array<{ type?: string; text?: string }>;
  };
  signal?: AbortSignal | null;
}

/**
 * The DSH mirror of core's `DreamTimerClient` (the surface the dreamer
 * executor consumes). Structural — the core types the facade against the
 * OpenCode SDK client; DSH casts at the boundary exactly like the Pi facade.
 */
export interface DshDreamSessionFacade {
  session: {
    create(args: {
      body?: { parentID?: string; title?: string };
      query?: { directory?: string };
    }): Promise<{ id: string }>;
    list(args: { query?: { directory?: string } }): Promise<{ data: Array<{ id: string }> }>;
    prompt(args: DreamFacadePromptArgs): Promise<unknown>;
    messages(args: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data: unknown[] }>;
    delete(args: { path: { id: string } }): Promise<Record<string, never>>;
    abort(args: { path: { id: string } }): Promise<Record<string, never>>;
  };
}

/** In-memory synthetic dream session (mirror of the Pi facade's sessionsById). */
interface DreamSessionRecord {
  id: string;
  directory: string;
  title?: string;
  messages: unknown[];
}

type SyntheticPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: { input: { description: string } } }
  | {
      type: "tool";
      tool: string;
      callID: string;
      state: { status: "completed"; input: Record<string, unknown>; output: "completed" };
    };

/**
 * Synthetic tool parts from a dream tool worker run — the Pi facade's
 * `syntheticToolParts` mirror: completed calls first (curate's
 * `inspectCurateMemoryOperations` reads these), then count-only filler parts
 * (the refresh-primers grounding gate counts tool use).
 */
function syntheticToolParts(
  count: number,
  completedCalls: readonly DreamCompletedToolCall[],
): SyntheticPart[] {
  const completed = completedCalls.map((call, index) => ({
    type: "tool" as const,
    callID: `dsh-dream-completed-tool-${index}`,
    tool: call.name,
    state: {
      status: "completed" as const,
      input: call.arguments as Record<string, unknown>,
      output: "completed" as const,
    },
  }));
  const remaining = Math.max(0, Math.floor(count) - completed.length);
  const filler = Array.from({ length: remaining }, () => ({
    type: "tool" as const,
    tool: "investigation",
    state: { input: { description: "investigation step" } },
  }));
  return [...completed, ...filler];
}

/** OpenCode-shaped synthetic message (mirror of the Pi facade's makeMessage). */
function makeMessage(role: "user" | "assistant", parts: SyntheticPart[]): unknown {
  return {
    info: { role, time: { created: Date.now() } },
    parts,
  };
}

/** Read the LLM runtime without declaring a hard inject (optional service). */
function readLlm(ctx: Context): LlmRuntime | undefined {
  return ctx.get("llm") as LlmRuntime | undefined;
}

/** Resolve the current provider/model route (fresh per call; same as the
 *  historian wiring). */
function currentRoute(ctx: Context): { provider: string; model: string } {
  const defaultModel = ctx.get("agentDefaultModel") as
    | { currentSelection?: () => { provider?: string; model?: string } }
    | undefined;
  const selection = defaultModel?.currentSelection?.();
  return {
    provider: selection?.provider ?? "deepseek",
    model: selection?.model ?? "deepseek-chat",
  };
}

/** Per-attempt model: body.model (the executor's per-task override) wins,
 *  else the current session route. */
function resolveDreamModel(
  ctx: Context,
  bodyModel: { providerID: string; modelID: string } | undefined,
): { provider: string; model: string } {
  if (bodyModel) return { provider: bodyModel.providerID, model: bodyModel.modelID };
  return currentRoute(ctx);
}

/** One direct `ctx.llm.stream` turn; returns the assembled assistant text.
 *  `purpose` is intentionally omitted — an ordinary auxiliary call, not a
 *  compaction/session-title classified one. */
async function streamDreamTurn(
  ctx: Context,
  opts: { system?: string; userText: string; model: { provider: string; model: string }; signal?: AbortSignal },
): Promise<string> {
  const llm = readLlm(ctx);
  if (llm === undefined) {
    throw new Error("magic-context: llm service unavailable (dreamer wiring)");
  }
  const user = createUserMessage({
    content: [{ type: "text", text: opts.userText }],
    source: DREAM_SOURCE,
  });
  let text = "";
  let failed: string | undefined;
  for await (const chunk of llm.stream({
    provider: opts.model.provider,
    model: opts.model.model,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [user],
    signal: opts.signal,
  })) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish") {
      if (chunk.reason.kind === "error") {
        failed = chunk.reason.failure?.message ?? "error finish";
      } else if (chunk.reason.kind === "aborted") {
        failed = "aborted";
      }
    }
  }
  if (failed !== undefined) {
    throw new Error(`magic-context: dreamer LLM stream failed (${failed})`);
  }
  if (text.trim().length === 0) {
    throw new Error("magic-context: dreamer LLM stream returned no text");
  }
  return text;
}

/**
 * Create the DSH DreamTimerClient facade. One instance is shared by the
 * schedule timer AND the /ctx-dream seam (same synthetic session table), like
 * the Pi facade. Zero-tool dream agents run one direct `ctx.llm.stream` turn;
 * tool-requiring agents borrow a live top-level agent (AgentPresence) as the
 * parent of a scoped subagent worker (`dream-worker.ts`). Facade failures are
 * classified by the core executor: transient-marked errors hot-retry, others
 * advance to the task's next cron slot.
 */
export function createDshDreamClient(ctx: Context, deps: DshDreamClientDeps): DshDreamSessionFacade {
  const log = deps.log ?? (() => {});
  const presence = deps.presence ?? agentPresenceOf(ctx);
  const sessions = new Map<string, DreamSessionRecord>();
  let sessionCounter = 0;

  const session: DshDreamSessionFacade["session"] = {
    create: async (args) => {
      const sessionId = `magic-context-dsh-dream-${++sessionCounter}`;
      sessions.set(sessionId, {
        id: sessionId,
        directory: args.query?.directory ?? "",
        title: args.body?.title,
        messages: [],
      });
      return { id: sessionId };
    },
    // The executor uses session.list only to resolve a parent session for
    // child-invocation telemetry (OpenCode-specific). DSH dream children stay
    // top-level in P1 — an empty list mirrors the Pi facade.
    list: async () => ({ data: [] }),
    prompt: async (args: DreamFacadePromptArgs) => {
      const dreamSession = sessions.get(args.path.id);
      if (!dreamSession) {
        throw new Error(`dsh dreamer session not found: ${args.path.id}`);
      }
      if (args.signal?.aborted) {
        throw new Error("prompt aborted by external signal");
      }
      const agent =
        typeof args.body?.agent === "string" && args.body.agent.length > 0
          ? args.body.agent
          : undefined;
      const rawParts = args.body?.parts;
      const userText = Array.isArray(rawParts)
        ? rawParts
            .map((part) => part?.text)
            .filter((text): text is string => typeof text === "string" && text.length > 0)
            .join("\n")
        : "";
      const rawModel = args.body?.model as { providerID?: unknown; modelID?: unknown } | undefined;
      const bodyModel =
        rawModel !== undefined &&
        rawModel !== null &&
        typeof rawModel === "object" &&
        typeof (rawModel as Record<string, unknown>).providerID === "string" &&
        typeof (rawModel as Record<string, unknown>).modelID === "string"
          ? {
              providerID: (rawModel as { providerID: string }).providerID,
              modelID: (rawModel as { modelID: string }).modelID,
            }
          : undefined;
      const model = resolveDreamModel(ctx, bodyModel);
      const rawSystem = args.body?.system;
      const system =
        typeof rawSystem === "string" && rawSystem.length > 0 ? rawSystem : undefined;
      try {
        if (agent !== undefined && TOOL_REQUIRING_DREAM_AGENTS.has(agent)) {
          // Tool-requiring dream agent: borrow a live top-level agent as the
          // worker parent and run the task through a scoped child (toolFilter
          // allowlist + persona system prompt + delegated approval 'never').
          // No live agent → transient failure; the scheduler hot-retries and a
          // later tick (with a session live) picks the task up.
          const parent = presence.pick(dreamSession.directory);
          if (parent === undefined) {
            throw transient(
              new Error(
                `magic-context: no live Magic agent available to host the dream tool worker ` +
                  `(agent "${agent}") — retry when a session is active`,
              ),
            );
          }
          const workerResult = await runDreamToolWorker(ctx, {
            parent,
            agent,
            system,
            userText,
            model: bodyModel
              ? { provider: bodyModel.providerID, model: bodyModel.modelID }
              : undefined,
            signal: args.signal ?? undefined,
            log,
          });
          dreamSession.messages = [
            makeMessage("user", [{ type: "text", text: userText }]),
            makeMessage(
              "assistant",
              // Completed tool calls first (curate's memory-operation
              // inspection reads them), then count-only filler parts for the
              // grounding gate, then the final answer text.
              [
                ...syntheticToolParts(workerResult.toolCallCount, workerResult.completedToolCalls),
                ...(workerResult.text.length > 0
                  ? [{ type: "text" as const, text: workerResult.text }]
                  : []),
              ],
            ),
          ];
          return {};
        }
        const text = await streamDreamTurn(ctx, {
          system,
          userText,
          model,
          signal: args.signal ?? undefined,
        });
        dreamSession.messages = [
          makeMessage("user", [{ type: "text", text: userText }]),
          // Direct-LLM turns make no tool calls — no synthetic tool parts.
          makeMessage("assistant", [{ type: "text", text }]),
        ];
        return {};
      } catch (error) {
        log(`[dreamer] prompt failed for ${dreamSession.id} (${agent ?? "default"}): ${describeError(error).brief}`);
        throw error;
      }
    },
    messages: async (args) => {
      return { data: sessions.get(args.path.id)?.messages ?? [] };
    },
    delete: async (args) => {
      sessions.delete(args.path.id);
      return {};
    },
    // Best-effort server-side abort hook (model-suggestion-retry calls it on
    // timeout/abort). The DSH stream is already cancelled via the signal; a
    // no-op is correct here.
    abort: async () => ({}),
  };

  return { session };
}

/* ─────────────────────────── scheduler wiring ─────────────────────────── */

/** Module state shared between registerDshDreamer and dshDreamSeams. */
interface DreamerRuntimeState {
  enabled: boolean;
  tickMs: number;
  coreConfig: DreamerConfig;
  directory: string;
  /** Live-agent registry for tool-worker parents (created eagerly at
   *  registration so early `agent/created` events are never missed). */
  presence: AgentPresence;
  /** Lazily created once; both the timer and the seam share one facade. */
  facade: DshDreamSessionFacade | null;
}

const dreamerRuntime = new WeakMap<object, DreamerRuntimeState>();

/** Synthesize the core DreamerConfig from the minimal DSH config: enabled →
 *  the core's default per-task schedules (v1-preserving); DSH has no
 *  per-task config surface in P1. */
function synthesizeDreamerConfig(raw?: unknown): DreamerConfig {
  return DreamerConfigSchema.parse(raw ?? {});
}

function defaultState(ctx?: Context): DreamerRuntimeState {
  return {
    enabled: true,
    tickMs: DEFAULT_DREAM_TICK_MS,
    coreConfig: synthesizeDreamerConfig(),
    directory: process.cwd(),
    presence: ctx !== undefined ? agentPresenceOf(ctx) : new AgentPresence(),
    facade: null,
  };
}

/** Deduped DSH project list from session_projects (discovery source; the
 *  session-track slice records these rows). DSH-harness only — the shared DB
 *  may also carry OpenCode/Pi rows whose projects this process must not sweep. */
export function discoverDreamProjects(db: Database): string[] {
  const rows = db
    .prepare<[string], { project_path: string }>(
      `SELECT DISTINCT project_path
         FROM session_projects
        WHERE harness = ?
          AND project_path IS NOT NULL
          AND TRIM(project_path) <> ''
        ORDER BY project_path`,
    )
    .all(DSH_HARNESS);
  return rows.map((row) => row.project_path);
}

/** The TaskExecutor the scheduler drives: core `createDreamTaskExecutor`
 *  closed over the DSH facade. `openOpenCodeDb` → null (no OpenCode store);
 *  no retrospective raw provider (retrospective becomes a clean no-op until a
 *  DSH raw-source provider lands); no mural (compress-cues no-ops). */
function buildDreamExecutor(
  facade: DshDreamSessionFacade,
  state: DreamerRuntimeState,
): ReturnType<typeof createDreamTaskExecutor> {
  return createDreamTaskExecutor({
    client: facade as never,
    sessionDirectory: state.directory,
    openOpenCodeDb: () => null,
    userMemoryCollectionEnabled: userMemoryCollectionEnabled(state.coreConfig),
  });
}

/** One per-project scheduler pass (the timer tick body). */
async function runDreamTick(
  db: Database,
  projectIdentity: string,
  executor: ReturnType<typeof createDreamTaskExecutor>,
  state: DreamerRuntimeState,
  log: (message: string) => void,
): Promise<void> {
  try {
    // Periodic maintenance sweeps (the opencode dream-timer lanes the DSH
    // port deferred): embedding registration + identity maintenance, git-commit
    // indexing, compiled smart-note checks. All fail-open — a sweep failure
    // must never block the task scheduler below.
    await runDshPeriodicMaintenance(db, projectIdentity, state, log);
  } catch (error) {
    log(`[dreamer] maintenance sweeps failed for ${projectIdentity}: ${describeError(error).brief}`);
  }
  try {
    const ran = await runDueTasksForProject({
      db,
      projectIdentity,
      // Full canonical set (disabled tasks get their rows reconciled to
      // next_due_at NULL by the scheduler, so config stays authoritative).
      tasks: buildDreamTaskRuntimeConfigs(state.coreConfig, "opencode"),
      executor,
    });
    if (ran > 0) log(`[dreamer] timer tick ${projectIdentity} — ran ${ran} task(s)`);
  } catch (error) {
    log(`[dreamer] timer tick failed for ${projectIdentity}: ${describeError(error).brief}`);
  }
}

/** Wall-clock budget for one commit-embedding backlog drain. */
const GIT_COMMIT_BACKLOG_DRAIN_MAX_MS = 5 * 60 * 1000;

/**
 * The periodic maintenance lanes the opencode dream-timer runs per project,
 * mirrored for DSH (minus the OpenCode-session orphan sweep — DSH dream
 * workers tear their child sessions down via SubagentRun.dispose, so there is
 * no OpenCode server loop to sweep):
 *   1. ensureProjectRegistered — (re)load config, register embedding provider;
 *   2. embedding identity maintenance + stale-identity GC;
 *   3. proactive memory embedding backfill (snapshot.enabled — the opencode
 *      runProjectMaintenance lane, dream-timer embedUnembeddedMemories);
 *   4. git-commit indexing sweep (lease + cooldown coordinated);
 *   5. compiled smart-note checks (leased, matches the evaluate-smart-notes
 *      lease domain).
 * Needs a workspace DIRECTORY for the config load and `git log`; identities
 * without a live observation (no session since process start) skip fail-open.
 * The opencode smart-note lane's `dreamingEnabled` gate is vacuous here: the
 * DSH timer itself only exists when the dreamer config is enabled.
 *
 * Dead-directory guard (the opencode sweepProject mirror): a workspace that
 * vanished from disk is skipped for this pass and dropped from the presence
 * map (a later session in the restored directory re-observes it). The
 * opencode version additionally GC's the `dir:` schedule rows; DSH schedules
 * are identity-keyed and re-seed on the next observation, so a map drop is
 * the faithful equivalent.
 */
async function runDshPeriodicMaintenance(
  db: Database,
  projectIdentity: string,
  state: DreamerRuntimeState,
  log: (message: string) => void,
): Promise<void> {
  const directory = state.presence.directoryOf(projectIdentity);
  if (directory === undefined) return;
  if (!existsSync(directory)) {
    log(`[dreamer] workspace directory vanished for ${projectIdentity}: ${directory} — skipping maintenance`);
    state.presence.forgetIdentity(projectIdentity);
    return;
  }
  try {
    await ensureProjectRegisteredFromDshDirectory(directory, db, log);
  } catch (error) {
    log(
      `[magic-context] embedding registration failed for ${projectIdentity}: ${describeError(error).brief}`,
    );
    return; // no snapshot below can be trusted without registration
  }

  try {
    await drainProjectEmbeddingIdentityMaintenance(db, projectIdentity);
    const gc = await drainStaleEmbeddingIdentitiesForProject(db, projectIdentity);
    const gcDeleted =
      gc.memoryRowsDeleted + gc.commitRowsDeleted + gc.chunkRowsDeleted;
    if (gcDeleted > 0) {
      log(
        `[magic-context] GC'd ${gcDeleted} stale embedding row(s) for ${projectIdentity} ` +
          `(memory=${gc.memoryRowsDeleted} commit=${gc.commitRowsDeleted} chunk=${gc.chunkRowsDeleted})`,
      );
    }
  } catch (error) {
    log(
      `[magic-context] embedding maintenance failed for ${projectIdentity}: ${describeError(error).brief}`,
    );
  }

  const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
  if (snapshot?.enabled === true) {
    try {
      const embeddedMemories = await embedUnembeddedMemoriesForProject(db, projectIdentity);
      if (embeddedMemories > 0) {
        log(
          `[magic-context] proactively embedded ${embeddedMemories} ` +
            `${embeddedMemories === 1 ? "memory" : "memories"} for ${projectIdentity}`,
        );
      }
      // Compartment-chunk backfill stays demand-driven (opencode parity).
    } catch (error) {
      log(
        `[magic-context] memory embedding backfill failed for ${projectIdentity}: ${describeError(error).brief}`,
      );
    }
  }

  if (snapshot?.gitCommitEnabled === true) {
    await sweepGitCommitsForProject({ db, projectIdentity, directory, log });
  }

  await runCompiledSmartNoteSweep(db, projectIdentity, directory, log);
}

/**
 * Mirror of the opencode sweepGitCommits: lease + cooldown coordinated
 * (across processes via the shared DB), renewed while running, parked on
 * non-indexable directories for the 24h re-probe horizon.
 */
async function sweepGitCommitsForProject(args: {
  db: Database;
  projectIdentity: string;
  directory: string;
  log: (message: string) => void;
}): Promise<void> {
  const { db, projectIdentity, directory, log } = args;
  let sinceDays = 365;
  let maxCommits = 2000;
  try {
    const config = loadPluginConfig(directory);
    sinceDays = config.memory.git_commit_indexing.since_days;
    maxCommits = config.memory.git_commit_indexing.max_commits;
  } catch {
    // Schema defaults above stand.
  }
  const holderId = randomUUID();
  const lease = acquireGitSweepLease(db, projectIdentity, holderId);
  if (!lease.acquired) {
    const reason =
      lease.reason === "cooldown_active"
        ? `cooldown active until ${lease.nextAllowedAt}`
        : `lease held by ${lease.leaseHolder ?? "another holder"} until ${lease.leaseExpiresAt ?? "unknown"}`;
    log(`[git-commits] sweep skipped for ${projectIdentity}: ${reason}`);
    return;
  }

  const startedAt = Date.now();
  const renewal = setInterval(() => {
    try {
      if (!renewGitSweepLease(db, projectIdentity, holderId)) {
        log(`[git-commits] sweep lease renewal failed for ${projectIdentity}`);
      }
    } catch {
      // Renewal is best-effort; the TTL catches us on the next tick.
    }
  }, GIT_SWEEP_LEASE_RENEWAL_MS);
  renewal.unref?.();
  try {
    const result = await indexCommitsForProject(db, projectIdentity, directory, {
      sinceDays,
      maxCommits,
    });
    if (result.nonIndexable) {
      // Not a repo / empty repo: park on the long re-probe cooldown so the
      // timer doesn't retry (and log) every tick.
      if (!parkGitSweepNonIndexable(db, projectIdentity, holderId)) {
        releaseGitSweepLease(db, projectIdentity, holderId);
      }
      return;
    }
    let drainedEmbeddings = 0;
    if (result.embedded > 0) {
      drainedEmbeddings = await embedUnembeddedCommits(db, projectIdentity);
    }
    if (!markGitSweepSuccessAndRelease(db, projectIdentity, holderId)) {
      releaseGitSweepLease(db, projectIdentity, holderId);
      log(
        `[git-commits] sweep finished for ${projectIdentity}, but lease was no longer active; cooldown not advanced`,
      );
    }
    let backlogDrained = 0;
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (snapshot?.gitCommitEnabled) {
      try {
        backlogDrained = await drainCommitBacklogForProject(
          db,
          projectIdentity,
          Date.now() + GIT_COMMIT_BACKLOG_DRAIN_MAX_MS,
        );
      } catch (error) {
        log(
          `[git-commits] commit backlog drain failed for ${projectIdentity}: ${describeError(error).brief}`,
        );
      }
    }
    const elapsedMs = Date.now() - startedAt;
    log(
      `[git-commits] sweep finished for ${projectIdentity} in ${elapsedMs}ms: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=${result.embedded} drained=${drainedEmbeddings} backlogDrained=${backlogDrained}`,
    );
  } catch (error) {
    releaseGitSweepLease(db, projectIdentity, holderId);
    log(
      `[git-commits] sweep failed for ${projectIdentity} after ${Date.now() - startedAt}ms: ${describeError(error).brief}`,
    );
  } finally {
    clearInterval(renewal);
  }
}

/**
 * Mirror of the opencode runCompiledSmartNoteSweep: leased under the
 * evaluate-smart-notes domain so it cannot race the scheduled dream task of
 * the same name. DSH passes no retinaHandoff (no retina plane yet).
 */
async function runCompiledSmartNoteSweep(
  db: Database,
  projectIdentity: string,
  projectRoot: string,
  log: (message: string) => void,
): Promise<void> {
  const leaseKey = leaseKeyFor("evaluate-smart-notes", projectIdentity);
  const holderId = randomUUID();
  if (!acquireLease(db, holderId, leaseKey)) return;
  try {
    const result = await runDueCompiledSmartNoteChecks({
      db,
      projectIdentity,
      projectRoot,
    });
    if (result.ran > 0) {
      log(
        `[dreamer] compiled smart-note sweep ${projectIdentity}: ran=${result.ran} surfaced=${result.surfaced} logic_failed=${result.failed} network_failed=${result.networkFailed}`,
      );
    }
  } finally {
    releaseLease(db, holderId, leaseKey);
  }
}

type IntervalFactory = (fn: () => void, ms: number) => () => void;

/** Default interval factory: a Node setInterval, unref'd (the timer must not
 *  hold the process open), disposed by clearInterval. */
function defaultIntervalFactory(fn: () => void, ms: number): () => void {
  const handle = setInterval(fn, ms);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref(): void }).unref();
  }
  return () => clearInterval(handle);
}

let intervalFactory: IntervalFactory = defaultIntervalFactory;

/**
 * Register the DSH dreamer plane: await host.ready → discover projects from
 * session_projects → one ctx-owned interval per project (default 15 min)
 * running the core scheduler pass, plus an immediate initial pass per project
 * (mirrors the core timer's startup sweep). Every side effect is fiber-owned
 * via one ctx.effect; disposal stops the timers.
 *
 * Also publishes the shared runtime state (config + facade) that
 * {@link dshDreamSeams} reads, so the timer and /ctx-dream share one facade.
 *
 * Deviation: the design's core process-wide `startDreamScheduleTimer`
 * singleton is NOT reused — see the module header for the rationale.
 */
export function registerDshDreamer(ctx: Context, deps: DreamerWiringDeps): void {
  const log = deps.log ?? (() => {});
  const enabled = deps.config?.enabled !== false;
  const rawTick = deps.config?.tickMs;
  const tickMs =
    typeof rawTick === "number" && Number.isFinite(rawTick) && rawTick > 0
      ? rawTick
      : DEFAULT_DREAM_TICK_MS;
  const state: DreamerRuntimeState = {
    enabled,
    tickMs,
    // 桥接：优先用 magic-context.jsonc 的 dreamer 段（含 per-task cron），
    // 缺失时回落核心默认调度（v1 保真）。
    coreConfig: synthesizeDreamerConfig(deps.coreConfig),
    directory: deps.directory ?? process.cwd(),
    presence: agentPresenceOf(ctx),
    facade: null,
  };
  dreamerRuntime.set(ctx, state);

  const disposers: Array<() => void> = [];
  let stopped = false;
  ctx.effect(
    () => () => {
      stopped = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Best-effort disposal.
        }
      }
    },
    "dreamer-timer",
  );

  if (!enabled) {
    log("[dreamer] disabled (config.enabled=false) — no schedule timer; /ctx-dream will report runnable=false");
    return;
  }

  void (async () => {
    let boot: DshStorageBootstrap;
    try {
      boot = await deps.host.ready;
    } catch (error) {
      log(`[dreamer] host bootstrap failed — timer not started: ${describeError(error).brief}`);
      return;
    }
    if (stopped) return;
    if (boot.kind !== "ok") {
      log(`[dreamer] host bootstrap ${boot.kind} (${boot.reason}) — timer not started`);
      return;
    }
    try {
      const db = boot.db;
      const projects = new Set(discoverDreamProjects(db));
      // Identities observed live since process start (agent/created → presence
      // directoryByIdentity): new workspaces opened AFTER timer start get a
      // tick without a restart.
      const observeLive = () => {
        for (const { identity } of state.presence.observedProjects()) {
          projects.add(identity);
        }
      };
      observeLive();
      if (projects.size === 0) {
        log("[dreamer] no projects discovered from session_projects — timer idle");
        return;
      }
      const facade = (state.facade ??= createDshDreamClient(ctx, {
        db,
        presence: state.presence,
        log,
      }));
      const executor = buildDreamExecutor(facade, state);
      // Re-entry guard (the opencode tickInFlight mirror): a slow dream task
      // (tool worker, LLM turn) must not stack onto a still-running tick for
      // the same project; the lease/gate chain keeps the work correct, this
      // keeps the process honest.
      const tickInFlight = new Set<string>();
      const tick = (projectIdentity: string, origin: "interval" | "startup") => {
        if (tickInFlight.has(projectIdentity)) {
          log(`[dreamer] tick ${origin} skipped for ${projectIdentity} — previous tick still in flight`);
          return;
        }
        tickInFlight.add(projectIdentity);
        runDreamTick(db, projectIdentity, executor, state, log)
          .catch(() => {
            // runDreamTick never rejects (both lanes catch internally);
            // this is the last-resort belt.
          })
          .finally(() => tickInFlight.delete(projectIdentity));
      };
      // ONE shared interval over the project set (not one interval per
      // project): a live-opened workspace joins the set without leaking a
      // per-project timer on every observation.
      disposers.push(
        intervalFactory(() => {
          observeLive();
          for (const projectIdentity of projects) {
            tick(projectIdentity, "interval");
          }
        }, tickMs),
      );
      log(
        `[dreamer] registered schedule timer (every ${Math.round(tickMs / 60_000)}m; projects=${projects.size})`,
      );
      // Initial pass per project (the core timer's startup sweep equivalent),
      // behind the shared boot quiet period and staggered per project (the
      // opencode BOOT_PROJECT_JITTER mirror: slot*1s + directory hash, so a
      // multi-project process does not create one writer burst).
      beginBootQuietPeriod();
      const startupJitter = new Map<string, number>();
      const startupJitterMs = (projectIdentity: string): number => {
        const existing = startupJitter.get(projectIdentity);
        if (existing !== undefined) return existing;
        const slot = startupJitter.size;
        const hash = [...projectIdentity].reduce(
          (value, character) => (value * 33 + character.charCodeAt(0)) >>> 0,
          5381,
        );
        const jitter =
          startupJitterSlotMs === 0
            ? 0
            : slot * startupJitterSlotMs + (hash % startupJitterSlotMs);
        startupJitter.set(projectIdentity, jitter);
        return jitter;
      };
      for (const projectIdentity of projects) {
        const timer = scheduleAfterBootQuiet(
          () => tick(projectIdentity, "startup"),
          startupJitterMs(projectIdentity),
        );
        disposers.push(() => clearTimeout(timer));
      }
    } catch (error) {
      log(`[dreamer] registration failed: ${describeError(error).brief}`);
    }
  })();
}

/**
 * Build the `CtxCommandSeams["dreamer"]` object for `/ctx-dream`:
 *   - tasks      — runtime configs for ENABLED tasks (schedule != "") in
 *                  canonical order;
 *   - executor   — core createDreamTaskExecutor over the shared facade;
 *   - runnable   — config.enabled && !compaction-off (compaction-off is read
 *                  structurally off the agent-plane config's
 *                  `commands.compactionOff`, the same flag registerCtxCommands
 *                  gates on; absent → compaction is on);
 *   - scheduleSummary — simple text from the core summarizeDreamSchedule.
 */
export function dshDreamSeams(
  ctx: Context,
  deps: {
    db: Database;
    log?: (message: string) => void;
    compactionOff?: boolean;
    presence?: AgentPresence;
  },
): NonNullable<CtxCommandSeams["dreamer"]> {
  const state = dreamerRuntime.get(ctx) ?? defaultState(ctx);
  const facade = (state.facade ??= createDshDreamClient(ctx, {
    ...deps,
    presence: deps.presence ?? state.presence,
  }));
  const executor = buildDreamExecutor(facade, state);
  const tasks = buildDreamTaskRuntimeConfigs(state.coreConfig, "opencode").filter(
    (task) => task.schedule.trim() !== "",
  );
  const runnable = state.enabled && deps.compactionOff !== true;
  return {
    tasks,
    executor,
    runnable,
    scheduleSummary: summarizeDreamSchedule(state.coreConfig),
  };
}

/* ────────────────────────────── test seam ─────────────────────────────── */

export const __test = {
  /** Replace the interval factory (fake timers in tests). */
  setIntervalFactory(factory: IntervalFactory | null): void {
    intervalFactory = factory ?? defaultIntervalFactory;
  },
  /** Zero the startup-pass stagger (deterministic immediate initial passes). */
  setStartupJitterSlotMs(ms: number): void {
    startupJitterSlotMs = ms;
  },
  reset(): void {
    intervalFactory = defaultIntervalFactory;
    startupJitterSlotMs = BOOT_PROJECT_JITTER_SLOT_MS;
    // Runtime state is keyed by ctx in a WeakMap and garbage-collected with
    // it, so only the factory needs restoring.
  },
  /** Direct access to the per-tick maintenance sweeps (test seam). */
  runDshPeriodicMaintenance,
};
