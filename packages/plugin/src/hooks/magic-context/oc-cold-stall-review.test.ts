/// <reference types="bun-types" />

import { Database as NativeDatabase } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { getDirtyIndexFloor } from "../../features/magic-context/message-index";
import { indexSingleMessageOffThread } from "../../features/magic-context/message-index-async";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addRemovedReasoningIds,
    getReasoningRemovalState,
} from "../../features/magic-context/storage-reasoning-removal";
import { getReasoningTokenEstimatesByMessage } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { Database, withSqliteTransformPass } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    countRawSessionMessageOrdinalsFromDb,
    forgetRawSessionSummaryRows,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
} from "./read-session-raw";
import type { MessageLike } from "./tag-messages";
import * as tagWarmup from "./tag-owner-warmup";
import { createTransform } from "./transform";
import { runPostTransformPhase } from "./transform-postprocess-phase";

// Opt in to defect witnesses; these assertions describe the intended contract, not current behavior.
const review = process.env.MC_OC_COLD_STALL_REVIEW === "1" ? describe : describe.skip;

type PostArgs = Parameters<typeof runPostTransformPhase>[0];

function postArgs(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostArgs> = {},
): PostArgs {
    return {
        sessionId,
        db,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(messages.map((message, i) => [message, i + 1])),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        todowriteAvailability: { callable: true, frozen: true },
        batch: null,
        contextUsage: { percentage: 60, inputTokens: 6000 },
        usableWindow: 128_000,
        schedulerDecision: "execute",
        schedulerDeferReason: null,
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: "turn",
        pendingMaterializationSessions: new Set([sessionId]),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTagIds: new Set(),
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        protectedCount: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        resolvedProviderID: "openai",
        keepReasoningTokens: 0,
        ...overrides,
    };
}

review("cold stall independent review", () => {
    test.skipIf(!process.env.MC_OC_COLD_STALL_BASE_ROOT)(
        "served bytes match the base through defer execute flush HARD restart and late cold touch",
        async () => {
            const { dir, cleanup } = createTestTempDir("mc-cold-review-differential-");
            const previous = process.env.OPENCODE_DB;
            process.env.OPENCODE_DB = join(dir, "opencode-fixture.db");
            const rawDb = new Database(process.env.OPENCODE_DB);
            const clock = spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
            try {
                rawDb.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
                const sessions = ["differential-main", "differential-late"];
                const source = (session: string, model = "claude-opus-4-6"): MessageLike[] => {
                    const messages = [];
                    for (let turn = 0; turn < 10; turn++) {
                        messages.push({
                            info: { id: `user-${turn}`, role: "user", sessionID: session },
                            parts: [{ type: "text", text: `Review invariant ${turn}.` }],
                        });
                        messages.push({
                            info: {
                                id: `assistant-${turn}`,
                                role: "assistant",
                                sessionID: session,
                                providerID: "anthropic",
                                modelID: model,
                                finish: "stop",
                                tokens: { reasoning: 100 },
                            },
                            parts: [
                                {
                                    type: "reasoning",
                                    text: `Reasoning ${turn}: ${"Preserve the public input contract. ".repeat(30)}`,
                                },
                                { type: "text", text: `Answer ${turn}.` },
                            ],
                        });
                    }
                    messages.push({
                        info: {
                            id: "latest-user",
                            role: "user",
                            sessionID: session,
                            model: { providerID: "anthropic", modelID: model },
                        },
                        parts: [{ type: "text", text: "Summarize." }],
                    });
                    return messages as unknown as MessageLike[];
                };
                for (const session of sessions)
                    for (const [i, message] of source(session).entries()) {
                        const id = `${session}-${message.info.id}`;
                        rawDb
                            .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
                            .run(id, session, i, i, JSON.stringify({ ...message.info, id }));
                    }
                const capture = async (root: string | undefined, name: string) => {
                    const url = (path: string) =>
                        root
                            ? pathToFileURL(join(root, "packages/plugin/src", path)).href
                            : new URL(`../../${path}`, import.meta.url).href;
                    const [
                        sqlite,
                        storage,
                        storageDb,
                        migrations,
                        tagger,
                        transforms,
                        rawReader,
                        logger,
                    ] = await Promise.all([
                        import(url("shared/sqlite.ts")),
                        import(url("features/magic-context/storage.ts")),
                        import(url("features/magic-context/storage-db.ts")),
                        import(url("features/magic-context/migrations.ts")),
                        import(url("features/magic-context/tagger.ts")),
                        import(url("hooks/magic-context/transform.ts")),
                        import(url("hooks/magic-context/read-session-db.ts")),
                        import(url("shared/logger.ts")),
                    ]);
                    const dbPath = join(dir, `${name}-context.db`);
                    let db = new sqlite.Database(dbPath);
                    const captures: string[] = [];
                    let decision: "execute" | "defer" = "defer";
                    let model = "claude-opus-4-6";
                    const materialize = new Set<string>();
                    const usage = new Map();
                    const liveModels = new Map();
                    let folds = 0;
                    const log = spyOn(logger, "sessionLog").mockImplementation(
                        (_id: string, ...values: unknown[]) => {
                            if (values.join(" ").includes("reason=model_change executed=true"))
                                folds++;
                        },
                    );
                    const makeTransform = () =>
                        transforms.createTransform({
                            db,
                            tagger: tagger.createTagger(),
                            scheduler: { shouldExecute: () => decision },
                            contextUsageMap: usage,
                            liveModelBySession: liveModels,
                            protectedTokens: 1000,
                            keepReasoningTokens: 300,
                            historyRefreshSessions: new Set(),
                            pendingMaterializationSessions: materialize,
                            lastHeuristicsTurnId: new Map(),
                            historianRunnable: false,
                            projectPath: join(dir, "project"),
                            directory: join(dir, "project"),
                        });
                    let transform = makeTransform();
                    const pass = async (session = sessions[0]) => {
                        liveModels.set(session, { providerID: "anthropic", modelID: model });
                        usage.set(session, {
                            usage: { percentage: 76, inputTokens: 76000 },
                            updatedAt: Date.now(),
                            hasUsageTokens: true,
                        });
                        const messages = source(session, model);
                        for (const message of messages)
                            message.info.id = `${session}-${message.info.id}`;
                        await transform({}, { messages });
                        const bytes = JSON.stringify(messages);
                        captures.push(bytes);
                        return bytes;
                    };
                    try {
                        storageDb.initializeDatabase(db);
                        migrations.runMigrations(db);
                        storage.getOrCreateSessionMeta(db, sessions[0]);
                        await pass(); // Cold first pass with no earlier reasoning cutoff.
                        await pass(); // Pure defer.
                        decision = "execute";
                        materialize.add(sessions[0]);
                        await pass();
                        decision = "defer";
                        const replay = await pass();
                        expect(replay).toBe(captures[2]);
                        materialize.add(sessions[0]);
                        await pass(); // Explicit flush on defer.
                        model = "claude-sonnet-4-6";
                        // Changing the model changes provider cache identity and forces a HARD m[0]/m[1] fold.
                        await pass();
                        expect(folds).toBeGreaterThan(0);
                        db.close();
                        rawReader.closeReadOnlySessionDb();
                        db = new sqlite.Database(dbPath);
                        transform = makeTransform();
                        await pass(); // Restart with persisted decisions but cold in-process caches.
                        clock.mockReturnValue(1_700_021_700_000);
                        await pass(sessions[1]); // A newly touched session six hours after startup.
                        expect(captures.some((bytes) => !bytes.includes("Reasoning 0:"))).toBe(
                            true,
                        );
                        expect(
                            storage.getOrCreateSessionMeta(db, sessions[0])
                                .clearedReasoningThroughTag,
                        ).toBeGreaterThan(0);
                        return captures;
                    } finally {
                        log.mockRestore();
                        rawReader.closeReadOnlySessionDb();
                        db.close();
                    }
                };
                const base = await capture(process.env.MC_OC_COLD_STALL_BASE_ROOT, "base");
                clock.mockReturnValue(1_700_000_100_000);
                const current = await capture(undefined, "current");
                expect(current).toEqual(base);
                console.log(
                    `Differential: ${current.length} byte-identical served passes against 881fa020; JSON byte lengths ${current.map((bytes) => Buffer.byteLength(bytes)).join(", ")}`,
                );
            } finally {
                clock.mockRestore();
                resetRawSessionOrdinalWarmupsForTest();
                closeReadOnlySessionDb();
                rawDb.close();
                if (previous === undefined) delete process.env.OPENCODE_DB;
                else process.env.OPENCODE_DB = previous;
                cleanup();
            }
        },
        60_000,
    );

    test("cold first cleanup selects nothing and warm cleanup matches the full cutoff", async () => {
        const { dir, cleanup } = createTestTempDir("mc-cold-review-cutoff-");
        const previous = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = join(dir, "absent-opencode.db");
        const db = new Database(join(dir, "context.db"));
        const full = new Database(":memory:");
        let wait: ReturnType<typeof spyOn> | undefined;
        try {
            initializeDatabase(db);
            initializeDatabase(full);
            const source = [
                {
                    info: { id: "old", role: "assistant" },
                    parts: [
                        { type: "reasoning", text: "Old chain of thought." },
                        { type: "text", text: "Old answer." },
                    ],
                },
                {
                    info: { id: "recent", role: "assistant" },
                    parts: [{ type: "text", text: "Current answer." }],
                },
            ] as MessageLike[];
            const cold = structuredClone(source);
            wait = spyOn(tagWarmup, "waitForTagOwners").mockResolvedValue(false);
            await runPostTransformPhase(postArgs(db, "first-cold-cleanup", cold));
            expect(JSON.stringify(cold)).toBe(JSON.stringify(source));
            expect(getReasoningRemovalState(db, "first-cold-cleanup").messageIds.size).toBe(0);
            wait.mockRestore();
            wait = undefined;
            expect(await tagWarmup.prewarmTagOwners(db, "first-cold-cleanup", 1)).toBe(true);
            const warm = structuredClone(source);
            const oracle = structuredClone(source);
            await runPostTransformPhase(postArgs(db, "first-cold-cleanup", warm));
            await runPostTransformPhase(postArgs(full, "first-cold-cleanup", oracle));
            expect(warm[0].parts).toEqual([{ type: "text", text: "Old answer." }]);
            expect(JSON.stringify(warm)).toBe(JSON.stringify(oracle));
            const coldReplay = structuredClone(source);
            const coldDb = new Database(join(dir, "context.db"));
            try {
                await runPostTransformPhase(
                    postArgs(coldDb, "first-cold-cleanup", coldReplay, {
                        schedulerDecision: "defer",
                        pendingMaterializationSessions: new Set(),
                    }),
                );
                expect(JSON.stringify(coldReplay)).toBe(JSON.stringify(warm));
            } finally {
                coldDb.close();
            }
        } finally {
            wait?.mockRestore();
            db.close();
            full.close();
            closeReadOnlySessionDb();
            if (previous === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previous;
            cleanup();
        }
    });

    test("a cold owner wait replays reasoning removals committed by a peer before serving", async () => {
        const { dir, cleanup } = createTestTempDir("mc-cold-review-reasoning-peer-");
        const previous = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = join(dir, "absent-opencode.db");
        const path = join(dir, "context.db");
        const db = new Database(path);
        let peer: Database | undefined;
        let wait: ReturnType<typeof spyOn> | undefined;
        try {
            initializeDatabase(db);
            const session = "reasoning-peer";
            const messages = [
                {
                    info: { id: "old", role: "assistant" },
                    parts: [
                        { type: "reasoning", text: "Previously removed private chain of thought." },
                        { type: "text", text: "Keep this answer." },
                    ],
                },
                {
                    info: { id: "new", role: "assistant" },
                    parts: [{ type: "text", text: "Current answer." }],
                },
            ] as MessageLike[];
            const args = postArgs(db, session, messages);
            peer = new Database(path);
            // Model a peer committing while the real postprocess path awaits a slow owner worker.
            wait = spyOn(tagWarmup, "waitForTagOwners").mockImplementation(async () => {
                expect(addRemovedReasoningIds(peer!, session, ["old"])).toBe(true);
                return false;
            });
            await runPostTransformPhase(args);
            expect(wait).toHaveBeenCalledTimes(1);
            expect([...getReasoningRemovalState(db, session).messageIds]).toContain("old");
            const racingBytes = JSON.stringify(messages);
            const replay = structuredClone([
                {
                    info: { id: "old", role: "assistant" },
                    parts: [
                        { type: "reasoning", text: "Previously removed private chain of thought." },
                        { type: "text", text: "Keep this answer." },
                    ],
                },
                {
                    info: { id: "new", role: "assistant" },
                    parts: [{ type: "text", text: "Current answer." }],
                },
            ] as MessageLike[]);
            await runPostTransformPhase(
                postArgs(db, session, replay, {
                    schedulerDecision: "defer",
                    pendingMaterializationSessions: new Set(),
                }),
            );
            expect(replay[0].parts).toEqual([{ type: "text", text: "Keep this answer." }]);
            expect(racingBytes).toBe(JSON.stringify(replay));
        } finally {
            wait?.mockRestore();
            peer?.close();
            db.close();
            closeReadOnlySessionDb();
            if (previous === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previous;
            cleanup();
        }
    });
    test("cold first turn with no persisted boundary remains servable while ordinal preparation reports unavailable", async () => {
        const { dir, cleanup } = createTestTempDir("mc-cold-review-first-turn-");
        const previous = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = join(dir, "opencode-fixture.db");
        const rawDb = new Database(process.env.OPENCODE_DB);
        const db = new Database(":memory:");
        try {
            rawDb.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            const session = "cold-first-turn";
            const insert = rawDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
            rawDb.transaction(() => {
                for (let i = 0; i < 1024; i++)
                    insert.run(`m-${String(i).padStart(4, "0")}`, session, i, i, '{"role":"user"}');
            })();
            initializeDatabase(db);
            runMigrations(db);
            getOrCreateSessionMeta(db, session);
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: { shouldExecute: () => "defer" },
                contextUsageMap: new Map(),
                protectedTokens: 1000,
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                historianRunnable: false,
                hostPrepareRawOrdinals: async () => false,
            });
            const messages: MessageLike[] = [
                {
                    info: { id: "m-1023", role: "user", sessionID: session },
                    parts: [{ type: "text", text: "A new request on an existing cold session." }],
                },
            ];
            await expect(transform({}, { messages })).resolves.toBeUndefined();
        } finally {
            resetRawSessionOrdinalWarmupsForTest();
            closeReadOnlySessionDb();
            rawDb.close();
            db.close();
            if (previous === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previous;
            cleanup();
        }
    });
    test("incremental indexing worker does not make a concurrent foreground turn refuse with SQLITE_BUSY", async () => {
        const { dir, cleanup } = createTestTempDir("mc-cold-review-writer-");
        const previous = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = join(dir, "absent-opencode.db");
        const db = new Database(join(dir, "context.db"));
        let pending: Promise<boolean> | undefined;
        try {
            initializeDatabase(db);
            runMigrations(db);
            pending = indexSingleMessageOffThread(db, "indexing-session", {
                id: "long-message",
                ordinal: 1,
                role: "user",
                parts: [{ type: "text", text: "semaphore ".repeat(6_000_000) }],
            });
            const deadline = performance.now() + 15_000;
            while (
                getDirtyIndexFloor(db, "indexing-session") === null &&
                performance.now() < deadline
            )
                await new Promise<void>((resolve) => setImmediate(resolve));
            expect(getDirtyIndexFloor(db, "indexing-session")).toBe(1);
            const probe = new NativeDatabase(join(dir, "context.db"));
            let locked = false;
            try {
                probe.exec("PRAGMA busy_timeout=0");
                while (!locked && performance.now() < deadline) {
                    try {
                        probe.exec("BEGIN IMMEDIATE");
                        probe.exec("ROLLBACK");
                    } catch (error) {
                        if (!/locked|busy/i.test(String(error))) throw error;
                        locked = true;
                    }
                    if (!locked) await new Promise<void>((resolve) => setImmediate(resolve));
                }
            } finally {
                probe.close();
            }
            expect(locked).toBe(true);
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: { shouldExecute: () => "defer" },
                contextUsageMap: new Map(),
                protectedTokens: 1000,
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                historianRunnable: false,
                hostPrepareRawOrdinals: async () => true,
            });
            const messages: MessageLike[] = [
                {
                    info: { id: "new-user", role: "user", sessionID: "foreground-session" },
                    parts: [
                        {
                            type: "text",
                            text: "Continue the turn while incremental indexing commits.",
                        },
                    ],
                },
            ];
            await withSqliteTransformPass(() => transform({}, { messages }));
            expect(messages.some((message) => message.info.id === "new-user")).toBe(true);
        } finally {
            await pending?.catch(() => {});
            resetRawSessionOrdinalWarmupsForTest();
            closeReadOnlySessionDb();
            db.close();
            if (previous === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previous;
            cleanup();
        }
    }, 30_000);

    test("in-memory owner digest includes every tag after an append larger than its page limit", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const insert = db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES ('large-append', ?, 'message', 100, ?, 100)",
            );
            insert.run("old", 1);
            expect(getReasoningTokenEstimatesByMessage(db, "large-append", 1).size).toBe(1);
            db.transaction(() => {
                for (let i = 2; i <= 601; i++) insert.run(`message-${i}`, i);
            })();
            const full = (
                db
                    .prepare(
                        "SELECT COUNT(DISTINCT message_id) AS n FROM tags WHERE session_id='large-append'",
                    )
                    .get() as { n: number }
            ).n;
            expect(getReasoningTokenEstimatesByMessage(db, "large-append", 1).size).toBe(full);
        } finally {
            db.close();
        }
    });

    test("file worker rewarm excludes a finished summary moved into a warm large session", async () => {
        const { dir, cleanup } = createTestTempDir("mc-cold-review-ordinal-");
        const path = join(dir, "opencode-fixture.db");
        const db = new Database(path);
        let writer: Database | undefined;
        try {
            db.exec("PRAGMA journal_mode=WAL");
            db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
            db.transaction(() => {
                insert.run(
                    "summary",
                    "source",
                    400,
                    400,
                    '{"role":"assistant","summary":true,"finish":"stop"}',
                );
                for (let i = 0; i < 1024; i++)
                    insert.run(
                        `m-${String(i).padStart(4, "0")}`,
                        "destination",
                        i,
                        i,
                        '{"role":"user"}',
                    );
            })();
            expect(await prewarmRawSessionOrdinalsForDb(db, "destination")).toBe("warm");
            expect(countRawSessionMessageOrdinalsFromDb(db, "destination")).toBe(1024);
            writer = new Database(path);
            writer.prepare("UPDATE message SET session_id='destination' WHERE id='summary'").run();
            expect(await prewarmRawSessionOrdinalsForDb(db, "destination")).toBe("warm");
            const full = (
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM message WHERE session_id='destination' AND NOT (COALESCE(json_extract(data, '$.summary'),0)=1 AND COALESCE(json_extract(data, '$.finish'),'')='stop')",
                    )
                    .get() as { n: number }
            ).n;
            const observed = {
                total: countRawSessionMessageOrdinalsFromDb(db, "destination"),
                last: readRawSessionMessageOrdinalByIdFromDb(db, "destination", "m-1023"),
                point: readRawSessionMessageByIdFromDb(db, "destination", "m-1023")?.ordinal,
            };
            // Forgetting the destination's summary rows makes preparation discover the moved summary.
            forgetRawSessionSummaryRows("destination");
            expect(await prewarmRawSessionOrdinalsForDb(db, "destination")).toBe("warm");
            expect(countRawSessionMessageOrdinalsFromDb(db, "destination")).toBe(full);
            expect(observed).toEqual({ total: full, last: full, point: full });
        } finally {
            resetRawSessionOrdinalWarmupsForTest();
            writer?.close();
            db.close();
            cleanup();
        }
    });
});
