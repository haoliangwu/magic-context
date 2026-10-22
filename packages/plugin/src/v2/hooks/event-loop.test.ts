import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import {
    MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS,
    sweepOrphanedOpenCodeMessageIndexesCooperatively,
} from "../../features/magic-context/message-index";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import * as transformModule from "../../hooks/magic-context/transform";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { _resetHarnessForTesting, getHarness, setHarness } from "../../shared/harness";
import * as logger from "../../shared/logger";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

type Event = { type: string; data: { sessionID: string } };
const sessionID = "ses-event-usage";
const succeeded: Event = { type: "session.execution.succeeded", data: { sessionID } };
const deleted: Event = { type: "session.deleted", data: { sessionID: "ses-deleted" } };

function aborted(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await delay(5);
    expect(predicate()).toBe(true);
}

async function fixture(
    stream: (signal: AbortSignal, subscription: number) => AsyncIterable<Event>,
    failDeletion = false,
) {
    const dir = createTestTempDir("mc-v2-event-loop-").dir;
    const oldEnv = {
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        OPENCODE_DB: process.env.OPENCODE_DB,
    };
    process.env.XDG_DATA_HOME = dir;
    process.env.OPENCODE_DB = join(dir, "opencode", "opencode2.db");
    resetOpenCodeDbPathStateForTesting();
    mkdirSync(join(dir, "opencode"));
    const hostDb = new Database(process.env.OPENCODE_DB);
    hostDb.exec(`
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT);
        INSERT INTO session_v2 VALUES ('${sessionID}', NULL, '${dir}');
    `);
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("throwaway store unavailable");
    getOrCreateSessionMeta(db, deleted.data.sessionID);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config: MagicContextConfigSchema.parse({
            historian: { disable: true },
            dreamer: { disable: true },
            memory: { enabled: false },
        }),
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const createGate = storageGate.createV2StorageGate;
    const gate = spyOn(storageGate, "createV2StorageGate").mockImplementation((options) =>
        createGate({ ...options, open: async () => db }),
    );
    const clearSessionLogState = mock(() => {
        if (failDeletion) throw new Error("injected deletion failure");
    });
    const fake = Object.assign(async () => {}, {
        getRustReplayParticipant: () => null,
        disposeRust: () => {},
        clearSessionLogState,
    });
    const transform = spyOn(transformModule, "createTransform").mockImplementation(
        () => fake as unknown as ReturnType<typeof transformModule.createTransform>,
    );
    const log = spyOn(logger, "log").mockImplementation(() => {});
    const sessionLog = spyOn(logger, "sessionLog");
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
    const starts: number[] = [];
    const signals: AbortSignal[] = [];
    let duties: Awaited<ReturnType<typeof registerContext>>;
    const start = async () => {
        duties = await registerContext({
            location: { directory: dir },
            agent: { transform: async () => {}, reload: async () => {} },
            model: {
                list: () => [
                    {
                        providerID: "test-provider",
                        id: "test-model",
                        limit: { context: 200000, output: 32000 },
                    },
                ],
            },
            storage: { get: async () => undefined, set: async () => {} },
            event: {
                subscribe: ({ signal }: { signal: AbortSignal }) => {
                    starts.push(Date.now());
                    signals.push(signal);
                    return stream(signal, starts.length);
                },
            },
            tool: { hook: async () => {} },
            session: {
                remove: async () => {},
                compact: async () => {},
                interrupt: async () => ({}),
                hook: async (name: string, callback: typeof hook) => {
                    if (name === "context") hook = callback;
                },
                get: async () => ({ location: { directory: dir } }),
            },
        } as unknown as V2Context);
        await hook!({
            sessionID,
            model: { providerID: "test-provider", id: "test-model", limit: { context: 200000 } },
            agent: "build",
            system: [],
            options: {},
            tools: {},
            messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }],
        } as SessionContext);
        // The completion appears after the pre-generation pass, just as on the host.
        hostDb
            .prepare(
                "INSERT OR REPLACE INTO session_message VALUES (?, ?, 'assistant', 1, 1000, ?)",
            )
            .run(
                "a1",
                sessionID,
                JSON.stringify({
                    model: { providerID: "test-provider", id: "test-model" },
                    tokens: { input: 12345, output: 50, cache: { read: 0, write: 0 } },
                    time: { created: 1000, completed: 2000 },
                    finish: "stop",
                }),
            );
    };
    return {
        db,
        hostDb,
        hostPath: process.env.OPENCODE_DB,
        starts,
        signals,
        start,
        log,
        sessionLog,
        clearSessionLogState,
        dispose: async () => {
            await duties?.dispose();
            duties = undefined;
        },
        cleanup: async () => {
            await duties?.dispose();
            log.mockRestore();
            sessionLog.mockRestore();
            transform.mockRestore();
            gate.mockRestore();
            load.mockRestore();
            _resetDreamTimerForTests();
            closeDatabase();
            hostDb.close();
            resetCtxReduceRegisteredGloballyForTest();
            for (const [key, value] of Object.entries(oldEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            resetOpenCodeDbPathStateForTesting();
            cleanupTestTempDir(dir);
        },
    };
}

for (const failDeletion of [false, true]) {
    test(`v2 records usage after ${failDeletion ? "a throwing" : "a normal"} deletion handler`, async () => {
        const ready = Promise.withResolvers<void>();
        let consumed = false;
        const f = await fixture(async function* () {
            await ready.promise;
            try {
                yield deleted;
                yield succeeded;
            } finally {
                consumed = true;
            }
        }, failDeletion);
        try {
            await f.start();
            expect(getOrCreateSessionMeta(f.db, sessionID).lastInputTokens).toBe(0);
            ready.resolve();
            await until(() => consumed);
            expect(
                getOrCreateSessionMeta(f.db, sessionID).lastInputTokens,
                JSON.stringify(f.sessionLog.mock.calls),
            ).toBe(12345);
            expect(f.starts).toHaveLength(1);
            expect(f.clearSessionLogState).toHaveBeenCalledTimes(1);
            const errors = f.log.mock.calls.filter(([message]) =>
                String(message).includes("event handler failed"),
            );
            expect(errors).toHaveLength(failDeletion ? 1 : 0);
            if (failDeletion)
                expect(errors[0]?.[0]).toContain("type=session.deleted, session=ses-deleted");
            else
                expect(
                    f.db
                        .prepare("SELECT 1 FROM session_meta WHERE session_id = ?")
                        .get(deleted.data.sessionID),
                ).toBeNull();
        } finally {
            ready.resolve();
            await f.cleanup();
        }
    });
}

for (const failure of ["end", "throw"] as const) {
    test(`v2 resubscribes with backoff after stream ${failure} and records usage`, async () => {
        const ready = Promise.withResolvers<void>();
        let consumed = false;
        const f = await fixture(async function* (signal, subscription) {
            await ready.promise;
            if (subscription === 1) {
                if (failure === "throw") throw new Error("injected stream failure");
                return;
            }
            yield succeeded;
            consumed = true;
            await aborted(signal);
        });
        try {
            await f.start();
            ready.resolve();
            await until(() => consumed);
            expect(f.starts).toHaveLength(2);
            expect(f.starts[1]! - f.starts[0]!).toBeGreaterThanOrEqual(100);
            expect(
                getOrCreateSessionMeta(f.db, sessionID).lastInputTokens,
                JSON.stringify(f.sessionLog.mock.calls),
            ).toBe(12345);
            await f.dispose();
            expect(f.signals.every((signal) => signal.aborted)).toBe(true);
            await delay(300);
            expect(f.starts).toHaveLength(2);
        } finally {
            ready.resolve();
            await f.cleanup();
        }
    });
}

test("v2 dispose cancels reconnect backoff before a replacement subscribes", async () => {
    let ended = false;
    const f = await fixture(async function* () {
        ended = true;
        yield* [];
    });
    try {
        await f.start();
        await until(() => ended);
        await f.dispose();
        const previousStarts = f.starts.length;
        await f.start();
        expect(f.starts).toHaveLength(previousStarts + 1);
        expect(f.signals.slice(0, previousStarts).every((signal) => signal.aborted)).toBe(true);
        await f.dispose();
        await delay(300);
        expect(f.starts).toHaveLength(previousStarts + 1);
    } finally {
        await f.cleanup();
    }
});

test("v2 sweep cleans a deletion missed during the resubscribe gap", async () => {
    const previous = getHarness();
    _resetHarnessForTesting();
    setHarness("opencode2");
    const ready = Promise.withResolvers<void>();
    let ended = false;
    const f = await fixture(async function* (signal, subscription) {
        await ready.promise;
        if (subscription === 1) {
            ended = true;
            return;
        }
        await aborted(signal);
        yield* [];
    });
    try {
        await f.start();
        f.hostDb
            .prepare("INSERT INTO session_v2 VALUES (?, NULL, '/tmp')")
            .run(deleted.data.sessionID);
        f.db
            .prepare(
                "INSERT INTO message_history_index(session_id,last_indexed_ordinal,updated_at,harness) VALUES (?,1,?,'opencode2')",
            )
            .run(deleted.data.sessionID, Date.now() - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1);
        ready.resolve();
        await until(() => ended);
        // No subscriber sees this deletion, so no pending-cleanup marker exists.
        f.hostDb.prepare("DELETE FROM session_v2 WHERE id = ?").run(deleted.data.sessionID);
        expect(f.clearSessionLogState).not.toHaveBeenCalled();
        expect(
            f.db
                .prepare("SELECT 1 FROM pending_session_cleanup WHERE session_id = ?")
                .get(deleted.data.sessionID),
        ).toBeNull();
        await until(() => f.starts.length === 2);
        const swept = await sweepOrphanedOpenCodeMessageIndexesCooperatively(
            f.db,
            () => new Database(f.hostPath, { readonly: true }),
        );
        expect(swept).toMatchObject({ status: "swept", deleted: 1 });
        expect(
            f.db
                .prepare("SELECT 1 FROM session_meta WHERE session_id = ?")
                .get(deleted.data.sessionID),
        ).toBeNull();
        expect(
            f.db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionID),
        ).not.toBeNull();
    } finally {
        ready.resolve();
        await f.cleanup();
        _resetHarnessForTesting();
        setHarness(previous);
    }
});
