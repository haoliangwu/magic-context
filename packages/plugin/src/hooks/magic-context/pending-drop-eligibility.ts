import { readEpochFloorSnapshot } from "../../features/magic-context/protection-window";
import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import {
    getMergedReasoningStrippedIds,
    loadProtectedTailMeta,
} from "../../features/magic-context/storage-meta-persisted";
import { getReasoningRemovalState } from "../../features/magic-context/storage-reasoning-removal";
import { tagRevisionKey } from "../../features/magic-context/storage-tag-identity-revision";
import type { Database } from "../../shared/sqlite";
import type { LkgEntryProjection } from "./lkg-replay";
import type { TagTarget } from "./tag-messages";

/** The first-application veto shared by pending drops and their historian projection. */
export function pendingDropVeto(
    tagNumber: number,
    target: TagTarget | undefined,
    protectedTagIds: ReadonlySet<number>,
): "protected" | "active_thinking" | null {
    if (protectedTagIds.has(tagNumber)) return "protected";
    if (target?.thinkingDropProtected) return "active_thinking";
    return null;
}

/** Absent/incomplete targets cannot reclaim wire bytes, even if a DB-only drop can persist. */
export function capturePendingDropEligibility(
    targets: ReadonlyMap<number, TagTarget>,
    protectedTagIds: ReadonlySet<number>,
): ReadonlySet<number> {
    const eligible = new Set<number>();
    for (const [number, target] of targets) {
        if (pendingDropVeto(number, target, protectedTagIds)) continue;
        if (target.drop) {
            if (target.canDrop?.() === true) eligible.add(number);
        } else {
            const content = target.getContent?.();
            const replacement = `[dropped §${number}§]`;
            if (
                typeof content === "string" &&
                content.length > replacement.length &&
                target.canSetContent?.(replacement) !== false
            )
                eligible.add(number);
        }
    }
    return eligible;
}

/** Reuse only an apply view of the same pristine request and protection policy. */
export function pendingDropEligibilityKey(
    db: Database,
    sessionId: string,
    input: readonly LkgEntryProjection[],
    protectionInputs: unknown,
): string | null {
    const digests = input.map((message) => message.contentDigest?.() ?? null);
    if (digests.some((digest) => digest === null)) return null;
    const revision = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(tagRevisionKey(sessionId)) as { value: string | null } | undefined;
    if (!revision?.value) return null;
    return JSON.stringify([
        input.map((message, index) => [
            message.id,
            message.role,
            message.synthetic,
            digests[index],
        ]),
        revision.value,
        readEpochFloorSnapshot(db, sessionId),
        sessionDecisionCalibration(db, sessionId).toolsRatio,
        loadProtectedTailMeta(db, sessionId),
        [...getMergedReasoningStrippedIds(db, sessionId)].sort(),
        [...getReasoningRemovalState(db, sessionId).messageIds].sort(),
        protectionInputs,
    ]);
}

export function createPendingDropEligibilityCache() {
    const sessions = new Map<string, { key: string; eligible: ReadonlySet<number> }>();
    return {
        read(sessionId: string, key: string | null): ReadonlySet<number> | undefined {
            const previous = sessions.get(sessionId);
            if (key === null || previous?.key !== key) {
                sessions.delete(sessionId);
                return undefined;
            }
            return previous.eligible;
        },
        record(sessionId: string, key: string | null, eligible: ReadonlySet<number>): void {
            sessions.delete(sessionId);
            if (key === null) return;
            const oldest = sessions.keys().next().value;
            if (sessions.size >= 64 && oldest !== undefined) sessions.delete(oldest);
            sessions.set(sessionId, { key, eligible: new Set(eligible) });
        },
    };
}
