/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    getRawSessionTagKeysThrough,
    type RawSessionTagKeys,
    readRawSessionMessages,
    withRawMessageProvider,
} from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { RawMessage } from "./read-session-raw";

const tempDirs: string[] = [];
const originalOpenCodeDb = process.env.OPENCODE_DB;

function normalizedKeys(keys: RawSessionTagKeys): {
    messageFileKeys: string[];
    toolObservations: Array<[string, string[]]>;
} {
    return {
        messageFileKeys: [...keys.messageFileKeys].sort(),
        toolObservations: [...keys.toolObservations]
            .map(([callId, owners]) => [callId, [...owners].sort()] as [string, string[]])
            .sort(([left], [right]) => left.localeCompare(right)),
    };
}

afterEach(() => {
    closeReadOnlySessionDb();
    resetOpenCodeDbPathStateForTesting();
    if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalOpenCodeDb;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

describe("compartment drop tag-key pagination", () => {
    it("matches the unpaged key set across more than two pages and preserves spanning tool ownership", async () => {
        const messages: RawMessage[] = [
            {
                ordinal: 1,
                id: "m-1",
                role: "user",
                parts: [{ type: "text", text: "first" }],
            },
            {
                ordinal: 2,
                id: "m-owner-2",
                role: "assistant",
                parts: [{ type: "tool-invocation", callID: "shared-call" }],
            },
            {
                ordinal: 3,
                id: "m-result-3",
                role: "tool",
                parts: [{ type: "tool", callID: "shared-call", state: { output: "first result" } }],
            },
            {
                ordinal: 4,
                id: "m-owner-4",
                role: "assistant",
                parts: [
                    { type: "text", text: "second" },
                    { type: "tool-invocation", callID: "shared-call" },
                ],
            },
            {
                ordinal: 5,
                id: "m-result-5",
                role: "tool",
                parts: [
                    { type: "tool", callID: "shared-call", state: { output: "second result" } },
                ],
            },
            {
                ordinal: 6,
                id: "m-6",
                role: "assistant",
                parts: [{ type: "text", text: "last included" }],
            },
            {
                ordinal: 7,
                id: "m-7-outside",
                role: "assistant",
                parts: [{ type: "text", text: "must not hydrate" }],
            },
        ];

        const unpaged = await withRawMessageProvider(
            "session-paged",
            { readMessages: () => messages },
            () => getRawSessionTagKeysThrough("session-paged", 6),
        );

        const hydratedOrdinals: number[][] = [];
        const partsPerBatch: number[] = [];
        let fullReads = 0;
        const paged = await withRawMessageProvider(
            "session-paged",
            {
                readMessages: () => {
                    fullReads += 1;
                    return messages;
                },
                readMessagePage: (afterOrdinal, limit, finalWatermark) => {
                    const page = messages
                        .filter(
                            (message) =>
                                message.ordinal > afterOrdinal && message.ordinal <= finalWatermark,
                        )
                        .slice(0, limit);
                    hydratedOrdinals.push(page.map((message) => message.ordinal));
                    partsPerBatch.push(
                        page.reduce((partCount, message) => partCount + message.parts.length, 0),
                    );
                    return page;
                },
            },
            () => getRawSessionTagKeysThrough("session-paged", 6, { pageSize: 2 }),
        );

        expect(normalizedKeys(paged)).toEqual(normalizedKeys(unpaged));
        expect(normalizedKeys(paged)).toEqual({
            messageFileKeys: ["m-1:p0", "m-6:p0", "m-owner-4:p0"],
            toolObservations: [["shared-call", ["m-owner-2", "m-owner-4"]]],
        });
        expect(hydratedOrdinals).toEqual([
            [1, 2],
            [3, 4],
            [5, 6],
        ]);
        expect(fullReads).toBe(0);
        expect(Math.max(...partsPerBatch)).toBeLessThanOrEqual(3);
        expect(paged.toolObservations.get("shared-call")).toEqual(
            new Set(["m-owner-2", "m-owner-4"]),
        );
        expect(paged.messageFileKeys.has("m-7-outside:p0")).toBe(false);
    });

    it("uses the nearest prior persisted owner for a result-only page", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "compartment-drop-owner-fallback-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "opencode.db");
        const openCodeDb = new Database(dbPath);
        const contextDb = new Database(":memory:");
        try {
            openCodeDb.exec(`
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
            `);
            const insertMessage = openCodeDb.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'session-fallback', ?, ?, '{}')",
            );
            insertMessage.run("owner-old", 10, 10);
            insertMessage.run("owner-nearest", 20, 20);
            insertMessage.run("result-only", 30, 30);
            contextDb.exec(`
                CREATE TABLE tags (
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    tool_owner_message_id TEXT
                );
                INSERT INTO tags VALUES
                    ('session-fallback', 'orphan-call', 'tool', 'owner-old'),
                    ('session-fallback', 'orphan-call', 'tool', 'owner-nearest');
            `);
        } finally {
            closeQuietly(openCodeDb);
        }

        process.env.OPENCODE_DB = dbPath;
        closeReadOnlySessionDb();
        resetOpenCodeDbPathStateForTesting();
        try {
            const resultMessage: RawMessage = {
                ordinal: 1,
                id: "result-only",
                role: "tool",
                createdAt: 30,
                parts: [{ type: "tool", callID: "orphan-call", state: { output: "done" } }],
            };
            const keys = await withRawMessageProvider(
                "session-fallback",
                {
                    readMessages: () => [resultMessage],
                    readMessagePage: () => [resultMessage],
                },
                () =>
                    getRawSessionTagKeysThrough("session-fallback", 1, {
                        db: contextDb,
                        pageSize: 1,
                    }),
            );

            expect(keys.toolObservations.get("orphan-call")).toEqual(new Set(["owner-nearest"]));
        } finally {
            closeQuietly(contextDb);
        }
    });

    it("contains no whole-session parts query in the raw reader source", () => {
        const rawReaderSource = readFileSync(join(import.meta.dir, "read-session-raw.ts"), "utf8");
        expect(rawReaderSource).not.toContain(
            "FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        );

        const chunkReaderSource = readFileSync(
            join(import.meta.dir, "read-session-chunk.ts"),
            "utf8",
        );
        const helperSource = chunkReaderSource.slice(
            chunkReaderSource.indexOf("export async function getRawSessionTagKeysThrough"),
            chunkReaderSource.indexOf("const PROTECTED_TAIL_USER_TURNS"),
        );
        expect(helperSource).toContain("readRawSessionMessages.readPage(");
        expect(helperSource).not.toContain("readRawSessionMessages(sessionId)");
    });

    it("yields to the event loop between pages while scanning 100k SQLite parts", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "compartment-drop-responsive-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "opencode.db");
        const db = new Database(dbPath);
        const sessionId = "session-large";
        const messageCount = 1_000;
        const partsPerMessage = 100;
        try {
            db.exec(`
                    PRAGMA journal_mode = WAL;
                    CREATE TABLE message (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        time_created INTEGER NOT NULL,
                        time_updated INTEGER NOT NULL,
                        data TEXT NOT NULL
                    );
                    CREATE TABLE part (
                        id TEXT PRIMARY KEY,
                        message_id TEXT NOT NULL,
                        session_id TEXT NOT NULL,
                        time_created INTEGER NOT NULL,
                        time_updated INTEGER NOT NULL,
                        data TEXT NOT NULL
                    );
                    CREATE INDEX message_session_created_id
                        ON message(session_id, time_created, id);
                    CREATE INDEX part_session_message_created_id
                        ON part(session_id, message_id, time_created, id);
                    BEGIN;
                `);
            const insertMessage = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            );
            const insertPart = db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            );
            const partData = JSON.stringify({
                type: "text",
                text: "x".repeat(1_024),
            });
            for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
                const messageId = `m-${messageIndex.toString().padStart(4, "0")}`;
                insertMessage.run(
                    messageId,
                    sessionId,
                    messageIndex,
                    messageIndex,
                    JSON.stringify({ role: messageIndex % 2 === 0 ? "user" : "assistant" }),
                );
                for (let partIndex = 0; partIndex < partsPerMessage; partIndex += 1) {
                    const time = messageIndex * partsPerMessage + partIndex;
                    insertPart.run(
                        `p-${time.toString().padStart(6, "0")}`,
                        messageId,
                        sessionId,
                        time,
                        time,
                        partData,
                    );
                }
            }
            db.exec("COMMIT;");
        } finally {
            closeQuietly(db);
        }

        process.env.OPENCODE_DB = dbPath;
        closeReadOnlySessionDb();
        resetOpenCodeDbPathStateForTesting();

        // Every SQLite page must hand the loop to another callback before the next
        // read. Observing each boundary also catches one missing yield in a long scan.
        const pageTurns: number[] = [];
        const readPage = readRawSessionMessages.readPage;
        const pagesRead = spyOn(readRawSessionMessages, "readPage").mockImplementation(
            (...args) => {
                pageTurns.push(loopTurns);
                return readPage(...args);
            },
        );
        let loopTurns = 0;
        let counting = true;
        const countTurns = () => {
            if (!counting) return;
            loopTurns += 1;
            setImmediate(countTurns);
        };
        try {
            setImmediate(countTurns);
            const keys = await getRawSessionTagKeysThrough(sessionId, messageCount, {
                pageSize: 32,
            });
            counting = false;

            const pages = Math.ceil(messageCount / 32);
            expect(keys.messageFileKeys.size).toBe(messageCount * partsPerMessage);
            expect(pageTurns).toHaveLength(pages);
            expect(loopTurns).toBeGreaterThanOrEqual(pages - 1);
            for (let index = 1; index < pageTurns.length; index += 1) {
                expect(pageTurns[index]).toBeGreaterThan(pageTurns[index - 1]!);
            }
        } finally {
            counting = false;
            pagesRead.mockRestore();
        }
    }, 30_000);
});
