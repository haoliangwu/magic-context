/**
 * DSH harness identity boundary (merged from adapter-api/harness.ts).
 *
 * Core declares HarnessId = "opencode" | "pi" | "dsh" (shared/harness.ts).
 * This module:
 *  1. declares DSH harness identity as runtime string "dsh";
 *  2. crosses closed-union via setDshHarness -> core setHarness("dsh");
 *  3. derives canonical Magic session key `dsh:<home-hash>:<dsh-session-id>`.
 */
import { setHarness } from "@magic-context/core/shared/harness";

/** DSH harness identity as persisted into the shared SQLite `harness` column. */
export const DSH_HARNESS = "dsh" as const;

/** Lock harness identity to "dsh" (idempotent; throws on different value). */
export function setDshHarness(): void {
  setHarness(DSH_HARNESS as Parameters<typeof setHarness>[0]);
}

/** Canonical Magic session key namespace prefix. */
export const DSH_SESSION_KEY_PREFIX = "dsh";

/** Separator between canonical-key segments. */
const SEP = ":";

/**
 * Derive canonical Magic session key for a DSH session.
 * @param homeHash - stable short hash of DSH home (first 8 hex of sha256).
 * @param dshSessionId - DSH-native session id (header.id).
 * @returns `dsh:<homeHash>:<dshSessionId>`.
 */
export function canonicalSessionKey(homeHash: string, dshSessionId: string): string {
  if (homeHash.length === 0) throw new Error("canonicalSessionKey: homeHash must be non-empty");
  if (dshSessionId.length === 0) throw new Error("canonicalSessionKey: dshSessionId must be non-empty");
  if (dshSessionId.includes(SEP)) {
    throw new Error(`canonicalSessionKey: dshSessionId must not contain "${SEP}"`);
  }
  return `${DSH_SESSION_KEY_PREFIX}${SEP}${homeHash}${SEP}${dshSessionId}`;
}

/** Parsed canonical DSH session key. */
export interface ParsedDshSessionKey {
  readonly homeHash: string;
  readonly dshSessionId: string;
}

/**
 * Invert {@link canonicalSessionKey}. Returns undefined for non-canonical keys.
 */
export function parseDshSessionKey(key: string): ParsedDshSessionKey | undefined {
  if (typeof key !== "string") return undefined;
  const first = key.indexOf(SEP);
  if (first <= 0) return undefined;
  if (key.slice(0, first) !== DSH_SESSION_KEY_PREFIX) return undefined;
  const second = key.indexOf(SEP, first + 1);
  if (second <= first + 1 || second === key.length - 1) return undefined;
  const homeHash = key.slice(first + 1, second);
  const dshSessionId = key.slice(second + 1);
  if (homeHash.length === 0 || dshSessionId.length === 0) return undefined;
  return { homeHash, dshSessionId };
}
