/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    explainQuery,
    OPENCODE1_MESSAGE_PART_SCHEMA,
} from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    forgetRawSessionOrdinalWatermark,
    getRawSessionOrdinalRowsVisitedForTest,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    readRawSessionMessagesFromDb,
    resetRawSessionOrdinalRowsVisitedForTest,
} from "./read-session-raw";

/**
 * The two ordinal statements as they were before the watermark, copied here
 * rather than imported so the implementation cannot move both sides of the
 * comparison. The point lookup used no `json_valid` guard; the ordinal-only
 * lookup did.
 */
const FROZEN_POINT_LOOKUP_ORDINAL_SQL = `SELECT COUNT(*) AS ordinal FROM message
     WHERE session_id = ?
       AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
       AND (time_created < ? OR (time_created = ? AND id <= ?))`;

const FROZEN_ORDINAL_BY_ID_SQL = `SELECT COUNT(candidate.id) AS ordinal
     FROM message AS target
     JOIN message AS candidate
       ON candidate.session_id = target.session_id
      AND NOT (
          CASE WHEN json_valid(candidate.data) = 1
               THEN COALESCE(json_extract(candidate.data, '$.summary'), 0)
               ELSE 0 END = 1
          AND CASE WHEN json_valid(candidate.data) = 1
                   THEN COALESCE(json_extract(candidate.data, '$.finish'), '')
                   ELSE '' END = 'stop'
      )
      AND (candidate.time_created < target.time_created
           OR (candidate.time_created = target.time_created AND candidate.id <= target.id))
     WHERE target.session_id = ?
       AND target.id = ?
       AND NOT (
           CASE WHEN json_valid(target.data) = 1
                THEN COALESCE(json_extract(target.data, '$.summary'), 0)
                ELSE 0 END = 1
           AND CASE WHEN json_valid(target.data) = 1
                    THEN COALESCE(json_extract(target.data, '$.finish'), '')
                    ELSE '' END = 'stop'
       )`;

const SESSION = "ses-ordinal";

function frozenPointLookupOrdinal(db: Database, id: string): number | null {
    const row = db
        .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? AND id = ?")
        .get(SESSION, id) as { id: string; data: string; time_created: number } | null;
    if (!row) return null;
    let info: unknown;
    try {
        info = JSON.parse(row.data);
    } catch {
        return null;
    }
    if (info === null || typeof info !== "object" || Array.isArray(info)) return null;
    const record = info as { summary?: unknown; finish?: unknown };
    if (record.summary === true && record.finish === "stop") return null;
    const counted = db
        .prepare(FROZEN_POINT_LOOKUP_ORDINAL_SQL)
        .get(SESSION, row.time_created, row.time_created, row.id) as { ordinal: number };
    return counted.ordinal > 0 ? counted.ordinal : null;
}

function frozenOrdinalById(db: Database, id: string): number | null {
    const row = db.prepare(FROZEN_ORDINAL_BY_ID_SQL).get(SESSION, id) as {
        ordinal: number;
    } | null;
    return row && row.ordinal > 0 ? row.ordinal : null;
}

function createStore(): Database {
    const db = new Database(":memory:");
    db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    return db;
}

interface Store {
    db: Database;
    insert(id: string, timeCreated: number, data: Record<string, unknown>): void;
    update(id: string, data: Record<string, unknown>): void;
    remove(where: string, ...args: Array<string | number>): void;
    ids(): string[];
}

function store(db: Database): Store {
    return {
        db,
        insert(id, timeCreated, data) {
            db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                id,
                SESSION,
                timeCreated,
                timeCreated,
                JSON.stringify(data),
            );
        },
        update(id, data) {
            db.prepare("UPDATE message SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
        },
        remove(where, ...args) {
            db.prepare(`DELETE FROM message WHERE session_id = ? AND ${where}`).run(
                SESSION,
                ...args,
            );
        },
        ids() {
            return (
                db
                    .prepare(
                        "SELECT id FROM message WHERE session_id = ? ORDER BY time_created, id",
                    )
                    .all(SESSION) as Array<{ id: string }>
            ).map((row) => row.id);
        },
    };
}

/** Check every message, in an order that walks the watermark forwards and backwards. */
function expectCanonical(fixture: Store, order: "forward" | "backward" | "shuffled"): void {
    const ids = fixture.ids();
    let sequence = order === "backward" ? [...ids].reverse() : ids;
    if (order === "shuffled") {
        let seed = 0x9e3779b9;
        sequence = [...ids].sort(() => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return (seed & 1) === 0 ? -1 : 1;
        });
    }
    for (const id of sequence) {
        expect({
            id,
            ordinal: readRawSessionMessageByIdFromDb(fixture.db, SESSION, id)?.ordinal ?? null,
        }).toEqual({ id, ordinal: frozenPointLookupOrdinal(fixture.db, id) });
        expect({
            id,
            ordinal: readRawSessionMessageOrdinalByIdFromDb(fixture.db, SESSION, id),
        }).toEqual({ id, ordinal: frozenOrdinalById(fixture.db, id) });
    }
}

describe("canonical ordinal watermark", () => {
    it("matches the frozen ordinal statements through summaries, timestamp ties and reverts", () => {
        const db = createStore();
        try {
            const fixture = store(db);
            // Ids run backwards inside each shared timestamp, so ordering on either
            // column alone gives a different answer than (time_created, id).
            fixture.insert("m-04", 10, { role: "user" });
            fixture.insert("m-03", 10, { role: "assistant", finish: "stop" });
            fixture.insert("m-02", 10, { role: "user", summary: { diffs: [] } });
            fixture.insert("m-01", 10, { role: "assistant", summary: 1, finish: "stop" });
            fixture.insert("m-05", 20, { role: "assistant", summary: "true", finish: "stop" });
            fixture.insert("m-06", 20, { role: "assistant", summary: true, finish: "length" });
            db.prepare("INSERT INTO message VALUES ('other-1', 'ses-other', 15, 15, '{}')").run();
            expectCanonical(fixture, "forward");

            // A Magic Context compaction marker is written behind the tail, at the
            // boundary's time + 1. It never bears an ordinal.
            fixture.insert("m-00-marker", 11, { role: "assistant", summary: true, finish: "stop" });
            fixture.insert("m-07", 30, { role: "user" });
            expectCanonical(fixture, "backward");

            // OpenCode's own compaction streams a summary before it finishes: it
            // bears an ordinal while open and loses it when it finishes.
            fixture.insert("m-08-summary", 40, { role: "assistant", summary: true });
            fixture.insert("m-09", 41, { role: "user" });
            expectCanonical(fixture, "forward");
            fixture.update("m-08-summary", { role: "assistant", summary: true, finish: "stop" });
            fixture.insert("m-10", 42, { role: "assistant", finish: "stop" });
            expectCanonical(fixture, "forward");
            expectCanonical(fixture, "shuffled");

            // A revert deletes the suffix, including the latest watermark, and new
            // messages follow. No removal event is needed when the watermark itself
            // is gone.
            fixture.remove("time_created >= ?", 30);
            fixture.insert("m-11", 50, { role: "user" });
            fixture.insert("m-12", 50, { role: "assistant", finish: "stop" });
            expectCanonical(fixture, "forward");

            // A removal before a surviving watermark is announced by message.removed.
            fixture.remove("id = ?", "m-03");
            forgetRawSessionOrdinalWatermark(SESSION);
            expectCanonical(fixture, "forward");
            expectCanonical(fixture, "shuffled");
        } finally {
            closeQuietly(db);
        }
    });

    it("agrees with the full reader on an OpenCode-shaped session", () => {
        const db = createStore();
        try {
            const fixture = store(db);
            for (let index = 0; index < 300; index += 1) {
                const time = 1_000 + Math.floor(index / 3);
                const id = `msg_${String(1_000 - index).padStart(5, "0")}`;
                const marker = index % 50 === 49;
                fixture.insert(
                    id,
                    time,
                    marker
                        ? { role: "assistant", summary: true, finish: "stop" }
                        : { role: index % 2 === 0 ? "user" : "assistant", finish: "stop" },
                );
            }
            const full = new Map(
                readRawSessionMessagesFromDb(db, SESSION).map((message) => [
                    message.id,
                    message.ordinal,
                ]),
            );
            for (const id of fixture.ids().reverse()) {
                expect(readRawSessionMessageByIdFromDb(db, SESSION, id)?.ordinal ?? null).toBe(
                    full.get(id) ?? null,
                );
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("counts malformed rows the way the full reader and the ordinal lookup always did", () => {
        const db = createStore();
        try {
            const fixture = store(db);
            fixture.insert("m-1", 1, { role: "user" });
            db.prepare(`INSERT INTO message VALUES ('m-2', ?, 2, 2, '{not json')`).run(SESSION);
            fixture.insert("m-3", 3, { role: "assistant", finish: "stop" });
            expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, "m-3")).toBe(
                frozenOrdinalById(db, "m-3"),
            );
            expect(readRawSessionMessageByIdFromDb(db, SESSION, "m-3")?.ordinal).toBe(3);
            expect(readRawSessionMessagesFromDb(db, SESSION).at(-1)?.ordinal).toBe(3);
        } finally {
            closeQuietly(db);
        }
    });

    it("reuses a proven count only while the store is unchanged, and recounts after any write", () => {
        const visitedFor = (sessionLength: number): { unchanged: number; afterWrite: number } => {
            const db = createStore();
            try {
                const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
                const id = (index: number) => `msg_${String(index).padStart(7, "0")}`;
                db.transaction(() => {
                    for (let index = 0; index < sessionLength + 3; index += 1) {
                        insert.run(
                            id(index),
                            SESSION,
                            index,
                            index,
                            JSON.stringify({
                                role: index % 2 === 0 ? "user" : "assistant",
                                summary: index % 997 === 0 ? true : undefined,
                                finish: "stop",
                            }),
                        );
                    }
                })();
                // First lookup counts the prefix once and leaves a watermark.
                readRawSessionMessageByIdFromDb(db, SESSION, id(sessionLength - 1));
                const appended = id(sessionLength + 2);
                const statements: string[] = [];
                const prepare = db.prepare.bind(db);
                db.prepare = ((sql: string) => {
                    statements.push(sql);
                    return prepare(sql);
                }) as typeof db.prepare;
                resetRawSessionOrdinalRowsVisitedForTest();
                const message = readRawSessionMessageByIdFromDb(db, SESSION, appended);
                const unchanged = getRawSessionOrdinalRowsVisitedForTest();
                db.prepare = prepare;
                expect(message?.ordinal).toBe(frozenPointLookupOrdinal(db, appended));
                // Every message statement must seek an index, never scan the table.
                for (const sql of statements.filter((text) => /\bFROM message\b/.test(text))) {
                    const plan = explainQuery(
                        db,
                        sql,
                        Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0),
                    ).join(" | ");
                    expect(plan).not.toMatch(/SCAN message\b/);
                }
                // Any write, even one after the target, moves the store stamp.
                insert.run(id(sessionLength + 3), SESSION, sessionLength + 3, 0, "{}");
                resetRawSessionOrdinalRowsVisitedForTest();
                expect(readRawSessionMessageByIdFromDb(db, SESSION, appended)?.ordinal).toBe(
                    frozenPointLookupOrdinal(db, appended),
                );
                return { unchanged, afterWrite: getRawSessionOrdinalRowsVisitedForTest() };
            } finally {
                closeQuietly(db);
            }
        };
        const short = visitedFor(2_000);
        const long = visitedFor(40_000);
        // Unchanged store: only the three rows after the watermark.
        expect(short.unchanged).toBe(3);
        expect(long.unchanged).toBe(3);
        // After a write: the whole prefix through the target.
        expect(short.afterWrite).toBe(2_003);
        expect(long.afterWrite).toBe(40_003);
    });
});
