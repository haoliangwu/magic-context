import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "./test-temp-dir";

// The scenario runs in a child process with NODE_ENV=production because the
// shared logger is silent under test. It imports storage-db for its side effect
// of registering the real log sink, then drives three privileged writes and one
// background writer through two connections on a throwaway database:
//   wait  - another connection holds the lock for 300 ms, the hold is short
//   hold  - the lock comes at once, the operation keeps it for 300 ms
//   fast  - neither crosses the threshold, so nothing is logged
//   async - beginSqliteWriterAsync acquires at once and holds for 300 ms
const scenario = `
    await import(${JSON.stringify(new URL("../features/magic-context/storage-db.ts", import.meta.url).href)});
    const sqlite = await import(${JSON.stringify(new URL("./sqlite.ts", import.meta.url).href)});
    const logger = await import(${JSON.stringify(new URL("./logger.ts", import.meta.url).href)});
    const dbPath = process.env.SCENARIO_DB_PATH;
    const holder = new sqlite.Database(dbPath);
    holder.exec("PRAGMA journal_mode=WAL; CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)");
    const writer = new sqlite.Database(dbPath);
    const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} };

    holder.exec("BEGIN IMMEDIATE");
    setTimeout(() => holder.exec("COMMIT"), 300);
    await sqlite.withAsyncPrivilegedWriter(writer, () => undefined);

    await sqlite.withAsyncPrivilegedWriter(writer, () => spin(300));

    await sqlite.withAsyncPrivilegedWriter(writer, () => undefined);

    await sqlite.beginSqliteWriterAsync(writer, "historian-publish");
    spin(300);
    writer.exec("COMMIT");

    logger.flushLogger();
    writer.close();
    holder.close();
`;

let root: string | null = null;
let logLines: string[] = [];
let consoleOutput = "";

function field(line: string, name: string): number {
    const value = new RegExp(`\\b${name}=(\\d+)`).exec(line)?.[1];
    if (value === undefined) throw new Error(`${name} missing from: ${line}`);
    return Number(value);
}

describe("sqlite writer diagnostics", () => {
    beforeAll(async () => {
        root = createTestTempDirFromPath(join(tmpdir(), "mc-sqlite-writer-diagnostics-"));
        const logPath = join(root, "magic-context.log");
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            NODE_ENV: "production",
            MAGIC_CONTEXT_LOG_PATH: logPath,
            MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
            SCENARIO_DB_PATH: join(root, "writer.db"),
        };
        for (const key of [
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
        ]) {
            env[key] = join(root, key);
            mkdirSync(env[key]);
        }
        const child = Bun.spawn({
            windowsHide: true,
            cmd: ["bun", "--eval", scenario],
            cwd: import.meta.dir,
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
        consoleOutput = stdout + stderr;
        logLines = existsSync(logPath)
            ? readFileSync(logPath, "utf8")
                  .split("\n")
                  .filter((line) => line.includes("sqlite writer"))
            : [];
    }, 30_000);

    afterAll(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = null;
    });

    test("nothing reaches the host console", () => {
        expect(consoleOutput).not.toContain("[magic-context]");
        expect(consoleOutput).not.toContain("sqlite writer");
    });

    test("a writer that waited for the lock reports the wait, not its short hold", () => {
        const waited = logLines.find((line) => line.includes("attempts=2"));
        if (!waited) throw new Error(`no retried acquisition logged:\n${logLines.join("\n")}`);
        expect(waited).toContain("[magic-context] sqlite writer site=privileged_writer");
        expect(waited).toContain("lane=foreground");
        expect(waited).toContain("outcome=committed");
        expect(field(waited, "acquire_ms")).toBeGreaterThanOrEqual(250);
        expect(field(waited, "hold_ms")).toBeLessThan(250);
    });

    test("a writer that held the lock reports the hold, not its quick acquisition", () => {
        const held = logLines.filter(
            (line) => line.includes("site=privileged_writer") && line.includes("attempts=1"),
        );
        expect(held).toHaveLength(1);
        expect(field(held[0], "acquire_ms")).toBeLessThan(250);
        expect(field(held[0], "hold_ms")).toBeGreaterThanOrEqual(300);
    });

    test("an async background writer reports its hold under its own site", () => {
        const held = logLines.filter((line) => line.includes("site=historian-publish"));
        expect(held).toHaveLength(1);
        expect(held[0]).toContain("lane=background");
        expect(field(held[0], "acquire_ms")).toBeLessThan(250);
        expect(field(held[0], "hold_ms")).toBeGreaterThanOrEqual(300);
    });

    test("a fast writer stays out of the log", () => {
        expect(logLines.filter((line) => line.includes("site=privileged_writer"))).toHaveLength(2);
    });
});
