import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { getDreamTaskBacklog } from "./dreamer/task-gates";
import { runMigrations } from "./migrations";
import {
    advanceSessionActivity,
    backfillSessionActivity,
    observeSessionActivity,
    readSessionActivity,
} from "./session-activity";
import { initializeDatabase } from "./storage-db";
import { clearSession } from "./storage-meta-session";

let db: Database;
afterEach(() => db?.close());
function setup(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("retrospective activity", () => {
    test("session deletion removes activity for OpenCode 1/2 and Pi/OMP without touching backfill state", () => {
        const db = setup();
        for (const harness of ["opencode", "opencode2", "pi", "omp"]) {
            const sessionId = `session-${harness}`;
            db.prepare(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, '/repo', 100)",
            ).run(sessionId, harness);
            observeSessionActivity(db, sessionId, 100);
            observeSessionActivity(db, sessionId, 101);
            expect(readSessionActivity(db, sessionId)).toBe(100);
            clearSession(db, sessionId);
            expect(readSessionActivity(db, sessionId)).toBeUndefined();
            expect(
                db.prepare("SELECT 1 FROM session_projects WHERE session_id = ?").get(sessionId),
            ).toBeNull();
        }
        db.prepare(
            "INSERT INTO schema_migrations_meta(key, value) VALUES ('retrospective_activity_backfill:pi:v1', 'completed')",
        ).run();
        clearSession(db, "session-pi");
        expect(
            db
                .prepare(
                    "SELECT value FROM schema_migrations_meta WHERE key = 'retrospective_activity_backfill:pi:v1'",
                )
                .get(),
        ).toEqual({ value: "completed" });
    });
    test("selects active sessions without binding writes and ignores binding-only changes", () => {
        const db = setup();
        const activeProject = "/repo/active";
        const idleProject = "/repo/idle";
        const insert = db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, ?)",
        );
        insert.run("active", activeProject, 10);
        insert.run("idle", idleProject, 400);
        advanceSessionActivity(db, "active", 300);
        advanceSessionActivity(db, "idle", 100);
        expect(
            getDreamTaskBacklog(db, activeProject, "retrospective", {
                retrospectiveWatermarkMs: 200,
            }).pending,
        ).toBe(1);
        expect(
            getDreamTaskBacklog(db, idleProject, "retrospective", { retrospectiveWatermarkMs: 200 })
                .pending,
        ).toBe(0);
        db.prepare("UPDATE session_projects SET updated_at = 900 WHERE session_id = 'idle'").run();
        expect(
            getDreamTaskBacklog(db, activeProject, "retrospective", {
                retrospectiveWatermarkMs: 200,
            }).pending,
        ).toBe(1);
        expect(
            getDreamTaskBacklog(db, idleProject, "retrospective", { retrospectiveWatermarkMs: 200 })
                .pending,
        ).toBe(0);
    });

    test("coalesces a burst, moves forward, and does not regress", () => {
        const db = setup();
        let writes = 0;
        db.exec(
            "CREATE TRIGGER activity_writes AFTER UPDATE ON schema_migrations_meta BEGIN INSERT INTO schema_migrations_meta(key,value) VALUES ('activity_writes', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1; END",
        );
        observeSessionActivity(db, "s", 100_000);
        for (let n = 1; n <= 20; n++) observeSessionActivity(db, "s", 100_000 + n);
        writes = Number(
            (
                db
                    .prepare(
                        "SELECT value FROM schema_migrations_meta WHERE key = 'activity_writes'",
                    )
                    .get() as { value?: string } | undefined
            )?.value ?? 0,
        );
        expect(writes).toBe(0);
        expect(readSessionActivity(db, "s")).toBe(100_000);
        observeSessionActivity(db, "s", 115_001);
        expect(readSessionActivity(db, "s")).toBe(115_001);
        expect(
            Number(
                (
                    db
                        .prepare(
                            "SELECT value FROM schema_migrations_meta WHERE key = 'activity_writes'",
                        )
                        .get() as { value: string }
                ).value,
            ),
        ).toBe(1);
        advanceSessionActivity(db, "s", 1);
        expect(readSessionActivity(db, "s")).toBe(115_001);
    });

    test("backfills once in bounded pages and keeps newer live activity", async () => {
        const db = setup();
        const insert = db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', '/repo', 1)",
        );
        for (let n = 0; n < 105; n++) insert.run(`s${String(n).padStart(3, "0")}`);
        advanceSessionActivity(db, "s000", 999);
        let calls = 0;
        const source = (_sessionId: string) => {
            calls++;
            return 100;
        };
        await backfillSessionActivity(db, "opencode", source);
        expect(calls).toBe(105);
        expect(readSessionActivity(db, "s000")).toBe(999);
        expect(readSessionActivity(db, "s104")).toBe(100);
        await backfillSessionActivity(db, "opencode", source);
        expect(calls).toBe(105);
    });
});
