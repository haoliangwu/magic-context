/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    ensureContextStoreUuid,
    installAuthorityManagedMarker,
} from "./legacy-authority-fixture.test-support";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

// The durable predicate every authority guard must carry after v71. Asserted
// byte-for-byte against sqlite_master.sql so a future regression that re-introduces
// a connection-local UDF reference (or drops the guard) is pinned exactly.
const STATE_TABLE_PREDICATE =
    "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";

const GUARD_TRIGGERS = [
    "memories_authority_guard_insert",
    "memories_authority_guard_update",
    "memories_authority_guard_delete",
    "notes_authority_guard_insert",
    "notes_authority_guard_update",
    "notes_authority_guard_delete",
] as const;

const databases: DatabaseType[] = [];
const tempDirs: string[] = [];

function track<T extends DatabaseType>(db: T): T {
    databases.push(db);
    return db;
}

function freshMigratedDatabase(path = ":memory:"): DatabaseType {
    const db = track(new Database(path));
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Drop the v71 record so runMigrations re-applies the trigger rebuild. */
function resetV71(db: DatabaseType): void {
    db.prepare("DELETE FROM schema_migrations WHERE version >= 71").run();
}

/**
 * Bake the LEGACY trigger shape: the connection-local `mc_privileged_writer()` UDF
 * reference that migrations produced when the migrating runtime supported scalar UDFs.
 * This reproduces a database migrated under an older UDF-capable runtime, which is the
 * exact variant that broke every non-registering connection (issue #253).
 */
function bakeLegacyUdfTriggers(db: DatabaseType): void {
    const udf = "mc_privileged_writer() = 0";
    db.exec(`
        DROP TRIGGER IF EXISTS memories_authority_guard_insert;
        DROP TRIGGER IF EXISTS memories_authority_guard_update;
        DROP TRIGGER IF EXISTS memories_authority_guard_delete;
        CREATE TRIGGER memories_authority_guard_insert
        BEFORE INSERT ON memories
        WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
          AND ${udf}
        BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
        CREATE TRIGGER memories_authority_guard_update
        BEFORE UPDATE ON memories
        WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
           OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
          AND ${udf}
        BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
        CREATE TRIGGER memories_authority_guard_delete
        BEFORE DELETE ON memories
        WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
          AND ${udf}
        BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
        DROP TRIGGER IF EXISTS notes_authority_guard_insert;
        DROP TRIGGER IF EXISTS notes_authority_guard_update;
        DROP TRIGGER IF EXISTS notes_authority_guard_delete;
        CREATE TRIGGER notes_authority_guard_insert
        BEFORE INSERT ON notes
        WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
          AND ${udf}
        BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
        CREATE TRIGGER notes_authority_guard_update
        BEFORE UPDATE ON notes
        WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
           OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
          AND ${udf}
        BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
        CREATE TRIGGER notes_authority_guard_delete
        BEFORE DELETE ON notes
        WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
           OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
          AND ${udf}
        BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
    `);
}

function triggerSql(db: DatabaseType, name: string): string {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(name) as { sql?: string } | null;
    if (!row?.sql) throw new Error(`trigger ${name} not found`);
    return row.sql;
}

function insertMemory(db: DatabaseType, projectPath: string, content: string): void {
    db.prepare(
        "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
    ).run(projectPath, "CONSTRAINTS", content, `hash-${content}`);
}

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migration v71: authority guards use the durable state-table predicate (issue #253)", () => {
    it("rebuilds legacy UDF-form triggers to reference context_privilege_state, not the UDF", () => {
        const db = freshMigratedDatabase();
        // Simulate a database migrated under an older UDF-capable runtime: roll back the
        // v71 record and bake the legacy UDF-reference triggers, then re-run the migration.
        resetV71(db);
        bakeLegacyUdfTriggers(db);
        // Sanity: the fixture really does carry the UDF reference before the migration.
        expect(triggerSql(db, "memories_authority_guard_insert")).toContain("mc_privileged_writer");

        runMigrations(db);

        // Byte-level: every guard now carries the exact durable predicate and no UDF ref.
        for (const name of GUARD_TRIGGERS) {
            const sql = triggerSql(db, name);
            expect(sql).toContain(STATE_TABLE_PREDICATE);
            expect(sql).not.toContain("mc_privileged_writer");
        }
    });

    it("is idempotent on a database that already has state-form triggers", () => {
        const db = freshMigratedDatabase();
        const before = GUARD_TRIGGERS.map((name) => triggerSql(db, name));
        resetV71(db);

        runMigrations(db);

        const after = GUARD_TRIGGERS.map((name) => triggerSql(db, name));
        expect(after).toEqual(before);
        for (const sql of after) {
            expect(sql).toContain(STATE_TABLE_PREDICATE);
            expect(sql).not.toContain("mc_privileged_writer");
        }
    });

    it("lets a second, raw connection write to a guarded table without 'no such function'", () => {
        // A file-backed DB so two independent connections can open the same schema.
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-v71-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "context.db");

        // Connection A: migrate and mark the project module-managed.
        const connA = freshMigratedDatabase(dbPath);
        const uuid = ensureContextStoreUuid(connA);
        installAuthorityManagedMarker(connA, "/project", uuid);

        // Connection B: a plain open with NO privilege setup of its own — exactly the
        // connection shape that used to fail every guarded write with `no such function`.
        const connB = track(new Database(dbPath));
        withPrivilegedWriter(connB, () => {
            insertMemory(connB, "/project", "written by second connection");
        });

        const row = connB
            .prepare("SELECT content FROM memories WHERE project_path = ?")
            .get("/project") as { content: string } | null;
        expect(row?.content).toBe("written by second connection");

        // The privilege flag is cleared within the same immediate transaction, so once the
        // bracket returns no other connection can observe enabled=1.
        const enabled = connA
            .prepare("SELECT enabled FROM context_privilege_state WHERE id = 1")
            .get() as { enabled: number } | null;
        expect(enabled?.enabled ?? 0).toBe(0);
    });

    it("still rejects unprivileged direct writes in both mutation directions", () => {
        const db = freshMigratedDatabase();
        const uuid = ensureContextStoreUuid(db);
        installAuthorityManagedMarker(db, "/project", uuid);

        // INSERT direction: an unprivileged insert must be aborted by the guard. If the
        // trigger were dropped entirely this would succeed and the assertion would fail.
        expect(() => insertMemory(db, "/project", "blocked insert")).toThrow(
            "context.db memory writes are managed by the Rust module",
        );

        // Seed a managed row through the privileged path so DELETE/UPDATE have a target.
        withPrivilegedWriter(db, () => insertMemory(db, "/project", "managed row"));
        const rowId = (
            db
                .prepare("SELECT id FROM memories WHERE project_path = ? AND content = ?")
                .get("/project", "managed row") as { id: number }
        ).id;

        // DELETE direction.
        expect(() => db.prepare("DELETE FROM memories WHERE id = ?").run(rowId)).toThrow(
            "context.db memory writes are managed by the Rust module",
        );
        // UPDATE direction.
        expect(() =>
            db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("tampered", rowId),
        ).toThrow("context.db memory writes are managed by the Rust module");

        // The row is untouched and, critically, the failure is the managed-write abort —
        // never `no such function`.
        const surviving = db.prepare("SELECT content FROM memories WHERE id = ?").get(rowId) as {
            content: string;
        };
        expect(surviving.content).toBe("managed row");
    });
});
