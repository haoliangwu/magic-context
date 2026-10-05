import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
} from "../../features/magic-context/memory/project-identity";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { V2StoreReader } from "../store-reader";
import { runV2SessionProjectBackfill } from "./session-project-backfill";

const cleanup: Array<() => void> = [];
afterEach(() => {
    _resetHarnessForTesting();
    __resetProjectIdentityForTests();
    for (const step of cleanup.splice(0)) step();
});

function tempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("binds existing OpenCode 2 sessions to their project from session_v2", async () => {
    setHarness("opencode2");
    const project = tempDir("v2-backfill-project-");
    const storePath = join(tempDir("v2-backfill-store-"), "opencode.db");
    const store = new Database(storePath);
    // Only the columns the reader touches; an OpenCode 2 store has no v1
    // message/part tables, which is how the reader recognizes it.
    store.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);" +
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    );
    store.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run("ses_a", project);
    store.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run("ses_b", project);
    store.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run("ses_empty", "");
    store.close();

    const db = new Database(join(tempDir("v2-backfill-context-"), "context.db"));
    cleanup.unshift(() => db.close());
    initializeDatabase(db);
    runMigrations(db);

    const result = await runV2SessionProjectBackfill(db, () => new V2StoreReader(storePath));
    // A session without a directory leaves the pass open for a later retry.
    expect(result.status).toBe("retry_pending");
    expect(result.backfilledSessions).toBe(2);
    expect(result.skippedEmptyDirectories).toBe(1);
    const rows = db
        .prepare(
            "SELECT session_id, harness, project_path FROM session_projects ORDER BY session_id",
        )
        .all() as Array<{ session_id: string; harness: string; project_path: string }>;
    expect(rows.map((row) => [row.session_id, row.harness])).toEqual([
        ["ses_a", "opencode2"],
        ["ses_b", "opencode2"],
    ]);
    expect(rows[0]!.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
    expect(rows[1]!.project_path).toBe(rows[0]!.project_path);
});

test("OpenCode 2 backfill never binds Windows home spellings", async () => {
    setHarness("opencode2");
    __setProjectIdentityTestHooks({ homeDirectory: () => "C:\\Users\\Phoenix" });
    const db = new Database(":memory:");
    cleanup.unshift(() => db.close());
    initializeDatabase(db);
    runMigrations(db);
    const result = await runV2SessionProjectBackfill(db, () => ({
        sessionDirectoryPage: (after) =>
            after
                ? []
                : [
                      { sessionId: "a", directory: "c:/Users/Phoenix" },
                      { sessionId: "b", directory: "\\\\?\\C:\\Users\\Phoenix" },
                  ],
        close: () => {},
    }));
    expect(result.backfilledSessions).toBe(0);
    expect(result.skippedEmptyDirectories).toBe(2);
    expect(db.prepare("SELECT * FROM session_projects").all()).toEqual([]);
});
