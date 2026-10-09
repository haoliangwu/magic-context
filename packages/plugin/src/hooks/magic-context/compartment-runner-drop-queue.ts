import { queuePendingDropForUnchangedTag } from "../../features/magic-context/storage-ops";
import { getActiveTagsBySession } from "../../features/magic-context/storage-tags";
import type { TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { getRawSessionTagKeysThrough, type RawSessionTagKeys } from "./read-session-chunk";

export interface PreparedCompartmentDrops {
    sessionId: string;
    upToMessageIndex: number;
    fromMessageIndex: number;
    candidates: readonly TagEntry[];
}

/** Select before BEGIN IMMEDIATE: even an indexed active-tag scan can fault in
 * many pages on a long session. No whole-session reads belong under the writer.
 */
export function prepareCompartmentDrops(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
    observedKeys: RawSessionTagKeys,
    fromMessageIndex = 1,
): PreparedCompartmentDrops {
    const candidates = getActiveTagsBySession(db, sessionId).filter((tag) => {
        if (tag.type !== "tool") return observedKeys.messageFileKeys.has(tag.messageId);
        const observedOwners = observedKeys.toolObservations.get(tag.messageId);
        // Tool tags written before owner tracking have no owner message; they match on the
        // call id alone until a later tagging pass records which message owns the call.
        return (
            observedOwners !== undefined &&
            (tag.toolOwnerMessageId === null || observedOwners.has(tag.toolOwnerMessageId))
        );
    });
    return { sessionId, upToMessageIndex, fromMessageIndex, candidates };
}

/** Only candidate point lookups and inserts run in the publication transaction.
 * Status and source identity are checked again on its fresh write-locked snapshot.
 */
export function queuePreparedCompartmentDrops(
    db: Database,
    prepared: PreparedCompartmentDrops,
): void {
    let dropsQueued = 0;
    for (const tag of prepared.candidates) {
        if (queuePendingDropForUnchangedTag(db, prepared.sessionId, tag)) dropsQueued += 1;
    }
    sessionLog(
        prepared.sessionId,
        `compartment agent: queued ${dropsQueued} drops for messages ${prepared.fromMessageIndex}-${prepared.upToMessageIndex}`,
    );
}

/**
 * Queue drop ops for active tags whose source content is at or before the
 * published compartment boundary. Tool tags use `(callId, ownerMessageId)` so a
 * reused call id outside the compartment remains live.
 *
 * Convenience path for post-commit recomp callers. Atomic publishers must collect
 * raw keys AND call prepareCompartmentDrops before acquiring the writer, then call
 * queuePreparedCompartmentDrops inside their publication transaction.
 */
export function queueDropsForCompartmentalizedMessages(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
): Promise<void>;
export function queueDropsForCompartmentalizedMessages(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
    observedKeys: RawSessionTagKeys,
    fromMessageIndex?: number,
): void;
export function queueDropsForCompartmentalizedMessages(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
    observedKeys?: RawSessionTagKeys,
    fromMessageIndex = 1,
): Promise<void> | void {
    if (!observedKeys) {
        return getRawSessionTagKeysThrough(sessionId, upToMessageIndex, { db }).then((keys) =>
            queueDropsForCompartmentalizedMessages(db, sessionId, upToMessageIndex, keys),
        );
    }

    queuePreparedCompartmentDrops(
        db,
        prepareCompartmentDrops(db, sessionId, upToMessageIndex, observedKeys, fromMessageIndex),
    );
}
