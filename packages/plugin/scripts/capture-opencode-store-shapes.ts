#!/usr/bin/env bun
/**
 * Capture the real OpenCode store shapes that the conditional harness relabel
 * (migration v87) reasons about, straight from the shipped binaries.
 *
 * Three shapes are captured, each in its own throwaway HOME/XDG tree so the
 * operator's real store is never touched:
 *
 *   fresh_v1       — an OpenCode 1.18.x host creating its store from scratch
 *   fresh_v2       — an OpenCode 2.0.x host creating its store from scratch
 *   migrated_v1_v2 — the 1.18.x store above, opened once by the 2.0.x host
 *
 * The output JSON pins the table list and the CREATE TABLE text for the tables
 * the relabel evidence reads, plus the session rows the 2.x host produced while
 * migrating. Tests rebuild stores from this DDL instead of hand-writing a host
 * schema that would drift from the real one.
 *
 * Usage:
 *   bun scripts/capture-opencode-store-shapes.ts
 *   OPENCODE_V1_BIN=/path/to/opencode OPENCODE_V2_BIN=/path/to/opencode2 \
 *     bun scripts/capture-opencode-store-shapes.ts
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../src/shared/sqlite";

const EVIDENCE_TABLES = [
    "project",
    "session",
    "message",
    "part",
    "session_message",
    "session_v2",
] as const;

const FIXTURE_PATH = resolve(
    import.meta.dir,
    "../src/features/magic-context/__fixtures__/opencode-store-shapes.json",
);

interface CapturedShape {
    description: string;
    tables: string[];
    ddl: Record<string, string>;
    rows: Record<string, Array<Record<string, unknown>>>;
}

interface CapturedFixture {
    capturedAt: string;
    binaries: Record<string, { path: string; version: string }>;
    shapes: Record<string, CapturedShape>;
}

function binaryVersion(bin: string): string {
    const result = Bun.spawnSync([bin, "--version"]);
    // 1.18.x prints a bare version, 2.0.x prints "opencode v2.0.5".
    const printed = new TextDecoder().decode(result.stdout).trim().split(/\s+/).pop() ?? "unknown";
    return printed.replace(/^v/, "");
}

function makeRoot(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `mc-store-shape-${name}-`));
    for (const dir of ["home", "data", "config", "state", "cache"]) {
        mkdirSync(join(root, dir), { recursive: true });
    }
    return root;
}

function hostEnvironment(root: string): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(root, "home"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        // Never inherit an operator override for the store location: every shape
        // must land inside its own throwaway data home.
        OPENCODE_DB: undefined,
    };
}

/** Boot the host long enough for it to create (or migrate) its store, then stop it. */
async function bootHost(bin: string, root: string, timeoutMs = 90_000): Promise<void> {
    const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: join(root, "home"),
        env: hostEnvironment(root),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    await new Promise<void>((settle, fail) => {
        const timer = setTimeout(() => {
            fail(new Error(`${bin} did not report a listening server in ${timeoutMs}ms: ${output}`));
        }, timeoutMs);
        const onChunk = (chunk: Buffer): void => {
            output += chunk.toString();
            if (/listening on http/i.test(output)) {
                clearTimeout(timer);
                settle();
            }
        };
        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        child.on("error", (error) => {
            clearTimeout(timer);
            fail(error);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            fail(new Error(`${bin} exited with code ${code} before listening: ${output}`));
        });
    });
    // The store is written during boot; give the host a moment to finish its
    // migration bookkeeping before the process group goes away.
    await Bun.sleep(2_000);
    if (child.pid !== undefined) {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            // Already gone: nothing to reap.
        }
    }
}

function captureShape(dbPath: string, description: string): CapturedShape {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const tables = (
            db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .all() as Array<{ name: string }>
        ).map((row) => row.name);
        const ddl: Record<string, string> = {};
        const rows: Record<string, Array<Record<string, unknown>>> = {};
        for (const table of EVIDENCE_TABLES) {
            if (!tables.includes(table)) continue;
            const statement = db
                .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get(table) as { sql?: string } | null;
            if (statement?.sql) ddl[table] = statement.sql;
            if (table === "session" || table === "session_v2") {
                rows[table] = db
                    .prepare(`SELECT id, time_created, time_updated FROM ${table} ORDER BY id`)
                    .all() as Array<Record<string, unknown>>;
            }
        }
        return { description, tables, ddl, rows };
    } finally {
        db.close();
    }
}

async function createV1Session(root: string, bin: string): Promise<void> {
    // A session row is the smallest real artifact the 2.x host will migrate, and
    // creating it needs no model or credential.
    const child = spawn(bin, ["serve", "--port", "4187"], {
        cwd: join(root, "home"),
        env: hostEnvironment(root),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    try {
        await new Promise<void>((settle, fail) => {
            const timer = setTimeout(() => fail(new Error("v1 host never listened")), 90_000);
            const onChunk = (chunk: Buffer): void => {
                if (/listening on http/i.test(chunk.toString())) {
                    clearTimeout(timer);
                    settle();
                }
            };
            child.stdout?.on("data", onChunk);
            child.stderr?.on("data", onChunk);
        });
        const response = await fetch("http://127.0.0.1:4187/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "magic-context store shape fixture" }),
        });
        if (!response.ok) throw new Error(`v1 session create failed: ${response.status}`);
        await response.json();
        await Bun.sleep(1_000);
    } finally {
        if (child.pid !== undefined) {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {
                // Already gone.
            }
        }
    }
}

async function main(): Promise<void> {
    const v1Bin = process.env.OPENCODE_V1_BIN ?? join(homedir(), ".opencode/bin/opencode");
    const v2Bin =
        process.env.OPENCODE_V2_BIN ??
        resolve(import.meta.dir, "../node_modules/.bin/opencode2");
    for (const bin of [v1Bin, v2Bin]) {
        if (!existsSync(bin)) throw new Error(`OpenCode binary not found: ${bin}`);
    }
    const v1Version = binaryVersion(v1Bin);
    const v2Version = binaryVersion(v2Bin);
    if (!v1Version.startsWith("1.")) throw new Error(`expected a 1.x binary, got ${v1Version}`);
    if (!v2Version.startsWith("2.")) throw new Error(`expected a 2.x binary, got ${v2Version}`);

    const roots: string[] = [];
    try {
        const v1Root = makeRoot("v1");
        roots.push(v1Root);
        await bootHost(v1Bin, v1Root);
        await createV1Session(v1Root, v1Bin);
        const freshV1 = captureShape(
            join(v1Root, "data/opencode/opencode.db"),
            `store created by OpenCode ${v1Version}`,
        );

        const v2Root = makeRoot("v2");
        roots.push(v2Root);
        await bootHost(v2Bin, v2Root);
        const freshV2 = captureShape(
            join(v2Root, "data/opencode/opencode.db"),
            `store created by OpenCode ${v2Version}`,
        );

        const migratedRoot = makeRoot("migrated");
        roots.push(migratedRoot);
        rmSync(join(migratedRoot, "data"), { recursive: true, force: true });
        cpSync(join(v1Root, "data"), join(migratedRoot, "data"), { recursive: true });
        await bootHost(v2Bin, migratedRoot);
        const migrated = captureShape(
            join(migratedRoot, "data/opencode/opencode.db"),
            `store created by OpenCode ${v1Version}, then opened once by OpenCode ${v2Version}`,
        );

        const repoRoot = resolve(import.meta.dir, "../../..");
        // Record binaries repo-relatively where possible: the absolute path of
        // whoever regenerated the fixture is noise in a committed file.
        const describeBinary = (path: string): string => {
            if (path.startsWith(`${repoRoot}/`)) return path.slice(repoRoot.length + 1);
            const home = homedir();
            return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
        };
        const fixture: CapturedFixture = {
            capturedAt: new Date().toISOString().slice(0, 10),
            binaries: {
                v1: { path: describeBinary(v1Bin), version: v1Version },
                v2: { path: describeBinary(v2Bin), version: v2Version },
            },
            shapes: { fresh_v1: freshV1, fresh_v2: freshV2, migrated_v1_v2: migrated },
        };
        await Bun.write(FIXTURE_PATH, `${JSON.stringify(fixture, null, 4)}\n`);
        console.log(`wrote ${FIXTURE_PATH}`);
        for (const [name, shape] of Object.entries(fixture.shapes)) {
            console.log(`  ${name}: ${Object.keys(shape.ddl).sort().join(", ")}`);
        }
    } finally {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
}

await main();
