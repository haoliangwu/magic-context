/**
 * compat/dsh-0.1/subagent — the minimal worker seam (PLAN §5.13 / D7).
 *
 * DSH 0.2.1 replaced the provider-scoped `start(provider, request)` API with
 * the unified activation API: `subagents.startActivation(spec)` where the
 * spec owns provider, label, caller cancellation and delivery, and the child
 * composition comes from its Agent Preset (or inherits the parent's) — the
 * per-request `toolFilter`/`persona` fields are gone for new children and are
 * only restored from a historical descriptor on cold resume. Magic therefore
 * composes the worker's task instructions into the prompt and lets the child
 * inherit the parent preset; the delegated approval pin ('never') is applied
 * by the activation manager itself.
 *
 * The adapter still does NOT depend on any undeclared `AgentOptions.role`
 * field.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
  SubagentDepthError,
  type SubagentActivation,
  type SubagentActivationSpec,
  type SubagentRuntime,
} from "@deepseek-ai/dsh-subagent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

export {
  SubagentDepthError,
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
};
export type { SubagentActivation, SubagentActivationSpec, SubagentRuntime };

/** Registry name of the in-process spawn backend Magic workers use. */
export const MAGIC_WORKER_PROVIDER = "spawn";

/** Tool allowlist for a Magic worker (read-only maintenance surface). */
export const MAGIC_WORKER_READONLY_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "fs_search",
];

/**
 * Compose one worker's instructions. DSH 0.2.1 has no per-request persona for
 * new children, so the task system prompt is delivered as the leading block
 * of the child's user message.
 */
export function magicWorkerPrompt(system: string | undefined, text: string): ContentBlock[] {
  const merged = system === undefined || system.length === 0 ? text : `${system}\n\n${text}`;
  return [{ type: "text", text: merged }];
}

/**
 * Build the activation spec for a one-shot Magic worker: depth pinned, the
 * borrowed parent supplies workspace/lineage, caller delivery keeps the
 * settlement notice out of the parent conversation.
 */
export function magicWorkerActivation(
  parent: Agent,
  opts: {
    label: string;
    prompt: ContentBlock[];
    maxDepth?: number;
    signal: AbortSignal;
    agentOptions?: AgentOptions;
  },
): SubagentActivationSpec {
  return {
    provider: MAGIC_WORKER_PROVIDER,
    label: opts.label,
    delivery: "caller",
    signal: opts.signal,
    request: {
      prompt: opts.prompt,
      parent,
      maxDepth: opts.maxDepth ?? 1,
      ...(opts.agentOptions === undefined ? {} : { agentOptions: opts.agentOptions }),
    },
  };
}

/** Resolve the subagents service from a context (undefined-safe read). */
export function subagentsOf(ctx: Context): SubagentRuntime | undefined {
  return ctx.get("subagents") as SubagentRuntime | undefined;
}

/** Resolve a live child agent by the activation's durable id (undefined-safe). */
export function childAgentOf(ctx: Context, childId: string): Agent | undefined {
  const agents = ctx.get("agents") as
    | { get(id: unknown): Agent | undefined }
    | undefined;
  return agents?.get(childId);
}
