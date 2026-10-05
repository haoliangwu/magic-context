import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
    closeDatabase,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { runDoctorSingleStore } from "./doctor-single-store";

const root = join(tmpdir(), "magic-context", "b2-t2");
mkdirSync(root, { recursive: true });
function executable(content: string): string {
    const path = join(root, createHash("sha256").update(content).digest("hex"));
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o755, flag: "wx" });
    return path;
}
const engine = executable(`#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CALLS"
printf '%s\\n' "$FAKE_REPORT"
printf '%s\\n' "$FAKE_STDERR" >&2
exit "\${FAKE_EXIT:-0}"
`);
const lsof = executable(`#!/bin/sh
printf '%s\\n' "$FAKE_LSOF_PID"
exit "\${FAKE_LSOF_EXIT:-1}"
`);
let dir: string;
let data: string;
let lines: string[];
let oldEnv: NodeJS.ProcessEnv;
const report = {
    status: "migrated",
    backup_dir: "/backup/pair",
    migrated_at: 100,
    migrated_by: "fake",
    projects: [
        {
            project: "git:p",
            winner: "store",
            skipped: false,
            tables: {
                memories: {
                    source: 3,
                    copied: 1,
                    updated: 1,
                    kept: 1,
                    deleted: 0,
                    orphans_kept: 0,
                },
            },
        },
    ],
    render_check: { sampled: 2, passed: true, seed: 7 },
    sessions_reset: 2,
    store_db_bytes: { before: 100, after: 50 },
};
beforeEach(() => {
    oldEnv = { ...process.env };
    dir = createTestTempDirFromPath(join(root, "case-"));
    data = join(dir, "cortexkit", "magic-context");
    mkdirSync(data, { recursive: true });
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = data;
    process.env.FAKE_CALLS = join(dir, "calls");
    process.env.FAKE_REPORT = JSON.stringify(report);
    process.env.FAKE_EXIT = "0";
    process.env.FAKE_STDERR = "";
    process.env.FAKE_LSOF_EXIT = "1";
    process.env.FAKE_LSOF_PID = "";
    const context = new Database(join(data, "context.db"));
    initializeDatabase(context);
    runMigrations(context);
    context.close();
    const store = new Database(join(data, "store.db"));
    store.exec(
        "CREATE TABLE cortexkit_schema_version(namespace TEXT, version INTEGER); INSERT INTO cortexkit_schema_version VALUES ('mc_cache', 59), ('mc_cache', 60); CREATE TABLE mc_privilege_state(id INTEGER PRIMARY KEY, single_store INTEGER, single_store_set_at_ms INTEGER); INSERT INTO mc_privilege_state VALUES (1,0,NULL)",
    );
    store.close();
    lines = [];
});
afterEach(() => {
    closeDatabase();
    process.env = oldEnv;
    rmSync(dir, { recursive: true, force: true });
});
function run(extra = {}, freeBytes = Number.MAX_SAFE_INTEGER) {
    return runDoctorSingleStore(
        { ckMc: engine, ...extra },
        {
            now: () => new Date("2026-09-28T12:00:00.000Z"),
            print: (line) => {
                if (
                    line === "To undo: quit every host, then" &&
                    !lines.some((entry) => entry === line)
                )
                    expect(called()).toBe(false);
                lines.push(line);
            },
            inspectHolders: () => ({ safe: true, blockers: [] }),
            lsofSpawn: (command, args, options) => {
                expect(command).toBe("lsof");
                expect(args).toContain(join(data, "context.db"));
                expect(args).toContain(join(data, "store.db"));
                return spawnSync(lsof, args, { ...options, windowsHide: true });
            },
            freeBytes: () => freeBytes,
        },
    );
}
function output() {
    return lines.join("\n");
}
function called() {
    return existsSync(join(dir, "calls"));
}

test("preflight refuses a fake lsof holder before calling the engine", () => {
    process.env.FAKE_LSOF_PID = "424242";
    process.env.FAKE_LSOF_EXIT = "0";
    expect(run()).toBe(2);
    expect(output()).toContain("single_store_files_in_use");
    expect(output()).toContain("database holder (PID 424242)");
    expect(output()).toContain("ck stop magic-context");
    expect(called()).toBe(false);
});
test("preflight refuses lsof failure rather than treating it as free", () => {
    process.env.FAKE_LSOF_EXIT = "3";
    expect(run()).toBe(2);
    expect(output()).toContain("could not run lsof");
    expect(called()).toBe(false);
});
test("preflight refuses insufficient disk space", () => {
    expect(run({}, 0)).toBe(2);
    expect(output()).toContain("single_store_disk_space");
    expect(output()).toMatch(/need \d+ bytes; have 0/);
    expect(called()).toBe(false);
});
test("already migrated prints its stamp without calling the engine", () => {
    const context = new Database(join(data, "context.db"));
    context.exec(
        "UPDATE single_store_state SET state='migrated', migrated_at=123, migrated_by='build', backup_dir='/backup'",
    );
    context.close();
    const store = new Database(join(data, "store.db"));
    store.exec(
        "UPDATE cortexkit_schema_version SET version=61; UPDATE mc_privilege_state SET single_store=1, single_store_set_at_ms=123",
    );
    store.close();
    expect(run()).toBe(0);
    expect(output()).toContain("already migrated at 123 by build; backup /backup");
    expect(called()).toBe(false);
});
test("refused engine run prints refusal code and message and exits nonzero", () => {
    process.env.FAKE_EXIT = "2";
    process.env.FAKE_REPORT = JSON.stringify({
        ...report,
        status: "refused",
        refusal: { code: "single_store_foreign_context", message: "foreign uuid for git:p" },
    });
    expect(run()).toBe(2);
    expect(output()).toContain("single_store_foreign_context: foreign uuid for git:p");
    expect(called()).toBe(true);
});
test("engine receives fixed flags and report prints counts backup and undo", () => {
    expect(
        run({
            dryRun: true,
            skipForeign: true,
            prefer: ["git:p=store", "git:q=context"],
            acceptIdChange: true,
        }),
    ).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual([
        "single-store-migrate",
        "--context-db",
        join(data, "context.db"),
        "--store-db",
        join(data, "store.db"),
        "--backup-dir",
        join(data, "backups", "single-store-2026-09-28T12-00-00.000Z"),
        "--dry-run",
        "--skip-foreign",
        "--prefer",
        "git:p=store",
        "--prefer",
        "git:q=context",
        "--accept-id-change",
    ]);
    expect(output()).toContain("git:p: winner store");
    expect(output()).toContain(
        "source 3 / copied 1 / updated 1 / kept 1 / deleted 0 / orphans_kept 0",
    );
    expect(output()).toContain("To undo: quit every host");
    expect(output()).toContain(
        "This restores the unmigrated stores. Keep the current plugin and ck-mc: TypeScript mode works as before, and Rust mode will refuse with MC-C14 until you run this command again.",
    );
    expect(output()).not.toContain("reinstall the previous plugin");
    expect(output()).toContain("Backup: /backup/pair");
    expect(output()).toContain("Render check: sampled 2, passed true, seed 7");
    expect(output()).toContain("Sessions reset: 2; store.db bytes: 100 -> 50");
});
test("split stamps refuse without invoking engine", () => {
    const store = new Database(join(data, "store.db"));
    store.exec("UPDATE mc_privilege_state SET single_store=1, single_store_set_at_ms=123");
    store.close();
    expect(run()).toBe(2);
    expect(output()).toContain("single_store_state_split");
    expect(called()).toBe(false);
});

test("RPC or Pi holder refuses even when lsof is free", () => {
    const code = runDoctorSingleStore(
        { ckMc: engine },
        {
            print: (line) => lines.push(line),
            inspectHolders: () => ({ safe: false, blockers: ["Pi/OMP harness (PID 555)"] }),
            lsofSpawn: () => ({ status: 1, stdout: "" }),
        },
    );
    expect(code).toBe(2);
    expect(output()).toContain("Pi/OMP harness (PID 555)");
    expect(called()).toBe(false);
});

test("versions outside the offline pair refuse before engine invocation", () => {
    const store = new Database(join(data, "store.db"));
    store.exec("INSERT INTO cortexkit_schema_version VALUES ('mc_cache', 62)");
    store.close();
    expect(run()).toBe(2);
    expect(output()).toContain(
        `single_store_version_mismatch: context.db v${LATEST_SUPPORTED_VERSION}; store.db v62`,
    );
    expect(called()).toBe(false);
});

test("malformed engine JSON fails as an internal error", () => {
    process.env.FAKE_REPORT = "not JSON";
    expect(run()).toBe(1);
    expect(output()).toContain("single_store_internal_error");
});

test("engine diagnostics preserve both timings and the structured internal error", () => {
    process.env.FAKE_STDERR = "backup context.db: copy: 12.3s";
    process.env.FAKE_REPORT = JSON.stringify({ status: "error", error: "transaction failed" });
    process.env.FAKE_EXIT = "1";
    expect(run()).toBe(1);
    expect(output()).toContain("backup context.db: copy: 12.3s");
    expect(output()).toContain("transaction failed");
});

test("successful engine diagnostics retain per-step times", () => {
    process.env.FAKE_STDERR = "transaction: 1.2s";
    expect(run()).toBe(0);
    expect(output()).toContain("transaction: 1.2s");
});

test("completed migration prints transaction and vacuum timings from the engine report", () => {
    process.env.FAKE_REPORT = JSON.stringify({ ...report, transaction_ms: 123, vacuum_ms: 45 });
    expect(run()).toBe(0);
    expect(output()).toContain("Transaction: 123 ms; vacuum: 45 ms");
});

test("offline preflight upgrades v92 and seeds history revisions before invoking the engine", () => {
    const path = join(data, "context.db");
    const context = new Database(path);
    context.exec(`
        DROP TRIGGER compartment_history_ai;
        DROP TRIGGER compartment_history_au;
        DROP TRIGGER compartment_history_ad;
        DROP TABLE compartment_history_versions;
        DELETE FROM schema_migrations WHERE version>=93;
        INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at)
        VALUES ('older-history',0,1,4,'title','body',1);
    `);
    context.close();
    expect(run()).toBe(0);
    expect(called()).toBe(true);
    const upgraded = new Database(path);
    try {
        expect(
            upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
        ).toEqual({ version: LATEST_SUPPORTED_VERSION });
        expect(
            upgraded
                .prepare(
                    "SELECT version FROM compartment_history_versions WHERE session_id='older-history'",
                )
                .get(),
        ).toEqual({ version: 0 });
        expect(
            upgraded
                .prepare("SELECT content FROM compartments WHERE session_id='older-history'")
                .get(),
        ).toEqual({ content: "body" });
    } finally {
        upgraded.close();
    }
});
