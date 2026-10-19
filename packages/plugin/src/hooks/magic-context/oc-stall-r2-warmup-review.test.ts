/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    getRawOrdinalWarmupFailures,
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
    stopRawSessionOrdinalWarmups,
} from "./raw-ordinal-warmup";
import { prepareRawSessionOrdinals, setRawMessageProvider } from "./read-session-chunk";
import {
    countRawSessionMessageOrdinalsFromDb,
    forgetRawSessionSummaryRows,
    getRawSessionSummaryFullScansForTest,
    isRawSessionSummaryWarm,
    readRawSessionMessageOrdinalByIdFromDb,
    resetRawSessionOrdinalJsonRowsReadForTest,
} from "./read-session-raw";

const entry = new URL("./oc-stall-r2-warmup-worker.fixture.ts", import.meta.url);
const options = { entry, inThreadMaxRows: 0, acceptMs: 2000, resultMs: 2000 };
afterEach(resetRawSessionOrdinalWarmupsForTest);

async function until(path: string): Promise<void> {
    const end = Date.now() + 1500;
    while (!existsSync(path) && Date.now() < end) await Bun.sleep(5);
    expect(existsSync(path)).toBe(true);
}

async function withStore(
    run: (path: string, first: Database, second: Database) => Promise<void>,
): Promise<void> {
    const { dir, cleanup } = createTestTempDir("mc-stall-r2-warmup-");
    const path = join(dir, "fixture.db");
    const first = new Database(path);
    first.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    first.exec("PRAGMA journal_mode = WAL");
    const second = new Database(path);
    try {
        await run(path, first, second);
    } finally {
        stopRawSessionOrdinalWarmups();
        first.close();
        second.close();
        cleanup();
    }
}

function seed(db: Database, session: string): void {
    db.prepare("INSERT INTO message VALUES (?, ?, 1, 1, ?)").run(
        `${session}-target`,
        session,
        '{"role":"user"}',
    );
}

async function coalescedConnections(retrySecond: boolean): Promise<void> {
    await withStore(async (path, first, second) => {
        const session = "ses-r2-shared";
        seed(first, session);
        resetRawSessionOrdinalJsonRowsReadForTest();
        const one = prewarmRawSessionOrdinalsForDb(first, session, options);
        const two = prewarmRawSessionOrdinalsForDb(second, session, options);
        await until(`${path}.${session}.ready`);
        writeFileSync(`${path}.${session}.release`, "go");
        expect(await Promise.all([one, two])).toEqual(["warm", "warm"]);
        expect(isRawSessionSummaryWarm(first, session)).toBe(true);
        if (retrySecond)
            expect(await prewarmRawSessionOrdinalsForDb(second, session, options)).toBe("warm");
        expect(isRawSessionSummaryWarm(second, session)).toBe(true);
        expect(countRawSessionMessageOrdinalsFromDb(second, session)).toBe(1);
        expect(getRawSessionSummaryFullScansForTest()).toBe(0);
    });
}

test("coalesced warm-up must install candidates on every awaiting connection", () =>
    coalescedConnections(false));
test("coalesced warm-up: a second prepare on the other connection actually warms it", () =>
    coalescedConnections(true));

for (const session of ["ses-r2-unaccepted", "ses-r2-silent"]) {
    test(`${session}: a worker with no answer fails without a serving-thread scan and backs off`, async () => {
        await withStore(async (_path, first) => {
            seed(first, session);
            resetRawSessionOrdinalJsonRowsReadForTest();
            const reason = session.includes("unaccepted") ? "not-accepted" : "no-result";
            expect(
                await prewarmRawSessionOrdinalsForDb(first, session, {
                    ...options,
                    acceptMs: 500,
                    resultMs: 30,
                }),
            ).toBe("failed");
            expect(getRawOrdinalWarmupFailures().get(reason)).toBe(1);
            expect(await prewarmRawSessionOrdinalsForDb(first, session, options)).toBe("failed");
            expect(getRawOrdinalWarmupFailures().get(reason)).toBe(1);
            expect(isRawSessionSummaryWarm(first, session)).toBe(false);
            expect(getRawSessionSummaryFullScansForTest()).toBe(0);
        });
    });
}

test("excluded summary writes preserve delayed checkpoints; sessions warm independently", async () => {
    await withStore(async (path, first, second) => {
        const sessions = ["ses-r2-one", "ses-r2-two"];
        for (const s of sessions) seed(first, s);
        const pending = sessions.map((s) => prewarmRawSessionOrdinalsForDb(first, s, options));
        for (const s of sessions) await until(`${path}.${s}.ready`);
        for (const s of sessions) {
            second
                .prepare("INSERT INTO message VALUES (?, ?, 0, 0, ?)")
                .run(`${s}-summary`, s, '{"role":"assistant","summary":true}');
            second
                .prepare(
                    "UPDATE message SET data = json_set(data, '$.finish', 'stop') WHERE id = ?",
                )
                .run(`${s}-summary`);
            writeFileSync(`${path}.${s}.release`, "go");
        }
        expect(await Promise.all(pending)).toEqual(["warm", "warm"]);
        for (const s of sessions)
            expect(await prewarmRawSessionOrdinalsForDb(first, s)).toBe("warm");
        resetRawSessionOrdinalJsonRowsReadForTest();
        for (const s of sessions) {
            expect(isRawSessionSummaryWarm(first, s)).toBe(true);
            expect(readRawSessionMessageOrdinalByIdFromDb(first, s, `${s}-target`)).toBe(1);
        }
        expect(getRawSessionSummaryFullScansForTest()).toBe(0);
    });
});

test("forgotten session rejects a delayed snapshot without backoff and can prepare again", async () => {
    await withStore(async (path, first) => {
        const session = "ses-r2-forgotten";
        seed(first, session);
        const pending = prewarmRawSessionOrdinalsForDb(first, session, options);
        await until(`${path}.${session}.ready`);
        forgetRawSessionSummaryRows(session);
        writeFileSync(`${path}.${session}.release`, "go");
        expect(await pending).toBe("failed");
        expect(getRawOrdinalWarmupFailures().get("superseded")).toBe(1);
        expect(await prewarmRawSessionOrdinalsForDb(first, session, options)).toBe("warm");
    });
});

test("stop resolves both sessions' awaiters as failed, without scanning or installing", async () => {
    await withStore(async (path, first) => {
        const sessions = ["ses-r2-stop-one", "ses-r2-stop-two"];
        for (const s of sessions) seed(first, s);
        resetRawSessionOrdinalJsonRowsReadForTest();
        const pending = sessions.map((s) => prewarmRawSessionOrdinalsForDb(first, s, options));
        for (const s of sessions) await until(`${path}.${s}.ready`);
        stopRawSessionOrdinalWarmups();
        expect(await Promise.all(pending)).toEqual(["failed", "failed"]);
        expect(getRawOrdinalWarmupFailures().get("stopped")).toBe(2);
        for (const s of sessions) expect(isRawSessionSummaryWarm(first, s)).toBe(false);
        expect(getRawSessionSummaryFullScansForTest()).toBe(0);
    });
});

test("a snapshot held past the result deadline is not installed and stays in failure backoff", async () => {
    await withStore(async (path, first) => {
        const session = "ses-r2-too-late";
        seed(first, session);
        resetRawSessionOrdinalJsonRowsReadForTest();
        const pending = prewarmRawSessionOrdinalsForDb(first, session, {
            ...options,
            resultMs: 150,
        });
        await until(`${path}.${session}.ready`);
        expect(await pending).toBe("failed");
        writeFileSync(`${path}.${session}.release`, "too late");
        expect(await prewarmRawSessionOrdinalsForDb(first, session, options)).toBe("failed");
        expect(getRawOrdinalWarmupFailures().get("no-result")).toBe(1);
        expect(isRawSessionSummaryWarm(first, session)).toBe(false);
        expect(getRawSessionSummaryFullScansForTest()).toBe(0);
    });
});

test("an OpenCode 2-style registered provider prepares without a SQLite worker or source reads", async () => {
    let reads = 0;
    const release = setRawMessageProvider("ses-r2-provider", {
        readMessages: () => {
            reads++;
            return [];
        },
        getMessageCount: () => {
            reads++;
            return 0;
        },
    });
    try {
        expect(await prepareRawSessionOrdinals("ses-r2-provider")).toBe(true);
        expect(reads).toBe(0);
        expect([...getRawOrdinalWarmupFailures()]).toEqual([]);
    } finally {
        release();
    }
});

test("a successful warm-up never permits an in-thread rescan after all remembered anchors are deleted", async () => {
    await withStore(async (path, first, second) => {
        const session = "ses-r2-anchors-gone";
        seed(first, session);
        const pending = prewarmRawSessionOrdinalsForDb(first, session, options);
        await until(`${path}.${session}.ready`);
        writeFileSync(`${path}.${session}.release`, "go");
        expect(await pending).toBe("warm");
        second.prepare("DELETE FROM message").run();
        second
            .prepare("INSERT INTO message VALUES ('replacement', ?, 1, 1, ?)")
            .run(session, '{"role":"user"}');
        resetRawSessionOrdinalJsonRowsReadForTest();
        expect(countRawSessionMessageOrdinalsFromDb(first, session)).toBe(1);
        expect(getRawSessionSummaryFullScansForTest()).toBe(0);
        expect([...getRawOrdinalWarmupFailures()]).toEqual([]);
    });
});
