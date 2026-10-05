import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    readRawSessionMessageRange,
    visitRawSessionMessages,
    withRawMessageProvider,
} from "../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../hooks/magic-context/read-session-raw";
import { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { createV2RawMessageProvider, createV2RawMessageReader } from "./hooks/store";
import { V2StoreReader } from "./store-reader";

test("v2 carried cursors preserve filtered ordinals and watermark across seq gaps", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "v2-keyset-paging-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    try {
        db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
            CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
        const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', ?, ?, 10, ?)");
        for (let i = 0; i < 400; i++) {
            insert.run(
                `m-${i}`,
                i % 7 === 0 ? "compaction" : i % 9 === 0 ? "idle" : "user",
                i * 3,
                JSON.stringify({ text: `turn ${i}` }),
            );
        }
        const reader = createV2RawMessageReader(() => new V2StoreReader(path));
        const provider = createV2RawMessageProvider(reader, "s");
        const count = provider.getMessageCount();
        for (const [from, to] of [
            [1, count],
            [count - 110, count],
            [39, 211],
        ]) {
            const expected: RawMessage[] = [];
            for (let after = from - 1; after < to; ) {
                const page = reader.readPage("s", after, 13, to);
                expected.push(...page);
                after = page[page.length - 1].ordinal;
            }
            withRawMessageProvider(
                "s",
                {
                    ...provider,
                    readMessages: () => {
                        throw new Error("bounded reads only");
                    },
                },
                () => {
                    expect(readRawSessionMessageRange("s", from, to)).toEqual(expected);
                    const visited: RawMessage[] = [];
                    visitRawSessionMessages(
                        "s",
                        from,
                        to,
                        (m) => {
                            visited.push(m);
                            return true;
                        },
                        { pageSize: 11 },
                    );
                    expect(visited).toEqual(expected);
                },
            );
        }
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
