import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    readRawSessionMessageRange,
    visitRawSessionMessages,
    withRawMessageProvider,
} from "./read-session-chunk";
import {
    getRawMessagePageRowsVisitedForTest,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    type RawMessage,
    type RawMessageOrdinalAnchor,
    RawOrdinalsNotReady,
    readRawSessionMessagePageFromDb,
    readRawSessionMessageSummaryPageFromDb,
    resetRawMessagePageRowsVisitedForTest,
    scanRawSessionSummaryRows,
} from "./read-session-raw";

// Frozen first-page SQL from master: the oracle must not use the new seek.
function masterRows(db: Database, session: string, after: number, limit: number) {
    return db
        .prepare(`SELECT id, data, time_created, time_updated FROM message
        WHERE session_id = ? AND NOT (
            CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
            AND CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
        ORDER BY time_created, id LIMIT ? OFFSET ?`)
        .all(session, limit, after) as Array<{
        id: string;
        data: string;
        time_created: number;
        time_updated: number;
    }>;
}

test("keyset ranges and visitors equal OFFSET rows and filtered ordinals across timestamp ties and summaries", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "keyset-equivalence-"));
    const db = new Database(join(dir, "opencode.db"));
    try {
        db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX part_message_id_idx ON part(message_id);`);
        let random = 576;
        const next = () => {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            return random;
        };
        const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
        for (let session = 0; session < 8; session++) {
            const sid = `session-${session}`;
            db.exec("BEGIN");
            for (let i = 0; i < 340; i++) {
                const id = `${sid}-${String(i).padStart(4, "0")}`;
                const time = next() % 17;
                const summary = next() % 9 === 0;
                const data =
                    i % 43 === 0
                        ? "{"
                        : JSON.stringify({
                              role: i % 2 ? "assistant" : "user",
                              summary,
                              finish: "stop",
                          });
                insert.run(id, sid, time, i, data);
                db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
                    `p-${id}`,
                    id,
                    sid,
                    time,
                    i,
                    JSON.stringify({ type: "text", text: id }),
                );
            }
            db.exec("COMMIT");
            const count = (
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND NOT (CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1 AND CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')",
                    )
                    .get(sid) as { n: number }
            ).n;
            for (const [from, to] of [
                [1, count],
                [count - 125, count],
                [23, 247],
                [count + 1, count + 10],
            ]) {
                const old: RawMessage[] = [];
                for (let after = from - 1; after < to; ) {
                    const page = masterRows(db, sid, after, Math.min(100, to - after)).map(
                        (row, i) => {
                            let role = "unknown";
                            try {
                                role = JSON.parse(row.data).role ?? "unknown";
                            } catch {}
                            return {
                                id: row.id,
                                ordinal: after + i + 1,
                                role,
                                createdAt: row.time_created,
                                version: row.time_updated,
                                parts: [{ type: "text", text: row.id }],
                            };
                        },
                    );
                    if (!page.length) break;
                    old.push(...page);
                    after = page[page.length - 1].ordinal;
                }
                withRawMessageProvider(
                    sid,
                    {
                        readMessages: () => {
                            throw new Error("must use bounded pages");
                        },
                        readMessagePage: (ordinal, limit, watermark, after) =>
                            readRawSessionMessagePageFromDb(
                                db,
                                sid,
                                ordinal,
                                limit,
                                watermark,
                                after,
                            ),
                    },
                    () => {
                        expect(readRawSessionMessageRange(sid, from, to)).toEqual(old);
                        const visited: RawMessage[] = [];
                        visitRawSessionMessages(
                            sid,
                            from,
                            to,
                            (message) => {
                                visited.push(message);
                                return true;
                            },
                            { pageSize: 7 },
                        );
                        expect(visited).toEqual(old);
                    },
                );
                const projected: RawMessage[] = [];
                let after: RawMessageOrdinalAnchor | undefined;
                for (let ordinal = from - 1; ordinal < to; ) {
                    const page = readRawSessionMessageSummaryPageFromDb(
                        db,
                        sid,
                        ordinal,
                        11,
                        to,
                        after,
                    );
                    if (!page.length) break;
                    projected.push(...page);
                    const last = page[page.length - 1];
                    after = { id: last.id, timeCreated: last.createdAt ?? 0 };
                    ordinal = last.ordinal;
                }
                expect(projected).toEqual(old);
            }
        }
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("restarted raw pages seek warm ranks on 150k tied messages and cold pages refuse prefix scans", () => {
    const db = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX part_message_id_idx ON part(message_id);`);
        const insert = db.prepare("INSERT INTO message VALUES (?, 'large', 1, ?, ?)");
        db.transaction(() => {
            for (let i = 0; i < 150_000; i++)
                insert.run(
                    `m${String(i).padStart(6, "0")}`,
                    i,
                    i % 400 === 399
                        ? '{"summary":true,"finish":"stop"}'
                        : i % 997 === 0
                          ? "{"
                          : '{"role":"user"}',
                );
        })();
        resetRawMessagePageRowsVisitedForTest();
        expect(() => readRawSessionMessagePageFromDb(db, "large", 149_000, 100, 149_625)).toThrow(
            RawOrdinalsNotReady,
        );
        expect(getRawMessagePageRowsVisitedForTest()).toBe(0);
        expect(
            installRawSessionSummaryScan(
                db,
                "large",
                scanRawSessionSummaryRows(db, "large"),
                getRawSessionSummaryEpoch("large"),
                true,
            ),
        ).toBe(true);
        resetRawMessagePageRowsVisitedForTest();
        const page = readRawSessionMessagePageFromDb(db, "large", 149_000, 100, 149_625);
        const expected = masterRows(db, "large", 149_000, 100).map((row, i) => ({
            ordinal: 149_001 + i,
            id: row.id,
            role: "user",
            parts: [],
            createdAt: 1,
            version: row.time_updated,
        }));
        expect(Buffer.from(JSON.stringify(page))).toEqual(Buffer.from(JSON.stringify(expected)));
        const last = page.at(-1)!;
        const next = readRawSessionMessagePageFromDb(db, "large", last.ordinal, 100, 149_625, {
            id: last.id,
            timeCreated: 1,
        });
        expect(next.map((m) => m.id)).toEqual(
            masterRows(db, "large", last.ordinal, 100).map((r) => r.id),
        );
        expect(getRawMessagePageRowsVisitedForTest()).toBeLessThan(1600);
    } finally {
        db.close();
    }
});
