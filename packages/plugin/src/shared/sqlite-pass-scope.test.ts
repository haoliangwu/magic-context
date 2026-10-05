import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    beginSqliteWriterAsync,
    Database,
    isTransientSqliteError,
    SqliteAcquisitionBusyError,
    withAsyncPrivilegedWriter,
    withPrivilegedWriter,
    withSqliteBackgroundWriter,
    withSqliteTransformPass,
} from "./sqlite";
import { startSqliteWriteLocker } from "./sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "./test-temp-dir";

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-busy-yield-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
    );
    db.exec("PRAGMA busy_timeout=5000");
    return {
        db,
        path,
        close: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("tool-style transaction outside a pass waits for a brief lock", async () => {
    const { db, path, close } = fixture();
    const locker = await startSqliteWriteLocker(path, 300);
    try {
        const start = performance.now();
        db.transaction(() =>
            db.prepare("INSERT INTO context_privilege_state(id, enabled) VALUES (1, 0)").run(),
        ).immediate();
        expect(performance.now() - start).toBeGreaterThanOrEqual(250);
        expect(db.prepare("SELECT COUNT(*) AS count FROM context_privilege_state").get()).toEqual({
            count: 1,
        });
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        await locker.exited;
        close();
    }
}, 30000);

test("named background acquisition gives up quickly and leaves work for retry", () => {
    const { db, path, close } = fixture();
    const blocker = new Database(path);
    blocker.exec("BEGIN IMMEDIATE");
    let calls = 0;
    let retryQueued = false;
    try {
        const start = performance.now();
        try {
            withSqliteBackgroundWriter(() => db.transaction(() => calls++)());
        } catch (error) {
            if (!isTransientSqliteError(error)) throw error;
            retryQueued = true;
        }
        expect(performance.now() - start).toBeLessThan(250);
        expect(retryQueued).toBe(true);
        expect(calls).toBe(0);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        close();
    }
});

test("foreground admission keeps the loop ticking while a separate writer holds the lock", async () => {
    const { db, path, close } = fixture();
    const locker = await startSqliteWriteLocker(path, 650);
    let timerFired = false;
    let calls = 0;
    try {
        setTimeout(() => {
            timerFired = true;
        }, 100);
        await withSqliteTransformPass(() =>
            withAsyncPrivilegedWriter(db, () => {
                calls++;
            }),
        );
        expect(timerFired).toBe(true);
        expect(calls).toBe(1);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        await locker.exited;
        close();
    }
}, 30000);

test("a foreground in-pass writer has bounded 250ms tolerance and restores its timeout", () => {
    const { db, path, close } = fixture();
    const blocker = new Database(path);
    blocker.exec("BEGIN IMMEDIATE");
    try {
        const start = performance.now();
        expect(() =>
            withSqliteTransformPass(() => withPrivilegedWriter(db, () => undefined)),
        ).toThrow(SqliteAcquisitionBusyError);
        expect(performance.now() - start).toBeGreaterThanOrEqual(200);
        expect(performance.now() - start).toBeLessThan(400);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        close();
    }
});

test("ready background publication retries on a timer and retains its write", async () => {
    const { db, path, close } = fixture();
    const locker = await startSqliteWriteLocker(path, 650);
    let ticked = false;
    try {
        setTimeout(() => {
            ticked = true;
        }, 100);
        await beginSqliteWriterAsync(db, "historian-publish");
        db.prepare("INSERT INTO context_privilege_state(id, enabled) VALUES (1, 0)").run();
        db.exec("COMMIT");
        expect(ticked).toBe(true);
        expect(db.prepare("SELECT COUNT(*) AS count FROM context_privilege_state").get()).toEqual({
            count: 1,
        });
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        await locker.exited;
        close();
    }
}, 30000);

test("an in-pass BEGIN tolerates a sibling writer that releases within 250ms", async () => {
    const { db, path, close } = fixture();
    const locker = await startSqliteWriteLocker(path, 150);
    try {
        withSqliteTransformPass(() => withPrivilegedWriter(db, () => undefined));
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        await locker.exited;
        close();
    }
}, 30000);
