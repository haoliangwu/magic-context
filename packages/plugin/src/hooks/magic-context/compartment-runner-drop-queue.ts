import { queuePendingOp } from "../../features/magic-context/storage-ops";
import { getActiveTagsBySession } from "../../features/magic-context/storage-tags";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { getRawSessionTagKeysThrough, type RawSessionTagKeys } from "./read-session-chunk";

/**
 * Queue drop ops for active tags whose source content is at or before the
 * published compartment boundary. Tool tags use `(callId, ownerMessageId)` so a
 * reused call id outside the compartment remains live.
 *
 * Callers publishing inside a transaction should collect the tag keys first and
 * pass them as `observedKeys`; this keeps paged SQLite reads and event-loop yields
 * outside the write transaction while the resulting drop rows still commit with
 * the compartment publication.
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

    const tags = getActiveTagsBySession(db, sessionId);
    let dropsQueued = 0;

    for (const tag of tags) {
        if (tag.status !== "active") continue;

        if (tag.type === "tool") {
            const observedOwners = observedKeys.toolObservations.get(tag.messageId);
            if (!observedOwners) continue;
            if (tag.toolOwnerMessageId !== null && !observedOwners.has(tag.toolOwnerMessageId)) {
                continue;
            }
            // Rows created before tool ownership was persisted retain the legacy
            // call-id fallback until a later tagging pass adopts an owner.
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
            continue;
        }

        if (observedKeys.messageFileKeys.has(tag.messageId)) {
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
        }
    }

    sessionLog(
        sessionId,
        `compartment agent: queued ${dropsQueued} drops for messages ${fromMessageIndex}-${upToMessageIndex}`,
    );
}
