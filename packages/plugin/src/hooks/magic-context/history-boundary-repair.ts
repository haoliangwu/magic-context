import { deleteChunkEmbedBackoffForSession } from "../../features/magic-context/compartment-chunk-embedding";
import {
    acquireCompartmentLease,
    isCompartmentLeaseHeld,
    releaseCompartmentLeaseBestEffort,
} from "../../features/magic-context/compartment-lease";
import {
    type Compartment,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { queueM0Mutation } from "../../features/magic-context/storage-m0-mutation-log";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { getActiveCompartmentRun } from "./compartment-runner";
import { invalidateAutoEmbedSession } from "./embed-session-state";
import { clearInjectionCache, resetPrefixTrimFallbackState } from "./inject-compartments";

// ── Repair for a history boundary the host store no longer has ──────────
//
// The history boundary is the end message of the newest compartment: the
// transform cuts the raw conversation through that message, and OpenCode 2's
// restore of rows the host compacted away starts right after it. Both look the
// message up by id. When the host store has lost the row (a store conversion
// drops it, an /undo deletes it), neither can place it: the cut never happens
// and the restore starts at the first row, so every pass sends the whole
// conversation, and nothing that runs later can move the boundary, because it
// is recomputed from the same newest compartment every time.
//
// The repair only acts on proof. "The row is not in this request" is not proof:
// the host leaves rows out of a request for ordinary reasons (its own
// compaction, a window that starts later). The caller supplies a lookup against
// the host store itself, and only a definite "not there" counts. A lookup that
// cannot answer leaves everything alone.
//
// Given proof, it re-anchors on the newest compartment whose end message the
// store still has. The compartments after it summarize history whose end no
// longer exists; they are removed so the historian rebuilds that range from the
// raw rows that remain, which is how going back inside summarized history is
// handled: truncate from the first affected compartment and let the historian
// redo the rest. Older compartments whose rows are gone keep rendering: their
// summaries are the history, and none of them is the boundary.
//
// The cached m[0]/m[1] pair is cleared with the removal, since its bytes render
// the removed compartments and its recorded boundary names the missing row. The
// next pass materializes a fresh pair against the new anchor: one cache-busting
// pass, after which ordinary replay resumes.

/**
 * Whether the host store holds a message: `true` or `false` when the store
 * answered, `null` when it could not be asked. Only `false` proves absence.
 */
export type HostMessagePresence = (messageId: string) => boolean | null;

export type HistoryBoundaryRepair =
    /** Nothing is missing, or there is nothing to anchor. */
    | { kind: "intact" }
    /** The store could not say whether the boundary exists; nothing changed. */
    | { kind: "unknown" }
    /** Compartments after the anchor were removed and the cached pair cleared. */
    | {
          kind: "repaired";
          missingEndMessageId: string;
          anchorEndMessageId: string;
          droppedSequences: number[];
      }
    /** The compartments are sound but the cached pair's boundary was not; the pair was cleared. */
    | { kind: "baseline-reset"; anchorEndMessageId: string; staleBaselineId: string | null }
    /** The boundary is proven missing but cannot be re-anchored now. */
    | { kind: "unresolved"; reason: "no-anchor" | "busy"; missingEndMessageId: string };

interface BaselineRow {
    hasCachedM0: boolean;
    boundary: string | null;
}

function readBaseline(db: Database, sessionId: string): BaselineRow {
    const row = db
        .prepare(
            "SELECT cached_m0_bytes IS NOT NULL AS hasM0, cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { hasM0: number | null; boundary: string | null } | null | undefined;
    return {
        hasCachedM0: row?.hasM0 === 1,
        boundary: row?.boundary && row.boundary.length > 0 ? row.boundary : null,
    };
}

/** The newest compartment, older than `latestIndex`, whose end message the store holds. */
function findAnchor(
    compartments: readonly Compartment[],
    latestIndex: number,
    isInHostStore: HostMessagePresence,
): Compartment | "unknown" | null {
    for (let index = latestIndex - 1; index >= 0; index -= 1) {
        const candidate = compartments[index];
        const endId = candidate?.endMessageId;
        if (!candidate || typeof endId !== "string" || endId.length === 0) continue;
        const present = isInHostStore(endId);
        if (present === null) return "unknown";
        if (present) return candidate;
    }
    return null;
}

function forgetCachedPrefix(sessionId: string): void {
    clearInjectionCache(sessionId);
    resetPrefixTrimFallbackState(sessionId);
}

/** Remove every compartment after `anchor` under the compartment-state lease. */
function dropCompartmentsAfter(
    db: Database,
    sessionId: string,
    anchor: Compartment,
    holderId: string,
): number[] | null {
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }
        const dropped = db
            .prepare(
                "SELECT id, sequence FROM compartments WHERE session_id = ? AND sequence > ? ORDER BY sequence",
            )
            .all(sessionId, anchor.sequence) as Array<{ id: number; sequence: number }>;
        const deleteEmbeddings = db.prepare(
            "DELETE FROM compartment_chunk_embeddings WHERE compartment_id = ?",
        );
        for (const row of dropped) deleteEmbeddings.run(row.id);
        db.prepare("DELETE FROM compartments WHERE session_id = ? AND sequence > ?").run(
            sessionId,
            anchor.sequence,
        );
        // Depth counters past the anchor belonged to the removed compartments;
        // the rebuilt ones start fresh, as a partial recomp's do.
        db.prepare(
            "DELETE FROM compression_depth WHERE session_id = ? AND message_ordinal > ?",
        ).run(sessionId, anchor.endMessage);
        deleteChunkEmbedBackoffForSession(db, sessionId);
        queueM0Mutation(db, { sessionId, mutationType: "recomp_boundary_change" });
        clearCachedM0M1(db, sessionId);
        db.exec("COMMIT");
        finished = true;
        return dropped.map((row) => row.sequence);
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // SQLite may already have closed the transaction after an error.
            }
        }
    }
}

/**
 * Re-anchor the history boundary when the host store proves its message is
 * gone. See the section comment above for the rules.
 */
export function repairMissingHistoryBoundary(args: {
    db: Database;
    sessionId: string;
    isInHostStore: HostMessagePresence;
}): HistoryBoundaryRepair {
    const { db, sessionId, isInHostStore } = args;
    const compartments = getCompartments(db, sessionId);
    // The boundary is the newest compartment that has an end id at all. Newer
    // compartments without one (legacy rows, or rows carried into a forked
    // session) are not the boundary: they keep rendering, and the boundary
    // functions trim at the newest id instead. Having no id says nothing about
    // the store, so on its own it never causes a removal.
    let latestIndex = compartments.length - 1;
    while (latestIndex >= 0 && !compartments[latestIndex]?.endMessageId) latestIndex -= 1;
    if (latestIndex < 0) return { kind: "intact" };
    const latestEnd = (compartments[latestIndex] as Compartment).endMessageId;

    const latestPresent = isInHostStore(latestEnd);
    if (latestPresent === null) return { kind: "unknown" };

    if (!latestPresent) {
        const missing = latestEnd;
        const problem = `newest compartment end ${latestEnd} is not in the host store`;
        const anchor = findAnchor(compartments, latestIndex, isInHostStore);
        if (anchor === "unknown") return { kind: "unknown" };
        if (anchor === null) {
            sessionLog(
                sessionId,
                `history boundary unresolved: ${problem} and no older compartment end is in the host store; nothing to re-anchor on`,
            );
            return { kind: "unresolved", reason: "no-anchor", missingEndMessageId: missing };
        }
        // A running historian, recomp or wrapup owns compartment state; removing
        // rows under it would race its publish. The next pass retries.
        if (getActiveCompartmentRun(sessionId) !== undefined) {
            return { kind: "unresolved", reason: "busy", missingEndMessageId: missing };
        }
        const holderId = crypto.randomUUID();
        if (!acquireCompartmentLease(db, sessionId, holderId)) {
            return { kind: "unresolved", reason: "busy", missingEndMessageId: missing };
        }
        let dropped: number[] | null;
        try {
            dropped = dropCompartmentsAfter(db, sessionId, anchor, holderId);
        } finally {
            releaseCompartmentLeaseBestEffort(db, sessionId, holderId);
        }
        if (dropped === null) {
            return { kind: "unresolved", reason: "busy", missingEndMessageId: missing };
        }
        invalidateAutoEmbedSession(sessionId);
        forgetCachedPrefix(sessionId);
        const range =
            dropped.length === 0
                ? "none"
                : `${dropped[0]}-${dropped[dropped.length - 1]} (${dropped.length})`;
        sessionLog(
            sessionId,
            `history boundary repair: ${problem}; re-anchored on compartment ${anchor.sequence} ending at ${anchor.endMessageId} (ordinal ${anchor.endMessage}); removed compartments ${range} for the historian to rebuild; the cached prefix is rebuilt on this pass`,
        );
        return {
            kind: "repaired",
            missingEndMessageId: missing,
            anchorEndMessageId: anchor.endMessageId,
            droppedSequences: dropped,
        };
    }

    // An empty cached boundary is left alone: it means the pair was recorded
    // before the first compartment, so replay covers none of them and their raw
    // rows are meant to be served until the next priced pass folds them in.
    const baseline = readBaseline(db, sessionId);
    if (!baseline.hasCachedM0 || baseline.boundary === null || baseline.boundary === latestEnd) {
        return { kind: "intact" };
    }
    if (isInHostStore(baseline.boundary) !== false) return { kind: "intact" };
    clearCachedM0M1(db, sessionId);
    forgetCachedPrefix(sessionId);
    sessionLog(
        sessionId,
        `history boundary repair: the cached prefix boundary ${baseline.boundary} is not in the host store; rebuilding it on this pass against compartment end ${latestEnd}`,
    );
    return {
        kind: "baseline-reset",
        anchorEndMessageId: latestEnd,
        staleBaselineId: baseline.boundary,
    };
}
