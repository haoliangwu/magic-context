import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { ensureColumn } from "./storage-schema-helpers";

describe("schema column discovery", () => {
    it("does not cache schema discovery when a proxy cannot report transaction state", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE probe(a INTEGER)");
        let tableInfoReads = 0;
        const proxy = new Proxy(db, {
            get(target, property) {
                if (property === "inTransaction" || property === "isTransaction")
                    throw new Error("unknown transaction");
                if (property === "prepare")
                    return (sql: string) => {
                        if (sql === "PRAGMA table_info(probe)") tableInfoReads++;
                        return target.prepare(sql);
                    };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        try {
            ensureColumn(proxy, "probe", "a", "INTEGER");
            ensureColumn(proxy, "probe", "a", "INTEGER");
            expect(tableInfoReads).toBe(2);
        } finally {
            db.close();
        }
    });
    it("reuses one table_info read while the committed schema is unchanged", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE probe(a INTEGER, b TEXT)");
        const spy = spyOn(db, "prepare");
        try {
            for (let i = 0; i < 171; i++) ensureColumn(db, "probe", i % 2 ? "a" : "b", "TEXT");
            expect(
                spy.mock.calls.filter(([sql]) => sql === "PRAGMA table_info(probe)"),
            ).toHaveLength(1);
        } finally {
            spy.mockRestore();
            db.close();
        }
    });

    it("discovers a same-connection DROP and recreation before ensuring columns", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE probe(a INTEGER, b TEXT)");
            ensureColumn(db, "probe", "b", "TEXT");
            db.exec("DROP TABLE probe; CREATE TABLE probe(a INTEGER)");
            ensureColumn(db, "probe", "b", "TEXT");
            expect(db.prepare("SELECT b FROM probe").all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("invalidates column discovery after a sibling connection changes the schema", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-columns-"));
        const path = join(root, "context.db");
        const db = new Database(path);
        const sibling = new Database(path);
        try {
            db.exec("CREATE TABLE probe(a INTEGER, b TEXT)");
            ensureColumn(db, "probe", "b", "TEXT");
            sibling.exec("DROP TABLE probe; CREATE TABLE probe(a INTEGER)");
            ensureColumn(db, "probe", "b", "TEXT");
            expect(db.prepare("SELECT b FROM probe").all()).toEqual([]);
        } finally {
            db.close();
            sibling.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not retain a rolled-back schema when its version is reused by another ALTER", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE probe(a INTEGER)");
            expect(() =>
                db.transaction(() => {
                    ensureColumn(db, "probe", "doomed", "TEXT");
                    ensureColumn(db, "probe", "doomed", "TEXT");
                    throw new Error("rollback");
                })(),
            ).toThrow("rollback");
            db.exec("ALTER TABLE probe ADD COLUMN other TEXT");
            ensureColumn(db, "probe", "doomed", "TEXT");
            expect(db.prepare("SELECT doomed, other FROM probe").all()).toEqual([]);
        } finally {
            db.close();
        }
    });
});
