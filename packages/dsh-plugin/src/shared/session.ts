/**
 * HarnessSession — Host-neutral session surface (merged from adapter-api/session.ts).
 */
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

export type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

export interface HarnessMessageUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
}

export interface HarnessCompactionInput {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly details?: unknown;
  readonly fromHook?: boolean;
}

export interface HarnessSession {
  readonly id: string;
  readonly nativeId: string;
  readBranch(): RawMessage[];
  appendCompaction(input: HarnessCompactionInput): string | undefined;
  stableId(index: number, ref?: unknown): string;
  usageOf(message: unknown): HarnessMessageUsage | null;
  isMidTurn(): boolean;
}
