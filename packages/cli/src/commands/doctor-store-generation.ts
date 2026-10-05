import type { OpenCodeHostGeneration } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";

/**
 * Read-only reporting on the store-projection rebase.
 *
 * Magic Context stores conversational coordinates as positions in the message
 * list a host serves, and the OpenCode 1.x and 2.x stores number the same
 * conversation differently. The plugin re-derives those positions from message
 * ids the first time it sees a session under a projection it has not recorded.
 * These helpers only READ that state: they say how many sessions are still
 * waiting for that to happen and what the rebases that already ran could not
 * re-anchor. Nothing here rebases anything.
 */

export interface PendingCoordinateRebases {
    /** Sessions whose recorded projection differs from the one this host serves. */
    changed: number;
    /** Sessions that hold coordinates but have never recorded a projection. */
    unrecorded: number;
    /** Sessions already recorded against the running host. */
    current: number;
}

export interface UnresolvedCompartmentSession {
    sessionId: string;
    count: number;
}

export interface UnresolvedCompartments {
    total: number;
    sessions: number;
    /** Highest-count sessions first, capped by the caller. */
    top: UnresolvedCompartmentSession[];
}

function hasColumn(db: Pick<Database, "prepare">, table: string, column: string): boolean {
    try {
        const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
        return rows.some((row) => row.name === column);
    } catch {
        return false;
    }
}

/** Whether this database is new enough to answer either question. */
export function supportsCoordinateGenerationReporting(db: Pick<Database, "prepare">): boolean {
    return (
        hasColumn(db, "session_meta", "coordinate_generation") &&
        hasColumn(db, "compartments", "rebase_status")
    );
}

/**
 * Count the sessions the next open would rebase.
 *
 * Only sessions that actually hold a compartment are counted: a session with no
 * saved coordinate has nothing to re-derive, so its stamp is written with no
 * other effect and it is not work anyone needs to plan for.
 */
export function countPendingCoordinateRebases(
    contextDb: Pick<Database, "prepare">,
    runningGeneration: OpenCodeHostGeneration,
): PendingCoordinateRebases {
    const rows = contextDb
        .prepare(
            `SELECT sm.coordinate_generation AS generation, COUNT(*) AS count
               FROM session_meta AS sm
              WHERE sm.harness IN ('opencode', 'opencode2')
                AND EXISTS (SELECT 1 FROM compartments AS c WHERE c.session_id = sm.session_id)
              GROUP BY sm.coordinate_generation`,
        )
        .all() as Array<{ generation?: unknown; count?: unknown }>;
    const result: PendingCoordinateRebases = { changed: 0, unrecorded: 0, current: 0 };
    for (const row of rows) {
        const count = typeof row.count === "number" ? row.count : 0;
        if (row.generation === runningGeneration) result.current += count;
        else if (row.generation === "v1" || row.generation === "v2") result.changed += count;
        else result.unrecorded += count;
    }
    return result;
}

export function formatPendingCoordinateRebases(
    pending: PendingCoordinateRebases,
    runningGeneration: OpenCodeHostGeneration,
): string {
    const waiting = pending.changed + pending.unrecorded;
    if (waiting === 0) {
        return `All ${pending.current} session(s) with compartments are already anchored to this host's ${runningGeneration} store projection`;
    }
    return (
        `${waiting} session(s) with compartments would be re-anchored on next open ` +
        `(${pending.changed} recorded against the other projection, ${pending.unrecorded} never recorded); ` +
        `${pending.current} already on ${runningGeneration}`
    );
}

/**
 * Compartments a rebase could not re-anchor, because the message their saved
 * endpoint id names is absent from the projection the host now serves. They
 * still render in the injected session history and stay readable by id; only
 * range recovery (`ctx_expand`) refuses them, because their
 * saved message range can no longer be trusted. The next store conversion in
 * either direction re-evaluates them.
 */
export function listUnresolvedCompartments(
    contextDb: Pick<Database, "prepare">,
    limit = 5,
): UnresolvedCompartments {
    const rows = contextDb
        .prepare(
            `SELECT session_id AS sessionId, COUNT(*) AS count
               FROM compartments
              WHERE rebase_status = 'unresolved'
              GROUP BY session_id
              ORDER BY count DESC, session_id ASC`,
        )
        .all() as Array<{ sessionId?: unknown; count?: unknown }>;
    const sessions = rows.flatMap((row) =>
        typeof row.sessionId === "string" && typeof row.count === "number"
            ? [{ sessionId: row.sessionId, count: row.count }]
            : [],
    );
    return {
        total: sessions.reduce((sum, session) => sum + session.count, 0),
        sessions: sessions.length,
        top: sessions.slice(0, Math.max(0, limit)),
    };
}

export function formatUnresolvedCompartmentSession(session: UnresolvedCompartmentSession): string {
    return `session=${session.sessionId} unresolved=${session.count}`;
}
