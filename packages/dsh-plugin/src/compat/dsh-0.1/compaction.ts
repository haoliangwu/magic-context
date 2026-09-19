/**
 * compat/dsh-0.1/compaction — the Magic compaction engine seam.
 *
 * PLAN D3 / §5.1: `MagicCompactionEngine extends BasicCompactionEngine`,
 * overriding ONLY `summarize()`. The official transaction (lock, event order,
 * replacement adjacency, flush, validation) stays fully owned by
 * `@deepseek-ai/dsh-compaction-basic`.
 *
 * The hook types are the OFFICIAL `SummarizationInput` / `SummaryResult`
 * contracts (validated in Phase 0 spike-3): `summary` is a ContentBlock array,
 * `provider`/`model` are required.
 */
import {
  BasicCompactionEngine,
  type BasicCompactionConfig,
} from "@deepseek-ai/dsh-compaction-basic";
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
  type CompactionEngine,
} from "@deepseek-ai/dsh-compaction";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";

export {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
};
export type { BasicCompactionConfig, CompactionEngine };

/**
 * OFFICIAL hook contracts, pinned here because
 * `@deepseek-ai/dsh-compaction-basic` does not export a `/summarizer` subpath.
 * Shapes copied verbatim from its `lib/types/summarizer.d.ts`; the DSH-upgrade
 * gate (compat layer contract fixtures) verifies they still match.
 */
export interface SummarizationInput {
  readonly system?: string;
  readonly tools?: readonly ToolSchema[];
  readonly messages: readonly Message[];
}

export type SummaryResult = {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  usage?: TokenUsage;
} & (
  | {
      rawOutput: ContentBlock[];
      llmStreamCall: true;
    }
  | {
      rawOutput?: ContentBlock[];
      llmStreamCall?: never;
    }
);

/** The sole subclass customization hook (official contract). */
export type SummarizeHook = (
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
) => Promise<SummaryResult>;

/**
 * Magic compaction engine. Mounted inside the preset's isolated `compaction`
 * group in place of the stock `compaction-basic` row; `auto` is controlled by
 * composition config (the preset row).
 *
 * The summarize hook is a FUNCTION and cannot travel in YAML config, and the
 * compaction entry bundle and the agent plane are separate bundles with
 * separate module state. The agent plane therefore registers the hook on the
 * HOST service (`magicContextHost.registerSummarizeHook`); this engine reads
 * it through the service at call time (falling back to a config-supplied
 * hook, which tests use).
 */
export class MagicCompactionEngine extends BasicCompactionEngine {
  /** Config-supplied hook (tests); the production path reads the host service. */
  protected readonly magicSummarize?: SummarizeHook;

  constructor(ctx: Context, config: BasicCompactionConfig & { summarize?: SummarizeHook }) {
    // Strip the hook before handing config to the stock engine: its schema
    // rejects unknown keys, and the hook is our seam, not its business.
    const { summarize, ...stockConfig } = config;
    super(ctx, { ...stockConfig, auto: stockConfig.auto ?? true });
    this.magicSummarize = summarize;
  }

  override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const host = readHostService(this.ctx);
    const hook = this.magicSummarize ?? readHostSummarizeHook(host);
    if (hook === undefined) {
      if (host === undefined) {
        // No Magic Context host in this composition (a sibling profile that
        // shares the patched shipped preset without MC mounted): degrade to
        // the stock engine behavior — the patched row must stay safe
        // wherever it loads (ADR 0001).
        return super.summarize(input, agent, signal);
      }
      // MC composition, but the agent plane has not wired the hook yet —
      // fail closed and loudly instead of silently stock-compacting.
      throw new Error(
        "magic-context: compaction summarize hook unavailable (agent plane not wired?)",
      );
    }
    return hook(input, agent, signal);
  }
}

/** The host service on `ctx`, when this composition mounts Magic Context. */
function readHostService(ctx: Context): unknown {
  return ctx.get("magicContextHost");
}

/** Read the hook the agent plane registered on the host service (if any). */
function readHostSummarizeHook(host: unknown): SummarizeHook | undefined {
  const typed = host as
    | { summarizeHook?: () => unknown }
    | undefined;
  const hook = typed?.summarizeHook?.();
  return typeof hook === "function" ? (hook as SummarizeHook) : undefined;
}
