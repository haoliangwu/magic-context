import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    openDatabase,
    openDatabaseAsync,
} from "../features/magic-context/storage-db";
import { Database } from "./sqlite";
import { configureContextDatabasePragmas } from "./sqlite-context-pragmas";
import { createTestTempDirFromPath } from "./test-temp-dir";

const roots: string[] = [];
function fixturePath(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-context-pragmas-"));
    roots.push(root);
    return join(root, "context.db");
}
afterEach(() => {
    closeDatabase();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("context database durability", () => {
    it("fresh synchronous open uses WAL and synchronous=NORMAL", () => {
        const db = openDatabase(fixturePath());
        expect(db?.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(db?.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    });

    it("fresh async open uses WAL and synchronous=NORMAL", async () => {
        const db = await openDatabaseAsync({ dbPath: fixturePath() });
        expect(db?.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(db?.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    });

    it("refuses NORMAL when SQLite cannot activate WAL", () => {
        const db = new Database(fixturePath());
        const prepare = db.prepare.bind(db);
        const spy = spyOn(db, "prepare").mockImplementation((sql: string) =>
            prepare(sql === "PRAGMA journal_mode=WAL" ? "PRAGMA journal_mode" : sql),
        );
        try {
            expect(() => configureContextDatabasePragmas(db)).toThrow("requires WAL");
            expect(prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
        } finally {
            spy.mockRestore();
            db.close();
        }
    });

    it("read-only inspection leaves a rollback-journal store unchanged", () => {
        const path = fixturePath();
        const writer = new Database(path);
        writer.exec("CREATE TABLE probe(id INTEGER)");
        writer.close();
        const bytes = readFileSync(path);
        const reader = new Database(path, { readonly: true });
        try {
            configureContextDatabasePragmas(reader, true);
            expect(reader.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
            expect(reader.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
        } finally {
            reader.close();
        }
        expect(readFileSync(path)).toEqual(bytes);
    });

    it("an independently reopened WAL writer receives the connection-local policy", () => {
        const path = fixturePath();
        const first = new Database(path);
        configureContextDatabasePragmas(first);
        first.close();
        const reopened = new Database(path);
        try {
            // Bun defaults WAL to NORMAL; Node defaults it to FULL. Exercise an
            // explicit FULL connection so the assertion is portable to both.
            reopened.exec("PRAGMA synchronous=FULL");
            expect(reopened.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
            configureContextDatabasePragmas(reopened);
            expect(reopened.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
        } finally {
            reopened.close();
        }
    });

    it("WAL configuration releases its read cursor before a sibling commits", () => {
        const path = fixturePath();
        const db = new Database(path);
        const sibling = new Database(path);
        try {
            configureContextDatabasePragmas(db);
            db.exec(
                "CREATE TABLE probe(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO probe VALUES (1, 0)",
            );
            sibling.exec("UPDATE probe SET value = 1 WHERE id = 1");
            db.exec("UPDATE probe SET value = 2 WHERE id = 1");
            expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value: 2 });
        } finally {
            db.close();
            sibling.close();
        }
    });
});
