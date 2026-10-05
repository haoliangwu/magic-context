import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    collectHistorianFailures,
    collectHistorianRuns,
    collectRecentSessions,
    type DiagnosticRows,
    type HistorianFailureSummary,
    type HistorianRunSummary,
    type RecentSessionSummary,
} from "./diagnostics-opencode";

interface StoreResults {
    runs: DiagnosticRows<HistorianRunSummary>;
    failures: DiagnosticRows<HistorianFailureSummary>;
    sessions: DiagnosticRows<RecentSessionSummary>;
}

const schema = `
    CREATE TABLE session_meta (
        session_id TEXT PRIMARY KEY, historian_failure_count INTEGER,
        historian_last_error TEXT, historian_last_failure_at INTEGER
    );
    CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER,
        parent_id TEXT, time_archived INTEGER
    );`;
const runsSchema = `CREATE TABLE historian_runs (
    session_id TEXT, status TEXT, failure_reason TEXT, created_at INTEGER
);`;

async function readStore(path: string): Promise<StoreResults> {
    return {
        runs: await collectHistorianRuns(path),
        failures: await collectHistorianFailures(path),
        sessions: await collectRecentSessions(
            { path: join(path, "context.db"), source: "default", channel: null },
            "v1",
        ),
    };
}

function assertStoreResults(results: Record<string, StoreResults>) {
    expect(results.populated.runs).toEqual({
        available: true,
        rows: [
            {
                sessionId: "ses_fixture",
                total: 3,
                success: 1,
                failed: 1,
                noop: 1,
                lastFailureReason: "fixture failure",
                lastRunAt: new Date(3000).toISOString(),
            },
        ],
    });
    expect(results.populated.failures).toEqual({
        available: true,
        rows: [
            {
                sessionId: "ses_fixture",
                failureCount: 2,
                lastError: "fixture error",
                lastFailureAt: new Date(1000).toISOString(),
            },
        ],
    });
    expect(results.populated.sessions).toEqual({
        available: true,
        rows: [
            {
                sessionId: "ses_fixture",
                title: "fixture",
                directory: "/fixture",
                lastActiveAt: new Date(3000).toISOString(),
                parentSessionId: null,
            },
        ],
    });
    for (const result of Object.values(results.empty)) {
        expect(result).toEqual({ available: true, rows: [] });
    }
    for (const result of Object.values(results.missing)) {
        expect(result).toEqual({ available: false, reason: "path missing" });
    }
    expect(results.older.runs).toMatchObject({
        available: false,
        reason: expect.stringContaining("schema too old"),
    });
    expect(results.older.failures).toEqual({ available: true, rows: [] });
    expect(results.older.sessions).toEqual({ available: true, rows: [] });
    for (const result of Object.values(results.corrupt)) {
        expect(result).toMatchObject({
            available: false,
            reason: expect.stringContaining("query error"),
        });
    }
}

describe("doctor database collectors", () => {
    let root: string;
    const names = ["populated", "empty", "missing", "older", "corrupt"];

    beforeEach(() => {
        const base = join(tmpdir(), "magic-context", "doctor-node");
        mkdirSync(base, { recursive: true });
        root = createTestTempDirFromPath(join(base, "collectors-"));
        for (const name of names) {
            const dir = join(root, name);
            mkdirSync(dir);
            if (name === "missing") continue;
            if (name === "corrupt") {
                writeFileSync(join(dir, "context.db"), "not a SQLite database");
                continue;
            }
            const db = new Database(join(dir, "context.db"));
            try {
                db.exec(schema);
                if (name !== "older") db.exec(runsSchema);
                if (name === "populated") {
                    const insert = db.prepare("INSERT INTO historian_runs VALUES (?, ?, ?, ?)");
                    insert.run("ses_fixture", "failed", "fixture failure", 1000);
                    insert.run("ses_fixture", "success", null, 2000);
                    insert.run("ses_fixture", "noop", null, 3000);
                    db.prepare("INSERT INTO session_meta VALUES (?, ?, ?, ?)").run(
                        "ses_fixture",
                        2,
                        "fixture error",
                        1000,
                    );
                    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
                        "ses_fixture",
                        "/fixture",
                        "fixture",
                        3000,
                        null,
                        null,
                    );
                }
            } finally {
                db.close();
            }
        }
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("reads populated, empty, missing, older and corrupt stores under Bun", async () => {
        const results: Record<string, StoreResults> = {};
        for (const name of names) results[name] = await readStore(join(root, name));
        assertStoreResults(results);
        expect(existsSync(join(root, "missing", "context.db"))).toBe(false);
    });

    it("reads populated, empty, missing, older and corrupt stores in a Node bundle", () => {
        const entry = join(root, "entry.ts");
        const bundle = join(root, "collector.mjs");
        const source = fileURLToPath(new URL("./diagnostics-opencode.ts", import.meta.url));
        writeFileSync(
            entry,
            `
            import { collectHistorianRuns, collectHistorianFailures, collectRecentSessions } from ${JSON.stringify(source)};
            if (typeof globalThis.Bun !== "undefined") throw new Error("Node test must not expose Bun");
            const results = {};
            for (const name of ${JSON.stringify(names)}) {
                const path = ${JSON.stringify(root)} + "/" + name;
                results[name] = {
                    runs: await collectHistorianRuns(path),
                    failures: await collectHistorianFailures(path),
                    sessions: await collectRecentSessions({ path: path + "/context.db", source: "default", channel: null }, "v1"),
                };
            }
            console.log(JSON.stringify(results));
        `,
        );
        const build = spawnSync(
            process.execPath,
            [
                "build",
                entry,
                "--target",
                "node",
                "--format",
                "esm",
                "--external",
                "node:sqlite",
                "--outfile",
                bundle,
            ],
            { encoding: "utf8", windowsHide: true },
        );
        expect(build.status, build.stderr).toBe(0);
        const run = spawnSync("node", [bundle], { encoding: "utf8", windowsHide: true });
        expect(run.status, run.stderr).toBe(0);
        assertStoreResults(JSON.parse(run.stdout));
        expect(existsSync(join(root, "missing", "context.db"))).toBe(false);
    });
});
