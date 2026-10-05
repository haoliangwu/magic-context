/**
 * The last maintenance tick that ended before it finished its work.
 *
 * A tick that dies early is otherwise invisible from outside: no task fails, no
 * schedule row changes, and the only trace is a log line nobody reads. That
 * makes "the background maintenance has nothing to do" and "the background
 * maintenance is not running at all" look identical in the status view. This
 * records the second one so both surfaces can tell them apart, and clears it as
 * soon as a tick gets all the way through.
 *
 * The row lives in the shared key/value table rather than in session state: the
 * timer is one per process, is not attached to any session, and its failures
 * have to survive the session that happened to be open when they occurred.
 */
import type { Database } from "../../../shared/sqlite";
import { userFacingFailureCode } from "../../../shared/user-facing-codes";

const DREAMER_TICK_FAILURE_KEY = "dreamer_tick_last_failure";

export interface DreamerTickFailure {
    /** When the failing stage was caught, in epoch milliseconds. */
    at: number;
    /**
     * Which stage of the tick failed, in words a user can act on — either
     * "message-history maintenance" or "project <identity>".
     */
    stage: string;
    /** The error text, already flattened to a single line. */
    message: string;
}

function parseFailure(value: string | null): DreamerTickFailure | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<DreamerTickFailure> | null;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
        if (typeof parsed.stage !== "string" || typeof parsed.message !== "string") return null;
        return { at: parsed.at, stage: parsed.stage, message: parsed.message };
    } catch {
        // A hand-edited or truncated row is treated as "nothing recorded"
        // rather than as a second failure to report.
        return null;
    }
}

/**
 * True when this database has the shared key/value table. A database old
 * enough to predate it simply has nothing recorded, which the caller reads the
 * same way as a clean pass.
 */
function hasMetaTable(db: Database): boolean {
    const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("schema_migrations_meta");
    return Boolean(row);
}

/** The last recorded tick failure, or null when the most recent tick was clean. */
export function getDreamerTickFailure(db: Database): DreamerTickFailure | null {
    if (!hasMetaTable(db)) return null;
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(DREAMER_TICK_FAILURE_KEY) as { value?: string } | undefined;
    return parseFailure(row?.value ?? null);
}

/** Record the stage that stopped this tick, replacing any earlier record. */
export function recordDreamerTickFailure(db: Database, failure: DreamerTickFailure): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(DREAMER_TICK_FAILURE_KEY, JSON.stringify(failure));
}

/** Drop the record after a tick that completed every stage. */
export function clearDreamerTickFailure(db: Database): void {
    db.prepare("DELETE FROM schema_migrations_meta WHERE key = ?").run(DREAMER_TICK_FAILURE_KEY);
}

/**
 * One diagnostic line for a recorded failure. Shared by every harness's doctor
 * so the three of them describe this the same way.
 */
export function formatDreamerTickFailure(failure: DreamerTickFailure): string {
    const when = Number.isFinite(failure.at)
        ? new Date(failure.at).toISOString()
        : "an unknown time";
    return (
        `Background maintenance stopped in ${failure.stage} at ${when} ` +
        `(${userFacingFailureCode("dreamer_tick_blocked")}): ${failure.message}. ` +
        "Scheduled maintenance tasks do not run until a pass completes."
    );
}
