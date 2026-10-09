import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import {
    AGE_RECLAIM_MIN_TOKENS,
    advanceToolReclaimWatermark,
    type ContextDatabase,
    getActiveToolTagsForAgeReclaim,
    getMaxTagNumberBySession,
} from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";

export function buildSyntheticToolReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    watermark: number;
    pendingOps?: readonly PendingOp[];
    protectedTools?: Readonly<Record<string, number>>;
    protectedToolTags?: ReadonlySet<number>;
}): PendingOp[] {
    const watermark = Math.max(0, input.watermark);
    if (watermark <= 0) return [];

    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveToolTagsForAgeReclaim(input.db, input.sessionId);
    const protectedTags =
        input.protectedToolTags ?? protectedToolTagNumbers(tags, input.protectedTools);
    const synthetic: PendingOp[] = [];

    for (const tag of tags) {
        if (tag.tagNumber > watermark) continue;
        if (tag.reclaimableTokens !== null && tag.reclaimableTokens < AGE_RECLAIM_MIN_TOKENS) {
            continue;
        }
        if (protectedTags.has(tag.tagNumber)) continue;
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
    }

    return synthetic;
}

export function advanceToolReclaimWatermarkToCurrentMax(
    db: ContextDatabase,
    sessionId: string,
): number {
    const maxTagNumber = getMaxTagNumberBySession(db, sessionId);
    advanceToolReclaimWatermark(db, sessionId, maxTagNumber);
    return maxTagNumber;
}
