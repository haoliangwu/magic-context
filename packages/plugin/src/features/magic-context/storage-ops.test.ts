/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearPendingOps,
    getPendingOps,
    getPendingOpsCount,
    hasPendingDropOps,
    queuePendingOp,
    removePendingOp,
} from "./storage-ops";

let db: Database;

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return d;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("storage-ops", () => {
    describe("pending ops", () => {
        it("100 enqueues are idempotent per session, tag and operation and preserve the first row", () => {
            db = makeMemoryDatabase();
            queuePendingOp(db, "ses-1", 1, "drop", 10);
            const first = getPendingOps(db, "ses-1");
            for (let n = 0; n < 99; n++) queuePendingOp(db, "ses-1", 1, "drop", 20 + n);
            expect(getPendingOps(db, "ses-1")).toEqual(first);
            expect(getPendingOpsCount(db, "ses-1")).toBe(1);
            // Queue identity includes the operation and session: a noop can coexist
            // with a drop, and tag numbers are independent across sessions.
            db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            ).run("ses-1", 2, "noop", 1);
            queuePendingOp(db, "ses-1", 2, "drop", 200);
            queuePendingOp(db, "ses-2", 1, "drop", 300);
            expect(getPendingOps(db, "ses-1").map((op) => op.tagId)).toEqual([1, 2]);
            expect(getPendingOps(db, "ses-2")).toHaveLength(1);
            removePendingOp(db, "ses-1", 1);
            queuePendingOp(db, "ses-1", 1, "drop", 400);
            expect(getPendingOps(db, "ses-1").map((op) => op.queuedAt)).toEqual([200, 400]);
        });

        it("probes pending drops with a scalar read instead of materializing queue rows", () => {
            db = makeMemoryDatabase();
            queuePendingOp(db, "ses-probe", 1, "drop", 1);
            let allCalls = 0;
            const prepare = db.prepare.bind(db);
            const spy = spyOn(db, "prepare").mockImplementation(((
                ...args: Parameters<typeof db.prepare>
            ) => {
                const statement = prepare(...args);
                return new Proxy(statement, {
                    get(target, key) {
                        const value = Reflect.get(target, key);
                        if (key === "all")
                            return (...params: unknown[]) => {
                                allCalls++;
                                return value.apply(target, params);
                            };
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });
            }) as typeof db.prepare);
            try {
                expect(hasPendingDropOps(db, "ses-probe")).toBe(true);
                expect(allCalls).toBe(0);
            } finally {
                spy.mockRestore();
            }
        });

        it("probes only valid session-local drops, including real-valued number fields", () => {
            db = makeMemoryDatabase();
            const insert = db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            );
            insert.run("ses-1", 1, "noop", 1);
            insert.run("ses-1", null, "drop", 1);
            insert.run("ses-1", 1, "drop", null);
            insert.run("ses-1", "malformed", "drop", 1);
            queuePendingOp(db, "ses-2", 2, "drop", 2);
            expect(hasPendingDropOps(db, "ses-1")).toBe(false);
            expect(hasPendingDropOps(db, "ses-2")).toBe(true);
            expect(hasPendingDropOps(db, "missing")).toBe(false);
            insert.run("ses-1", 1.5, "drop", 2.5);
            expect(hasPendingDropOps(db, "ses-1")).toBe(true);
            removePendingOp(db, "ses-1", 1.5);
            expect(hasPendingDropOps(db, "ses-1")).toBe(false);
        });

        it("queues and returns drop ops in order", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop", 10);
            queuePendingOp(db, "ses-1", 2, "drop", 20);

            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tagId: 1, operation: "drop", queuedAt: 10 }),
                expect.objectContaining({ tagId: 2, operation: "drop", queuedAt: 20 }),
            ]);
        });

        it("reports durable queue depth without loading pending-op rows", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop");
            queuePendingOp(db, "ses-1", 2, "drop");
            db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            ).run("ses-1", 3, "noop", Date.now());

            expect(getPendingOpsCount(db, "ses-1")).toBe(3);
            expect(getPendingOpsCount(db, "ses-2")).toBe(0);
        });

        it("ignores unsupported pending-op rows", () => {
            db = makeMemoryDatabase();

            db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            ).run("ses-1", 1, "noop", Date.now());
            queuePendingOp(db, "ses-1", 2, "drop");

            const ops = getPendingOps(db, "ses-1");

            expect(ops).toHaveLength(1);
            expect(ops[0]?.tagId).toBe(2);
            expect(ops[0]?.operation).toBe("drop");
        });

        it("clears and removes pending ops by session/tag", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop");
            queuePendingOp(db, "ses-1", 2, "drop");
            queuePendingOp(db, "ses-2", 3, "drop");

            removePendingOp(db, "ses-1", 1);
            expect(getPendingOps(db, "ses-1")).toHaveLength(1);

            clearPendingOps(db, "ses-1");
            expect(getPendingOps(db, "ses-1")).toEqual([]);
            expect(getPendingOps(db, "ses-2")).toHaveLength(1);
        });
    });

    describe("error propagation", () => {
        it("throws when the database layer fails", () => {
            const failingDb = {
                prepare: () => {
                    throw new Error("db-error");
                },
            } as unknown as Database;

            expect(() => queuePendingOp(failingDb, "s", 1, "drop")).toThrow("db-error");
            expect(() => getPendingOps(failingDb, "s")).toThrow("db-error");
            expect(() => hasPendingDropOps(failingDb, "s")).toThrow("db-error");
            expect(() => clearPendingOps(failingDb, "s")).toThrow("db-error");
            expect(() => removePendingOp(failingDb, "s", 1)).toThrow("db-error");
        });
    });
});
