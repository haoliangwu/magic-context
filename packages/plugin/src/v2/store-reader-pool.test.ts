import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { getV2StoreReaderDebugCounters, V2StoreReaderPool } from "./store-reader";

function fixture(path: string, id = "m1") {
    const writer = new Database(path);
    writer.exec(`
        CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
        INSERT INTO session_message VALUES ('${id}', 's', 'user', 1, 0, '{"text":"original"}');`);
    return writer;
}

test("pooled readers reuse one handle but see WAL edits and reject a closed lease", () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-reader-pool-"));
    const path = join(root, "store.db");
    const writer = fixture(path);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("UPDATE session_message SET time_created = 1");
    const pool = new V2StoreReaderPool();
    const before = getV2StoreReaderDebugCounters();
    try {
        const first = pool.open(path);
        expect(first.messageById("s", "m1")?.data).toEqual({ text: "original" });
        first.close();
        expect(() => first.sequenceForId("s", "m1")).toThrow("closed");
        writer
            .prepare("UPDATE session_message SET data = ? WHERE id = 'm1'")
            .run('{"text":"edited"}');
        const next = pool.open(path);
        expect(next.messageById("s", "m1")?.data).toEqual({ text: "edited" });
        next.close();
        const after = getV2StoreReaderDebugCounters();
        expect(after.readersOpened - before.readersOpened).toBe(1);
        expect(after.readersClosed - before.readersClosed).toBe(0);
        pool.close();
        expect(getV2StoreReaderDebugCounters().readersClosed - before.readersClosed).toBe(1);
        expect(() => pool.open(path)).toThrow("closed");
    } finally {
        pool.close();
        writer.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("pool bounds retained handles and rechecks generation after file replacement", () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-reader-inode-"));
    const path = join(root, "store.db");
    const secondPath = join(root, "second.db");
    fixture(path).close();
    fixture(secondPath, "m2").close();
    const pool = new V2StoreReaderPool(1);
    try {
        const lease = pool.open(path);
        const second = pool.open(secondPath);
        second.close();
        // Eviction cannot close a handle still owned by another caller.
        expect(lease.sequenceForId("s", "m1")).toBe(1);
        lease.close();
        const reopened = pool.open(path);
        reopened.close();
        renameSync(path, join(root, "old.db"));
        fixture(path, "replacement").close();
        const replacement = pool.open(path);
        expect(replacement.sequenceForId("s", "m1")).toBeUndefined();
        expect(replacement.sequenceForId("s", "replacement")).toBe(1);
        replacement.close();
        renameSync(path, join(root, "old2.db"));
        const v1 = new Database(path);
        v1.exec(
            "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY)",
        );
        v1.close();
        expect(() => pool.open(path)).toThrow();
        rmSync(path);
        expect(() => pool.open(path)).toThrow();
    } finally {
        pool.close();
        rmSync(root, { recursive: true, force: true });
    }
});
