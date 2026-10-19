import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import {
    clearSessionTracking,
    indexSingleMessageOffThread,
} from "../../features/magic-context/message-index-async";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getReasoningTokenEstimatesByMessage,
    getTagOwnerRowsReadForTest,
    isTagOwnerSummaryReady,
    resetTagOwnerRowsReadForTest,
    TagOwnerSummaryNotReady,
    tryGetReasoningTokenEstimatesByMessage,
} from "../../features/magic-context/storage-tags";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    getRawOrdinalWarmupFailures,
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import {
    countRawSessionMessageOrdinalsFromDb,
    RawOrdinalsNotReady,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
} from "./read-session-raw";
import { prewarmTagOwners, waitForTagOwners } from "./tag-owner-warmup";

const SESSION = "cold-session";
afterEach(() => {
    resetRawSessionOrdinalWarmupsForTest();
    _resetHarnessForTesting();
});

async function fixture(run: (db: Database) => Promise<void>) {
    const { dir, cleanup } = createTestTempDir("mc-cold-session-");
    const db = new Database(join(dir, "fixture.db"));
    try {
        db.exec("PRAGMA journal_mode=WAL");
        await run(db);
    } finally {
        db.close();
        cleanup();
    }
}

function rawSeed(db: Database, session = SESSION) {
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    db.transaction(() => {
        for (let i = 0; i < 1024; i++)
            insert.run(
                `${session}-${i}`,
                session,
                i,
                i,
                JSON.stringify({
                    role: "user",
                    padding: "x".repeat(4096),
                    ...(i % 20 === 19 ? { summary: true, finish: "stop" } : {}),
                }),
            );
    })();
}

function tagSeed(db: Database, session = SESSION) {
    const insert = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES (?, ?, 'message', 8192, ?, ?)",
    );
    db.transaction(() => {
        for (let i = 0; i < 1024; i++) insert.run(session, `${session}-${i}`, i + 1, i + 10);
    })();
}

function fullOrdinal(db: Database, session: string, time: number): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM message WHERE session_id=? AND time_created <= ? AND NOT (COALESCE(json_extract(data, '$.summary'), 0)=1 AND COALESCE(json_extract(data, '$.finish'), '')='stop')",
            )
            .get(session, time) as { n: number }
    ).n;
}

test("cold raw point, ordinal and total readers cannot execute an unbounded count", async () => {
    await fixture(async (db) => {
        db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        rawSeed(db);
        const prepare = db.prepare.bind(db);
        const statements: string[] = [];
        db.prepare = ((sql: string) => {
            statements.push(sql);
            return prepare(sql);
        }) as typeof db.prepare;
        try {
            expect(() => readRawSessionMessageByIdFromDb(db, SESSION, `${SESSION}-1022`)).toThrow(
                RawOrdinalsNotReady,
            );
            expect(() =>
                readRawSessionMessageOrdinalByIdFromDb(db, SESSION, `${SESSION}-1022`),
            ).toThrow(RawOrdinalsNotReady);
            expect(() => countRawSessionMessageOrdinalsFromDb(db, SESSION)).toThrow(
                RawOrdinalsNotReady,
            );
            expect(statements.some((sql) => sql.includes("COUNT(*)"))).toBe(false);
            const outcome = await prewarmRawSessionOrdinalsForDb(db, SESSION);
            expect({ outcome, failures: [...getRawOrdinalWarmupFailures()] }).toEqual({
                outcome: "warm",
                failures: [],
            });
            expect(readRawSessionMessageByIdFromDb(db, SESSION, `${SESSION}-1022`)?.ordinal).toBe(
                972,
            );
            expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, `${SESSION}-1022`)).toBe(
                972,
            );
            expect(countRawSessionMessageOrdinalsFromDb(db, SESSION)).toBe(973);
        } finally {
            db.prepare = prepare;
        }
    });
});

test("late first touch and invalidated checkpoint ranks match the full-count oracle", async () => {
    await fixture(async (db) => {
        db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        rawSeed(db);
        const warmed = await prewarmRawSessionOrdinalsForDb(db, SESSION);
        expect({ warmed, failures: [...getRawOrdinalWarmupFailures()] }).toEqual({
            warmed: "warm",
            failures: [],
        });
        rawSeed(db, "late");
        expect(() => readRawSessionMessageOrdinalByIdFromDb(db, "late", "late-1022")).toThrow(
            RawOrdinalsNotReady,
        );
        expect(await prewarmRawSessionOrdinalsForDb(db, "late")).toBe("warm");
        for (const session of [SESSION, "late"]) {
            expect(await prewarmRawSessionOrdinalsForDb(db, session)).toBe("warm");
            for (const time of [0, 255, 256, 511, 1022])
                expect(
                    readRawSessionMessageOrdinalByIdFromDb(db, session, `${session}-${time}`),
                ).toBe(fullOrdinal(db, session, time));
        }
        db.prepare("UPDATE message SET time_created=-1 WHERE id=?").run(`${SESSION}-1022`);
        expect(await prewarmRawSessionOrdinalsForDb(db, SESSION)).toBe("warm");
        expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, `${SESSION}-1022`)).toBe(1);
    });
});

test("cold and invalidated tag digests read no owner rows on the serving thread", async () => {
    await fixture(async (db) => {
        initializeDatabase(db);
        tagSeed(db);
        resetTagOwnerRowsReadForTest();
        expect(() => getReasoningTokenEstimatesByMessage(db, SESSION, 1)).toThrow(
            TagOwnerSummaryNotReady,
        );
        expect(tryGetReasoningTokenEstimatesByMessage(db, SESSION, 1)).toBeUndefined();
        expect(getTagOwnerRowsReadForTest()).toBe(0);
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        expect(await prewarmTagOwners(db, SESSION, 1.25)).toBe(true);
        expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
        expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get(`${SESSION}-1023`)).toBe(
            1033,
        );
        db.prepare(
            "UPDATE tags SET reasoning_token_count=3000 WHERE session_id=? AND tag_number=1",
        ).run(SESSION);
        expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(false);
        expect(getTagOwnerRowsReadForTest()).toBe(0);
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get(`${SESSION}-0`)).toBe(3000);
        tagSeed(db, "hours-later");
        expect(tryGetReasoningTokenEstimatesByMessage(db, "hours-later", 1)).toBeUndefined();
        expect(await prewarmTagOwners(db, "hours-later", 1)).toBe(true);
        expect(getTagOwnerRowsReadForTest()).toBe(0);
    });
});

test("a timed-out tag wait continues warming without substituting zero estimates", async () => {
    await fixture(async (db) => {
        initializeDatabase(db);
        tagSeed(db);
        expect(await waitForTagOwners(db, SESSION, 1, 0)).toBe(false);
        expect(tryGetReasoningTokenEstimatesByMessage(db, SESSION, 1)).toBeUndefined();
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get(`${SESSION}-0`)).toBe(10);
    });
});

test("incremental FTS COMMIT executes on the worker and persists identical source bytes", async () => {
    await fixture(async (db) => {
        initializeDatabase(db);
        const execute = db.exec.bind(db);
        const statements: string[] = [];
        db.exec = ((sql: string) => {
            statements.push(sql);
            return execute(sql);
        }) as typeof db.exec;
        const message = {
            id: "m-index",
            ordinal: 1,
            role: "user",
            parts: [{ type: "text", text: "index me ".repeat(1024) }],
        };
        expect(await indexSingleMessageOffThread(db, SESSION, message)).toBe(true);
        expect(statements.some((sql) => /COMMIT|BEGIN IMMEDIATE/.test(sql))).toBe(false);
        expect(
            db
                .prepare("SELECT message_id, content FROM message_history_fts WHERE session_id=?")
                .get(SESSION),
        ).toEqual({ message_id: message.id, content: message.parts[0].text.trim() });
        expect(await indexSingleMessageOffThread(db, SESSION, message)).toBe(false);
    });
});

test("indexing worker preserves the Pi/OMP harness identity", async () => {
    setHarness("omp");
    await fixture(async (db) => {
        initializeDatabase(db);
        expect(
            await indexSingleMessageOffThread(db, SESSION, {
                id: "omp-message",
                ordinal: 1,
                role: "user",
                parts: [{ type: "text", text: "OMP source" }],
            }),
        ).toBe(true);
        expect(
            db
                .prepare("SELECT harness FROM message_history_source WHERE session_id=?")
                .get(SESSION),
        ).toEqual({ harness: "omp" });
        expect(
            db.prepare("SELECT harness FROM message_history_index WHERE session_id=?").get(SESSION),
        ).toEqual({ harness: "omp" });
    });
});

test("session teardown cancels an indexing worker before it can revive cleared FTS rows", async () => {
    await fixture(async (db) => {
        initializeDatabase(db);
        const pending = indexSingleMessageOffThread(db, SESSION, {
            id: "cancelled",
            ordinal: 1,
            role: "user",
            parts: [{ type: "text", text: "must not return" }],
        });
        clearSessionTracking(SESSION);
        expect(await pending).toBe(false);
        expect(db.prepare("SELECT COUNT(*) AS n FROM message_history_fts").get()).toEqual({ n: 0 });
    });
});

test("large legacy ownerless sets remain servable once their worker digest is ready", async () => {
    await fixture(async (db) => {
        initializeDatabase(db);
        const insert = db.prepare(
            "INSERT INTO tags(session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'tool', 100, ?)",
        );
        db.transaction(() => {
            for (let i = 0; i < 600; i++) insert.run(SESSION, `call-${i}`, i + 1);
        })();
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
        expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).size).toBe(0);
    });
});
