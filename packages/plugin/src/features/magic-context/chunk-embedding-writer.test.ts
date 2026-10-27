import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { getWorkerShutdownStats } from "../../shared/worker-shutdown";
import { createChunkEmbeddingWriter } from "./chunk-embedding-writer";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

test("closing the writer lets its worker close its connection and exit by itself", async () => {
    const { dir, cleanup } = createTestTempDir("mc-chunk-writer-");
    const db = new Database(join(dir, "context.db"));
    try {
        initializeDatabase(db);
        runMigrations(db);
        const before = getWorkerShutdownStats().get("chunk-embedding-writer") ?? {
            graceful: 0,
            forced: 0,
        };
        const writer = createChunkEmbeddingWriter(db);
        if (!writer) throw new Error("file-backed store has no writer");
        // One write, so the worker's writable connection has been used.
        await writer.project("git:chunk-writer", "ses-chunk-writer");
        await writer.close();
        expect(getWorkerShutdownStats().get("chunk-embedding-writer")).toEqual({
            graceful: before.graceful + 1,
            forced: before.forced,
        });
        db.exec("PRAGMA busy_timeout=0");
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
    } finally {
        db.close();
        cleanup();
    }
});
