import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    clearIndexedMessages,
    getIndexableContent,
    getLastIndexedOrdinal,
    messageIndexSkipKey,
} from "../../features/magic-context/message-index";
import {
    getIndexWorkerMeasurements,
    indexSingleMessageOffThread,
} from "../../features/magic-context/message-index-async";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import * as tagStorage from "../../features/magic-context/storage-tags";
import { getTagsBySession, updateTagStatus } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import {
    Database,
    indexCoordinationInput,
    withIndexChunk,
    withSqliteTransformPass,
} from "../../shared/sqlite";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { resetRawSessionOrdinalWarmupsForTest } from "./raw-ordinal-warmup";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";
import * as warmup from "./tag-owner-warmup";
import { createTransform } from "./transform";

async function fixture(run: (db: Database, path: string) => Promise<void>) {
    const { dir, cleanup } = createTestTempDir("mc-cold-stall-fixes-");
    const previous = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = join(dir, "absent-opencode.db");
    const path = join(dir, "context.db");
    const db = new Database(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
        await run(db, path);
    } finally {
        resetRawSessionOrdinalWarmupsForTest();
        closeReadOnlySessionDb();
        db.close();
        if (previous === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previous;
        cleanup();
    }
}

test("a peer drop committed during the owner wait never returns on the served wire", async () => {
    await fixture(async (db, path) => {
        const session = "peer-drop";
        const peer = new Database(path);
        const source = (): MessageLike[] =>
            [
                {
                    info: { id: "old-user", role: "user", sessionID: session },
                    parts: [{ type: "text", text: "Old question" }],
                },
                {
                    info: {
                        id: "old",
                        role: "assistant",
                        sessionID: session,
                        providerID: "openai",
                        modelID: "gpt-5",
                        finish: "stop",
                    },
                    parts: [{ type: "text", text: "Durably dropped answer must not return." }],
                },
                {
                    info: { id: "new", role: "user", sessionID: session },
                    parts: [{ type: "text", text: "Continue" }],
                },
            ] as unknown as MessageLike[];
        const unavailable = spyOn(
            tagStorage,
            "tryGetReasoningTokenEstimatesByMessage",
        ).mockReturnValue(undefined);
        const wait = spyOn(warmup, "waitForTagOwners").mockImplementation(async () => {
            const tag = getTagsBySession(peer, session).find(
                (row) =>
                    row.type === "message" && contentTagOwnerMessageId(row.messageId) === "old",
            );
            expect(tag).toBeDefined();
            if (!tag) throw new Error("tag was not minted before the wait");
            updateTagStatus(peer, session, tag.tagNumber, "dropped");
            return false;
        });
        try {
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: { shouldExecute: () => "execute" },
                contextUsageMap: new Map(),
                protectedTokens: 1000,
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set([session]),
                lastHeuristicsTurnId: new Map(),
                historianRunnable: false,
            });
            const messages = source();
            await transform({}, { messages });
            expect(wait).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(messages)).not.toContain(
                "Durably dropped answer must not return.",
            );
        } finally {
            wait.mockRestore();
            unavailable.mockRestore();
            peer.close();
        }
    });
});

test("oversized indexing uses short identity chunks, records its omission, and leaves normal messages searchable", async () => {
    await fixture(async (db) => {
        const text = "source identity semaphore ".repeat(100_000);
        const message = {
            id: "large",
            ordinal: 1,
            role: "user",
            version: "v1",
            parts: [{ type: "text", text }],
        };
        await indexSingleMessageOffThread(db, "chunks", message);
        const measured = getIndexWorkerMeasurements(db, "chunks");
        if (!measured) throw new Error("worker timing missing");
        expect(measured.skipped).toBe(true);
        expect(measured.holdMs.length).toBeGreaterThan(2);
        expect(Math.max(...measured.holdMs)).toBeLessThan(100);
        const record = JSON.parse(
            (
                db
                    .prepare("SELECT value FROM schema_migrations_meta WHERE key=?")
                    .get(messageIndexSkipKey("chunks", "large")) as { value: string }
            ).value,
        );
        expect(record).toMatchObject({ reason: "oversized", complete: true });
        const hash = createHash("sha256")
            .update(getIndexableContent(message.role, message.parts))
            .digest("hex");
        expect(record.contentHash).toBe(hash);
        expect(getLastIndexedOrdinal(db, "chunks")).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM message_history_fts").get()).toEqual({ n: 0 });
        expect(
            await indexSingleMessageOffThread(db, "chunks", {
                id: "normal",
                ordinal: 2,
                role: "user",
                parts: [{ type: "text", text: "searchable sentinel" }],
            }),
        ).toBe(true);
        expect(
            db
                .prepare(
                    "SELECT message_id FROM message_history_fts WHERE message_history_fts MATCH 'sentinel'",
                )
                .get(),
        ).toEqual({ message_id: "normal" });
        clearIndexedMessages(db, "chunks");
        expect(
            db
                .prepare("SELECT value FROM schema_migrations_meta WHERE key=?")
                .get(messageIndexSkipKey("chunks", "large")),
        ).toBeNull();
    });
});

test("a foreground pass waits for one owned chunk before spending its SQLite budget", async () => {
    const input = indexCoordinationInput();
    let releaseChunk!: () => void;
    let chunkStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        chunkStarted = resolve;
    });
    const end = new Promise<void>((resolve) => {
        releaseChunk = resolve;
    });
    // Use the real admission primitive; the async value models a chunk still in COMMIT.
    const maintenance = withIndexChunk(input, () => {
        chunkStarted();
        return end;
    });
    await started;
    let foregroundRan = false;
    const foreground = withSqliteTransformPass(async () => {
        foregroundRan = true;
    });
    await Promise.resolve();
    expect(foregroundRan).toBe(false);
    releaseChunk();
    await maintenance;
    await foreground;
    expect(foregroundRan).toBe(true);
});

test("the host stall watchdog ignores a 1.3 second asynchronous foreground wait but detects a real block", async () => {
    const { dir, cleanup } = createTestTempDir("mc-index-wait-profiler-");
    const { writeFileSync, readdirSync } = await import("node:fs");
    const { createNodeHostStallProfiler } = await import("../../shared/host-stall-profiler-node");
    writeFileSync(join(dir, "enable"), JSON.stringify({ threshold_ms: 500 }));
    const handle = createNodeHostStallProfiler({
        profilerDir: () => dir,
        now: () => performance.now(),
        wallNow: () => Date.now(),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
        rss: () => 1,
        memoryUsage: () => ({ heapUsed: 1, rss: 1 }),
        log: () => {},
        pid: process.pid,
        bunVersion: Bun.version,
        createSession: async () => ({
            connect() {},
            disconnect() {},
            post(method, _params, callback) {
                callback(
                    null,
                    method === "Profiler.stop"
                        ? { profile: { startTime: 0, endTime: 1, nodes: [] } }
                        : {},
                );
            },
        }),
    });
    let last = performance.now();
    let longest = 0;
    let ticks = 0;
    const ticker = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        ticks++;
    }, 5);
    try {
        handle.start();
        await handle.checkNow();
        const input = indexCoordinationInput();
        const held = withIndexChunk(
            input,
            () => new Promise<void>((resolve) => setTimeout(resolve, 1330)),
        );
        await Promise.resolve();
        const began = performance.now();
        await withSqliteTransformPass(async () => {});
        await held;
        await handle.checkNow();
        expect(performance.now() - began).toBeGreaterThanOrEqual(1300);
        expect(ticks).toBeGreaterThan(100);
        expect(longest).toBeLessThan(200);
        expect(readdirSync(dir).filter((name) => name.startsWith("stall-"))).toHaveLength(0);
        // Positive control: the same watchdog must detect a synchronous block.
        const blockedAt = performance.now();
        while (performance.now() - blockedAt < 900) {}
        await new Promise((resolve) => setTimeout(resolve, 30));
        await handle.checkNow();
        expect(readdirSync(dir).filter((name) => name.startsWith("stall-"))).toHaveLength(1);
    } finally {
        clearInterval(ticker);
        handle.stop();
        await handle.checkNow();
        cleanup();
    }
});
