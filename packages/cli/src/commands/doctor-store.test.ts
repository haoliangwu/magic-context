import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SUPPORTED_VERSION } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { runDoctorStoreCli, runDoctorStoreInit } from "./doctor-store";

let root: string;
let data: string;
let oldEnv: NodeJS.ProcessEnv;
beforeEach(() => {
    oldEnv = { ...process.env };
    const parent = join(tmpdir(), "magic-context", "store-init");
    mkdirSync(parent, { recursive: true });
    root = createTestTempDirFromPath(join(parent, "cli-"));
    data = join(root, "cortexkit", "magic-context");
    // Explicit scratch paths exercise production path resolution without touching a live store.
    process.env.NODE_ENV = "production";
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
});
afterEach(() => {
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
});

test("store init creates the host schema and identity at the current fence", () => {
    const path = join(data, "context.db");
    expect(existsSync(path)).toBe(false);
    const lines: string[] = [];
    expect(runDoctorStoreInit((line) => lines.push(line))).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(lines.join("\n")).toContain(`${path} (schema v${LATEST_SUPPORTED_VERSION})`);
    const db = new Database(path, { readonly: true });
    try {
        expect(
            db.prepare("SELECT value FROM context_store_meta WHERE key = 'store_uuid'").get(),
        ).toBeTruthy();
        expect(db.prepare("SELECT state FROM single_store_state WHERE id = 1").get()).toEqual({
            state: "required",
        });
    } finally {
        db.close();
    }
});

test("store init honours the explicit storage directory and leaves existing stores byte-identical", () => {
    data = join(root, "override");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = data;
    expect(runDoctorStoreInit(() => {})).toBe(0);
    const path = join(data, "context.db");
    const before = readFileSync(path);
    const lines: string[] = [];
    expect(runDoctorStoreInit((line) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("Store already exists:");
    expect(readFileSync(path)).toEqual(before);
});

test("store init refuses a newer schema without changing it", () => {
    mkdirSync(data, { recursive: true });
    const path = join(data, "context.db");
    const db = new Database(path);
    db.exec(
        `CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES (${LATEST_SUPPORTED_VERSION + 1})`,
    );
    db.close();
    const before = readFileSync(path);
    const lines: string[] = [];
    expect(runDoctorStoreInit((line) => lines.push(line))).toBe(1);
    expect(lines.join("\n")).toContain("newer than this CLI supports");
    expect(readFileSync(path)).toEqual(before);
});

test("store command rejects unknown operations", () => {
    expect(runDoctorStoreCli(["upgrade"])).toBe(1);
    expect(existsSync(join(data, "context.db"))).toBe(false);
});

async function setupCli(dryRun: boolean): Promise<number> {
    const entry = new URL("../index.ts", import.meta.url).pathname;
    const child = Bun.spawn(
        [
            process.execPath,
            "run",
            entry,
            "setup",
            "--harness",
            "pi",
            ...(dryRun ? ["--dry-run"] : []),
        ],
        {
            windowsHide: true,
            env: { ...process.env, PATH: root },
            cwd: root,
            stdout: "ignore",
            stderr: "ignore",
        },
    );
    return child.exited;
}

test("setup provisions context.db even when no Pi host is installed", async () => {
    expect(await setupCli(false)).toBe(1);
    expect(existsSync(join(data, "context.db"))).toBe(true);
});

test("setup dry run does not provision context.db", async () => {
    expect(await setupCli(true)).toBe(1);
    expect(existsSync(join(data, "context.db"))).toBe(false);
});
