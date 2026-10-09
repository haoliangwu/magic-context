// Real Pi RPC boot on a full copied context store, without any model request.

import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    watch,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = realpathSync(process.argv[2]);
assert.ok(root.startsWith(`${realpathSync(join(process.env.TMPDIR, "magic-context"))}/`));
const repo = resolve(import.meta.dir, "../../../..");
const manifest = resolve(
    repo,
    "packages/pi-plugin/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const cli = join(resolve(manifest, ".."), "dist/cli.js");
const version = JSON.parse(readFileSync(manifest, "utf8")).version;
const base = join(root, "pi-full-size");
mkdirSync(base, { recursive: true });
const env = {
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: join(base, "agent"),
    MAGIC_CONTEXT_STORAGE_DIR: join(base, "context"),
    MAGIC_CONTEXT_LOG_PATH: join(base, "plugin.log"),
    OPENCODE_DB: join(base, "absent.db"),
};
for (const key of [
    "HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
]) {
    env[key] = join(base, key);
    mkdirSync(env[key], { recursive: true });
}
mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
mkdirSync(env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true });
const cwd = join(base, "project");
mkdirSync(cwd, { recursive: true });
const context = join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db");
for (const suffix of ["", "-wal", "-shm"]) rmSync(context + suffix, { force: true });
rmSync(env.MAGIC_CONTEXT_LOG_PATH, { force: true });
const copied = spawnSync("timeout", ["60", "cp", "-c", join(root, "context.db"), context], {
    encoding: "utf8",
});
assert.equal(copied.status, 0, copied.stderr);
chmodSync(context, 0o600);
mkdirSync(join(env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
writeFileSync(
    join(env.XDG_CONFIG_HOME, "cortexkit/magic-context.jsonc"),
    JSON.stringify({
        auto_update: false,
        temporal_awareness: false,
        embedding: { provider: "off" },
        historian: { disable: true },
        dreamer: { disable: true, inject_docs: false },
        memory: { enabled: false, auto_search: { enabled: false } },
    }),
);
writeFileSync(
    join(env.PI_CODING_AGENT_DIR, "settings.json"),
    JSON.stringify({
        quietStartup: true,
        enableInstallTelemetry: false,
        compaction: { enabled: false },
        retry: { enabled: false },
    }),
);
function counts() {
    const d = new Database(context, { readonly: true });
    try {
        return d
            .query(
                "SELECT (SELECT MAX(version) FROM schema_migrations WHERE version<10000) AS schema,(SELECT count(*) FROM tags) AS tags,(SELECT count(*) FROM message_fts_rowid_map) AS messageMap,(SELECT count(*) FROM git_commits_fts) AS gitFts",
            )
            .get();
    } finally {
        d.close();
    }
}
const before = counts();
assert.equal(before.schema, 94);
const nodeProbe = spawnSync("timeout", ["20", "node", "--version"], { env, cwd, encoding: "utf8" });
assert.equal(nodeProbe.status, 0, nodeProbe.stderr);
const nodeVersion = nodeProbe.stdout.trim();
const results = [];
for (const phase of ["migration", "restart"]) {
    const logOffset =
        phase === "migration" ? 0 : readFileSync(env.MAGIC_CONTEXT_LOG_PATH, "utf8").length;
    const started = performance.now();
    const child = spawn(
        "timeout",
        [
            "180",
            "node",
            cli,
            "--mode",
            "rpc",
            "--no-extensions",
            "--extension",
            join(repo, "packages/pi-plugin"),
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--model",
            "anthropic/claude-haiku-4-5",
            "--api-key",
            "test-key-not-real",
        ],
        { env, cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
        stderr = "";
    child.stderr.on("data", (data) => {
        stderr += data;
    });
    try {
        const response = await new Promise((done, reject) => {
            const timeout = setTimeout(
                () => reject(new Error(`Pi readiness deadline: ${stderr}`)),
                60000,
            );
            child.stdout.on("data", (data) => {
                stdout += data;
                for (const line of stdout.split("\n")) {
                    try {
                        const event = JSON.parse(line);
                        if (event.id === "ready" && event.type === "response") {
                            clearTimeout(timeout);
                            done(event);
                        }
                    } catch {}
                }
            });
            child.on("exit", (code) => {
                clearTimeout(timeout);
                reject(new Error(`Pi exited ${code}: ${stderr}`));
            });
            child.stdin.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
        });
        assert.equal(response.success, true, JSON.stringify(response));
        // RPC is available while extension initialization is still pending. Wait
        // for its actual async-open completion without mistaking RPC for storage readiness.
        await new Promise((done, reject) => {
            const deadline = setTimeout(() => {
                watcher.close();
                reject(new Error(`Pi storage completion deadline: ${stderr}`));
            }, 60000);
            const check = () => {
                if (
                    existsSync(env.MAGIC_CONTEXT_LOG_PATH) &&
                    /async open main-thread migration-body count: 0 \(total=0\)/.test(
                        readFileSync(env.MAGIC_CONTEXT_LOG_PATH, "utf8").slice(logOffset),
                    )
                ) {
                    clearTimeout(deadline);
                    watcher.close();
                    done();
                }
            };
            const watcher = watch(base, check);
            check();
        });
        const logs = readFileSync(env.MAGIC_CONTEXT_LOG_PATH, "utf8").slice(logOffset);
        assert.ok(/async open main-thread migration-body count: 0 \(total=0\)/.test(logs), logs);
        if (phase === "migration") {
            assert.ok(logs.includes("applied v95"), logs);
            assert.ok(logs.includes("migration worker connection closed"), logs);
        } else
            assert.ok(
                !logs.includes("applying pending migrations on a worker thread") &&
                    !logs.includes("applied v95"),
                logs,
            );
        const fd = spawnSync("timeout", ["30", "lsof", "-g", String(child.pid), "-Fn"], {
            encoding: "utf8",
        });
        assert.equal(fd.status, 0, fd.stderr);
        const files = fd.stdout
            .split("\n")
            .filter((line) => /^n.*\.db(?:-wal|-shm|-journal)?$/.test(line))
            .map((line) => line.slice(1));
        assert.ok(files.length > 0);
        assert.ok(
            files.every((path) => path.startsWith(`${root}/`)),
            JSON.stringify(files),
        );
        const after = counts();
        assert.deepEqual(after, { ...before, schema: 95 });
        const result = {
            phase,
            piVersion: version,
            node: nodeVersion,
            readinessMs: performance.now() - started,
            mainThreadMigrationBodies: 0,
            counts: after,
            files,
            migrationLogs: logs.split("\n").filter((line) => line.includes("[migrations]")),
        };
        results.push(result);
        console.log(JSON.stringify(result));
    } finally {
        const ended = new Promise((done) => child.once("close", done));
        try {
            process.kill(-child.pid, "SIGTERM");
        } catch {}
        await ended;
    }
}
writeFileSync(join(root, "pi-boot.json"), JSON.stringify(results, null, 2));
console.log(
    `PASS: Pi ${version} real RPC migration and no-op restart; no inference or /health claim`,
);
