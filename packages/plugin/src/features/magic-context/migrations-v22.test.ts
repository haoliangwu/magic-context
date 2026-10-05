import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { closeDatabase, initializeDatabase, openDatabase } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta-session";
import { clearCachedM0M1, persistCachedM0 } from "./storage-meta-shared";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function hasTable(db: Database, table: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

function metaValue(db: Database, key: string): string | null {
    const row = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}

function createLegacyV21Database(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations (version, description, applied_at)
        VALUES (21, 'legacy v21', 1);

        CREATE TABLE compartments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            start_message INTEGER NOT NULL,
            end_message INTEGER NOT NULL,
            start_message_id TEXT DEFAULT '',
            end_message_id TEXT DEFAULT '',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            UNIQUE(session_id, sequence)
        );

        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            source_session_id TEXT,
            source_type TEXT DEFAULT 'historian',
            seen_count INTEGER DEFAULT 1,
            retrieval_count INTEGER DEFAULT 0,
            first_seen_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            last_retrieved_at INTEGER,
            status TEXT DEFAULT 'active',
            expires_at INTEGER,
            verification_status TEXT DEFAULT 'unverified',
            verified_at INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from TEXT,
            metadata_json TEXT,
            UNIQUE(project_path, category, normalized_hash)
        );

        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            harness TEXT NOT NULL DEFAULT 'opencode',
            last_response_time INTEGER,
            cache_ttl TEXT,
            counter INTEGER DEFAULT 0,
            last_nudge_tokens INTEGER DEFAULT 0,
            last_nudge_band TEXT DEFAULT '',
            last_transform_error TEXT DEFAULT '',
            is_subagent INTEGER DEFAULT 0,
            last_context_percentage REAL DEFAULT 0,
            last_input_tokens INTEGER DEFAULT 0,
            observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_alert_sent INTEGER NOT NULL DEFAULT 0,
            times_execute_threshold_reached INTEGER DEFAULT 0,
            compartment_in_progress INTEGER DEFAULT 0,
            system_prompt_hash TEXT DEFAULT '',
            system_prompt_tokens INTEGER DEFAULT 0,
            conversation_tokens INTEGER DEFAULT 0,
            tool_call_tokens INTEGER DEFAULT 0,
            cleared_reasoning_through_tag INTEGER DEFAULT 0,
            last_todo_state TEXT DEFAULT ''
        );
    `);
    return db;
}

afterEach(() => {
    closeDatabase();
});

describe("migration v22", () => {
    test("creates v22 schema and pending backfill flag on a fresh database", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(hasTable(db, "project_state")).toBe(true);
            expect(hasTable(db, "m0_mutation_log")).toBe(true);
            expect(hasTable(db, "v22_identity_rekey_map")).toBe(true);
            expect(hasTable(db, "v22_backfill_failures")).toBe(true);
            expect(columnNames(db, "session_meta")).toEqual(
                expect.arrayContaining([
                    "cached_m0_bytes",
                    "cached_m0_project_memory_epoch",
                    "cached_m0_project_user_profile_version",
                    "cached_m0_max_compartment_seq",
                    "cached_m0_max_memory_id",
                    "cached_m0_max_mutation_id",
                    "cached_m0_project_docs_hash",
                    "cached_m0_materialized_at",
                    "cached_m0_session_facts_version",
                    "cached_m0_upgrade_state",
                    "upgrade_reminded_at",
                ]),
            );
            expect(columnNames(db, "compartments")).toEqual(
                expect.arrayContaining([
                    "importance",
                    "episode_type",
                    "p1_embedding",
                    "p1_embedding_model_id",
                    "legacy",
                ]),
            );
            expect(columnNames(db, "memories")).toContain("importance");
            expect(metaValue(db, "v22_legacy_memory_backfill")).toBe("pending");
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades existing v21 data without eager project_state population", () => {
        const db = createLegacyV21Database();
        try {
            db.prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES ('ses-1', 1, 1, 2, 'Legacy', 'legacy body', 100)`,
            ).run();
            db.prepare(
                `INSERT INTO memories
                    (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES ('/raw/project', 'CONSTRAINTS', 'keep data', 'hash-1', 1, 1, 1, 1)`,
            ).run();
            db.prepare(
                "INSERT INTO session_meta (session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, last_context_percentage, last_input_tokens) VALUES ('ses-1', 1, '5m', 0, 0, 0, 0)",
            ).run();

            runMigrations(db);

            const memory = db
                .prepare("SELECT project_path, content, importance FROM memories")
                .get() as {
                project_path: string;
                content: string;
                importance: number | null;
            };
            expect(memory).toEqual({
                project_path: "/raw/project",
                content: "keep data",
                importance: null,
            });
            const legacy = db
                .prepare("SELECT legacy, importance, episode_type FROM compartments")
                .get() as {
                legacy: number;
                importance: number;
                episode_type: string | null;
            };
            expect(legacy).toEqual({ legacy: 1, importance: 50, episode_type: null });
            const projectStateRows = db
                .prepare("SELECT COUNT(*) AS count FROM project_state")
                .get() as {
                count: number;
            };
            expect(projectStateRows.count).toBe(0);

            db.prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES ('ses-1', 2, 3, 4, 'V2', 'v2 body', 200)`,
            ).run();
            const newRow = db
                .prepare("SELECT legacy FROM compartments WHERE sequence = 2")
                .get() as { legacy: number };
            expect(newRow.legacy).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("is idempotent and does not promote post-boundary v2 compartments", () => {
        const db = createLegacyV21Database();
        try {
            db.prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES ('ses-1', 1, 1, 2, 'Legacy', 'legacy body', 100)`,
            ).run();
            runMigrations(db);
            db.prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES ('ses-1', 2, 3, 4, 'V2', 'v2 body', 200)`,
            ).run();
            db.prepare("DELETE FROM schema_migrations WHERE version = 22").run();

            expect(() => runMigrations(db)).not.toThrow();

            const rows = db
                .prepare("SELECT sequence, legacy FROM compartments ORDER BY sequence")
                .all() as Array<{ sequence: number; legacy: number }>;
            expect(rows).toEqual([
                { sequence: 1, legacy: 1 },
                { sequence: 2, legacy: 0 },
            ]);
            const boundaryRows = db
                .prepare(
                    "SELECT COUNT(*) AS count FROM schema_migrations_meta WHERE key = 'v22_legacy_compartment_boundary'",
                )
                .get() as { count: number };
            expect(boundaryRows.count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("round-trips cached m0 bytes as a BLOB", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const expected = Buffer.from([0, 1, 2, 253, 254, 255]);

            persistCachedM0(db, "ses-blob", {
                m0Bytes: expected,
                projectMemoryEpoch: 3,
                projectUserProfileVersion: null,
                maxCompartmentSeq: 9,
                maxMemoryId: 10,
                maxMutationId: null,
                projectDocsHash: "docs-hash",
                materializedAt: 1234,
                sessionFactsVersion: 7,
                upgradeState: null,
            });

            const meta = getOrCreateSessionMeta(db, "ses-blob");
            expect(Buffer.isBuffer(meta.cachedM0Bytes)).toBe(true);
            expect(meta.cachedM0Bytes?.equals(expected)).toBe(true);
            expect(meta.cachedM0ProjectMemoryEpoch).toBe(3);
            expect(meta.cachedM0ProjectUserProfileVersion).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("clears cached m0/m1 fields and memory block manifest", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            persistCachedM0(db, "ses-null", {
                m0Bytes: Buffer.from("cached", "utf8"),
                projectMemoryEpoch: 1,
                projectUserProfileVersion: 2,
                maxCompartmentSeq: 3,
                maxMemoryId: 4,
                maxMutationId: 5,
                projectDocsHash: "hash",
                materializedAt: 6,
                sessionFactsVersion: 7,
                upgradeState: "pending",
            });

            db.prepare(
                "UPDATE session_meta SET cached_m1_bytes = ?, cached_m0_max_memory_mutation_id = ?, memory_block_cache = ?, memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
            ).run(Buffer.from("m1", "utf8"), 8, "stale", 2, "[1,2]", "ses-null");

            clearCachedM0M1(db, "ses-null");

            const raw = db
                .prepare(
                    `SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_max_memory_mutation_id,
                            cached_m0_project_docs_hash, memory_block_cache, memory_block_count,
                            memory_block_ids
                       FROM session_meta
                      WHERE session_id = ?`,
                )
                .get("ses-null") as {
                cached_m0_bytes: Buffer | null;
                cached_m1_bytes: Buffer | null;
                cached_m0_max_memory_mutation_id: number | null;
                cached_m0_project_docs_hash: string | null;
                memory_block_cache: string;
                memory_block_count: number;
                memory_block_ids: string;
            };
            const meta = getOrCreateSessionMeta(db, "ses-null");
            expect(raw.cached_m0_bytes).toBeNull();
            expect(raw.cached_m1_bytes).toBeNull();
            expect(raw.cached_m0_max_memory_mutation_id).toBeNull();
            expect(raw.cached_m0_project_docs_hash).toBeNull();
            expect(raw.memory_block_cache).toBe("");
            expect(raw.memory_block_count).toBe(0);
            expect(raw.memory_block_ids).toBe("");
            expect(meta.cachedM0Bytes).toBeNull();
            expect(meta.cachedM1Bytes).toBeNull();
            expect(meta.cachedM0MaxMemoryMutationId).toBeNull();
            expect(meta.cachedM0ProjectDocsHash).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("schema fence refuses to open a newer schema than the binary supports", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-v22-fence-"));
        const dbPath = join(dir, "context.db");
        const seed = new Database(dbPath);
        try {
            initializeDatabase(seed);
            runMigrations(seed);
        } finally {
            closeQuietly(seed);
        }

        try {
            const refused = openDatabase({ dbPath, latestSupportedVersion: 20 });
            expect(refused).toBeNull();
        } finally {
            closeDatabase();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
