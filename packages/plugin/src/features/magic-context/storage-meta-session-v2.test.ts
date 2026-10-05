import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { initializeDatabase } from "./storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "./storage-meta-session";

let root: string;
let host: Database;
let meta: Database;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalDb = process.env.OPENCODE_DB;

beforeEach(() => {
    root = createTestTempDir("mc-session-meta-v2-").dir;
    process.env.XDG_DATA_HOME = root;
    process.env.OPENCODE_DB = "opencode2.db";
    resetOpenCodeDbPathStateForTesting();
    _resetHarnessForTesting();
    setHarness("opencode2");
    mkdirSync(join(root, "opencode"));
    host = new Database(join(root, "opencode", "opencode2.db"));
    host.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT);
        CREATE TABLE session_message (id TEXT PRIMARY KEY);
        -- A converted store can retain the v1 table. It is not the authority.
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
        INSERT INTO session_v2 VALUES ('child', 'parent'), ('parent', NULL), ('empty', '');
        INSERT INTO session VALUES ('child', NULL), ('parent', 'wrong-parent');
    `);
    meta = new Database(":memory:");
    initializeDatabase(meta);
});

afterEach(() => {
    meta.close();
    host.close();
    _resetHarnessForTesting();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalDb;
    resetOpenCodeDbPathStateForTesting();
    rmSync(root, { recursive: true, force: true });
});

test("OC2 meta creation uses session_v2.parent_id before the first pass", () => {
    meta.exec(`
        CREATE TABLE creation_modes (session_id TEXT, is_subagent INTEGER);
        CREATE TRIGGER capture_creation_mode AFTER INSERT ON session_meta BEGIN
            INSERT INTO creation_modes VALUES (new.session_id, new.is_subagent);
        END;
    `);
    expect(getOrCreateSessionMeta(meta, "child").isSubagent).toBe(true);
    expect(
        meta.prepare("SELECT is_subagent FROM session_meta WHERE session_id = 'child'").get(),
    ).toEqual({ is_subagent: 1 });
    expect(
        meta.prepare("SELECT is_subagent FROM creation_modes WHERE session_id = 'child'").get(),
    ).toEqual({ is_subagent: 1 });
    expect(getOrCreateSessionMeta(meta, "parent").isSubagent).toBe(false);
    expect(getOrCreateSessionMeta(meta, "empty").isSubagent).toBe(false);
});

test("OC2 existing meta rows keep their mode across upgrades and later parent changes", () => {
    // A child first seen by the old plugin already has a primary-mode baseline.
    updateSessionMeta(meta, "child", { isSubagent: false });
    expect(getOrCreateSessionMeta(meta, "child").isSubagent).toBe(false);
    expect(getOrCreateSessionMeta(meta, "parent").isSubagent).toBe(false);
    host.exec("UPDATE session_v2 SET parent_id = 'new-parent' WHERE id = 'parent'");
    expect(getOrCreateSessionMeta(meta, "parent").isSubagent).toBe(false);
    updateSessionMeta(meta, "empty", { isSubagent: true });
    expect(getOrCreateSessionMeta(meta, "empty").isSubagent).toBe(true);
});
