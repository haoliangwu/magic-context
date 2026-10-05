import {
    addMergedReasoningStrippedIds,
    getMergedReasoningStrippedIds,
    THINKING_BINDING_STRIP_ORDER_END_MARKER,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { getSlot } from "./lkg-slot";
import { stripTagPrefix } from "./tag-content-primitives";
import type { MessageLike } from "./tag-messages";
import type { ToolSweepCandidates, ToolSweepVariantResolver } from "./tool-drop-target";

// This reserved non-message ID shares the session-owned reasoning replay ledger.
// Older readers ignore unknown entries, so no schema migration is necessary.
export const TOOL_SWEEP_SCOPED_MARKER = "@tool-sweep-scoped";

/**
 * Ledger entries that are session-wide control flags rather than message ids.
 * The reasoning replay ledger is a plain set of strings, so every consumer that
 * filters it by message identity (session clone, in particular) has to copy
 * these through verbatim instead of discarding them as undecodable ids.
 */
export const RESERVED_LEDGER_CONTROL_ENTRIES: readonly string[] = [
    TOOL_SWEEP_SCOPED_MARKER,
    THINKING_BINDING_STRIP_ORDER_END_MARKER,
];

export function isReservedLedgerControlEntry(entry: string): boolean {
    return RESERVED_LEDGER_CONTROL_ENTRIES.includes(entry);
}

/** Restore unrelated reasoning-only messages only when a cache-busting pass permits byte changes. */
export function useScopedToolSweep(db: Database, sessionId: string, canAdopt: boolean): boolean {
    if (getMergedReasoningStrippedIds(db, sessionId).has(TOOL_SWEEP_SCOPED_MARKER)) return true;
    if (!canAdopt) return false;
    return addMergedReasoningStrippedIds(db, sessionId, [TOOL_SWEEP_SCOPED_MARKER]);
}

/**
 * What the durable last-served snapshot says about a pre-adoption pass:
 *
 * - `lkg_absent`   nothing durable was recorded, so no bytes are known to have
 *                  been served under either sweep.
 * - `matched_old`  the last served rows are reproduced by the legacy sweep.
 *                  Also reported when both candidates reproduce them, because
 *                  then the snapshot is no evidence for changing behavior.
 * - `matched_scoped` only the scoped sweep reproduces the last served rows.
 * - `matched_neither` neither candidate reproduces them (history moved since).
 */
export type ToolSweepLkgCondition =
    | "lkg_absent"
    | "matched_old"
    | "matched_scoped"
    | "matched_neither";

export interface ToolSweepVariantDecision {
    condition: ToolSweepLkgCondition;
    /** True when this pass should serve — and therefore adopt — the scoped sweep. */
    scoped: boolean;
    legacyDivergence: number;
    scopedDivergence: number;
    lastServedRows: number;
}

/**
 * Identify a served row for comparison against a previously served array.
 *
 * Rows with nothing left to send are skipped: a row whose parts were all
 * removed, or that was reduced to an empty text shell, is dropped before the
 * request is built, so it is not part of what the model saw. A build that
 * emptied such a row without removing it would otherwise look like a different
 * history. Reasoning-only rows DO reach the provider and are compared — they
 * are exactly what the two sweeps disagree about.
 */
function servedRowKeys(messages: readonly MessageLike[]): string[] {
    const keys: string[] = [];
    for (const message of messages) {
        if (!Array.isArray(message?.parts) || !message.parts.some(partReachesProvider)) continue;
        const id = message.info?.id;
        keys.push(typeof id === "string" && id.length > 0 ? id : JSON.stringify(message.info));
    }
    return keys;
}

function partReachesProvider(part: unknown): boolean {
    if (!isRecord(part)) return true;
    if (part.type !== "text") return true;
    return typeof part.text === "string" && stripTagPrefix(part.text).trim().length > 0;
}

function firstDivergence(left: readonly string[], right: readonly string[]): number {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index += 1) {
        if (left[index] !== right[index]) return index;
    }
    return left.length === right.length ? -1 : shared;
}

/**
 * True when serving `candidate` replays every row the previous pass served, in
 * order, before whatever this pass appended. A candidate that is missing rows
 * the session already paid for is not a replay of them.
 */
function reproducesLastServed(
    lastServed: readonly string[],
    candidate: readonly string[],
): boolean {
    if (lastServed.length === 0 || candidate.length < lastServed.length) return false;
    return lastServed.every((key, index) => candidate[index] === key);
}

export function classifyToolSweepCandidates(
    lastServed: readonly MessageLike[] | null,
    candidates: ToolSweepCandidates,
): ToolSweepVariantDecision {
    if (!lastServed) {
        // Nothing durable was served under either sweep, so serving the scoped
        // array now cannot contradict bytes this session already paid for.
        return {
            condition: "lkg_absent",
            scoped: true,
            legacyDivergence: -1,
            scopedDivergence: -1,
            lastServedRows: 0,
        };
    }
    const legacyKeys = servedRowKeys(candidates.legacy);
    const scopedKeys = servedRowKeys(candidates.scoped);
    const lastKeys = servedRowKeys(lastServed);
    const decision = {
        legacyDivergence: firstDivergence(lastKeys, legacyKeys),
        scopedDivergence: firstDivergence(lastKeys, scopedKeys),
        lastServedRows: lastKeys.length,
    };
    // Checked before the scoped arm on purpose: when both candidates reproduce
    // the snapshot they are indistinguishable over the evidence, which is no
    // reason to change what this session is already being served. The next
    // priced pass adopts unconditionally.
    if (reproducesLastServed(lastKeys, legacyKeys)) {
        return { condition: "matched_old", scoped: false, ...decision };
    }
    if (reproducesLastServed(lastKeys, scopedKeys)) {
        return { condition: "matched_scoped", scoped: true, ...decision };
    }
    return { condition: "matched_neither", scoped: false, ...decision };
}

function parseLastServedArray(jsonPrefix: string | undefined): MessageLike[] | null {
    if (!jsonPrefix) return null;
    try {
        const parsed: unknown = JSON.parse(jsonPrefix);
        return Array.isArray(parsed) ? (parsed as MessageLike[]) : null;
    } catch {
        // An unreadable snapshot is no evidence of what was served.
        return null;
    }
}

/**
 * Pick the sweep variant for a pass that may NOT change bytes and has not
 * adopted the scoped sweep yet.
 *
 * A session upgraded from a build that only ever ran the legacy sweep may have
 * been served either array, depending on which code path last priced it, so a
 * fixed default is wrong for one of the two populations. Instead compare both
 * candidates against the last array this session actually served and serve the
 * one that reproduces it. Reproducing the scoped array is adoption evidence —
 * it re-serves bytes the session already paid for — so the marker is written on
 * that pass. Every outcome is logged under one stable key so the populations
 * can be counted.
 */
export function createPreAdoptionToolSweepResolver(
    db: Database,
    sessionId: string,
): ToolSweepVariantResolver {
    // Read the snapshot here, where the pass selects its policy, so a second
    // process that prices the same session mid-pass cannot change this pass's
    // input halfway through it. Only the comparison itself is deferred to the
    // point where both candidate arrays exist.
    const snapshot = getSlot(sessionId)?.jsonPrefix;
    return (candidates) => {
        const decision = classifyToolSweepCandidates(parseLastServedArray(snapshot), candidates);
        sessionLog(
            sessionId,
            `tool_sweep_lkg_mismatch session=${sessionId} condition=${decision.condition} ` +
                `last_served_rows=${decision.lastServedRows} legacy_divergence=${decision.legacyDivergence} ` +
                `scoped_divergence=${decision.scopedDivergence}`,
        );
        if (!decision.scoped) return false;
        // Persisting can fail on a locked database; the decision is re-derived
        // from the same durable snapshot next pass, so the bytes stay stable.
        addMergedReasoningStrippedIds(db, sessionId, [TOOL_SWEEP_SCOPED_MARKER]);
        return true;
    };
}
