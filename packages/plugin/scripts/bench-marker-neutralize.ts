import { Database as NativeDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// An optional checkout root runs the same generated input against different
// versions of the plugin source. Every database is created here; source-root
// selection never opens a database supplied by the caller.
const sourceRoot = resolve(process.argv[2] ?? join(import.meta.dir, "../../.."));
const output = process.argv[3];
if (!output) throw new Error("usage: bun scripts/bench-marker-neutralize.ts <source root> <output.json>");
const root = mkdtempSync(join(tmpdir(), "marker-neutralize-"));
for (const name of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR"])
    process.env[name] = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "plugin.log");
mkdirSync(join(root, "opencode"));
const path = join(root, "opencode/opencode.db");
process.env.OPENCODE_DB = path;
const source = (file: string) => import(pathToFileURL(join(sourceRoot, "packages/plugin/src", file)).href);
const { hostStore, messageId, SESSION } = await source("features/magic-context/__tests__/host-stalls.fixture.ts") as typeof import("../src/features/magic-context/__tests__/host-stalls.fixture");
const host = hostStore(path, 160_000);
const samples: { sql: string; ms: number }[] = [];
let active = false;
const prepare = NativeDatabase.prototype.prepare;
const exec = NativeDatabase.prototype.exec;
NativeDatabase.prototype.prepare = function (this: NativeDatabase, ...args: Parameters<typeof prepare>) {
    const stmt = Reflect.apply(prepare, this, args);
    for (const method of ["get", "run", "all"] as const) {
        const run = stmt[method];
        Object.defineProperty(stmt, method, { configurable: true, value: (...params: unknown[]) => {
            const start = performance.now();
            try { return Reflect.apply(run, stmt, params); }
            finally { if (active) samples.push({ sql: args[0], ms: performance.now() - start }); }
        } });
    }
    return stmt;
} as typeof prepare;
NativeDatabase.prototype.exec = function (sql: string) {
    const start = performance.now();
    try { return Reflect.apply(exec, this, [sql]); }
    finally { if (active) samples.push({ sql, ms: performance.now() - start }); }
};
const marker = await source("features/magic-context/compaction-marker.ts") as typeof import("../src/features/magic-context/compaction-marker");
const args = { sessionId: SESSION, endOrdinal: 150_000, endMessageId: messageId(149_999), summaryText: "summary", directory: "/synthetic/project", resolvedBoundary: { id: messageId(149_999), timeCreated: 49_999 } };
if (!await marker.prepareCompactionMarkerCandidates(SESSION)) throw new Error("candidate preparation failed");
const initial = marker.injectCompactionMarker(args);
if (!initial) throw new Error("initial marker failed");
if (!await marker.prepareCompactionMarkerCandidates(SESSION)) throw new Error("candidate preparation failed");
host.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0");
const insert = host.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");
const partCount = 80_000;
const partData = JSON.stringify({ type: "text", text: "p".repeat(4096) });
host.transaction(() => {
    for (let i = 0; i < partCount; i++) insert.run(`part-${i}`, messageId(i), SESSION, i, i, partData);
})();
const walState = () => {
    const shm = readFileSync(`${path}-shm`);
    return { frames: shm.readUInt32LE(16), backfilled: shm.readUInt32LE(96) };
};
const before = walState();
active = true;
const start = performance.now();
const result = marker.replaceCompactionMarker(initial, { ...args, endOrdinal: 160_000, endMessageId: messageId(159_999), resolvedBoundary: { id: messageId(159_999), timeCreated: 53_333 } });
const replaceMs = performance.now() - start;
active = false;
if (result.kind !== "committed") throw new Error(`replacement failed: ${result.kind}`);
const after = walState();
const hash = createHash("sha256");
for (const table of ["message", "part"])
    for (const row of host.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) hash.update(JSON.stringify(row));
marker.closeCompactionMarkerDb();
host.close();
NativeDatabase.prototype.prepare = prepare;
NativeDatabase.prototype.exec = exec;
const { Database } = await source("shared/sqlite.ts") as typeof import("../src/shared/sqlite");
const { initializeDatabase } = await source("features/magic-context/storage-db.ts") as typeof import("../src/features/magic-context/storage-db");
const { runMigrations } = await source("features/magic-context/migrations.ts") as typeof import("../src/features/magic-context/migrations");
const { applyStrippedPlaceholderDelta } = await source("features/magic-context/storage-meta-persisted.ts") as typeof import("../src/features/magic-context/storage-meta-persisted");
const { markTagsCompactedByMessageIds } = await source("features/magic-context/storage-tags.ts") as typeof import("../src/features/magic-context/storage-tags");
const context = new Database(join(root, "context.db"));
initializeDatabase(context);
runMigrations(context);
const insertTag = context.prepare("INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES (?,?,?,'text','dropped',1)");
context.transaction(() => {
    for (let i = 1; i <= 160_000; i++) insertTag.run(SESSION, i, `old-${i}:p0`);
    insertTag.run(SESSION, 160_001, "new:p0");
})();
applyStrippedPlaceholderDelta(context, SESSION, { add: Array.from({ length: 4096 }, (_, i) => `persisted-${i}`) });
const deltaStart = performance.now();
if (!applyStrippedPlaceholderDelta(context, SESSION, { add: ["new"] })) throw new Error("delta failed");
const deltaMs = performance.now() - deltaStart;
const retireStart = performance.now();
const retired = markTagsCompactedByMessageIds(context, SESSION, ["new"]);
const retireMs = performance.now() - retireStart;
if (retired !== 1) throw new Error("incorrect retirement");
const tagHash = createHash("sha256");
for (const row of context.prepare("SELECT tag_number,status FROM tags ORDER BY tag_number").iterate()) tagHash.update(JSON.stringify(row));
context.close();
const report = { bun: Bun.version, messageCount: 160_000, partCount, before, after, replaceMs, deltaMs, retireMs, hostSha256: hash.digest("hex"), tagSha256: tagHash.digest("hex"), samples, root };
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
