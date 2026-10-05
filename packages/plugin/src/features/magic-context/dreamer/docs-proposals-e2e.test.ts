import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMER_DOCS_ALLOWED_TOOLS } from "../../../agents/dreamer";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { listPendingDocsProposals } from "./docs-proposals";
import { acquireLease } from "./lease";
import { writeTaskStateJson } from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";

let dir: string;
let db: Database;
afterEach(() => {
    if (db) closeQuietly(db);
    if (dir) rmSync(dir, { recursive: true, force: true });
});

test("maintain-docs stub model cannot edit docs, emits a proposal and skips the next run", async () => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-docs-e2e-"));
    const git = (...args: string[]) =>
        execFileSync("git", args, { windowsHide: true, cwd: dir, encoding: "utf8" }).trim();
    const file = join(dir, "ARCHITECTURE.md");
    writeFileSync(file, "# Architecture\n\n## Core\nOld sentence.\n");
    writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\n## Layout\nLayout.\n");
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", ".");
    git("commit", "-qm", "base docs");
    writeFileSync(join(dir, "src.ts"), "export const core = true;\n");
    git("add", ".");
    git("commit", "-qm", "core implementation");
    const before = readFileSync(file);
    expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain("write");
    expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain("edit");
    expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain("bash");
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    let prompts = 0;
    const proposal = JSON.stringify([
        {
            file: "ARCHITECTURE.md",
            action: "replace",
            heading: "## Core",
            text: "## Core\nCurrent sentence.",
            reason: "Core source contradicts old description",
        },
    ]);
    const client = {
        session: {
            list: async () => ({ data: [{ id: "parent" }] }),
            create: async () => ({ data: { id: "child" } }),
            prompt: async (args: { body: { agent: string } }) => {
                prompts++;
                expect(args.body.agent).toBe("dreamer-docs");
                return {};
            },
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: Date.now() } },
                        parts: [
                            {
                                type: "tool",
                                tool: "write",
                                state: {
                                    status: "error",
                                    input: { filePath: file, content: "MALICIOUS EDIT" },
                                    error: "permission denied",
                                },
                            },
                            { type: "text", text: proposal },
                        ],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
    const executor = createDreamTaskExecutor({
        client: client as never,
        sessionDirectory: dir,
        openOpenCodeDb: () => null,
    });
    const leaseKey = leaseKeyFor("maintain-docs", dir);
    expect(acquireLease(db, "holder", leaseKey)).toBe(true);
    const ctx = { db, projectIdentity: dir, holderId: "holder", leaseKey };
    const config = { task: "maintain-docs" as const, schedule: "0 4 * * *", timeoutMinutes: 20 };
    const first = await executor(config, ctx);
    expect(first.status).toBe("completed");
    expect(JSON.parse(first.schedulePatch?.taskStateJson ?? "null")).toEqual({
        head: git("rev-parse", "HEAD"),
    });
    writeTaskStateJson(db, dir, "maintain-docs", first.schedulePatch?.taskStateJson ?? "{}");
    expect(readFileSync(file)).toEqual(before);
    expect(listPendingDocsProposals(dir)).toHaveLength(1);
    const second = await executor(config, ctx);
    expect(second.status).toBe("completed");
    expect(second.detail).toBe("no commits since last run");
    expect(prompts).toBe(1);
    expect(readFileSync(file)).toEqual(before);
});
