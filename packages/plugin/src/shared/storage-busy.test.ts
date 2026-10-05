import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Database,
    isTransientSqliteError,
    withAsyncPrivilegedWriter,
    withPrivilegedWriter,
} from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

describe("writer acquisition", () => {
    test("exhausted async admission preserves the foreground budget and never invokes the callback", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-writer-budget-"));
        const path = join(dir, "context.db");
        const blocker = new Database(path);
        blocker.exec(
            "CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
        );
        const db = new Database(path);
        db.exec("PRAGMA busy_timeout=5000");
        blocker.exec("BEGIN IMMEDIATE");
        let calls = 0;
        let ticks = 0;
        const timer = setInterval(() => ticks++, 50);
        const started = performance.now();
        try {
            await expect(withAsyncPrivilegedWriter(db, () => calls++)).rejects.toThrow(
                "acquisition remained busy",
            );
            expect(performance.now() - started).toBeGreaterThanOrEqual(16_500);
            expect(performance.now() - started).toBeLessThan(17_500);
            expect(ticks).toBeGreaterThan(100);
            expect(calls).toBe(0);
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        } finally {
            clearInterval(timer);
            blocker.exec("ROLLBACK");
            blocker.close();
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);

    test("busy callback rolls back without retrying mutations", () => {
        const db = new Database(":memory:");
        db.exec(
            "CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER); CREATE TABLE result(value TEXT)",
        );
        let calls = 0;
        try {
            expect(() =>
                withPrivilegedWriter(db, () => {
                    calls++;
                    db.exec("INSERT INTO result VALUES ('partial')");
                    throw Object.assign(new Error("after acquisition"), { code: "SQLITE_BUSY" });
                }),
            ).toThrow("after acquisition");
            expect(calls).toBe(1);
            expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    test("recognizes Bun extended and Node numeric contention codes only", () => {
        expect(isTransientSqliteError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
        expect(isTransientSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBe(true);
        expect(isTransientSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 262 })).toBe(true);
        expect(isTransientSqliteError({ code: "SQLITE_CORRUPT" })).toBe(false);
    });
});
