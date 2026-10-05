import { describe, expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    checkOpenCodeCompactionMarkerConversion,
    formatOpenCodeCompactionMarkerConversion,
    formatOpenCodeV2MissingMarkerNotice,
} from "./doctor-compaction-markers";

function convertedStoreFixture(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER,
            time_updated INTEGER,
            data TEXT NOT NULL
        );
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
        CREATE TABLE session_message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            time_created INTEGER,
            data TEXT NOT NULL
        );
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insert = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses-1', 1, 1, ?)",
    );
    insert.run(
        "mc-summary",
        JSON.stringify({
            role: "assistant",
            parentID: "mc-boundary",
            summary: true,
            finish: "stop",
            providerID: "magic-context",
            time: { created: 101 },
        }),
    );
    insert.run(
        "native-summary",
        JSON.stringify({
            role: "assistant",
            parentID: "native-boundary",
            summary: true,
            finish: "stop",
            providerID: "openai",
            time: { created: 200, completed: 250 },
        }),
    );
    insert.run(
        "mc-non-summary",
        JSON.stringify({
            role: "assistant",
            providerID: "magic-context",
            time: { created: 300 },
        }),
    );
    db.prepare("INSERT INTO session_v2 (id) VALUES ('ses-1')").run();
    db.prepare("INSERT INTO kv (key, value) VALUES ('migration.v1-v2', ?)").run(
        JSON.stringify({ phase: "completed" }),
    );
    return db;
}

function messageData(db: Database, id: string): Record<string, unknown> {
    const row = db.prepare("SELECT data FROM message WHERE id = ?").get(id) as { data: string };
    return JSON.parse(row.data) as Record<string, unknown>;
}

describe("doctor OpenCode compaction-marker conversion check", () => {
    it("reports read-only counts, repairs only MC summaries, and detects stale v2 conversion", () => {
        const db = convertedStoreFixture();
        try {
            const before = checkOpenCodeCompactionMarkerConversion(db);
            expect(before).toEqual({
                missingBefore: 1,
                missingAfter: 1,
                repaired: 0,
                migrationCompleted: true,
                migratedV2Schema: true,
                unmatchedConvertedMarkers: 1,
                postConversionMessages: 0,
                postConversionSessions: 0,
            });
            expect(formatOpenCodeCompactionMarkerConversion(before)).toContain(
                "before=1 missing time.completed; after=1",
            );
            expect(messageData(db, "mc-summary")).toMatchObject({ time: { created: 101 } });

            const fixed = checkOpenCodeCompactionMarkerConversion(db, { fix: true });
            expect(fixed.missingBefore).toBe(1);
            expect(fixed.missingAfter).toBe(0);
            expect(fixed.repaired).toBe(1);
            expect(messageData(db, "mc-summary")).toMatchObject({
                time: { created: 101, completed: 101 },
            });
            expect(messageData(db, "native-summary")).toMatchObject({
                time: { created: 200, completed: 250 },
            });
            expect(messageData(db, "mc-non-summary")).toMatchObject({ time: { created: 300 } });

            db.prepare(
                "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('mc-boundary', 'ses-1', 'compaction', 0, '{}')",
            ).run();
            const converted = checkOpenCodeCompactionMarkerConversion(db);
            expect(converted.unmatchedConvertedMarkers).toBe(0);
        } finally {
            db.close();
        }
    });

    it("never offers reconversion when OpenCode 2 added messages after the conversion", () => {
        const db = convertedStoreFixture();
        try {
            // OpenCode 2's converter rebuilds every OpenCode 1 session from its v1 rows
            // and deletes the session's session_message rows first, so a row that only
            // exists in v2 would be lost. Converted rows keep their v1 time_created.
            db.exec(`
                CREATE TABLE session (id TEXT PRIMARY KEY);
                INSERT INTO session (id) VALUES ('ses-1'), ('ses-untouched');
                INSERT INTO message (id, session_id, time_created, time_updated, data)
                    VALUES ('v1-user', 'ses-untouched', 7, 7, '{"role":"user"}');
                INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES
                    ('mc-summary', 'ses-1', 'assistant', 0, 1, '{}'),
                    ('v1-user', 'ses-untouched', 'user', 0, 7, '{}'),
                    ('v2-user', 'ses-1', 'user', 1, 5000, '{}'),
                    ('v2-assistant', 'ses-1', 'assistant', 2, 5001, '{}');
            `);
            const report = checkOpenCodeCompactionMarkerConversion(db);
            expect(report.unmatchedConvertedMarkers).toBe(1);
            expect(report.postConversionMessages).toBe(2);
            expect(report.postConversionSessions).toBe(1);

            const notice = formatOpenCodeV2MissingMarkerNotice(report)?.join("\n") ?? "";
            expect(notice).toContain("No action is needed");
            expect(notice).toContain("Do not clear kv.migration.v1-v2");
            expect(notice).toContain("delete the 2 message(s)");
            expect(notice).not.toContain("DELETE FROM kv");
        } finally {
            db.close();
        }
    });

    it("reports a missing converted marker as informational and never prints a reconversion command", () => {
        const db = convertedStoreFixture();
        try {
            const report = checkOpenCodeCompactionMarkerConversion(db);
            expect(report.postConversionMessages).toBe(0);
            const notice = formatOpenCodeV2MissingMarkerNotice(report)?.join("\n") ?? "";
            expect(notice).toContain("did not carry over 1 Magic Context compaction marker(s)");
            expect(notice).toContain("No action is needed");
            expect(notice).toContain("Do not clear kv.migration.v1-v2");
            expect(notice).not.toContain("DELETE FROM kv");
            expect(notice).not.toContain("opencode serve");
            expect(notice).not.toContain("INSERT INTO session_message");

            db.prepare(
                "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('mc-boundary', 'ses-1', 'compaction', 0, '{}')",
            ).run();
            expect(
                formatOpenCodeV2MissingMarkerNotice(checkOpenCodeCompactionMarkerConversion(db)),
            ).toBeNull();
        } finally {
            db.close();
        }
    });
});
