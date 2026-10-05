import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { runDoctorSingleStoreCli } from "./doctor-single-store";
import { parseRepairHistoryArgs, runDoctorSingleStoreRepair } from "./doctor-single-store-repair";

const root = join(tmpdir(), "magic-context", "b2-repair-cli");
mkdirSync(root, { recursive: true });
function executable(content: string): string {
    const path = join(root, createHash("sha256").update(content).digest("hex"));
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o755, flag: "wx" });
    return path;
}
const engine = executable(`#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CALLS"
printf '%s\\n' "$FAKE_REPORT"
exit "\${FAKE_EXIT:-0}"
`);
const lsof = executable(`#!/bin/sh
printf '%s\\n' "$FAKE_LSOF_PID"
exit "\${FAKE_LSOF_EXIT:-1}"
`);

const plan = {
    session: "ses_lost",
    project: "git:p",
    backup: { compartments: 5, max_sequence: 4, end_message: 50 },
    live: { compartments: 5, max_sequence: 4, end_message: 48 },
    after: { compartments: 5, max_sequence: 4, end_message: 50 },
    kept: 2,
    restored: 3,
    removed: 3,
    removed_sequences: [2, 4],
    straddling: 0,
    tail: 0,
    compartment_events: { restored: 3, removed: 2 },
    chunk_embeddings: { restored: 2, removed: 1 },
    user_memory_candidates: { restored: 1, removed: 1 },
};
let dir: string;
let data: string;
let backup: string;
let lines: string[];
let lsofCalls: number;
let oldEnv: NodeJS.ProcessEnv;

beforeEach(() => {
    oldEnv = { ...process.env };
    dir = createTestTempDirFromPath(join(root, "case-"));
    data = join(dir, "cortexkit", "magic-context");
    backup = join(dir, "migration-backup");
    mkdirSync(data, { recursive: true });
    mkdirSync(backup, { recursive: true });
    for (const path of [
        join(data, "context.db"),
        join(data, "store.db"),
        join(backup, "context.db"),
        join(backup, "store.db"),
    ])
        writeFileSync(path, "");
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = data;
    process.env.FAKE_CALLS = join(dir, "calls");
    process.env.FAKE_REPORT = JSON.stringify({
        status: "preview",
        sessions: [plan],
        not_needed: [],
    });
    process.env.FAKE_EXIT = "0";
    process.env.FAKE_LSOF_EXIT = "1";
    process.env.FAKE_LSOF_PID = "";
    lines = [];
    lsofCalls = 0;
});
afterEach(() => {
    process.env = oldEnv;
    rmSync(dir, { recursive: true, force: true });
});

function run(options: Parameters<typeof runDoctorSingleStoreRepair>[0]) {
    return runDoctorSingleStoreRepair(
        { ckMc: engine, fromBackup: backup, ...options },
        {
            now: () => new Date("2026-09-30T20:00:00.000Z"),
            print: (line) => lines.push(line),
            inspectHolders: () => ({ safe: true, blockers: [] }),
            lsofSpawn: (command, args, options) => {
                lsofCalls += 1;
                expect(command).toBe("lsof");
                return spawnSync(lsof, args, { ...options, windowsHide: true });
            },
            freeBytes: () => Number.MAX_SAFE_INTEGER,
        },
    );
}
const engineArgs = () =>
    existsSync(join(dir, "calls"))
        ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
        : null;

test("a preview calls the engine without --apply and without probing holders", () => {
    expect(run({ sessions: ["ses_lost"] })).toBe(0);
    const args = engineArgs()!;
    expect(args[0]).toBe("single-store-repair-history");
    expect(args).toContain("--from-backup");
    expect(args).toContain("ses_lost");
    expect(args).not.toContain("--apply");
    expect(lsofCalls).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("preview; nothing written");
    expect(out).toContain("kept 2 / restored 3 / removed 3 (sequences 2-4)");
});

test("apply refuses while a host holds the stores and never calls the engine", () => {
    process.env.FAKE_LSOF_PID = "4242";
    process.env.FAKE_LSOF_EXIT = "0";
    expect(run({ apply: true })).toBe(2);
    expect(lines.join("\n")).toContain("repair_files_in_use");
    expect(lines.join("\n")).toContain("database holder (PID 4242)");
    expect(engineArgs()).toBeNull();
});

test("apply --live repairs named sessions while a host holds the stores", () => {
    process.env.FAKE_LSOF_PID = "4242";
    process.env.FAKE_LSOF_EXIT = "0";
    process.env.FAKE_REPORT = JSON.stringify({
        status: "repaired",
        backup_dir: "/b",
        sessions: [plan],
        not_needed: [],
    });
    expect(run({ apply: true, live: true, sessions: ["ses_lost"] })).toBe(0);
    const args = engineArgs()!;
    expect(args).toContain("--apply");
    const backupDir = args[args.indexOf("--backup-dir") + 1];
    expect(backupDir).toBe(join(data, "backups", "repair-history-2026-09-30T20-00-00.000Z"));
    expect(lines.join("\n")).toContain("Repaired 1 session(s)");
});

test("--live without a named session refuses", () => {
    expect(run({ apply: true, live: true })).toBe(2);
    expect(lines.join("\n")).toContain("--live repairs named sessions only");
    expect(engineArgs()).toBeNull();
});

test("an engine refusal is reported with its code", () => {
    process.env.FAKE_EXIT = "2";
    process.env.FAKE_REPORT = JSON.stringify({
        status: "refused",
        refusal: { code: "repair_session_busy", message: "session ses_lost is being written" },
    });
    expect(run({ apply: true, sessions: ["ses_lost"] })).toBe(2);
    expect(lines.join("\n")).toContain("repair_session_busy: session ses_lost is being written");
});

test("a missing backup file refuses before the engine runs", () => {
    rmSync(join(backup, "store.db"));
    expect(run({})).toBe(2);
    expect(lines.join("\n")).toContain("repair_backup_missing");
});

test("the repair-history arguments are parsed", () => {
    expect(parseRepairHistoryArgs(["--session", "a"])).toBe("--from-backup <dir> is required");
    expect(parseRepairHistoryArgs(["--from-backup", "b", "--live"])).toBe(
        "--live only applies with --apply",
    );
    expect(
        parseRepairHistoryArgs([
            "--from-backup",
            "b",
            "--session",
            "a",
            "--session",
            "c",
            "--apply",
        ]),
    ).toEqual({ fromBackup: "b", sessions: ["a", "c"], apply: true });
});

test("migrate rejects a malformed --prefer-history", () => {
    expect(runDoctorSingleStoreCli(["migrate", "--prefer-history", "ses_a=both"])).toBe(1);
});
