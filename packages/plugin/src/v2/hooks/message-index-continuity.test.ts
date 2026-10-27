import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
    getLastIndexedOrdinal,
    indexMessagesAfterOrdinal,
} from "../../features/magic-context/message-index";
import {
    __resetMessageIndexAsyncForTests,
    getMessageIndexQueueHeapStats,
} from "../../features/magic-context/message-index-async";
import { runMigrations } from "../../features/magic-context/migrations";
import { searchMessageHistory } from "../../features/magic-context/search";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { createTransform } from "../../hooks/magic-context/transform";
import { setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { renderSearchArchive } from "../../tools/ctx-expand/search-archive";
import { V2StoreReader } from "../store-reader";
import { createHostSeams } from "./context";
import { createV2RawMessageReader, readAllV2RawMessagesForConversion } from "./store";
import type { V2Context } from "./types";

afterEach(() => {
    __resetMessageIndexAsyncForTests();
    setBootQuietPeriodForTests(null);
});

test("OpenCode 2 indexes messages after the rebase and after an earlier reconciliation", async () => {
    const root = createTestTempDir("v2-index-continuity-");
    const path = join(root.dir, "host.db");
    const host = new Database(path);
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    setBootQuietPeriodForTests(null);
    const sessionId = "ses-index-continuity";
    getOrCreateSessionMeta(db, sessionId);
    db.prepare(
        "UPDATE session_meta SET harness = 'opencode', coordinate_generation = 'v1' WHERE session_id = ?",
    ).run(sessionId);
    host.exec(`CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, data TEXT);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
    const append = (seq: number, text: string, type = "user") =>
        host
            .prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)")
            .run(`m-${seq}`, sessionId, type, seq, seq, JSON.stringify({ text }));
    const open = () => new V2StoreReader(path);
    const source = createV2RawMessageReader(open);
    const pages = spyOn(source, "readPage");
    const fullCounts = spyOn(source, "getCount");
    const deltaCounts = spyOn(source, "getCountAfterRevision");
    const raw = () => readAllV2RawMessagesForConversion(open, sessionId);
    const transform = createTransform({
        ...createHostSeams({} as V2Context, raw, source, new Map()),
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        historianRunnable: false,
        protectedTokens: 0,
        storeGeneration: "v2",
    });
    const pass = () =>
        transform(
            {},
            {
                messages: [
                    {
                        info: { id: "live-user", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "continue" }],
                    },
                ],
            },
        );
    const settled = async () => {
        await Bun.sleep(30);
        for (let i = 0; getMessageIndexQueueHeapStats().queueLength > 0 && i < 500; i++)
            await Bun.sleep(10);
    };
    try {
        indexMessagesAfterOrdinal(
            db,
            sessionId,
            [
                {
                    id: "v1-old",
                    ordinal: 1,
                    role: "user",
                    parts: [{ type: "text", text: "v1 projection" }],
                },
            ],
            0,
            1,
        );
        append(1, "before rebase");
        await pass();
        await settled();
        expect(getLastIndexedOrdinal(db, sessionId)).toBe(1);
        append(2, "instruction update", "system");
        append(3, "postrebaseneedle newly written searchable message");
        await pass();
        await settled();
        expect(getLastIndexedOrdinal(db, sessionId)).toBe(3);
        const hits = searchMessageHistory(db, {
            sessionId,
            query: "postrebaseneedle",
            probes: ["postrebaseneedle"],
            limit: 5,
            collectDiagnostics: false,
            dateRange: null,
        });
        expect(hits.results.map((hit) => hit.messageId)).toEqual(["m-3"]);
        expect(renderSearchArchive(db, sessionId, 3, 3, 1000, true)).toContain(
            "[3] U: postrebaseneedle newly written searchable message",
        );
        append(4, "after another reconciliation");
        await pass();
        await settled();
        expect(getLastIndexedOrdinal(db, sessionId)).toBe(4);
        expect(fullCounts).not.toHaveBeenCalled();
        expect(deltaCounts.mock.calls).toEqual([
            [sessionId, -1, 1],
            [sessionId, 1, 3],
            [sessionId, 3, 4],
        ]);
        expect(pages.mock.calls.at(-1)?.[4]?.id).toBe("m-3");
        const pageCount = pages.mock.calls.length;
        await pass();
        await settled();
        expect(pages.mock.calls.length).toBe(pageCount);
        expect(deltaCounts).toHaveBeenCalledTimes(3);

        append(5, "checkpoint", "compaction");
        await pass();
        await settled();
        expect(getLastIndexedOrdinal(db, sessionId)).toBe(4);
        expect(pages.mock.calls.length).toBe(pageCount);
        append(6, "postcompactionneedle raw ordinal excludes the checkpoint");
        await pass();
        await settled();
        expect(getLastIndexedOrdinal(db, sessionId)).toBe(5);
        expect(
            searchMessageHistory(db, {
                sessionId,
                query: "postcompactionneedle",
                probes: ["postcompactionneedle"],
                limit: 5,
                collectDiagnostics: false,
                dateRange: null,
            }).results.map((hit) => [hit.messageId, hit.messageOrdinal]),
        ).toEqual([["m-6", 5]]);
    } finally {
        await settled();
        host.close();
        db.close();
        root.cleanup();
    }
});
