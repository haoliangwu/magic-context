/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetVerificationPathsForTests,
    __setVerificationPathsTestHooks,
    insertMemory,
    readGitFileChangeTimesSince,
    recordMemoryMapping,
    recordMemoryVerifications,
} from "../memory";
import { resolveGitTopLevel } from "../memory/verification-paths";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { getTaskScheduleState, seedTaskScheduleState } from "./storage-task-schedule";
import { partitionVerifyScope } from "./verify-gate";

const PROJECT = "git:test";
const HEAD_SHA = "1111111111111111111111111111111111111111";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function mem(db: Database, projectPath: string, content: string): number {
    const m = insertMemory(db, {
        projectPath,
        category: "ARCHITECTURE",
        content,
        sourceSessionId: "ses",
    });
    if (!m) throw new Error("insertMemory failed");
    return m.id;
}

function gitCommand(args: readonly string[]): string {
    return JSON.stringify([...args]);
}

function makeGitMetadataDirectory(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    dirs.push(dir);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n", "utf8");
    return dir;
}

function installGitScript(responses: Map<string, string | Error>): void {
    __setVerificationPathsTestHooks({
        execFile: async (file, args, options) => {
            if (file !== "git") {
                throw new Error(`Unexpected binary: ${file}`);
            }
            const response = responses.get(gitCommand(args));
            if (response === undefined) {
                throw new Error(
                    `Unexpected git command for ${options.cwd}: ${JSON.stringify([...args])}`,
                );
            }
            if (response instanceof Error) {
                throw response;
            }
            return { stdout: response, stderr: "" };
        },
    });
}

const dirs: string[] = [];

afterEach(() => {
    __resetVerificationPathsForTests();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
});

test("git verification timeout reports the stalled command", async () => {
    const dir = makeGitMetadataDirectory("mc-verify-git-timeout-");
    const timeout = Object.assign(new Error("git exceeded its deadline"), { killed: true });
    installGitScript(new Map([[gitCommand(["rev-parse", "--show-toplevel"]), timeout]]));
    await expect(resolveGitTopLevel(dir)).rejects.toThrow(
        "Git verification command git rev-parse --show-toplevel timed out after 10000ms",
    );
});

describe("partitionVerifyScope (per-memory verified_at gate)", () => {
    test("a failed top-level lookup retains full verification even if git log could succeed", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-no-worktree-");
        __setVerificationPathsTestHooks({
            execFile: async (_binary, args) => {
                if (args[0] === "rev-parse") throw new Error("not a working tree");
                return { stdout: "", stderr: "" };
            },
        });
        try {
            const id = mem(db, PROJECT, "mapped fact without a working tree");
            recordMemoryVerifications(db, id, ["a.ts"], 10000);
            const result = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
            });
            expect(result.mode).toBe("full");
            expect(result.inScopeIds).toEqual([id]);
        } finally {
            db.close();
        }
    });
    test("incremental verification resolves the repository once and preserves skipped ids", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-one-root-");
        const calls: string[][] = [];
        __setVerificationPathsTestHooks({
            execFile: async (_binary, args) => {
                calls.push([...args]);
                if (args[0] === "rev-parse")
                    return { stdout: `${args[1] === "HEAD" ? HEAD_SHA : dir}\n`, stderr: "" };
                return { stdout: "", stderr: "" };
            },
        });
        try {
            const id = mem(db, PROJECT, "unchanged mapped fact");
            recordMemoryVerifications(db, id, ["a.ts"], 10000);
            const result = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 20000,
            });
            expect(result.skippedIds).toEqual([id]);
            expect(result.inScopeIds).toEqual([]);
            expect(calls).toEqual([
                ["rev-parse", "--show-toplevel"],
                ["log", "--since=@10", "--name-only", "--format=%ct"],
                ["rev-parse", "HEAD"],
                ["diff", "--name-only", "-z", HEAD_SHA],
            ]);
        } finally {
            db.close();
        }
    });
    test("excludes both no-file sentinel origins and unmapped memories", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-scope-");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@1", "--name-only", "--format=%ct"]), ""],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), ""],
            ]),
        );
        try {
            const mapped = mem(db, PROJECT, "A in a.ts");
            const independent = mem(db, PROJECT, "Anthropic returns 400 on empty content");
            const hostFallback = mem(db, PROJECT, "The host rejected every mapped path");
            mem(db, PROJECT, "unmapped fact");
            recordMemoryMapping(db, mapped, ["a.ts"], 1);
            recordMemoryMapping(db, independent, [], 1);
            recordMemoryMapping(db, hostFallback, [], 1, "host_rejected_fallback");

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 1000,
            });
            expect(gate.inScopeIds).toEqual([mapped]);
        } finally {
            closeQuietly(db);
        }
    });

    test("never-verified mapped memory is always in scope (verified_at=0)", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-never-");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@2", "--name-only", "--format=%ct"]), ""],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), ""],
            ]),
        );
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryMapping(db, m, ["a.ts"], 1);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 2000,
            });
            expect(gate.inScopeIds).toEqual([m]);
            expect(gate.mode).toBe("incremental");
        } finally {
            closeQuietly(db);
        }
    });

    test("a verified memory whose file is unchanged is SKIPPED", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-unchanged-");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@10", "--name-only", "--format=%ct"]), ""],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), ""],
            ]),
        );
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryVerifications(db, m, ["a.ts"], 10_000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 5000,
            });
            expect(gate.inScopeIds).toEqual([]);
            expect(gate.skippedIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a verified memory whose file changed AFTER verification is in scope", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-changed-");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@1", "--name-only", "--format=%ct"]), "2\na.ts\n"],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), ""],
            ]),
        );
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryVerifications(db, m, ["a.ts"], 1000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 2000,
            });
            expect(gate.inScopeIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a same-second git change is in scope despite millisecond verification skew", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-same-second-");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@10", "--name-only", "--format=%ct"]), "10\na.ts\n"],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), ""],
            ]),
        );
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryVerifications(db, m, ["a.ts"], 10_500);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 20_000,
            });
            expect(gate.inScopeIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("an uncommitted edit keeps the mapped memory in scope", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-uncommitted-");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@10", "--name-only", "--format=%ct"]), ""],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), "a.ts\0"],
            ]),
        );
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryVerifications(db, m, ["a.ts"], 10_000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 5000,
            });
            expect(gate.inScopeIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a deleted mapped file keeps the memory in scope", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-deleted-");
        unlinkSync(join(dir, "a.ts"));
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [gitCommand(["log", "--since=@10", "--name-only", "--format=%ct"]), ""],
                [gitCommand(["rev-parse", "HEAD"]), `${HEAD_SHA}\n`],
                [gitCommand(["diff", "--name-only", "-z", HEAD_SHA]), ""],
            ]),
        );
        try {
            const m = mem(db, PROJECT, "A in a.ts");
            recordMemoryVerifications(db, m, ["a.ts"], 10_000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 5000,
            });
            expect(gate.inScopeIds).toEqual([m]);
        } finally {
            closeQuietly(db);
        }
    });

    test("git-unavailable verification falls back to full mode", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-full-");
        installGitScript(
            new Map([
                [
                    gitCommand(["rev-parse", "--show-toplevel"]),
                    new Error("git is temporarily unavailable"),
                ],
            ]),
        );
        try {
            const a = mem(db, PROJECT, "A in a.ts");
            const b = mem(db, PROJECT, "B in b.ts");
            recordMemoryVerifications(db, a, ["a.ts"], 10_000);
            recordMemoryVerifications(db, b, ["b.ts"], 10_000);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 5000,
            });
            expect(gate.mode).toBe("full");
            expect(gate.inScopeIds.sort()).toEqual([a, b].sort());
            expect(gate.skippedIds).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("reads commit change times using Unix timestamp --since format", async () => {
        const dir = makeGitMetadataDirectory("mc-verify-gate-log-");
        const beforeChange = Date.parse("2026-01-01T12:00:00Z");
        const changeAt = Date.parse("2026-01-02T00:00:00Z");
        const afterChange = Date.parse("2026-01-03T00:00:00Z");
        installGitScript(
            new Map([
                [gitCommand(["rev-parse", "--show-toplevel"]), `${dir}\n`],
                [
                    gitCommand([
                        "log",
                        `--since=@${Math.floor(beforeChange / 1000)}`,
                        "--name-only",
                        "--format=%ct",
                    ]),
                    `${Math.floor(changeAt / 1000)}\na.ts\n`,
                ],
                [
                    gitCommand([
                        "log",
                        `--since=@${Math.floor(afterChange / 1000)}`,
                        "--name-only",
                        "--format=%ct",
                    ]),
                    "",
                ],
            ]),
        );

        const changeTimes = await readGitFileChangeTimesSince(dir, beforeChange);

        expect(changeTimes?.get("a.ts")).toBe(changeAt);

        const laterTimes = await readGitFileChangeTimesSince(dir, afterChange);
        expect(laterTimes?.has("a.ts")).toBe(false);
    });

    test("verify-broad opens a cycle and selects oldest verified memories first", async () => {
        const db = freshDb();
        const dir = makeGitMetadataDirectory("mc-verify-gate-broad-");
        try {
            const a = mem(db, PROJECT, "A in a.ts");
            const b = mem(db, PROJECT, "B in b.ts");
            recordMemoryVerifications(db, a, ["a.ts"], 10);
            recordMemoryVerifications(db, b, ["b.ts"], 20);
            seedTaskScheduleState(db, PROJECT, "verify-broad", null, null, "0 3 * * 0");
            const holderId = "verify-broad-holder";
            const leaseKey = "verify-broad-test-lease";
            expect(acquireLease(db, holderId, leaseKey)).toBe(true);
            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                forceBroad: true,
                now: 100,
                holderId,
                leaseKey,
            });
            expect(gate.mode).toBe("broad");
            expect(gate.inScopeIds).toEqual([a, b]);
            expect(gate.broadCycleStartAt).toBe(100);
            expect(getTaskScheduleState(db, PROJECT, "verify-broad")?.lastBroadRunAt).toBe(100);

            recordMemoryVerifications(db, a, ["a.ts"], 200);
            const continuation = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                forceBroad: true,
                now: 300,
                holderId,
                leaseKey,
            });
            expect(continuation.inScopeIds).toEqual([b]);
            expect(continuation.broadCycleStartAt).toBe(100);
        } finally {
            closeQuietly(db);
        }
    });
});
