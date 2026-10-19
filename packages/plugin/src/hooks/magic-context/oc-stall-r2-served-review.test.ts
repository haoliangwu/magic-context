/// <reference types="bun-types" />

import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    getOrCreateSessionMeta,
    getTagsBySession,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

type FixtureMessage = Omit<MessageLike, "info"> & {
    info: MessageLike["info"] & {
        time?: { created: number; completed?: number };
        providerID?: string;
        modelID?: string;
        finish?: string;
    };
};

test("served JSON bytes match 6bc65dcc on initial, defer, rebuild and replay passes", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-r2-served-");
    const previous = process.env.OPENCODE_DB;
    const path = join(dir, "opencode-fixture.db");
    process.env.OPENCODE_DB = path;
    const rawDb = new Database(path);
    rawDb.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const session = "ses-stall-r2-served";
    getOrCreateSessionMeta(db, session);
    const clock = spyOn(Date, "now").mockReturnValue(1700000100000);
    const raw: FixtureMessage[] = [];
    for (let turn = 0; turn < 12; turn++) {
        raw.push({
            info: {
                id: `user-${turn}`,
                role: "user",
                sessionID: session,
                time: { created: 1700000000000 + turn * 1000 },
            },
            parts: [
                {
                    type: "text",
                    text: `Investigate function ${turn}: preserve public behavior.\n${"An independent input with a timestamp tie. ".repeat(20)}`,
                },
            ],
        });
        raw.push({
            info: {
                id: `assistant-${turn}`,
                role: "assistant",
                sessionID: session,
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
                finish: "stop",
                time: {
                    created: 1700000000000 + turn * 1000,
                    completed: 1700000000500 + turn * 1000,
                },
            },
            parts: [
                {
                    type: "reasoning",
                    text: `Reasoning ${turn}: ${"Check input invariants before changing code. ".repeat(20)}`,
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: `call-${turn}`,
                    state: {
                        status: "completed",
                        input: { filePath: `/fixture/function-${turn}.ts` },
                        output: `READ-RESULT-${turn}\n${"export const unchanged = true;\n".repeat(80)}`,
                    },
                },
                {
                    type: "text",
                    text: `Function ${turn} reviewed; the exported contract is unchanged.`,
                },
            ],
        });
    }
    raw.push({
        info: { id: "last-user", role: "user", sessionID: session },
        parts: [{ type: "text", text: "Summarize the review." }],
    });
    for (const [index, message] of raw.entries()) {
        const time = 1700000000000 + Math.floor(index / 2) * 1000;
        rawDb
            .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
            .run(message.info.id!, session, time, time, JSON.stringify(message.info));
        for (const [partIndex, part] of message.parts.entries())
            rawDb
                .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
                .run(
                    `part-${index}-${partIndex}`,
                    message.info.id!,
                    session,
                    time,
                    time,
                    JSON.stringify(part),
                );
    }
    rawDb
        .prepare(
            "INSERT INTO message VALUES ('finished-summary', ?, 1700000004000, 1700000004000, ?)",
        )
        .run(session, '{"role":"assistant","summary":true,"finish":"stop"}');
    let decision: "execute" | "defer" = "defer";
    const materialize = new Set<string>();
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        contextUsageMap: new Map([
            [
                session,
                {
                    usage: { percentage: 76, inputTokens: 76000 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                },
            ],
        ]),
        protectedTokens: 1000,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: materialize,
        lastHeuristicsTurnId: new Map(),
        historianRunnable: false,
        clearReasoningAge: 1000,
    });
    const pass = async () => {
        const messages = structuredClone(raw);
        await transform({}, { messages });
        return JSON.stringify(messages);
    };
    try {
        const initial = await pass();
        const defer = await pass();
        expect(defer).toBe(initial);
        const tool = getTagsBySession(db, session).find((tag) => tag.messageId === "call-2");
        expect(tool).toBeDefined();
        updateTagStatus(db, session, tool!.tagNumber, "dropped");
        materialize.add(session);
        decision = "execute";
        const rebuild = await pass();
        expect(rebuild).not.toBe(defer);
        expect(rebuild).not.toContain("READ-RESULT-2\\n");
        decision = "defer";
        const replay = await pass();
        expect(replay).toBe(rebuild);
        const captures = [initial, defer, rebuild, replay].map((bytes) => ({
            length: Buffer.byteLength(bytes),
            sha256: createHash("sha256").update(bytes).digest("hex"),
        }));
        // These independent golden digests are captured by running this same
        // fixture against the complete source tree of commit 6bc65dcc.
        expect(captures).toEqual([
            {
                length: 60568,
                sha256: "456512031b061875b93ba4c291eacbd08be38e42f92f2d637e588499741d093f",
            },
            {
                length: 60568,
                sha256: "456512031b061875b93ba4c291eacbd08be38e42f92f2d637e588499741d093f",
            },
            {
                length: 57850,
                sha256: "04a8af262a83d0363111a0db50c38304cd4b5486f030d2c0a86146270cde9333",
            },
            {
                length: 57850,
                sha256: "04a8af262a83d0363111a0db50c38304cd4b5486f030d2c0a86146270cde9333",
            },
        ]);
    } finally {
        clock.mockRestore();
        closeReadOnlySessionDb();
        rawDb.close();
        db.close();
        if (previous === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previous;
        cleanup();
    }
});
