/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHarnessForTesting, getHarness, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { openOpenCodeDb } from "./dreamer/open-opencode-db";
import { recordMessageFtsRowid } from "./message-fts-rowid-map";
import {
    MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS,
    MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS,
    sweepOrphanedOpenCodeMessageIndexes,
} from "./message-index";
import { runMigrations } from "./migrations";
import { advanceSessionActivity, readSessionActivity } from "./session-activity";
import { initializeDatabase } from "./storage-db";
import { deleteSessionScopedRows } from "./storage-session-tables";

const tempDirectories: string[] = [];

function createOpenCodeDb(liveSessionIds: string[]): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), "message-index-orphan-source-"));
    tempDirectories.push(directory);
    const path = join(directory, "opencode.db");
    const db = new Database(path);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO session (id) VALUES (?)");
    for (const sessionId of liveSessionIds) insert.run(sessionId);
    closeQuietly(db);
    return path;
}

function createStoreDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedIndexedSession(db: Database, sessionId: string, updatedAt: number): void {
    db.prepare(
        `INSERT INTO message_history_index
            (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
         VALUES (?, 1, 0, ?, 'opencode')`,
    ).run(sessionId, updatedAt);
    const result = db
        .prepare(
            `INSERT INTO message_history_fts
                (session_id, message_ordinal, message_id, role, content)
             VALUES (?, 1, ?, 'user', ?)`,
        )
        .run(sessionId, `${sessionId}-message`, `searchable ${sessionId}`) as {
        lastInsertRowid: number | bigint;
    };
    recordMessageFtsRowid(db, sessionId, 1, result.lastInsertRowid);
}

function seedSessionScopedRows(db: Database, sessionId: string, updatedAt: number): void {
    seedIndexedSession(db, sessionId, updatedAt);
    db.prepare(
        "INSERT INTO session_meta (session_id, harness, last_response_time) VALUES (?, 'opencode', ?)",
    ).run(sessionId, updatedAt);
    db.prepare("INSERT INTO tags (session_id, tag_number, harness) VALUES (?, 1, 'opencode')").run(
        sessionId,
    );
    db.prepare(
        `INSERT INTO session_facts
            (session_id, category, content, created_at, updated_at, harness)
         VALUES (?, 'fact', 'content', ?, ?, 'opencode')`,
    ).run(sessionId, updatedAt, updatedAt);
    db.prepare(
        "INSERT INTO tool_owner_backfill_state (session_id, status) VALUES (?, 'completed')",
    ).run(sessionId);
}

function countRows(db: Database, table: string, sessionId: string): number {
    const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count: number };
    return row.count;
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
    tempDirectories.length = 0;
});

describe("message history orphan maintenance", () => {
    test("removes activity for a missing host session but retains the live session and backfill marker", () => {
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        const old = now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1;
        seedSessionScopedRows(db, "missing", old);
        seedSessionScopedRows(db, "live", old);
        advanceSessionActivity(db, "missing", old);
        advanceSessionActivity(db, "live", old);
        db.prepare(
            "INSERT INTO schema_migrations_meta(key, value) VALUES ('retrospective_activity_backfill:opencode:v1', 'completed')",
        ).run();
        const hostPath = createOpenCodeDb(["live"]);
        try {
            expect(
                sweepOrphanedOpenCodeMessageIndexes(
                    db,
                    () => new Database(hostPath, { readonly: true }),
                    { now },
                ),
            ).toMatchObject({ status: "swept", deleted: 1 });
            expect(readSessionActivity(db, "missing")).toBeUndefined();
            expect(readSessionActivity(db, "live")).toBe(old);
            expect(
                db
                    .prepare(
                        "SELECT value FROM schema_migrations_meta WHERE key = 'retrospective_activity_backfill:opencode:v1'",
                    )
                    .get(),
            ).toEqual({ value: "completed" });
        } finally {
            closeQuietly(db);
        }
    });
    test("sweeps every old orphan row while retaining live, young, and Pi rows", () => {
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        const old = now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1;
        seedSessionScopedRows(db, "ses-live", old);
        seedSessionScopedRows(db, "ses-orphan", old);
        seedSessionScopedRows(db, "ses-young", now - 1_000);
        db.prepare(
            "INSERT INTO tags (session_id, tag_number, harness) VALUES ('ses-orphan', 2, 'pi')",
        ).run();
        const openCodePath = createOpenCodeDb(["ses-live"]);

        try {
            const result = sweepOrphanedOpenCodeMessageIndexes(
                db,
                () => new Database(openCodePath, { readonly: true }),
                { now },
            );

            expect(result).toMatchObject({ status: "swept", scanned: 2, deleted: 1 });
            for (const table of [
                "message_history_fts",
                "message_history_index",
                "session_meta",
                "session_facts",
                "tool_owner_backfill_state",
            ]) {
                expect(countRows(db, table, "ses-orphan"), `${table} retained an orphan`).toBe(0);
                expect(countRows(db, table, "ses-live"), `${table} removed a live session`).toBe(1);
                expect(countRows(db, table, "ses-young"), `${table} removed a young session`).toBe(
                    1,
                );
            }
            expect(
                db
                    .prepare("SELECT harness FROM tags WHERE session_id = ? ORDER BY harness")
                    .all("ses-orphan"),
            ).toEqual([{ harness: "pi" }]);
            expect(countRows(db, "tags", "ses-live")).toBe(1);
            expect(countRows(db, "tags", "ses-young")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("preserves every host row and coordinate for an orphan with pending Rust cleanup", () => {
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        const old = now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1;
        const sessionId = "ses-rust-cleanup-orphan";
        seedSessionScopedRows(db, sessionId, old);
        advanceSessionActivity(db, sessionId, old);
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', 'git:rust-cleanup-orphan', ?)",
        ).run(sessionId, old);
        db.prepare(
            "INSERT INTO pending_session_cleanup (session_id, harness, requested_at) VALUES (?, 'opencode:rust', ?)",
        ).run(sessionId, old);
        const openCodePath = createOpenCodeDb([]);

        try {
            const result = sweepOrphanedOpenCodeMessageIndexes(
                db,
                () => new Database(openCodePath, { readonly: true }),
                { now },
            );

            expect(result).toMatchObject({ status: "swept", scanned: 1, deleted: 0 });
            expect(readSessionActivity(db, sessionId)).toBe(old);
            for (const table of [
                "message_history_fts",
                "message_history_index",
                "session_meta",
                "session_projects",
                "pending_session_cleanup",
                "tags",
                "session_facts",
                "tool_owner_backfill_state",
            ]) {
                expect(countRows(db, table, sessionId), `${table} lost Rust cleanup state`).toBe(1);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("discovers an orphan whose index rows were already purged", () => {
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        const orphanSessionId = "ses-indexless-orphan";
        const liveSessionId = "ses-indexless-live";
        db.prepare(
            "INSERT INTO tags (session_id, tag_number, harness) VALUES (?, 1, 'opencode')",
        ).run(orphanSessionId);
        db.prepare(
            "INSERT INTO tags (session_id, tag_number, harness) VALUES (?, 1, 'opencode')",
        ).run(liveSessionId);
        const openCodePath = createOpenCodeDb([liveSessionId]);

        try {
            expect(countRows(db, "message_history_index", orphanSessionId)).toBe(0);

            const result = sweepOrphanedOpenCodeMessageIndexes(
                db,
                () => new Database(openCodePath, { readonly: true }),
                { now },
            );

            expect(result).toMatchObject({ status: "swept", scanned: 2, deleted: 1 });
            expect(countRows(db, "tags", orphanSessionId)).toBe(0);
            expect(countRows(db, "tags", liveSessionId)).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("persists a keyset cursor and resumes within the configured batch bound", () => {
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        const old = now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1;
        for (const sessionId of ["ses-a", "ses-b", "ses-c"]) {
            seedIndexedSession(db, sessionId, old);
        }
        const openCodePath = createOpenCodeDb([]);

        try {
            const openSource = () => new Database(openCodePath, { readonly: true });
            const first = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                now,
                batchSize: 2,
            });
            expect(first).toEqual({ status: "swept", scanned: 2, deleted: 2, cursor: "ses-b" });

            const persisted = db
                .prepare(
                    "SELECT cursor_session_id FROM message_history_orphan_sweep WHERE harness = 'opencode'",
                )
                .get() as { cursor_session_id: string };
            expect(persisted.cursor_session_id).toBe("ses-b");

            const second = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                now,
                batchSize: 2,
            });
            expect(second).toEqual({ status: "swept", scanned: 1, deleted: 1, cursor: "" });
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS count FROM message_history_index").get() as {
                        count: number;
                    }
                ).count,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("parks cleanly when a Pi-only install has no OpenCode database", () => {
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        seedIndexedSession(db, "pi-do-not-delete", now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1);
        let openAttempts = 0;
        const unavailable = () => {
            openAttempts += 1;
            return null;
        };

        try {
            const first = sweepOrphanedOpenCodeMessageIndexes(db, unavailable, { now });
            const second = sweepOrphanedOpenCodeMessageIndexes(db, unavailable, {
                now: now + 15 * 60 * 1000,
            });

            expect(first.status).toBe("source_unavailable");
            expect(second.status).toBe("cooldown");
            expect(openAttempts).toBe(1);
            expect(countRows(db, "message_history_fts", "pi-do-not-delete")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

/**
 * The sweep reads OpenCode's session table, which Pi and OMP do not have. That
 * used to be asserted with a throw, and because the sweep runs early in the
 * shared maintenance tick, the throw ended the tick before any scheduled task
 * could be dispatched — on those two hosts the background maintenance stopped
 * entirely (issue 496). An absent source parks exactly like an unreadable one.
 */
describe("message history orphan sweep on a host without an OpenCode store", () => {
    afterEach(() => {
        _resetHarnessForTesting();
    });

    for (const harness of ["pi", "omp"] as const) {
        test(`parks and re-probes instead of throwing on ${harness}`, () => {
            setHarness(harness);
            const db = createStoreDb();
            const now = 2_000_000_000_000;
            seedIndexedSession(db, "host-row-kept", now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1);
            let openAttempts = 0;
            const openSource = () => {
                openAttempts += 1;
                return null;
            };

            try {
                const first = sweepOrphanedOpenCodeMessageIndexes(db, openSource, { now });
                expect(first).toEqual({
                    status: "unavailable",
                    scanned: 0,
                    deleted: 0,
                    cursor: "",
                });
                // The store this sweep reads is never opened on these hosts.
                expect(openAttempts).toBe(0);

                // Parked future-dated, so the ordinary cooldown arithmetic
                // re-probes after a day rather than on the next tick.
                const parked = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                    now: now + 15 * 60 * 1000,
                });
                expect(parked.status).toBe("cooldown");
                const reprobed = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                    now: now + MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS + 1,
                });
                expect(reprobed.status).toBe("unavailable");

                // Parking must not touch this host's own indexed rows.
                expect(countRows(db, "message_history_fts", "host-row-kept")).toBe(1);
            } finally {
                closeQuietly(db);
            }
        });
    }
});

test("a harness-scoped orphan sweep retains counters until the last harness's compartments are gone", () => {
    const previousHarness = getHarness();
    const db = createStoreDb();
    try {
        setHarness("opencode");
        const source = createOpenCodeDb([]);
        const sweep = () =>
            sweepOrphanedOpenCodeMessageIndexes(db, () => new Database(source), {
                now: 10_000,
                safetyAgeMs: 0,
                cooldownMs: 0,
            });
        db.prepare(`INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness)
            VALUES (?,0,1,4,'title','opencode body',1,'opencode')`).run("shared-session");
        db.prepare(`INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness)
            VALUES (?,1,5,8,'title','claude body',1,'opencode2')`).run("shared-session");
        const before = db
            .prepare(
                "SELECT generation,version FROM compartment_history_versions WHERE session_id=?",
            )
            .get("shared-session") as { generation: string; version: number };
        expect(sweep().deleted).toBe(1);
        expect(
            db
                .prepare("SELECT harness,content FROM compartments WHERE session_id=?")
                .all("shared-session"),
        ).toEqual([{ harness: "opencode2", content: "claude body" }]);
        expect(
            db
                .prepare(
                    "SELECT generation,version FROM compartment_history_versions WHERE session_id=?",
                )
                .get("shared-session"),
        ).toEqual({ ...before, version: before.version + 1 });
        // OpenCode 2's sweep is parked (it cannot see session_v2), so its row
        // goes through the same deletion routine the sweep uses, directly.
        _resetHarnessForTesting();
        setHarness("opencode2");
        expect(sweep()).toMatchObject({ status: "unavailable", deleted: 0 });
        expect(deleteSessionScopedRows(db, ["shared-session"], "opencode2")).toBe(1);
        expect(
            db
                .prepare("SELECT generation FROM compartment_history_versions WHERE session_id=?")
                .get("shared-session"),
        ).toBeNull();
    } finally {
        db.close();
        _resetHarnessForTesting();
        setHarness(previousHarness);
    }
});

/**
 * The sweep decides a session is orphaned when OpenCode 1's `session` table has
 * no row for it. OpenCode 2 keeps its sessions in `session_v2`, and a store
 * OpenCode 2 migrated from OpenCode 1 keeps the old `session`, `message` and
 * `part` tables too, so it opens as an OpenCode 1 store. Sweeping from an
 * OpenCode 2 process would then call every OpenCode 2 session orphaned and
 * delete its state. The sweep is parked on OpenCode 2 until it can read
 * `session_v2`.
 */
describe("message history orphan sweep on OpenCode 2", () => {
    beforeEach(() => {
        _resetHarnessForTesting();
    });
    afterEach(() => {
        _resetHarnessForTesting();
    });

    /** A store OpenCode 2 migrated from OpenCode 1: both generations' tables. */
    function createMigratedStore(liveV2SessionIds: string[]): string {
        const directory = createTestTempDirFromPath(join(tmpdir(), "message-index-migrated-"));
        tempDirectories.push(directory);
        const path = join(directory, "opencode.db");
        const db = new Database(path);
        db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT);
            CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
            CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT);`);
        const insert = db.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, '/work')");
        for (const sessionId of liveV2SessionIds) insert.run(sessionId);
        closeQuietly(db);
        return path;
    }

    function seedOpenCode2Session(db: Database, sessionId: string, updatedAt: number): void {
        db.prepare(
            `INSERT INTO message_history_index
                (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
             VALUES (?, 1, 0, ?, 'opencode2')`,
        ).run(sessionId, updatedAt);
        db.prepare(
            `INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness)
             VALUES (?,0,1,4,'title','opencode2 body',1,'opencode2')`,
        ).run(sessionId);
    }

    test("parks without opening any store, and keeps every OpenCode 2 session's state", () => {
        setHarness("opencode2");
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        seedOpenCode2Session(db, "ses-v2-live", now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1);
        const store = createMigratedStore(["ses-v2-live"]);
        let openAttempts = 0;
        const openSource = () => {
            openAttempts += 1;
            return new Database(store, { readonly: true });
        };
        try {
            const result = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                now,
                safetyAgeMs: 0,
            });
            expect(result).toMatchObject({ status: "unavailable", scanned: 0, deleted: 0 });
            expect(result.reason).toContain("session_v2");
            expect(openAttempts).toBe(0);
            expect(countRows(db, "message_history_index", "ses-v2-live")).toBe(1);
            expect(countRows(db, "compartments", "ses-v2-live")).toBe(1);

            // Parked for a day like Pi's, then parked again on the re-probe.
            const reprobed = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                now: now + MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS + 1,
                safetyAgeMs: 0,
            });
            expect(reprobed.status).toBe("unavailable");
            expect(openAttempts).toBe(0);
            expect(countRows(db, "compartments", "ses-v2-live")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("a migrated store the OpenCode 2 process opens as OpenCode 1's never reaches the sweep", () => {
        setHarness("opencode2");
        const db = createStoreDb();
        const now = 2_000_000_000_000;
        seedOpenCode2Session(db, "ses-v2-live", now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1);
        const store = createMigratedStore(["ses-v2-live"]);
        const previous = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = store;
        try {
            // The hazard is real: the shared opener the timer passes opens this
            // store from an OpenCode 2 process, because it looks like OpenCode 1's.
            const opened = openOpenCodeDb();
            expect(opened).not.toBeNull();
            closeQuietly(opened);

            const result = sweepOrphanedOpenCodeMessageIndexes(db, openOpenCodeDb, {
                now,
                safetyAgeMs: 0,
            });
            expect(result).toMatchObject({ status: "unavailable", deleted: 0 });
            expect(countRows(db, "message_history_index", "ses-v2-live")).toBe(1);
            expect(countRows(db, "compartments", "ses-v2-live")).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previous;
            closeQuietly(db);
        }
    });
});
