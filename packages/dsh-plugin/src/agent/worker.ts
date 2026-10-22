/**
 * agent/worker — the minimal Magic worker (PLAN §5.13/D7) + recursion
 * isolation (PLAN §9 worker 递归隔离).
 *
 * A worker is a one-shot child agent started through the DSH 0.2.1 activation
 * API: depth pinned (maxDepth 0 — workers can never spawn further), caller
 * delivery (no settlement notice in the borrowed parent's conversation), and
 * delegated approval pinned to 'never' by the activation manager. DSH 0.2.1
 * composes new children from their Agent Preset (the parent's when none is
 * selected) and no longer accepts a per-request toolFilter/persona, so the
 * task instructions travel as the leading prompt block and the worker's tool
 * surface is the inherited preset's. It is used for the tool-requiring
 * Dreamer paths.
 *
 * RECURSION ISOLATION: the agent-plane Magic listeners (context plane,
 * knowledge gate, session tracking) must NOT process child sessions — a child
 * inherits the parent's preset composition, so without this gate every worker
 * turn would re-enter the full Magic pipeline. `isMagicChildSession` is the
 * single gate: header `origin === 'subagent'` or a persisted delegation
 * depth ≥ 1. This matches §5.10: Magic's per-session machinery applies to the
 * Magic-marked (top-level, host-mounted) agent tree, while children run with
 * official semantics.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  magicWorkerActivation,
  magicWorkerPrompt,
  subagentsOf,
} from "../compat/dsh-0.1/subagent";

/** Whether a session is a CHILD session (subagent origin or delegation depth). */
export function isMagicChildSession(agent: Agent): boolean {
  const header = agent.session?.header as
    | { origin?: string; delegationDepth?: number }
    | undefined;
  if (header?.origin === "subagent") return true;
  return typeof header?.delegationDepth === "number" && header.delegationDepth >= 1;
}

/** One worker run result. */
export interface MagicWorkerResult {
  readonly text: string;
  readonly durationMs: number;
  readonly toolCallCount: number;
}

export interface MagicWorkerDeps {
  /** The parent agent (owner of the worker). */
  readonly parent: Agent;
  /** Worker label (persistent provenance). */
  readonly label: string;
  /** The worker's task prompt (user turn). */
  readonly prompt: string;
  /**
   * Preferred tool allowlist. Kept for callers/tests; DSH 0.2.1 composes new
   * children from their Agent Preset, so this no longer narrows the surface.
   */
  readonly allow?: readonly string[];
  /** Optional system prompt for the worker. */
  readonly systemPrompt?: string;
  readonly signal: AbortSignal;
  /** Hard timeout (default 120s). */
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

/**
 * Run one Magic worker. Returns null on failure/cancel/timeout (never throws
 * to the caller's pre-step chain). The activation manager seeds the delegated
 * policy (approval 'never' + the parent's sandbox mode) onto the child log
 * before publication.
 */
export async function runMagicWorker(
  ctx: Context,
  deps: MagicWorkerDeps,
): Promise<MagicWorkerResult | null> {
  const log = deps.log ?? (() => {});
  try {
    const subagents = subagentsOf(ctx);
    if (subagents === undefined) {
      log("[magic-context] worker skipped: subagents service unavailable");
      return null;
    }
    const started = Date.now();
    const run = await subagents.startActivation(
      magicWorkerActivation(deps.parent, {
        label: deps.label,
        prompt: magicWorkerPrompt(deps.systemPrompt, deps.prompt),
        maxDepth: 0, // workers can never spawn further (recursion cap)
        signal: deps.signal,
      }),
    );

    const timeout = deps.timeoutMs ?? 120_000;
    const result = await Promise.race([
      run.result,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => {
          run.dispose();
          resolve(null);
        }, timeout);
        deps.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            run.dispose();
            resolve(null);
          },
          { once: true },
        );
      }),
    ]);
    if (result === null) return null;
    const stopReason = (result as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted" || stopReason === "refusal") {
      return null;
    }
    const text = result.output
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (text.length === 0) return null;
    return {
      text,
      durationMs: Date.now() - started,
      toolCallCount: result.structured !== undefined ? 1 : 0,
    };
  } catch (error) {
    log(`[magic-context] worker failed (returns null): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
