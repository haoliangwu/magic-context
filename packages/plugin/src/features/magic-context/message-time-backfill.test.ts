/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    backfillMessageTimesBatch,
    getMessageTimeBackfillProgress,
    type MessageTimeBackfillReader,
} from "./message-time-backfill";
import { initializeDatabase } from "./storage-db";

const tempDirectories: string[] = [];

afterEach(() => {
    for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
    tempDirectories.length = 0;
});

function createDb(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    return db;
}

function seedIndexedRows(db: Database, sessionId: string, count: number): void {
    const insertFts = db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)",
    );
    const insertMap = db.prepare(
        "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid) VALUES (?, ?, ?)",
    );
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        const result = insertFts.run(
            sessionId,
            ordinal,
            `${sessionId}-m${ordinal}`,
            `row ${ordinal}`,
        ) as {
            lastInsertRowid: number | bigint;
        };
        insertMap.run(sessionId, ordinal, Number(result.lastInsertRowid));
    }
}

function readerFor(rows: ReadonlyMap<string, RawMessage[]>): MessageTimeBackfillReader {
    const read = ((sessionId: string) => [
        ...(rows.get(sessionId) ?? []),
    ]) as MessageTimeBackfillReader;
    read.readPage = (sessionId, afterOrdinal, limit, finalWatermark) =>
        (rows.get(sessionId) ?? [])
            .filter(
                (message) => message.ordinal > afterOrdinal && message.ordinal <= finalWatermark,
            )
            .slice(0, limit);
    return read;
}

describe("message time backfill", () => {
    test("persists bounded progress and resumes after reopening the database", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "message-time-backfill-"));
        tempDirectories.push(directory);
        const path = join(directory, "context.db");
        const rows = new Map<string, RawMessage[]>([
            [
                "ses",
                Array.from({ length: 5 }, (_, index) => ({
                    ordinal: index + 1,
                    id: `ses-m${index + 1}`,
                    role: "user",
                    parts: [],
                    createdAt: 1_000 + index,
                })),
            ],
        ]);
        let db = createDb(path);
        seedIndexedRows(db, "ses", 5);

        expect(backfillMessageTimesBatch(db, readerFor(rows), 2)).toMatchObject({
            processed: 2,
            cursorSessionId: "ses",
            cursorOrdinal: 2,
            completed: false,
        });
        closeQuietly(db);

        db = createDb(path);
        expect(getMessageTimeBackfillProgress(db)).toMatchObject({
            cursorSessionId: "ses",
            cursorOrdinal: 2,
            completed: false,
        });
        backfillMessageTimesBatch(db, readerFor(rows), 2);
        backfillMessageTimesBatch(db, readerFor(rows), 2);
        expect(
            db
                .prepare(
                    "SELECT message_ordinal, message_time_ms FROM message_fts_rowid_map ORDER BY message_ordinal",
                )
                .all(),
        ).toEqual(
            Array.from({ length: 5 }, (_, index) => ({
                message_ordinal: index + 1,
                message_time_ms: 1_000 + index,
            })),
        );
        closeQuietly(db);
    });

    test("a host-read failure mid-page commits neither timestamps nor cursor", () => {
        const db = createDb();
        try {
            seedIndexedRows(db, "a", 1);
            seedIndexedRows(db, "b", 1);
            const failing = readerFor(
                new Map([
                    ["a", [{ ordinal: 1, id: "a-m1", role: "user", parts: [], createdAt: 10 }]],
                ]),
            );
            const baseReadPage = failing.readPage!;
            failing.readPage = (sessionId, afterOrdinal, limit, finalWatermark) => {
                if (sessionId === "b") throw new Error("simulated restart");
                return baseReadPage(sessionId, afterOrdinal, limit, finalWatermark);
            };

            expect(() => backfillMessageTimesBatch(db, failing, 10)).toThrow("simulated restart");
            expect(getMessageTimeBackfillProgress(db)).toMatchObject({
                cursorSessionId: "",
                cursorOrdinal: 0,
                completed: false,
            });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM message_fts_rowid_map WHERE message_time_ms IS NOT NULL",
                    )
                    .get(),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("leaves rows NULL when their host message no longer exists", () => {
        const db = createDb();
        try {
            seedIndexedRows(db, "missing", 1);
            expect(backfillMessageTimesBatch(db, readerFor(new Map()), 10)).toMatchObject({
                processed: 1,
                completed: true,
            });
            expect(
                db
                    .prepare(
                        "SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id = 'missing'",
                    )
                    .get(),
            ).toEqual({ message_time_ms: null });
        } finally {
            closeQuietly(db);
        }
    });
});
