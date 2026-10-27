/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { getMemoriesByProject, insertMemory } from "./memory/storage-memory";
import { MIGRATIONS, runMigrations } from "./migrations";
import { closeDatabase, initializeDatabase, openDatabase, openDatabaseAsync } from "./storage-db";

/*
 * Upgrade populated file-backed stores through the same openers the plugin, the
 * v2 server and Pi use, then write a memory through the opened connection.
 *
 * Bun 1.4.4 changed two things these stores depend on: `db.function` now exists
 * (migration v55 used to switch its trigger shape on it), and a multi-statement
 * `exec` now throws when a statement before the last one fails at run time,
 * where older Bun skipped the error and ran the rest. Running this on several
 * Bun versions shows an old store still upgrades and still accepts memory writes.
 */

const PROJECT_PATH = "/real-store-upgrade";
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const roots: string[] = [];

afterEach(async () => {
    await closeDatabase();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copyMigrationLedger(db: DatabaseType): void {
    // Take the runner's own ledger DDL from a scratch store so this fixture does not
    // carry a hand-written copy of it.
    const source = new Database(":memory:");
    try {
        initializeDatabase(source);
        runMigrations(source);
        const row = source
            .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            )
            .get() as { sql?: string } | null;
        if (!row?.sql) throw new Error("source migration runner did not create its ledger");
        db.exec(row.sql);
    } finally {
        closeQuietly(source);
    }
}

/** Write a store file that has applied exactly migrations 1..`version` and holds rows. */
function buildStoreAt(version: number): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-real-store-upgrade-"));
    roots.push(root);
    const dbPath = join(root, "context.db");
    const db = new Database(dbPath);
    try {
        initializeDatabase(db);
        copyMigrationLedger(db);
        for (const migration of MIGRATIONS) {
            if (migration.version > version) break;
            db.transaction(() => {
                migration.up(db);
                db.prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                ).run(migration.version, migration.description, Date.now());
            }).immediate();
        }
        db.prepare(
            "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', ?, ?, 0, 0, 0, 0)",
        ).run(PROJECT_PATH, `memory written at v${version}`, `real-store-hash-v${version}`);
        db.prepare("INSERT INTO session_meta(session_id, counter) VALUES(?, 3)").run(
            `ses-at-v${version}`,
        );
        db.prepare(
            "INSERT INTO tags(session_id, message_id, type, byte_size, tag_number, harness) VALUES(?, ?, 'message', 1, 1, 'opencode')",
        ).run(`ses-at-v${version}`, `msg-at-v${version}:p0`);
    } finally {
        closeQuietly(db);
    }
    return dbPath;
}

/** Remove what migration v86 adds, so the file matches a store written by a v85 build. */
function stripToV85Shape(dbPath: string): void {
    // A fresh connection carries none of the TEMP triggers initializeDatabase
    // installs, so only the durable schema that names tags_version stands in the way.
    const db = new Database(dbPath);
    try {
        db.exec(`
            DROP TRIGGER tags_version_ai;
            DROP TRIGGER tags_version_ad;
            DROP TRIGGER tags_version_au;
            ALTER TABLE session_meta DROP COLUMN tags_version;
        `);
        const columns = (
            db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>
        ).map((column) => column.name);
        expect(columns).not.toContain("tags_version");
    } finally {
        closeQuietly(db);
    }
}

function assertUpgradedAndWritable(db: DatabaseType, version: number): void {
    const persisted = db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number };
    expect(persisted.version).toBe(LATEST);
    const guards = (
        db
            .prepare(
                "SELECT group_concat(sql, char(10)) AS sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%authority_guard%'",
            )
            .get() as { sql?: string }
    ).sql;
    expect(guards).not.toContain("mc_privileged_writer");

    insertMemory(db, {
        projectPath: PROJECT_PATH,
        category: "CONSTRAINTS",
        content: `memory written after upgrading from v${version}`,
        sourceSessionId: `ses-at-v${version}`,
    });
    const contents = getMemoriesByProject(db, PROJECT_PATH).map((memory) => memory.content);
    expect(contents).toContain(`memory written at v${version}`);
    expect(contents).toContain(`memory written after upgrading from v${version}`);
}

describe("populated stores upgrade through the real openers", () => {
    for (const version of [30, 54, 60, 70, 85]) {
        test(`synchronous opener upgrades a v${version} store and accepts a memory write`, () => {
            const dbPath = buildStoreAt(version);
            if (version === 85) stripToV85Shape(dbPath);
            const db = openDatabase(dbPath);
            if (!db) throw new Error("openDatabase refused the store");
            assertUpgradedAndWritable(db, version);
        });
    }

    for (const version of [54, 85]) {
        test(`worker-thread opener upgrades a v${version} store and accepts a memory write`, async () => {
            const dbPath = buildStoreAt(version);
            if (version === 85) stripToV85Shape(dbPath);
            const db = await openDatabaseAsync({ dbPath });
            if (!db) throw new Error("openDatabaseAsync refused the store");
            assertUpgradedAndWritable(db, version);
        });
    }
});
