import {
    cachedTagOwnerRatios,
    installTagOwnerDelta,
    installTagOwnerSummary,
    isTagOwnerSummaryReady,
    tagOwnerWarmupState,
} from "../../features/magic-context/storage-tags";
import { sessionLog } from "../../shared/logger";
import {
    type Database,
    getSqliteDatabasePath,
    getTagIdentityWriteGeneration,
} from "../../shared/sqlite";
import { runSessionWarmupWorker } from "./raw-ordinal-warmup";

const pending = new WeakMap<Database, Map<string, Promise<boolean>>>();

function stamp(db: Database) {
    const row = db
        .prepare(
            "SELECT data_version AS dataVersion, total_changes() AS changes, (SELECT schema_version FROM pragma_schema_version) AS schemaVersion FROM pragma_data_version",
        )
        .get() as { dataVersion: number; changes: number; schemaVersion: number };
    return { ...row, generation: getTagIdentityWriteGeneration() };
}

/** Cold and invalidated digests use the ordinal worker entry, never the host thread. */
export function prewarmTagOwners(db: Database, sessionId: string, ratio: number): Promise<boolean> {
    if (isTagOwnerSummaryReady(db, sessionId, ratio)) return Promise.resolve(true);
    const path = getSqliteDatabasePath(db);
    if (!path) return Promise.resolve(false);
    const key = `${sessionId}\0${ratio}`;
    const sessions = pending.get(db) ?? new Map<string, Promise<boolean>>();
    pending.set(db, sessions);
    const existing = sessions.get(key);
    if (existing) return existing;
    const job = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = stamp(db);
            const ratios = cachedTagOwnerRatios(db, sessionId);
            const cached = tagOwnerWarmupState(db, sessionId);
            const tagState =
                cached?.generation === before.generation &&
                cached.dataVersion !== before.dataVersion &&
                cached.schemaVersion === before.schemaVersion &&
                ratios.includes(ratio)
                    ? cached
                    : undefined;
            const result = await runSessionWarmupWorker(
                { path, sessionId, tagRatio: ratio, tagRatios: ratios, tagState },
                {},
            );
            if (!("summary" in result) && !("delta" in result)) {
                sessionLog(sessionId, "WARN tag owner warm-up failed:", result);
                return false;
            }
            if (JSON.stringify(before) !== JSON.stringify(stamp(db))) continue;
            if ("delta" in result) {
                if (
                    !tagState ||
                    !installTagOwnerDelta(db, sessionId, tagState, result.delta, before)
                )
                    continue;
            } else installTagOwnerSummary(db, sessionId, result.summary, before, Boolean(tagState));
            return true;
        }
        sessionLog(
            sessionId,
            "WARN tag owner warm-up superseded by store changes after 3 attempts",
        );
        return false;
    })()
        .catch((error) => {
            sessionLog(sessionId, "WARN tag owner warm-up threw:", error);
            return false;
        })
        .finally(() => sessions.delete(key));
    sessions.set(key, job);
    return job;
}

/** The worker continues after the deadline so a later pass can use its result. */
export async function waitForTagOwners(
    db: Database,
    sessionId: string,
    ratio: number,
    waitMs = 250,
): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const ready = await Promise.race([
            prewarmTagOwners(db, sessionId, ratio),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), waitMs);
            }),
        ]);
        if (!ready) {
            sessionLog(
                sessionId,
                `WARN tag owner digest unavailable within ${waitMs}ms; decisions requiring exact owners must defer or retry`,
            );
        }
        return ready;
    } finally {
        clearTimeout(timer);
    }
}
