import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    getRawSessionTagKeysThrough,
    readRawSessionMessagePage,
    withRawMessageProvider,
} from "./read-session-chunk";
import {
    hasRawSessionMessageByIdFromDb,
    type RawMessage,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageIdOrdinalsForRangeFromDb,
    readRawSessionMessageIdOrdinalsFromDb,
} from "./read-session-raw";

describe("bounded raw reader regressions", () => {
    it("forwards the cursor through raw page and tag-key readers without changing part indexes", async () => {
        const messages: RawMessage[] = [
            {
                id: "a",
                ordinal: 1,
                createdAt: 5,
                role: "assistant",
                parts: [
                    { type: "reasoning", text: "hidden" },
                    { type: "text", text: "text" },
                ],
            },
            {
                id: "b",
                ordinal: 2,
                createdAt: 5,
                role: "user",
                parts: [{ type: "file", mime: "image/png", url: "data:large" }],
            },
        ];
        const cursors: unknown[] = [];
        await withRawMessageProvider(
            "cursor",
            {
                readMessages: () => {
                    throw new Error("unexpected full read");
                },
                readMessagePage: (ordinal, limit, _watermark, after) => {
                    cursors.push(after);
                    return messages.filter((m) => m.ordinal > ordinal).slice(0, limit);
                },
            },
            async () => {
                expect(
                    readRawSessionMessagePage("cursor", 1, 1, 2, { timeCreated: 5, id: "a" }),
                ).toEqual([messages[1]]);
                const keys = await getRawSessionTagKeysThrough("cursor", 2, {
                    pageSize: 1,
                    yieldToEventLoop: async () => {},
                });
                expect([...keys.messageFileKeys]).toEqual(["a:p1", "b:file0"]);
            },
        );
        expect(cursors).toEqual([
            { timeCreated: 5, id: "a" },
            undefined,
            { timeCreated: 5, id: "a" },
        ]);
    });

    it("hydrates only the requested id range while preserving malformed-row ordinal holes", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
                CREATE INDEX message_session_time_idx ON message(session_id, time_created, id);`);
            const insert = db.prepare("INSERT INTO message VALUES (?, 's', ?, ?)");
            for (let i = 1; i <= 1000; i++)
                insert.run(
                    `m-${String(i).padStart(4, "0")}`,
                    Math.floor(i / 4),
                    i === 999
                        ? "malformed"
                        : JSON.stringify({ role: "user", summary: i === 995, finish: "stop" }),
                );
            insert.run("numeric-summary", 1001, '{"role":"user","summary":1,"finish":"stop"}');
            insert.run("array", 1002, "[]");
            const full = readRawSessionMessageIdOrdinalsFromDb(db, "s");
            let hydratedRows = 0;
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                const stmt = prepare(sql);
                return new Proxy(stmt, {
                    get(target, property) {
                        const value = Reflect.get(target, property);
                        if (property === "all")
                            return (...args: unknown[]) => {
                                const rows = Reflect.apply(value, target, args);
                                hydratedRows += rows.length;
                                return rows;
                            };
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });
            }) as typeof db.prepare;
            const range = readRawSessionMessageIdOrdinalsForRangeFromDb(db, "s", 998, 1001);
            expect([...range]).toEqual(
                [...full].filter(([, ordinal]) => ordinal >= 998 && ordinal <= 1001),
            );
            expect(hydratedRows).toBe(4);
        } finally {
            db.close();
        }
    });

    it("checks existence without parts and excludes malformed, summary and cross-session rows", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
                INSERT INTO message VALUES ('valid', 's', 1, 1, '{"role":"user"}'),
                ('summary', 's', 2, 2, '{"role":"assistant","summary":true,"finish":"stop"}'),
                ('bad', 's', 3, 3, 'malformed'), ('array', 's', 4, 4, '[]');`);
            expect(hasRawSessionMessageByIdFromDb(db, "s", "valid")).toBe(true);
            for (const id of ["summary", "bad", "array", "absent"])
                expect(hasRawSessionMessageByIdFromDb(db, "s", id)).toBe(false);
            expect(hasRawSessionMessageByIdFromDb(db, "other", "valid")).toBe(false);
            db.exec(
                "DELETE FROM message WHERE id IN ('bad', 'array'); CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);",
            );
            expect(hasRawSessionMessageByIdFromDb(db, "s", "valid")).toBe(
                readRawSessionMessageByIdFromDb(db, "s", "valid") !== null,
            );
        } finally {
            db.close();
        }
    });
});
