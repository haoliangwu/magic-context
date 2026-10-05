import { HAS_COMPARTMENT_CONTENT_SQL } from "../../features/magic-context/no-content-compartment";
import type { Database } from "../../shared/sqlite";

/**
 * Detection of compartments written before the current (tiered) historian
 * format. Such rows still render, only in the degraded title-only/P4 form, and
 * a plain `/ctx-recomp` rebuilds them into the current shape.
 */

/** A compartment needs rebuilding when it lacks usable tiers — either a pre-v2
 *  `legacy=1` row, OR a malformed "pseudo-v2" row flagged `legacy=0` but with no
 *  `p1` tier (e.g. from an interrupted/crashed recomp, or an older partial-v2
 *  build). The `legacy=0 ⟹ has tiers` invariant can break from any partial state,
 *  so both shapes must count as "still old". */
export const NEEDS_UPGRADE_SQL = `(${HAS_COMPARTMENT_CONTENT_SQL} AND (legacy = 1 OR p1 IS NULL OR p1 = ''))`;

/**
 * Count compartments still written in the pre-tier format (pre-v2 `legacy=1`
 * rows OR tierless `p1 IS NULL/''` rows from an interrupted/old partial build).
 * Surfaced by the Pi `/ctx-status` dialog (Pi has no sidebar). Returns 0 on any
 * error.
 */
export function countCompartmentsNeedingUpgrade(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare(
                `SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND ${NEEDS_UPGRADE_SQL}`,
            )
            .get(sessionId) as { count?: number } | undefined;
        return typeof row?.count === "number" ? row.count : 0;
    } catch {
        return 0;
    }
}
