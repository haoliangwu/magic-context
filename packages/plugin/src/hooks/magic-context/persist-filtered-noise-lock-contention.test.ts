/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { startSqliteWriteLocker } from "../../shared/sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { persistFilteredNoise } from "./persist-filtered-noise";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REAL_COMPARTMENT = {
    sequence: 0,
    startMessage: 1,
    endMessage: 1,
    startMessageId: "m1",
    endMessageId: "m1",
    title: "Real",
    content: "Full",
    p1: "Full",
    p2: "Short",
    p3: "Tiny",
    p4: "Title",
};

/** Seed one real compartment and a raw provider whose ordinal 2 is filtered noise. */
function seedSession(db: Database, sessionId: string): void {
    appendCompartments(db, sessionId, [REAL_COMPARTMENT]);
    cleanups.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [
                {
                    ordinal: 2,
                    id: "m2",
                    role: "assistant",
                    parts: [{ type: "reasoning", text: "noise" }],
                },
            ],
        }),
    );
}

function persistNoiseHead(db: Database, sessionId: string): boolean {
    return persistFilteredNoise(db, sessionId, readSessionChunk(sessionId, 1000, 2, 3), 3);
}

describe("persistFilteredNoise write lock", () => {
    it("waits outside a pass for a brief write lock without a partial append", async () => {
        const directory = createTestTempDirFromPath(
            join(tmpdir(), "persist-filtered-noise-lock-contention-"),
        );
        cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
        const dbPath = join(directory, "context.db");
        const db = openDatabase(dbPath);
        if (!db) throw new Error("file-backed test database did not open");
        cleanups.push(() => closeQuietly(db));
        const sessionId = "ses_noise_lock";
        seedSession(db, sessionId);

        const locker = await startSqliteWriteLocker(dbPath, 800);
        const startedAt = performance.now();
        try {
            expect(persistNoiseHead(db, sessionId)).toBe(true);
            expect(performance.now() - startedAt).toBeGreaterThanOrEqual(700);
            expect(getCompartments(db, sessionId)).toHaveLength(2);
        } finally {
            await locker.exited;
        }
        expect(getCompartments(db, sessionId).map((row) => row.endMessageId)).toEqual(["m1", "m2"]);
    }, 20_000);

    describe("called inside a caller's transaction", () => {
        function memoryDb(): Database {
            const db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            cleanups.push(() => db.close());
            return db;
        }

        it("nests as a savepoint inside an immediate transaction and rolls back with it", () => {
            const db = memoryDb();
            const sessionId = "ses_nested_immediate";
            seedSession(db, sessionId);

            expect(() =>
                db
                    .transaction(() => {
                        expect(persistNoiseHead(db, sessionId)).toBe(true);
                        expect(getCompartments(db, sessionId)).toHaveLength(2);
                        throw new Error("outer rollback");
                    })
                    .immediate(),
            ).toThrow("outer rollback");
            expect(getCompartments(db, sessionId)).toHaveLength(1);
        });

        it("nests inside a deferred transaction and a manual BEGIN IMMEDIATE", () => {
            const db = memoryDb();
            const sessionId = "ses_nested_other";
            seedSession(db, sessionId);

            db.transaction(() => {
                expect(persistNoiseHead(db, sessionId)).toBe(true);
            })();
            expect(getCompartments(db, sessionId)).toHaveLength(2);

            db.exec("DELETE FROM compartments WHERE sequence = 1");
            db.exec("BEGIN IMMEDIATE");
            try {
                expect(persistNoiseHead(db, sessionId)).toBe(true);
                db.exec("COMMIT");
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
            expect(getCompartments(db, sessionId)).toHaveLength(2);
        });
    });
});
