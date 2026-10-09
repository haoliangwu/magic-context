/**
 * Marker writer probe. Run with all storage/config roots under a throwaway
 * $TMPDIR/magic-context/<run>/ directory and OPENCODE_DB pointing to a database
 * initialized by OpenCode 1.18.30. Never accepts a live-store path or copies one.
 *
 * timeout 180s bun packages/plugin/scripts/bench-compaction-marker.ts
 * Results, query plans and lsof evidence are written beside the throwaway DB.
 */
import { Database as NativeDatabase } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const path = process.env.OPENCODE_DB;
if (!path || !existsSync(path)) throw new Error("Initialize a throwaway OpenCode 1.18.30 DB first");
const canonicalPath = realpathSync(path);
const root = process.env.MARKER_PROBE_ROOT;
if (!root || !realpathSync(root).includes("/magic-context/")) throw new Error("Missing throwaway MARKER_PROBE_ROOT");
const canonicalRoot = realpathSync(root);
for (const name of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR", "MAGIC_CONTEXT_LOG_PATH", "OPENCODE_CONFIG_DIR"] as const) {
    const value = resolve(process.env[name] ?? "");
    const canonical = existsSync(value) ? realpathSync(value) : `${realpathSync(dirname(value))}/${value.split("/").at(-1)}`;
    if (!canonical.startsWith(`${canonicalRoot}/`)) throw new Error(`${name} is not isolated: ${canonical}`);
}
if (!canonicalPath.startsWith(`${canonicalRoot}/`)) throw new Error("DB is outside throwaway root");

const db = new NativeDatabase(path);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
const schema = db.query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
writeFileSync(join(root, "schema.json"), JSON.stringify(schema, null, 2));
const session = db.query("SELECT id FROM session LIMIT 1").get() as { id: string } | null;
if (!session) throw new Error("Create one session through the isolated host's HTTP API first");
const sessionId = session.id;
const messageId = (n: number) => `msg_probe_${String(n).padStart(6, "0")}`;
const messageCount = 150_000;
const partCount = 1_000_000;
const counts = db.query("SELECT (SELECT count(*) FROM message) AS messages, (SELECT count(*) FROM part) AS parts").get() as { messages: number; parts: number };
if (!counts.messages) {
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    for (let start = 0; start < messageCount; start += 10_000) {
        db.transaction(() => {
            for (let n = start; n < Math.min(start + 10_000, messageCount); n++) {
                const data = JSON.stringify({ role: n % 10 === 0 ? "user" : "assistant", agent: "build", modelID: "probe", providerID: "probe", padding: "m".repeat(512) });
                insertMessage.run(messageId(n), sessionId, n * 10, n * 10, data);
            }
        })();
    }
    const data = JSON.stringify({ type: "text", text: "p".repeat(1024) });
    for (let start = 0; start < partCount; start += 10_000) {
        db.transaction(() => {
            for (let n = start; n < Math.min(start + 10_000, partCount); n++) {
                const m = Math.floor(n * messageCount / partCount);
                insertPart.run(`prt_probe_${String(n).padStart(7, "0")}`, messageId(m), sessionId, m * 10, m * 10, data);
            }
        })();
        if (statSync(path).size > 4_500_000_000) throw new Error("Synthetic DB exceeded size budget");
    }
}
// The checkpoint exercise below temporarily changes these fixture-owned rows.
// Heal an interrupted prior probe before comparing the independent baseline.
db.prepare("UPDATE part SET time_updated=time_created WHERE id >= 'prt_probe_0000000' AND id < 'prt_probe_0005000'").run();
const lsof = spawnSync("timeout", ["10s", "lsof", "-p", String(process.pid), "-Fn"], { encoding: "utf8" });
if (lsof.status !== 0) throw new Error("lsof failed");
const stores = lsof.stdout.split("\n").filter(line => /^n.*\.db(?:$|-)/.test(line));
if (!stores.length || stores.some(line => !line.slice(1).startsWith(`${canonicalRoot}/`))) throw new Error("lsof isolation failed");
writeFileSync(join(root, "probe-lsof.txt"), lsof.stdout);

interface Sample { phase: string; sql: string; method: string; ms: number; plan?: unknown[] }
const samples: Sample[] = [];
let phase = "idle";
const nativePrepare = NativeDatabase.prototype.prepare;
const nativeExec = NativeDatabase.prototype.exec;
NativeDatabase.prototype.prepare = function (this: NativeDatabase, ...args: Parameters<typeof nativePrepare>) {
    const sql = args[0];
    const statement = Reflect.apply(nativePrepare, this, args);
    for (const method of ["run", "get", "all"] as const) {
        const execute = statement[method];
        Object.defineProperty(statement, method, { value: (...params: unknown[]) => {
            if (phase === "idle") return Reflect.apply(execute, statement, params);
            // EXPLAIN uses the independent probe handle; never runs the statement.
            const planStatement = Reflect.apply(nativePrepare, db, [`EXPLAIN QUERY PLAN ${sql}`]);
            let plan: unknown[];
            try { plan = Reflect.apply(planStatement.all, planStatement, params); }
            finally { planStatement.finalize(); }
            const started = performance.now();
            try { return Reflect.apply(execute, statement, params); }
            finally { samples.push({ phase, sql, method, ms: performance.now() - started, plan }); }
        }, configurable: true });
    }
    return statement;
} as typeof nativePrepare;
NativeDatabase.prototype.exec = function (this: NativeDatabase, sql: string) {
    const started = performance.now();
    try { return Reflect.apply(nativeExec, this, [sql]); }
    catch (error) { throw new Error(`Probe exec failed: ${sql}`, { cause: error }); }
    finally { if (phase !== "idle") samples.push({ phase, sql, method: "exec", ms: performance.now() - started }); }
};
// Import after installing native instrumentation so it observes the real plugin,
// including the shared wrapper's BEGIN, nested savepoint, COMMIT and rollback.
const marker = await import("../src/features/magic-context/compaction-marker");
const summaryText = "[Compacted by magic-context — session history is managed by the plugin]";
const oldArgs = { sessionId, endOrdinal: 140_000, endMessageId: messageId(139_999), summaryText, directory: root };
const args = { ...oldArgs, endOrdinal: messageCount, endMessageId: messageId(messageCount - 1) };
const oldBoundary = { id: messageId(139_990), timeCreated: 1_399_900 };
const boundary = { id: messageId(149_990), timeCreated: 1_499_900 };
// Reset only rows owned by this probe, permitting before/after runs on one store.
for (const target of [oldArgs, args]) {
    const identity = `${sessionId}\0${target.endMessageId}`;
    const b = target === args ? boundary : oldBoundary;
    const summary = marker.generateMessageId(b.timeCreated + 1, 1n, `${identity}\0summary-message`);
    db.query("DELETE FROM part WHERE message_id=?").run(summary);
    db.query("DELETE FROM message WHERE id=?").run(summary);
    db.query("DELETE FROM part WHERE id=?").run(marker.generatePartId(b.timeCreated, 1n, `${identity}\0compaction-part`));
}
db.query("DELETE FROM part WHERE id LIKE 'probe_legacy_%'").run();
db.query("DELETE FROM message WHERE id LIKE 'probe_legacy_%'").run();
db.query("INSERT INTO message VALUES ('probe_legacy_summary',?,?,?,?)")
    .run(sessionId, boundary.timeCreated + 1, boundary.timeCreated + 1, JSON.stringify({ role: "assistant", summary: true, finish: "stop", parentID: boundary.id }));
db.query("INSERT INTO part VALUES ('probe_legacy_text',?,?,?,?,?)").run("probe_legacy_summary", sessionId, 0, 0, JSON.stringify({ type: "text", text: summaryText }));
db.query("INSERT INTO part VALUES ('probe_legacy_compaction',?,?,?,?,?)").run(boundary.id, sessionId, 0, 0, '{"type":"compaction","auto":true}');

const initial = marker.injectCompactionMarker({ ...oldArgs, resolvedBoundary: oldBoundary });
if (!initial) throw new Error("Initial marker failed");
const totals: Record<string, number> = {};
function timed<T>(name: string, operation: () => T): T {
    phase = name;
    const started = performance.now();
    try { return operation(); }
    finally { totals[name] = performance.now() - started; phase = "idle"; }
}
const found = timed("boundary-preflight", () => marker.findBoundaryUserMessage(sessionId, args.endMessageId));
if (JSON.stringify(found) !== JSON.stringify(boundary)) throw new Error("Incorrect boundary");
const replacement = timed("replacement", () => marker.replaceCompactionMarker(initial, { ...args, resolvedBoundary: boundary }));
if (replacement.kind !== "committed") throw new Error(replacement.error.message);
const hash = createHash("sha256");
for (const table of ["message", "part"]) {
    for (const row of db.query(`SELECT * FROM ${table} ORDER BY id`).iterate()) hash.update(JSON.stringify(row));
}

// Independent process writes real part rows, signals after BEGIN and holds that
// lock for 1200ms. No sleep/polling in the parent, and every child is bounded.
const writerCode = `import {Database} from 'bun:sqlite'; const db=new Database(process.env.OPENCODE_DB);
db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
db.query('UPDATE part SET time_updated=time_updated+1 WHERE id=?').run('prt_probe_0999999');
console.log('locked'); await Bun.sleep(1200); db.exec('ROLLBACK'); db.close();`;
const writer = Bun.spawn(["timeout", "10s", process.execPath, "-e", writerCode], { stdout: "pipe", stderr: "pipe" });
const reader = writer.stdout.getReader();
const signal = await reader.read();
if (signal.done || !new TextDecoder().decode(signal.value).includes("locked")) throw new Error("Writer did not acquire lock");
const contended = timed("concurrent-writer", () => marker.replaceCompactionMarker(replacement.marker, { ...oldArgs, resolvedBoundary: oldBoundary }));
await reader.cancel();
if (await writer.exited !== 0) throw new Error("Concurrent writer failed");
function checkpointProbe(mode: "PASSIVE" | "TRUNCATE"): unknown {
    const connection = new NativeDatabase(path);
    const statement = Reflect.apply(nativePrepare, connection, [`PRAGMA wal_checkpoint(${mode})`]);
    try { return statement.all()[0]; }
    finally { statement.finalize(); connection.close(); }
}
const checkpoint = timed("explicit-passive-checkpoint", () => checkpointProbe("PASSIVE"));
// Prime a WAL beyond SQLite's default 1000-page auto-checkpoint threshold on
// this connection (which has auto-checkpoint disabled), then let the plugin's
// next COMMIT encounter it. Restore the synthetic host rows afterwards.
checkpointProbe("TRUNCATE");
db.exec("PRAGMA wal_autocheckpoint=0");
db.query("UPDATE part SET time_updated=time_updated+1 WHERE id >= 'prt_probe_0000000' AND id < 'prt_probe_0005000'").run();
const primedWalBytes = statSync(`${path}-wal`).size;
const checkpointMarker = timed("checkpoint-triggering-retry", () => marker.replaceCompactionMarker(
    contended.kind === "committed" ? contended.marker : replacement.marker,
    { ...(contended.kind === "committed" ? oldArgs : args), resolvedBoundary: contended.kind === "committed" ? oldBoundary : boundary },
));
if (checkpointMarker.kind !== "committed") throw new Error("Checkpoint probe did not commit");
const checkpointAfter = timed("post-commit-passive-checkpoint", () => checkpointProbe("PASSIVE"));
const restore = Reflect.apply(nativePrepare, db, ["UPDATE part SET time_updated=time_created WHERE id >= 'prt_probe_0000000' AND id < 'prt_probe_0005000'"]);
restore.run();
restore.finalize();
checkpointProbe("TRUNCATE");
marker.closeCompactionMarkerDb();
NativeDatabase.prototype.prepare = nativePrepare;
NativeDatabase.prototype.exec = nativeExec;
const result = { bun: Bun.version, sqlite: db.query("SELECT sqlite_version() AS version").get(), schemaSource: "fresh OpenCode 1.18.30", messageCount, partCount, dbBytes: statSync(path).size, totals, paritySha256: hash.digest("hex"), contendedOutcome: contended.kind, checkpoint, primedWalBytes, checkpointAfter, samples };
const label = process.env.MARKER_PROBE_LABEL ?? "run";
if (label !== "baseline") {
    const baseline = JSON.parse(readFileSync(join(dirname(path), "marker-probe-baseline.json"), "utf8")) as { paritySha256: string };
    if (result.paritySha256 !== baseline.paritySha256) throw new Error("Host-row byte parity differs from baseline");
    console.log("Host-row byte parity matches the separately captured baseline");
}
const output = join(dirname(path), `marker-probe-${label}.json`);
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, samples: samples.length, output }, null, 2));
db.close();
