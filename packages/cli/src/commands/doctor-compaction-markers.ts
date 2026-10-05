import type { Database } from "@magic-context/core/shared/sqlite";

export interface OpenCodeCompactionMarkerConversionReport {
    missingBefore: number;
    missingAfter: number;
    repaired: number;
    migrationCompleted: boolean;
    migratedV2Schema: boolean;
    unmatchedConvertedMarkers: number;
    /**
     * session_message rows OpenCode 2 wrote after its conversion, in sessions that
     * still have an OpenCode 1 `session` row. Reconverting deletes all of them.
     */
    postConversionMessages: number;
    /** Sessions holding at least one of those rows. */
    postConversionSessions: number;
}

function safeData(column = "data"): string {
    return `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
}

function mcMarkerPredicate(column = "data"): string {
    const data = safeData(column);
    return `
        json_extract(${data}, '$.role') = 'assistant'
        AND json_extract(${data}, '$.summary') = 1
        AND json_extract(${data}, '$.providerID') = 'magic-context'`;
}

function tableExists(db: Pick<Database, "prepare">, table: string): boolean {
    return (
        db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .get(table) != null
    );
}

function countMissingCompleted(db: Database): number {
    if (!tableExists(db, "message")) return 0;
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count
               FROM message
              WHERE ${mcMarkerPredicate()}
                AND json_type(${safeData()}, '$.time.completed') IS NULL`,
        )
        .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
}

function migrationV1ToV2Completed(db: Database): boolean {
    if (!tableExists(db, "kv")) return false;
    const columns = db.prepare("PRAGMA table_info(kv)").all() as Array<{ name?: unknown }>;
    const names = new Set(
        columns.flatMap((column) => (typeof column.name === "string" ? [column.name] : [])),
    );
    if (!names.has("key") || !names.has("value")) return false;
    const row = db.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2' LIMIT 1").get() as
        | { value?: unknown }
        | undefined;
    if (typeof row?.value !== "string") return false;
    try {
        const parsed = JSON.parse(row.value) as { phase?: unknown };
        return parsed.phase === "completed";
    } catch {
        return false;
    }
}

function countUnmatchedConvertedMarkers(db: Database, migratedV2Schema: boolean): number {
    if (!migratedV2Schema || !tableExists(db, "message")) return 0;
    const row = db
        .prepare(
            `SELECT COUNT(DISTINCT json_extract(${safeData("marker.data")}, '$.parentID')) AS count
               FROM message marker
              WHERE ${mcMarkerPredicate("marker.data")}
                AND typeof(json_extract(${safeData("marker.data")}, '$.parentID')) = 'text'
                AND NOT EXISTS (
                    SELECT 1
                      FROM session_message converted
                     WHERE converted.id = json_extract(${safeData("marker.data")}, '$.parentID')
                       AND converted.type = 'compaction'
                )`,
        )
        .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
}

/**
 * Count session_message rows that have no OpenCode 1 source row.
 *
 * OpenCode 2's converter (`V1Migration.run` in packages/core/src/database/v1-migration.bun.ts,
 * 2.0.15) walks every row of the OpenCode 1 `session` table, deletes that session's
 * session_message rows and inserts the projection of its v1 `message` rows. Every
 * projected row copies the time_created of the v1 message it came from, including split
 * synthetic rows and merged compaction rows. A row whose time_created matches no v1
 * message of the same session was therefore written by OpenCode 2 after the conversion,
 * and a reconversion would delete it.
 *
 * The whole store is counted, not only the sessions missing a marker, because the
 * converter rewrites every OpenCode 1 session when it runs again.
 */
function countPostConversionMessages(
    db: Database,
    migratedV2Schema: boolean,
): { messages: number; sessions: number } {
    if (!migratedV2Schema || !tableExists(db, "message") || !tableExists(db, "session")) {
        return { messages: 0, sessions: 0 };
    }
    const row = db
        .prepare(
            `SELECT COUNT(*) AS messages, COUNT(DISTINCT converted.session_id) AS sessions
               FROM session_message converted
              WHERE EXISTS (SELECT 1 FROM session legacy WHERE legacy.id = converted.session_id)
                AND NOT EXISTS (
                    SELECT 1
                      FROM message source
                     WHERE source.session_id = converted.session_id
                       AND source.time_created = converted.time_created
                )`,
        )
        .get() as { messages?: number; sessions?: number } | undefined;
    return { messages: Number(row?.messages ?? 0), sessions: Number(row?.sessions ?? 0) };
}

/**
 * Check, and optionally repair, v1 compaction-summary rows before OpenCode 2 converts them.
 * Only summaries with Magic Context's provider identity are eligible; summaries written by
 * OpenCode itself keep their original data.
 */
export function checkOpenCodeCompactionMarkerConversion(
    db: Database,
    options: { fix?: boolean } = {},
): OpenCodeCompactionMarkerConversionReport {
    const missingBefore = countMissingCompleted(db);
    let repaired = 0;

    if (options.fix && missingBefore > 0 && tableExists(db, "message")) {
        repaired = db.transaction(() => {
            const result = db
                .prepare(
                    `UPDATE message
                        SET data = json_set(
                            data,
                            '$.time.completed',
                            json_extract(${safeData()}, '$.time.created')
                        )
                      WHERE ${mcMarkerPredicate()}
                        AND json_type(${safeData()}, '$.time.completed') IS NULL`,
                )
                .run() as { changes?: number };
            return Number(result.changes ?? 0);
        })();
    }

    const missingAfter = countMissingCompleted(db);
    const migratedV2Schema = tableExists(db, "session_v2") && tableExists(db, "session_message");
    const migrationCompleted = migrationV1ToV2Completed(db);
    const unmatchedConvertedMarkers = countUnmatchedConvertedMarkers(db, migratedV2Schema);
    const postConversion = countPostConversionMessages(db, migratedV2Schema);

    return {
        missingBefore,
        missingAfter,
        repaired,
        migrationCompleted,
        migratedV2Schema,
        unmatchedConvertedMarkers,
        postConversionMessages: postConversion.messages,
        postConversionSessions: postConversion.sessions,
    };
}

export function formatOpenCodeCompactionMarkerConversion(
    report: OpenCodeCompactionMarkerConversionReport,
): string {
    return `OpenCode compaction markers are convertible to OpenCode 2: before=${report.missingBefore} missing time.completed; after=${report.missingAfter}`;
}

/**
 * Explain Magic Context markers that OpenCode 2's conversion did not carry over.
 *
 * This is informational. Magic Context on OpenCode 2 never relies on a host
 * compaction row: it writes none for sessions started there (the v2 marker strategy
 * is inert), keeps its own boundary in session_meta, and re-derives compartment
 * positions from the messages that survived, filling an anchor the conversion removed
 * from the neighbouring compartment. A converted session without the marker is in
 * the same state as a session started on OpenCode 2.
 *
 * It never suggests clearing kv.migration.v1-v2. A reconversion rebuilds every
 * OpenCode 1 session from its v1 rows, deletes whatever OpenCode 2 added to it, and
 * also empties OpenCode 2's event table. Returns null when no marker is missing.
 */
export function formatOpenCodeV2MissingMarkerNotice(
    report: OpenCodeCompactionMarkerConversionReport,
): string[] | null {
    if (
        !report.migrationCompleted ||
        !report.migratedV2Schema ||
        report.unmatchedConvertedMarkers === 0
    ) {
        return null;
    }
    const lines = [
        `OpenCode 2's conversion did not carry over ${report.unmatchedConvertedMarkers} Magic Context compaction marker(s). No action is needed.`,
        "Magic Context on OpenCode 2 does not use host compaction rows: it keeps its own boundary and re-derives compartment positions from the messages that survived. OpenCode reads these sessions' full history on each turn, as it does for any Magic Context session started on OpenCode 2.",
    ];
    lines.push(
        report.postConversionMessages > 0
            ? `Do not clear kv.migration.v1-v2 to reconvert: OpenCode 2 would rebuild every converted session from its OpenCode 1 rows and delete the ${report.postConversionMessages} message(s) it added after the conversion, in ${report.postConversionSessions} session(s).`
            : "Do not clear kv.migration.v1-v2 to reconvert: OpenCode 2 would rebuild every converted session from its OpenCode 1 rows, deleting anything added on OpenCode 2 since.",
        "If you already reconverted, restore opencode.db (with its -wal and -shm files) from a backup taken before the reconversion.",
    );
    return lines;
}
