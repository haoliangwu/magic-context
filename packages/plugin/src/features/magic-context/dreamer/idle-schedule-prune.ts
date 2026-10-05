import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { deleteTaskScheduleRowsForProject } from "./storage-task-schedule";
import { identityHasProjectInput } from "./task-gates";

/**
 * Pruning visits every identity that holds schedule rows, so it runs at most
 * once per day across all processes sharing the store, not on every tick.
 */
export const IDLE_SCHEDULE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** dream_state key holding the epoch-ms time of the last idle-identity prune. */
export const IDLE_SCHEDULE_PRUNE_AT_KEY = "schedule_idle_prune_at";

/**
 * Delete every schedule row of identities that can do nothing now.
 *
 * Any directory that hosted a session used to keep a full set of schedule rows
 * forever, even when it never produced a memory (chat folders, downloads,
 * scratch directories). The timer only visits directories open in a running
 * process, so those rows were never even evaluated again; they just piled up
 * in the store and on the dashboard. An identity with active memories is never
 * pruned. A pruned identity gets rows back from the normal seeding path once it
 * has input again.
 *
 * Throttled through dream_state to once per IDLE_SCHEDULE_PRUNE_INTERVAL_MS.
 * Returns the identities whose rows were deleted (empty when throttled).
 */
export function pruneIdleScheduleIdentities(db: Database, now: number): string[] {
    const last = Number(getDreamState(db, IDLE_SCHEDULE_PRUNE_AT_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < IDLE_SCHEDULE_PRUNE_INTERVAL_MS) {
        return [];
    }
    // Claim the slot before the scan: two processes racing here both prune, and
    // deleting the same rows twice is harmless.
    setDreamState(db, IDLE_SCHEDULE_PRUNE_AT_KEY, String(now));

    const identities = db
        .prepare<[], { project_path: string }>(
            "SELECT DISTINCT project_path FROM task_schedule_state",
        )
        .all()
        .map((row) => row.project_path);
    const pruned: string[] = [];
    for (const identity of identities) {
        if (identityHasProjectInput(db, identity, now)) continue;
        const removed = deleteTaskScheduleRowsForProject(db, identity);
        if (removed > 0) pruned.push(identity);
    }
    if (pruned.length > 0) {
        log(
            `[dreamer] pruned schedule rows of ${pruned.length} idle identit${pruned.length === 1 ? "y" : "ies"} (no memories, no recent sessions, no task input)`,
        );
    }
    return pruned;
}
