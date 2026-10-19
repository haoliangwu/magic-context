import { expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { runMigrations } from "../../features/magic-context/migrations";
import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import { isTagOwnerSummaryReady } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import * as logger from "../../shared/logger";
import { Database, withSqliteTransformPass } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import * as trigger from "./compartment-trigger";
import * as rawWarmup from "./raw-ordinal-warmup";
import { resetRawSessionOrdinalWarmupsForTest } from "./raw-ordinal-warmup";
import { getRawSessionMessageOrdinalCount, prepareRawSessionOrdinals } from "./read-session-chunk";
import { closeReadOnlySessionDb, observeOpenCodeTurnEvent } from "./read-session-db";
import * as warmup from "./tag-owner-warmup";
import { createTransform } from "./transform";

const SESSION = "historian-owner-readiness";

async function fixture(run: (db: Database, path: string) => Promise<void>) {
    const { dir, cleanup } = createTestTempDir("mc-historian-owners-");
    const previous = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = join(dir, "absent-opencode.db");
    const path = join(dir, "context.db");
    const db = new Database(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
        getOrCreateSessionMeta(db, SESSION);
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

function source() {
    return [
        {
            info: { id: "old-user", role: "user", sessionID: SESSION },
            parts: [{ type: "text", text: "Question" }],
        },
        {
            info: {
                id: "old-answer",
                role: "assistant",
                sessionID: SESSION,
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
                finish: "stop",
            },
            parts: [{ type: "text", text: "Durable answer" }],
        },
        {
            info: { id: "new-user", role: "user", sessionID: SESSION },
            parts: [{ type: "text", text: "Continue" }],
        },
    ];
}

function makeTransform(db: Database, usage: Map<string, ReturnType<typeof pressure>>) {
    return createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: usage,
        protectedTokens: 1000,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
    });
}

function pressure(inputTokens: number) {
    return {
        usage: { percentage: inputTokens / 1000, inputTokens },
        updatedAt: Date.now(),
        hasUsageTokens: true,
    };
}

test("historian trigger awaits cold owners before taking its usage snapshot", async () => {
    await fixture(async (db) => {
        const usage = new Map([[SESSION, pressure(1000)]]);
        const originalWait = warmup.waitForTagOwners;
        const wait = spyOn(warmup, "waitForTagOwners").mockImplementation(async (...args) => {
            const ready = await originalWait(...args);
            usage.set(SESSION, pressure(76000));
            updateSessionMeta(db, SESSION, {
                lastContextPercentage: 76,
                lastInputTokens: 76000,
                lastResponseTime: Date.now(),
            });
            return ready;
        });
        const decisions: number[] = [];
        const check = spyOn(trigger, "checkCompartmentTrigger").mockImplementation(
            (_db, _session, _meta, reading) => {
                decisions.push(reading.inputTokens);
                return { shouldFire: false };
            },
        );
        try {
            expect(
                isTagOwnerSummaryReady(
                    db,
                    SESSION,
                    sessionDecisionCalibration(db, SESSION).proseRatio,
                ),
            ).toBe(false);
            await withSqliteTransformPass(() =>
                makeTransform(db, usage)({}, { messages: source() }),
            );
            expect(decisions).toEqual([76000]);
        } finally {
            check.mockRestore();
            wait.mockRestore();
        }
    });
});

test("historian trigger keeps warm owners through unrelated peer commits", async () => {
    await fixture(async (db, path) => {
        const peer = new Database(path);
        const usage = new Map([[SESSION, pressure(50000)]]);
        const transform = makeTransform(db, usage);
        const check = spyOn(trigger, "checkCompartmentTrigger").mockReturnValue({
            shouldFire: false,
        });
        try {
            await withSqliteTransformPass(() => transform({}, { messages: source() }));
            expect(check).toHaveBeenCalledTimes(1);
            const ratio = sessionDecisionCalibration(db, SESSION).proseRatio;
            expect(await warmup.prewarmTagOwners(db, SESSION, ratio)).toBe(true);
            expect(isTagOwnerSummaryReady(db, SESSION, ratio)).toBe(true);

            // Index-worker activity commits do not change tag ownership.
            peer.prepare(
                "UPDATE session_meta SET last_input_tokens = last_input_tokens + 1 WHERE session_id = ?",
            ).run(SESSION);
            expect(isTagOwnerSummaryReady(db, SESSION, ratio)).toBe(true);
            await withSqliteTransformPass(() => transform({}, { messages: source() }));
            expect(check).toHaveBeenCalledTimes(2);
        } finally {
            check.mockRestore();
            peer.close();
        }
    });
});

test("an owner readiness deadline warns and leaves the worker able to finish", async () => {
    await fixture(async (db) => {
        const messages: string[] = [];
        const log = spyOn(logger, "sessionLog").mockImplementation((_session, ...values) => {
            messages.push(values.join(" "));
        });
        try {
            expect(await warmup.waitForTagOwners(db, SESSION, 1, 0)).toBe(false);
            expect(
                messages.some((message) =>
                    message.includes("WARN tag owner digest unavailable within 0ms"),
                ),
            ).toBe(true);
            expect(await warmup.prewarmTagOwners(db, SESSION, 1)).toBe(true);
            expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
        } finally {
            log.mockRestore();
        }
    });
});

test("cold ordinal preparation truncates a tail removed while the worker ran", async () => {
    await fixture(async (_db, path) => {
        const raw = new Database(join(dirname(path), "absent-opencode.db"));
        raw.exec("PRAGMA journal_mode=WAL");
        raw.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        for (let i = 0; i < 3; i++) {
            raw.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                `raw-${i}`,
                SESSION,
                i,
                i,
                JSON.stringify({ role: "user" }),
            );
        }
        const originalPrepare = rawWarmup.prewarmRawSessionOrdinalsForDb;
        let firstOutcome: rawWarmup.RawOrdinalWarmupOutcome | undefined;
        let attempts = 0;
        const prepare = spyOn(rawWarmup, "prewarmRawSessionOrdinalsForDb").mockImplementation(
            async (...args) => {
                const result = originalPrepare(...args);
                if (++attempts === 1) {
                    // Simulate an undo that deletes a message while the cold off-thread scan is
                    // still running. The scan must repair its result by truncating at the
                    // deleted message, not by starting the whole-session scan again.
                    raw.prepare("DELETE FROM message WHERE id = 'raw-2'").run();
                    observeOpenCodeTurnEvent("message.removed", {
                        sessionID: SESSION,
                        messageID: "raw-2",
                    });
                    firstOutcome = await result;
                    return firstOutcome;
                }
                return result;
            },
        );
        try {
            expect(await prepareRawSessionOrdinals(SESSION)).toBe(true);
            expect(firstOutcome).toBe("warm");
            expect(attempts).toBe(1);
            expect(getRawSessionMessageOrdinalCount(SESSION)).toBe(2);
        } finally {
            prepare.mockRestore();
            closeReadOnlySessionDb();
            raw.close();
        }
    });
});
