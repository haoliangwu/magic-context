/// <reference types="bun-types" />

import { Database as UnwrappedDatabase } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
    explainQuery,
    OPENCODE1_MESSAGE_PART_SCHEMA,
} from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionOrdinalJsonRowsReadForTest,
    getRawSessionSummaryFullScansForTest,
    noteRawSessionSummaryRowWritten,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    resetRawSessionOrdinalJsonRowsReadForTest,
} from "./read-session-raw";

const SESSION = "ses-indexed-ordinal";

/** The canonical count as it was before the index-only path, kept independent of it. */
const OLD_PREFIX_COUNT = `SELECT COUNT(*) AS ordinal FROM message
    WHERE session_id = ?
      AND NOT (CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
               AND CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
      AND (time_created < ? OR (time_created = ? AND id <= ?))`;
const OLD_SESSION_COUNT = `SELECT COUNT(*) AS count FROM message
    WHERE session_id = ?
      AND NOT (CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
               AND CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')`;

function oldOrdinal(db: Database, id: string): number {
    const row = db.prepare("SELECT time_created FROM message WHERE id = ?").get(id) as {
        time_created: number;
    };
    return (
        db.prepare(OLD_PREFIX_COUNT).get(SESSION, row.time_created, row.time_created, id) as {
            ordinal: number;
        }
    ).ordinal;
}

function oldSessionCount(db: Database): number {
    return (db.prepare(OLD_SESSION_COUNT).get(SESSION) as { count: number }).count;
}

function insert(
    db: Database | UnwrappedDatabase,
    id: string,
    time: number,
    info: Record<string, unknown> = { role: "user" },
): void {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        id,
        SESSION,
        time,
        time,
        JSON.stringify(info),
    );
}

function expectOld(db: Database, id: string): void {
    const expected = oldOrdinal(db, id);
    expect({ id, point: readRawSessionMessageByIdFromDb(db, SESSION, id)?.ordinal }).toEqual({
        id,
        point: expected,
    });
    expect({ id, ordinal: readRawSessionMessageOrdinalByIdFromDb(db, SESSION, id) }).toEqual({
        id,
        ordinal: expected,
    });
}

/** About 2 KB of message JSON, as OpenCode stores assistant metadata. */
const PADDING = "x".repeat(2_000);
const id = (index: number) => `msg_${String(index).padStart(7, "0")}`;

function populate(db: Database, length: number): void {
    const statement = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    db.transaction(() => {
        for (let index = 0; index < length; index += 1) {
            statement.run(
                id(index),
                SESSION,
                Math.floor(index / 4),
                index,
                JSON.stringify(
                    index % 500 === 499
                        ? { role: "assistant", summary: true, finish: "stop", padding: PADDING }
                        : {
                              role: index % 2 ? "assistant" : "user",
                              finish: "stop",
                              padding: PADDING,
                          },
                ),
            );
        }
    })();
}

describe("index-only canonical ordinal", () => {
    it("reads JSON only for new rows and summaries after the first lookup, however long the session", () => {
        const costFor = (length: number) => {
            const db = new Database(":memory:");
            try {
                db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
                populate(db, length);
                resetRawSessionOrdinalJsonRowsReadForTest();
                expectOld(db, id(length - 2));
                // The first lookup of a session scans it once for summary rows.
                const firstScans = getRawSessionSummaryFullScansForTest();
                const statements: string[] = [];
                const prepare = db.prepare.bind(db);
                let json = 0;
                for (let step = 0; step < 5; step += 1) {
                    // Every append moves the store stamp, so each lookup recounts the prefix.
                    insert(db, id(length + step), length + step, {
                        role: "user",
                        padding: PADDING,
                    });
                    resetRawSessionOrdinalJsonRowsReadForTest();
                    db.prepare = ((sql: string) => {
                        statements.push(sql);
                        return prepare(sql);
                    }) as typeof db.prepare;
                    const ordinal = readRawSessionMessageByIdFromDb(
                        db,
                        SESSION,
                        id(length + step),
                    )?.ordinal;
                    db.prepare = prepare;
                    json += getRawSessionOrdinalJsonRowsReadForTest();
                    expect(getRawSessionSummaryFullScansForTest()).toBe(0);
                    expect(ordinal).toBe(oldOrdinal(db, id(length + step)));
                }
                // The session-wide count uses the same path.
                resetRawSessionOrdinalJsonRowsReadForTest();
                expect(countRawSessionMessageOrdinalsFromDb(db, SESSION)).toBe(oldSessionCount(db));
                const sessionCountJson = getRawSessionOrdinalJsonRowsReadForTest();
                for (const sql of statements.filter((text) => /\bFROM message\b/.test(text))) {
                    const plan = explainQuery(
                        db,
                        sql,
                        Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0),
                    ).join(" | ");
                    expect(plan).not.toMatch(/SCAN message\b/);
                    if (sql.includes("AS stored"))
                        expect(plan).toMatch(/SEARCH message USING COVERING INDEX/);
                }
                return { firstScans, json, sessionCountJson };
            } finally {
                closeQuietly(db);
            }
        };
        const short = costFor(2_000);
        const long = costFor(20_000);
        expect(short.firstScans).toBe(1);
        expect(long.firstScans).toBe(1);
        // Per lookup: the one new row and the session's summaries (4 vs 40) are
        // re-read by primary key; nothing else depends on the session length.
        expect(short.json).toBe(5 * (1 + 4));
        expect(long.json).toBe(5 * (1 + 40));
        expect(short.sessionCountJson).toBe(4);
        expect(long.sessionCountJson).toBe(40);
    });

    it("stays exact when the highest rowid is deleted and SQLite reuses it", () => {
        const db = new Database(":memory:");
        try {
            db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            // OpenCode's message table has a text primary key and no
            // AUTOINCREMENT, so a deleted top rowid is handed out again.
            const declared = db
                .prepare("SELECT sql FROM sqlite_master WHERE name = 'message'")
                .get() as { sql: string };
            expect(declared.sql).not.toMatch(/AUTOINCREMENT|WITHOUT ROWID/i);
            insert(db, "a", 10);
            insert(db, "b", 20);
            insert(db, "c", 30);
            expectOld(db, "c");
            const rowidOf = (key: string) =>
                (
                    db.prepare("SELECT rowid AS rid FROM message WHERE id = ?").get(key) as {
                        rid: number;
                    }
                ).rid;
            const topRowid = rowidOf("c");
            db.prepare("DELETE FROM message WHERE id = 'c'").run();
            // A finished summary behind the tail takes the deleted rowid.
            insert(db, "a-summary", 11, { role: "assistant", summary: true, finish: "stop" });
            expect(rowidOf("a-summary")).toBe(topRowid);
            insert(db, "d", 40);
            resetRawSessionOrdinalJsonRowsReadForTest();
            expectOld(db, "b");
            expectOld(db, "d");
            expect(getRawSessionSummaryFullScansForTest()).toBe(0);

            // Two top rows gone at once, then reused by new rows.
            db.prepare("DELETE FROM message WHERE id IN ('d', 'a-summary')").run();
            insert(db, "b-summary", 21, { role: "assistant", summary: true, finish: "stop" });
            insert(db, "e", 50);
            expectOld(db, "e");
            expectOld(db, "b");
            expect(getRawSessionSummaryFullScansForTest()).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("rescans the session once every remembered top row is gone", () => {
        const db = new Database(":memory:");
        try {
            db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            for (let index = 0; index < 400; index += 1) insert(db, id(index), index);
            expectOld(db, id(399));
            // Delete the newest 300 rows, then write new ones into their rowids.
            db.prepare("DELETE FROM message WHERE time_created >= 100").run();
            insert(db, "summary-early", 5, { role: "assistant", summary: true, finish: "stop" });
            insert(db, "late", 1000);
            resetRawSessionOrdinalJsonRowsReadForTest();
            expectOld(db, "late");
            expect(getRawSessionSummaryFullScansForTest()).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    it("sees another connection's commits, including a finished summary behind the tail", () => {
        const { dir, cleanup } = createTestTempDir("mc-indexed-ordinal-");
        const path = join(dir, "opencode-fixture.db");
        const reader = new Database(path);
        const writer = new UnwrappedDatabase(path);
        try {
            reader.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            reader.exec("PRAGMA journal_mode = WAL");
            writer.exec("PRAGMA busy_timeout = 1000");
            for (let index = 0; index < 50; index += 1) insert(writer, id(index), index);
            expectOld(reader, id(49));
            // OpenCode streams a compaction assistant: flagged at insert, finished later.
            insert(writer, "summary-open", 25, { role: "assistant", summary: true });
            insert(writer, id(50), 50);
            expectOld(reader, id(50));
            writer
                .prepare("UPDATE message SET data = ? WHERE id = 'summary-open'")
                .run(JSON.stringify({ role: "assistant", summary: true, finish: "stop" }));
            expectOld(reader, id(50));
            writer.prepare("UPDATE message SET time_created = 60 WHERE id = 'summary-open'").run();
            writer.prepare(`DELETE FROM message WHERE id = '${id(3)}'`).run();
            expectOld(reader, id(50));
            expect(countRawSessionMessageOrdinalsFromDb(reader, SESSION)).toBe(
                oldSessionCount(reader),
            );
        } finally {
            writer.close();
            reader.close();
            cleanup();
        }
    });

    it("re-reads a row Magic Context rewrote into a summary in place once it is reported", () => {
        const db = new Database(":memory:");
        try {
            db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            insert(db, "a", 10);
            insert(db, "b", 20);
            insert(db, "c", 30);
            expectOld(db, "c");
            db.prepare("UPDATE message SET data = ? WHERE id = 'b'").run(
                JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
            );
            noteRawSessionSummaryRowWritten(SESSION, "b");
            expectOld(db, "c");
            expect(readRawSessionMessageByIdFromDb(db, SESSION, "c")?.ordinal).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });
});
