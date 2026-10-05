/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { appendCompartments, getCompartments, replaceAllCompartments } from "./compartment-storage";
import { MIGRATIONS, runMigrations } from "./migrations";
import { installCompartmentHistoryVersions } from "./storage-compartment-history-version";
import { initializeDatabase } from "./storage-db";
import { deleteSessionScopedRows } from "./storage-session-tables";

function populatedV92(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    // Remove the current bootstrap's additions to exercise an actual v92 upgrade.
    db.exec(`
        DROP TRIGGER compartment_history_ai;
        DROP TRIGGER compartment_history_au;
        DROP TRIGGER compartment_history_ad;
        DROP TABLE compartment_history_versions;
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
    `);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 92)) {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)").run(
            migration.version,
        );
    }
    appendCompartments(db, "populated", [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 4,
            startMessageId: "m1",
            endMessageId: "m4",
            title: "title",
            content: "body",
        },
    ]);
    return db;
}

function revision(
    db: Database,
    session = "populated",
): { generation: string; version: number } | null {
    return db
        .prepare("SELECT generation, version FROM compartment_history_versions WHERE session_id=?")
        .get(session) as { generation: string; version: number } | null;
}

test("v93 steps over populated v92 and tracks inserts, same-length updates and deletes", () => {
    const db = populatedV92();
    try {
        const before = getCompartments(db, "populated");
        runMigrations(db);
        expect(getCompartments(db, "populated")).toEqual(before);
        const seeded = revision(db)!;
        expect(seeded.generation).toMatch(/^[a-f0-9]{32}$/);
        expect(seeded.version).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT rewrite_version,seeded FROM compartment_history_versions WHERE session_id='populated'",
                )
                .get(),
        ).toEqual({ rewrite_version: 0, seeded: 1 });
        appendCompartments(db, "populated", [
            {
                sequence: 1,
                startMessage: 5,
                endMessage: 8,
                startMessageId: "m5",
                endMessageId: "m8",
                title: "later",
                content: "next",
            },
        ]);
        expect(revision(db)).toEqual({ ...seeded, version: 1 });
        expect(
            db
                .prepare(
                    "SELECT rewrite_version FROM compartment_history_versions WHERE session_id='populated'",
                )
                .get(),
        ).toEqual({ rewrite_version: 0 });
        db.prepare("UPDATE compartments SET content='BODY' WHERE session_id=? AND sequence=0").run(
            "populated",
        );
        expect(revision(db)).toEqual({ ...seeded, version: 2 });
        expect(
            db
                .prepare(
                    "SELECT rewrite_version FROM compartment_history_versions WHERE session_id='populated'",
                )
                .get(),
        ).toEqual({ rewrite_version: 1 });
        expect(db.prepare("SELECT count(*) AS n FROM m0_mutation_log").get()).toEqual({ n: 0 });
        db.prepare(
            "UPDATE compartments SET title='TITLE', end_block_index=2 WHERE session_id=? AND sequence=0",
        ).run("populated");
        expect(revision(db)).toEqual({ ...seeded, version: 3 });
        db.prepare("DELETE FROM compartments WHERE session_id=? AND sequence=1").run("populated");
        expect(revision(db)).toEqual({ ...seeded, version: 4 });
        MIGRATIONS.find((m) => m.version === 93)!.up(db);
        expect(revision(db)).toEqual({ ...seeded, version: 4 });
    } finally {
        db.close();
    }
});

test("v93 invalidates both sessions on moves and rolls back revisions with bodies", () => {
    const db = populatedV92();
    try {
        runMigrations(db);
        const seeded = revision(db)!;
        db.prepare("UPDATE compartments SET session_id='moved' WHERE session_id='populated'").run();
        expect(revision(db)).toEqual({ ...seeded, version: 1 });
        const moved = revision(db, "moved")!;
        expect(moved.version).toBe(1);
        expect(moved.generation).not.toBe(seeded.generation);
        db.exec("BEGIN; UPDATE compartments SET content='same' WHERE session_id='moved'; ROLLBACK");
        expect(revision(db, "moved")).toEqual(moved);
        expect(getCompartments(db, "moved")[0]!.content).toBe("body");
    } finally {
        db.close();
    }
});

test("fresh stores install v93 and session cleanup removes counters without reusing generations", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        const input = [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 4,
                startMessageId: "m1",
                endMessageId: "m4",
                title: "title",
                content: "body",
            },
        ];
        appendCompartments(db, "populated", input);
        const before = revision(db)!;
        runMigrations(db);
        deleteSessionScopedRows(db, ["populated"]);
        expect(revision(db)).toBeNull();
        appendCompartments(db, "populated", input);
        expect(revision(db)!.version).toBe(before.version);
        expect(revision(db)!.generation).not.toBe(before.generation);
        const replaced = revision(db)!;
        replaceAllCompartments(db, "populated", input);
        expect(revision(db)).toEqual({ ...replaced, version: replaced.version + 2 });
    } finally {
        db.close();
    }
});

test("all body updates invalidate validation while owned hint updates and deletes retain rendering policy", () => {
    const db = populatedV92();
    try {
        runMigrations(db);
        const seeded = revision(db)!;
        db.exec(
            "BEGIN; INSERT INTO context_privilege_state(id,enabled) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET enabled=1; UPDATE compartments SET content='BODY' WHERE session_id='populated'; UPDATE context_privilege_state SET enabled=0 WHERE id=1; COMMIT",
        );
        expect(revision(db)).toEqual({ ...seeded, version: 1 });
        expect(
            db
                .prepare(
                    "SELECT rewrite_version FROM compartment_history_versions WHERE session_id='populated'",
                )
                .get(),
        ).toEqual({ rewrite_version: 0 });
        db.exec("UPDATE compartments SET content='body' WHERE session_id='populated'");
        expect(revision(db)).toEqual({ ...seeded, version: 2 });
        expect(
            db
                .prepare(
                    "SELECT rewrite_version FROM compartment_history_versions WHERE session_id='populated'",
                )
                .get(),
        ).toEqual({ rewrite_version: 1 });
        db.exec("DELETE FROM compartments WHERE session_id='populated'");
        expect(revision(db)).toEqual({ ...seeded, version: 3 });
        expect(
            db
                .prepare(
                    "SELECT rewrite_version FROM compartment_history_versions WHERE session_id='populated'",
                )
                .get(),
        ).toEqual({ rewrite_version: 1 });
    } finally {
        db.close();
    }
});

test("v93 installer on a second open is read-only and leaves schema_version unchanged", () => {
    const { dir } = createTestTempDir("mc-v93-idempotent-");
    const path = join(dir, "context.db");
    const writer = new Database(path);
    let opener: Database | undefined;
    try {
        initializeDatabase(writer);
        runMigrations(writer);
        writer.exec("PRAGMA journal_mode=WAL");
        const before = writer.prepare("PRAGMA schema_version").get();
        opener = new Database(path);
        opener.exec("PRAGMA busy_timeout=0");
        // Readers can proceed while this reservation makes any new write lock fail.
        writer.exec("BEGIN IMMEDIATE");
        installCompartmentHistoryVersions(opener);
        expect(opener.prepare("PRAGMA schema_version").get()).toEqual(before);
        writer.exec("ROLLBACK");
        installCompartmentHistoryVersions(opener);
        expect(opener.prepare("PRAGMA schema_version").get()).toEqual(before);
        opener.exec("DROP TRIGGER compartment_history_ai");
        const missing = opener.prepare("PRAGMA schema_version").get();
        installCompartmentHistoryVersions(opener);
        expect(opener.prepare("PRAGMA schema_version").get()).not.toEqual(missing);
        const repaired = opener.prepare("PRAGMA schema_version").get();
        installCompartmentHistoryVersions(opener);
        expect(opener.prepare("PRAGMA schema_version").get()).toEqual(repaired);
        const expectedUpdate = opener
            .prepare("SELECT sql FROM sqlite_master WHERE name='compartment_history_au'")
            .get();
        opener.exec(
            "DROP TRIGGER compartment_history_au; CREATE TRIGGER compartment_history_au AFTER UPDATE ON compartments BEGIN SELECT 1; END",
        );
        installCompartmentHistoryVersions(opener);
        expect(
            opener
                .prepare("SELECT sql FROM sqlite_master WHERE name='compartment_history_au'")
                .get(),
        ).toEqual(expectedUpdate);
        expect(
            String(
                (
                    opener
                        .prepare(
                            "SELECT sql FROM sqlite_master WHERE name='compartment_history_au'",
                        )
                        .get() as { sql: string }
                ).sql,
            ),
        ).toContain("rewrite_version");
    } finally {
        if (writer.inTransaction) writer.exec("ROLLBACK");
        opener?.close();
        writer.close();
        cleanupTestTempDir(dir);
    }
});
