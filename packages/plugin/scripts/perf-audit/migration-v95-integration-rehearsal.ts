/** Rehearse the emitted worker on a disposable VACUUM copy, never a live store. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Database } from "bun:sqlite";

const [rootArg, seedArg, oldTreeArg] = process.argv.slice(2);
assert.ok(rootArg && seedArg && oldTreeArg, "usage: bun migration-v95-integration-rehearsal.ts <task-root> <read-only-backup> <master-archive>");
const root = realpathSync(rootArg);
const seed = realpathSync(seedArg);
const oldTree = realpathSync(oldTreeArg);
const scratch = realpathSync(join(process.env.TMPDIR!, "magic-context"));
for (const path of [root, seed, oldTree])
    assert.ok(path.startsWith(`${scratch}${sep}`), `path outside throwaway storage: ${path}`);

const storage = join(root, "rehearsal");
mkdirSync(storage, { recursive: true, mode: 0o700 });
for (const [key, name] of Object.entries({
    HOME: "home", XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config",
    XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime", XDG_CACHE_HOME: "cache",
})) {
    process.env[key] = join(root, name);
    mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
}
process.env.MAGIC_CONTEXT_STORAGE_DIR = storage;
process.env.OPENCODE_DB = join(storage, "synthetic-opencode.db");
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "logs/rehearsal-host.log");

const { openDatabaseAsync, closeDatabase, LATEST_SUPPORTED_VERSION } = await import("../../src/features/magic-context/storage-db");
const { __setMigrationWorkerEntryForTests } = await import("../../src/features/magic-context/migration-worker-client");
const { getMainThreadMigrationBodyCount } = await import("../../src/features/magic-context/migrations");
__setMigrationWorkerEntryForTests(new URL("../../dist/migration-worker.js", import.meta.url));
const copy = join(storage, "context.db");
const tables = ["session_meta", "tags", "git_commits_fts", "message_fts_rowid_map", "transform_decisions", "plugin_messages", "user_memory_candidates"];
function digest(db: Database) {
    return Object.fromEntries(tables.map((table) => {
        const hash = createHash("sha256");
        let rows = 0;
        for (const row of db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).iterate()) {
            hash.update(JSON.stringify(row));
            hash.update("\n");
            rows++;
        }
        return [table, { rows, sha256: hash.digest("hex") }];
    }));
}
function inventory() {
    const text = execFileSync("lsof", ["-nP", "-p", String(process.pid), "-Fn"], { encoding: "utf8", timeout: 30_000 });
    const paths = text.split("\n").filter((line) => /^n.*\.db(?:-wal|-shm|-journal)?$/.test(line)).map((line) => line.slice(1));
    assert.ok(paths.length > 0, "rehearsal host must hold its migrated database");
    for (const path of paths) assert.ok(path.startsWith(`${realpathSync(root)}${sep}`), path);
    writeFileSync(join(root, "logs/rehearsal-lsof.txt"), text);
    return { pid: process.pid, paths };
}

try {
    const reader = new Database(seed, { readonly: true });
    try {
        assert.equal((reader.query("SELECT MAX(version) AS v FROM schema_migrations WHERE version<10000").get() as { v: number }).v, 94);
        reader.query("VACUUM INTO ?").run(copy);
    } finally {
        reader.close();
    }
    const beforeDb = new Database(copy, { readonly: true });
    const before = digest(beforeDb);
    assert.ok(before.tags!.rows >= 2_000_000, "large-store corpus floor");
    beforeDb.close();
    const bodiesBefore = getMainThreadMigrationBodyCount();
    const timings: unknown[] = [];
    const coldStart = performance.now();
    const cold = await openDatabaseAsync({ dbPath: copy, onBootTimings: (timing) => timings.push(timing) });
    const coldMs = performance.now() - coldStart;
    assert.ok(cold, "real async boot must accept the migrated store");
    const hostFiles = inventory();
    closeDatabase();
    const warmStart = performance.now();
    const warm = await openDatabaseAsync({ dbPath: copy, onBootTimings: (timing) => timings.push(timing) });
    const warmMs = performance.now() - warmStart;
    assert.ok(warm, "warm boot must reopen the same v95 store");
    assert.equal(getMainThreadMigrationBodyCount(), bodiesBefore, "no migration body on the host thread");
    closeDatabase();

    const afterDb = new Database(copy, { readonly: true });
    const after = digest(afterDb);
    assert.deepEqual(after, before, "all indexed base-table row bytes and rowids must survive");
    assert.equal(LATEST_SUPPORTED_VERSION, 95);
    assert.deepEqual(afterDb.query("SELECT MAX(version) AS v FROM schema_migrations WHERE version<10000").get(), { v: 95 });
    assert.deepEqual(afterDb.query("PRAGMA quick_check").all(), [{ quick_check: "ok" }]);
    assert.deepEqual(afterDb.query("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(afterDb.query("SELECT COUNT(*) AS n FROM git_commit_fts_rowid_map").get(), { n: before.git_commits_fts!.rows });
    assert.ok(afterDb.query("SELECT 1 FROM sqlite_master WHERE name='temporal_decisions'").get());
    const schemaBeforeFence = afterDb.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    afterDb.close();

    // Compile the actual master's opener, rather than overriding the candidate's fence.
    const entry = join(root, "fence94-entry.ts");
    writeFileSync(entry, `import {strict as assert} from 'node:assert';\nimport {openDatabase,LATEST_SUPPORTED_VERSION,getSchemaFenceRejection} from ${JSON.stringify(join(oldTree, "packages/plugin/src/features/magic-context/storage-db.ts"))};\nassert.equal(LATEST_SUPPORTED_VERSION,94);\nassert.equal(openDatabase(${JSON.stringify(copy)}),null);\nassert.deepEqual(getSchemaFenceRejection(),{persistedVersion:95,supportedVersion:94});\nconsole.log('FENCE94_REFUSED: persisted=95 supported=94; 3 assertions passed');\n`);
    const bundle = join(root, "fence94-build");
    const built = await Bun.build({ entrypoints: [entry], outdir: bundle, target: "bun", external: ["bun:sqlite", "node:sqlite"] });
    assert.ok(built.success, String(built.logs));
    const fenceOutput = execFileSync(process.execPath, [join(bundle, "fence94-entry.js")], { encoding: "utf8", env: process.env, timeout: 30_000 });
    assert.ok(fenceOutput.includes("FENCE94_REFUSED"));
    const finalDb = new Database(copy, { readonly: true });
    assert.deepEqual(digest(finalDb), before, "older build must not rewrite any data");
    assert.deepEqual(finalDb.query("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schemaBeforeFence, "older build must not rewrite schema");
    finalDb.close();
    const report = { bun: Bun.version, source: "pre-existing read-only ckmc-perf backup (not a live store)", copyMethod: "read-only VACUUM INTO", coldMs, warmMs, timings, before, after, mainThreadMigrationBodies: getMainThreadMigrationBodyCount() - bodiesBefore, hostFiles, fenceOutput: fenceOutput.trim(), assertions: "seven durable table hashes, corpus floor, v95 ledger, both new tables, quick/fk checks, fence94 refusal and unchanged data/schema" };
    writeFileSync(join(root, "logs/rehearsal.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
} finally {
    closeDatabase();
    __setMigrationWorkerEntryForTests(null);
    rmSync(storage, { recursive: true, force: true });
    console.log("Disposable rehearsal databases deleted");
}
