import fixture from "../../../../testdata/temporal-upgrade-projections.json";
import type { Database } from "./sqlite";

export type TemporalFixtureRuntime = "Pi" | "OpenCode 1" | "OpenCode 2";
type Value = null | string | number | { base64: string };
interface CapturedSession {
    sessionId: string;
    cwd?: string;
    input: unknown[];
    entryIds?: string[];
    projection: unknown[];
    projectionJson: string;
    state: Record<string, Array<Record<string, Value>>>;
}

export const temporalUpgradeCases: Record<TemporalFixtureRuntime, CapturedSession> = fixture.cases;

/** Restore old served state, never by first rendering it with the current code. */
export function seedTemporalUpgradeFixture(
    db: Database,
    runtime: TemporalFixtureRuntime,
): CapturedSession {
    const captured = temporalUpgradeCases[runtime];
    db.transaction(() => {
        for (const [table, rows] of Object.entries(captured.state)) {
            for (const row of rows) {
                const columns = Object.keys(row);
                const values = Object.values(row).map((value) =>
                    value !== null && typeof value === "object"
                        ? Buffer.from(value.base64, "base64")
                        : value,
                );
                db.prepare(
                    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
                ).run(...values);
            }
        }
        // Advance only the cache clock: timestamp-derived marker bytes and
        // the old input/projection are the immutable captured fixture.
        db.prepare("UPDATE session_meta SET last_response_time=? WHERE session_id=?").run(
            Date.now(),
            captured.sessionId,
        );
        db.prepare("UPDATE lkg_slots SET captured_at=? WHERE session_id=?").run(
            Date.now(),
            captured.sessionId,
        );
    }).immediate();
    return captured;
}
