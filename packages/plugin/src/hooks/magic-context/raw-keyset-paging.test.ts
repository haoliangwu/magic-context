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
    type RawMessage,
    type RawMessageOrdinalAnchor,
    readRawSessionMessagePageFromDb,
    readRawSessionMessageSummaryPageFromDb,
} from "./read-session-raw";

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
                    const page = readRawSessionMessagePageFromDb(
                        db,
                        sid,
                        after,
                        Math.min(100, to - after),
                        to,
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
