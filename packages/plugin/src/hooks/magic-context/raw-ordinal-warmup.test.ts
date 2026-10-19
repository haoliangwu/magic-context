/// <reference types="bun-types" />

import { Database as UnwrappedDatabase } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { scheduleIncrementalIndex } from "../../features/magic-context/message-index-async";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    getRawOrdinalWarmupFailures,
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
    stopRawSessionOrdinalWarmups,
} from "./raw-ordinal-warmup";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionSummaryEpoch,
    getRawSessionSummaryFullScansForTest,
    installRawSessionSummaryScan,
    isRawSessionSummaryWarm,
    type RawMessage,
    readRawSessionMessageByIdFromDb,
    resetRawSessionOrdinalJsonRowsReadForTest,
    scanRawSessionSummaryRows,
} from "./read-session-raw";

const SESSION = "ses-warmup";
const OLD_COUNT = `SELECT COUNT(*) AS count FROM message
    WHERE session_id = ?
      AND NOT (CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
               AND CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
      AND (time_created < ? OR (time_created = ? AND id <= ?))`;

function oldOrdinal(db: Database | UnwrappedDatabase, id: string): number {
    const row = db.prepare("SELECT time_created FROM message WHERE id = ?").get(id) as {
        time_created: number;
    };
    return (
        db.prepare(OLD_COUNT).get(SESSION, row.time_created, row.time_created, id) as {
            count: number;
        }
    ).count;
}

function insert(
    db: Database | UnwrappedDatabase,
    id: string,
    time: number,
    info: Record<string, unknown> = { role: "user" },
): void {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        id,
        SESSION,
        time,
        time,
        JSON.stringify(info),
    );
}

const id = (index: number) => `msg_${String(index).padStart(6, "0")}`;

/** A file store with `length` messages, a finished summary every 50th. */
function withStore(length: number, run: (path: string, reader: Database) => Promise<void> | void) {
    return async () => {
        const { dir, cleanup } = createTestTempDir("mc-ordinal-warmup-");
        const path = join(dir, "opencode-fixture.db");
        const setup = new UnwrappedDatabase(path);
        setup.exec("PRAGMA journal_mode = WAL");
        setup.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        setup.transaction(() => {
            for (let index = 0; index < length; index += 1)
                insert(
                    setup,
                    id(index),
                    index,
                    index % 50 === 49
                        ? { role: "assistant", summary: true, finish: "stop" }
                        : { role: "user" },
                );
        })();
        setup.close();
        const reader = new Database(path, { readonly: true });
        try {
            await run(path, reader);
        } finally {
            reader.close();
            cleanup();
        }
    };
}

afterEach(() => resetRawSessionOrdinalWarmupsForTest());

describe("canonical ordinal warm-up", () => {
    it(
        "scans on a worker and leaves the serving connection nothing to scan",
        withStore(600, async (_path, reader) => {
            expect(isRawSessionSummaryWarm(reader, SESSION)).toBe(false);
            resetRawSessionOrdinalJsonRowsReadForTest();
            expect(
                await prewarmRawSessionOrdinalsForDb(reader, SESSION, { inThreadMaxRows: 10 }),
            ).toBe("warm");
            expect(isRawSessionSummaryWarm(reader, SESSION)).toBe(true);
            expect(readRawSessionMessageByIdFromDb(reader, SESSION, id(598))?.ordinal).toBe(
                oldOrdinal(reader, id(598)),
            );
            // Neither the warm-up nor the count scanned the session on this thread.
            expect(getRawSessionSummaryFullScansForTest()).toBe(0);
        }),
    );

    it(
        "counts rows written while the scan ran, including a reused top rowid and a summary behind the tail",
        withStore(300, async (path, reader) => {
            const epoch = getRawSessionSummaryEpoch(SESSION);
            // The worker's part: a scan on its own connection.
            const scanner = new Database(path, { readonly: true });
            const scan = scanRawSessionSummaryRows(scanner, SESSION);
            scanner.close();
            // Writes that land after the scan's snapshot and before it is installed.
            const writer = new UnwrappedDatabase(path);
            writer.exec("PRAGMA busy_timeout = 1000");
            writer.prepare("DELETE FROM message WHERE id = ?").run(id(299));
            insert(writer, "summary-late", 10, {
                role: "assistant",
                summary: true,
                finish: "stop",
            });
            insert(writer, "open-summary", 20, { role: "assistant", summary: true });
            insert(writer, "tail", 400);
            writer
                .prepare("UPDATE message SET data = ? WHERE id = 'open-summary'")
                .run(JSON.stringify({ role: "assistant", summary: true, finish: "stop" }));
            writer.close();
            expect(installRawSessionSummaryScan(reader, SESSION, scan, epoch)).toBe(false);
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            resetRawSessionOrdinalJsonRowsReadForTest();
            expect(readRawSessionMessageByIdFromDb(reader, SESSION, "tail")?.ordinal).toBe(
                oldOrdinal(reader, "tail"),
            );
            expect(readRawSessionMessageByIdFromDb(reader, SESSION, id(150))?.ordinal).toBe(
                oldOrdinal(reader, id(150)),
            );
            expect(getRawSessionSummaryFullScansForTest()).toBe(0);
        }),
    );

    it(
        "reports a failed worker, counts it, and does not start another for the session within the backoff",
        withStore(100, async (_path, reader) => {
            const missing = new URL("./no-such-raw-ordinal-worker.ts", import.meta.url);
            expect(
                await prewarmRawSessionOrdinalsForDb(reader, SESSION, {
                    entry: missing,
                    inThreadMaxRows: 10,
                }),
            ).toBe("failed");
            const failures = [...getRawOrdinalWarmupFailures().values()].reduce((a, b) => a + b, 0);
            expect(failures).toBe(1);
            // Within the backoff the answer is immediate and no worker starts.
            expect(
                await prewarmRawSessionOrdinalsForDb(reader, SESSION, {
                    entry: missing,
                    inThreadMaxRows: 10,
                }),
            ).toBe("failed");
            expect([...getRawOrdinalWarmupFailures().values()].reduce((a, b) => a + b, 0)).toBe(1);
            // The failure never scanned the session on this thread.
            expect(isRawSessionSummaryWarm(reader, SESSION)).toBe(false);
        }),
    );

    it(
        "stops a running worker on shutdown",
        withStore(100, async (_path, reader) => {
            const silent = new URL(
                "./raw-ordinal-warmup-silent-worker.fixture.ts",
                import.meta.url,
            );
            const pending = prewarmRawSessionOrdinalsForDb(reader, SESSION, {
                entry: silent,
                inThreadMaxRows: 10,
                resultMs: 60_000,
            });
            await Bun.sleep(200);
            stopRawSessionOrdinalWarmups();
            expect(await pending).toBe("failed");
            expect(getRawOrdinalWarmupFailures().get("stopped")).toBe(1);
        }),
    );

    it(
        "scans even a small file session on the worker",
        withStore(100, async (_path, reader) => {
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            expect(isRawSessionSummaryWarm(reader, SESSION)).toBe(true);
            expect(countRawSessionMessageOrdinalsFromDb(reader, SESSION)).toBe(98);
        }),
    );
});

describe("message indexing waits for the warm-up", () => {
    it("does not read the session while its source cannot be prepared", async () => {
        const db = new Database(":memory:");
        let reads = 0;
        let prepares = 0;
        const source = Object.assign(
            (_sessionId: string, _messageId: string): RawMessage | null => {
                reads += 1;
                return null;
            },
            {
                prepare: async () => {
                    prepares += 1;
                    return false;
                },
            },
        );
        try {
            scheduleIncrementalIndex(db, "ses-deferred", "msg-1", source);
            await Bun.sleep(300);
            expect({ prepares, reads }).toEqual({ prepares: 1, reads: 0 });
        } finally {
            db.close();
        }
    });
});
