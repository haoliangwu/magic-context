/** Default-FTS hold/COMMIT distribution and the foreground wait on the same large index. */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(process.env.INDEX_HOLD_ROOT ?? "");
if (!process.env.INDEX_HOLD_ROOT || !root.startsWith(`${resolve(tmpdir(), "magic-context")}/`)) throw new Error("INDEX_HOLD_ROOT must be under TMPDIR/magic-context");
mkdirSync(root, { recursive: true });
for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "MAGIC_CONTEXT_STORAGE_DIR"]) {
    process.env[name] = join(root, name.toLowerCase()); mkdirSync(process.env[name], { recursive: true });
}
process.env.OPENCODE_DB = join(root, "absent-opencode.db");
process.env.SQLITE_TMPDIR = join(root, "sqlite-tmp"); mkdirSync(process.env.SQLITE_TMPDIR, { recursive: true });
const { Database, indexCoordinationInput, withSqliteTransformPass } = await import("../../src/shared/sqlite");
const { initializeDatabase } = await import("../../src/features/magic-context/storage-db");
const { configureContextDatabasePragmas } = await import("../../src/shared/sqlite-context-pragmas");
const { indexSingleMessageOffThread, getIndexWorkerMeasurements } = await import("../../src/features/magic-context/message-index-async");
const { messageIndexSkipKey } = await import("../../src/features/magic-context/message-index");
const db = new Database(join(root, "context.db"));
initializeDatabase(db); configureContextDatabasePragmas(db);
const session = "hold-benchmark";
const rows = Number(process.env.INDEX_HOLD_ROWS ?? 2_000_000);
const payload = "context worker index immutable source semaphore project history ".repeat(40);
const insert = db.prepare("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES (?,?,?,'user',?)");
const isolation = () => {
    const output = spawnSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8" });
    if (output.status !== 0) throw new Error(output.stderr);
    const paths = output.stdout.split("\n").filter(line => /^n.*\.db(?:-wal|-shm)?$/.test(line)).map(line => line.slice(1));
    if (!paths.length || paths.some(path => !path.startsWith(`${realpathSync(root)}/`))) throw new Error(`isolation failed ${JSON.stringify(paths)}`);
    console.log(JSON.stringify({ hostPid: process.pid, dbPaths: paths }));
};
isolation();
const setupHolds: number[] = [];
for (let start = 0; start < rows; start += 500) {
    const began = performance.now();
    db.transaction(() => {
        for (let i = start; i < Math.min(rows, start + 500); i++) insert.run(session, i + 1, `seed-${i}`, `${payload} unique${i}`);
    })();
    setupHolds.push(performance.now() - began);
    if (start % 250_000 === 0) console.log(JSON.stringify({ builtRows: start, payloadBytes: payload.length }));
}
db.prepare("INSERT INTO message_history_index(session_id,last_indexed_ordinal,updated_at) VALUES (?,?,0)").run(session, rows);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const config = () => db.prepare("SELECT * FROM message_history_fts_config ORDER BY k").all();
const initialConfig = JSON.stringify(config());
const holds: number[] = []; const commits: number[] = []; const foreground: number[] = [];
const shared = new Int32Array(indexCoordinationInput().indexCoordination);
for (let step = 1; step <= 512; step++) {
    let done = false;
    const pending = indexSingleMessageOffThread(db, session, { id: `new-${step}`, ordinal: rows + step, role: "user", parts: [{ type: "text", text: `${payload.repeat(2)} step${step}` }] });
    void pending.finally(() => { done = true; });
    while (!done && Atomics.load(shared, 1) === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const began = performance.now();
    await withSqliteTransformPass(async () => { db.prepare("INSERT INTO schema_migrations_meta(key,value) VALUES ('hold_probe','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(); });
    foreground.push(performance.now() - began);
    await pending;
    const measured = getIndexWorkerMeasurements(db, session);
    if (!measured) throw new Error("worker timing missing");
    holds.push(...measured.holdMs); commits.push(...measured.commitMs);
}
const largeSession = "large-message";
await indexSingleMessageOffThread(db, largeSession, { id: "60mb", ordinal: 1, role: "user", parts: [{ type: "text", text: "semaphore ".repeat(6_000_000) }] });
const large = getIndexWorkerMeasurements(db, largeSession);
const skip = db.prepare("SELECT value FROM schema_migrations_meta WHERE key=?").get(messageIndexSkipKey(largeSession, "60mb"));
const distribution = (values: number[]) => {
    const sorted = [...values].sort((a,b) => a-b);
    const at = (fraction: number) => sorted[Math.min(sorted.length-1, Math.floor(sorted.length * fraction))];
    return { count: values.length, min: sorted[0], p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
};
if (initialConfig !== JSON.stringify(config())) throw new Error("FTS settings changed");
isolation();
const results = { bun: Bun.version, rows, payloadBytes: payload.length, config: config(), setup: distribution(setupHolds), hold: distribution(holds), commit: distribution(commits), foreground: distribution(foreground), large: { bytes: large?.sourceBytes, skipped: large?.skipped, hold: distribution(large?.holdMs ?? []), commit: distribution(large?.commitMs ?? []), skip }, escalationRequired: Math.max(...commits) > 1000 };
console.log(JSON.stringify(results));
writeFileSync(join(root, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
db.close();
if (results.escalationRequired) process.exitCode = 2;
