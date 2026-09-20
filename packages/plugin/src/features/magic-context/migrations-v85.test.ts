/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    LATEST_MIGRATION_VERSION,
    runMigrations,
    V85_OPENCODE2_RELABEL_TABLES,
    V85_OPTIONAL_OPENCODE2_RELABEL_TABLES,
} from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function harnessTablesFromDdl(db: Database): string[] {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
    return tables
        .filter((table) => columnNames(db, table.name).includes("harness"))
        .map((table) => table.name)
        .sort();
}

describe("migration v85: relabel OpenCode 1.x opencode2 mislabels", () => {
    test("fresh databases keep the v84 schema and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "session_meta")).toContain("protected_tokens_effective");
            expect(columnNames(db, "session_meta")).toContain("harness");
            expect(LATEST_SUPPORTED_VERSION).toBe(85);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")
                    .get(),
            ).toEqual({ count: 1 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM session_meta WHERE harness = 'opencode2'",
                    )
                    .get(),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("v85 names every table whose DDL has a harness column", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const fromDdl = harnessTablesFromDdl(db);
            expect(fromDdl).toEqual([...V85_OPENCODE2_RELABEL_TABLES].sort());
            for (const optional of V85_OPTIONAL_OPENCODE2_RELABEL_TABLES) {
                expect(V85_OPENCODE2_RELABEL_TABLES).not.toContain(optional);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("v84 upgrades relabel populated opencode2 rows and resolve session_projects twins", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            seedAppliedVersion(db, 84);

            db.exec(`
                INSERT INTO session_meta (session_id, harness, counter, is_subagent)
                VALUES
                    ('ses-only-o2', 'opencode2', 4, 1),
                    ('ses-primary', 'opencode', 9, 0);

                INSERT INTO tags (session_id, message_id, type, tag_number, harness)
                VALUES
                    ('ses-only-o2', 'm1', 'message', 1, 'opencode2'),
                    ('ses-primary', 'm2', 'message', 1, 'opencode');

                INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                VALUES
                    ('ses-twin', 'opencode', '/old', 100),
                    ('ses-twin', 'opencode2', '/new', 200),
                    ('ses-twin-old-o2', 'opencode', '/keep', 300),
                    ('ses-twin-old-o2', 'opencode2', '/drop', 150),
                    ('ses-o2-only', 'opencode2', '/solo', 50);

                CREATE TABLE IF NOT EXISTS notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL DEFAULT 'session',
                    status TEXT NOT NULL DEFAULT 'active',
                    content TEXT NOT NULL,
                    session_id TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode'
                );
                INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness)
                VALUES ('session', 'active', 'mislabelled', 'ses-only-o2', 1, 1, 'opencode2');

                INSERT INTO message_history_orphan_sweep (harness, cursor_session_id, last_swept_at)
                VALUES
                    ('opencode', '', 500),
                    ('opencode2', 'ses-cursor', NULL);
            `);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT harness, counter FROM session_meta WHERE session_id = 'ses-only-o2'",
                    )
                    .get(),
            ).toEqual({ harness: "opencode", counter: 4 });
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM tags WHERE harness = 'opencode2'").get(),
            ).toEqual({ count: 0 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM tags WHERE session_id = 'ses-only-o2' AND harness = 'opencode'",
                    )
                    .get(),
            ).toEqual({ count: 1 });
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path, updated_at FROM session_projects WHERE session_id = 'ses-twin'",
                    )
                    .all(),
            ).toEqual([{ harness: "opencode", project_path: "/new", updated_at: 200 }]);
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path, updated_at FROM session_projects WHERE session_id = 'ses-twin-old-o2'",
                    )
                    .all(),
            ).toEqual([{ harness: "opencode", project_path: "/keep", updated_at: 300 }]);
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path FROM session_projects WHERE session_id = 'ses-o2-only'",
                    )
                    .get(),
            ).toEqual({ harness: "opencode", project_path: "/solo" });
            expect(
                db.prepare("SELECT harness FROM notes WHERE content = 'mislabelled'").get(),
            ).toEqual({ harness: "opencode" });
            expect(
                db.prepare("SELECT harness, last_swept_at FROM message_history_orphan_sweep").all(),
            ).toEqual([{ harness: "opencode", last_swept_at: 500 }]);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")
                    .get(),
            ).toEqual({ count: 1 });

            for (const table of harnessTablesFromDdl(db)) {
                const remaining = db
                    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE harness = 'opencode2'`)
                    .get() as { count: number };
                expect(remaining.count, `${table} still has opencode2 rows`).toBe(0);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("v85 prefers a completed backfill cursor over a mislabelled running lease", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            seedAppliedVersion(db, 84);
            db.exec(`
                CREATE TABLE IF NOT EXISTS session_project_backfill_state (
                    harness TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
                    started_at INTEGER,
                    lease_expires_at INTEGER,
                    completed_at INTEGER,
                    holder_id TEXT
                );
                INSERT INTO session_project_backfill_state
                    (harness, status, started_at, completed_at)
                VALUES
                    ('opencode', 'completed', 100, 110),
                    ('opencode2', 'running', 900, NULL);
            `);

            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT harness, status, started_at FROM session_project_backfill_state",
                    )
                    .all(),
            ).toEqual([{ harness: "opencode", status: "completed", started_at: 100 }]);
        } finally {
            closeQuietly(db);
        }
    });
});
