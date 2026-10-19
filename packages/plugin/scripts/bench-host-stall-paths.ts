import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Set isolation before importing any plugin module, including lazy store readers.
const requestedRoot = join(tmpdir(), "magic-context", "bg_7204a03b349b5f25");
mkdirSync(requestedRoot, { recursive: true });
const root = realpathSync(requestedRoot);
for (const name of ["home", "data/opencode", "config", "cache"]) mkdirSync(join(root, name), { recursive: true });
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
delete process.env.OPENCODE_DB;
const label = process.argv[2];
if (label !== "master" && label !== "fixed") throw new Error("usage: bun scripts/bench-host-stall-paths.ts master|fixed [source package root]");
const packageRoot = resolve(process.argv[3] ?? join(import.meta.dir, ".."));
const source = (path: string) => import(pathToFileURL(join(packageRoot, "src", path)).href);
const { Database, withSqliteTransformPass } = await source("shared/sqlite.ts") as typeof import("../src/shared/sqlite");
const raw = await source("hooks/magic-context/read-session-raw.ts") as typeof import("../src/hooks/magic-context/read-session-raw");
const { prewarmRawSessionOrdinalsForDb } = await source("hooks/magic-context/raw-ordinal-warmup.ts") as typeof import("../src/hooks/magic-context/raw-ordinal-warmup");
const { initializeDatabase } = await source("features/magic-context/storage-db.ts") as typeof import("../src/features/magic-context/storage-db");
const { getOrCreateSessionMeta } = await source("features/magic-context/storage.ts") as typeof import("../src/features/magic-context/storage");
const { replaceAllCompartmentState } = await source("features/magic-context/compartment-storage.ts") as typeof import("../src/features/magic-context/compartment-storage");
const { markTagsCompactedByMessageIds } = await source("features/magic-context/storage-tags.ts") as typeof import("../src/features/magic-context/storage-tags");
const { materializeM0, renderM1 } = await source("hooks/magic-context/inject-compartments.ts") as typeof import("../src/hooks/magic-context/inject-compartments");
const { startSqliteWriteLocker } = await source("shared/sqlite-write-locker-test-support.ts") as typeof import("../src/shared/sqlite-write-locker-test-support");
const dbPath = join(root, "data/opencode/opencode.db");
const session = "stall-fixture";
const count = 150_000;
const frozenUnits = 70_000;
const id = (i: number) => `m${String(i).padStart(6, "0")}`;
const seed = !existsSync(dbPath);
const oc = new Database(dbPath);
if (seed) {
    oc.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE INDEX part_message_id_idx ON part(message_id);
        CREATE INDEX part_session_idx ON part(session_id);`);
    const message = oc.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const part = oc.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    const text = "synthetic tool output ".repeat(800);
    const pad = "metadata ".repeat(900);
    oc.transaction(() => {
        for (let i = 0; i < count; i++) {
            message.run(id(i), session, 1_767_355_200_000 + Math.floor(i / 25), i, JSON.stringify({ role: "user", pad, summary: i % 400 === 399, finish: "stop" }));
            part.run(`p${i}`, id(i), session, i, i, JSON.stringify({ type: "text", text: `${id(i)} ${text}` }));
        }
    })();
}
const contextPath = join(root, `context-${label}.db`);
if (existsSync(contextPath)) throw new Error(`Remove only the synthetic ${contextPath} before repeating a measurement`);
const db = new Database(contextPath);
initializeDatabase(db);
getOrCreateSessionMeta(db, session);
replaceAllCompartmentState(db, session, [{ sequence: 1, startMessage: 149_001, endMessage: 149_002, startMessageId: id(149_373), endMessageId: id(149_374), title: "fixture", content: "identical history", p1: "identical history", p2: "history", p3: "history", p4: "history", importance: 80 }], []);
const map = db.prepare("INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES (?,?,?,?)");
const tag = db.prepare("INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES (?,?,?,'text','dropped',?)");
db.transaction(() => {
    for (let i = 1; i <= count; i++) {
        map.run(session, i, i, 1_767_355_200_000 + i);
    }
    for (let i = 1; i <= frozenUnits; i++) {
        const sourceId = i > frozenUnits - 2 ? id(149_373 + i - (frozenUnits - 1)) : id(i - 1);
        tag.run(session, i, `${sourceId}:p0`, 1700);
    }
})();
const isolation = Bun.spawnSync(["lsof", "-p", String(process.pid), "-Fn"], { stdout: "pipe", stderr: "pipe" });
const opened = isolation.stdout.toString().split("\n").filter((line) => line.startsWith("n") && /\.db(?:-|$)/.test(line));
if (isolation.exitCode !== 0 || opened.length < 2 || opened.some((line) => !line.slice(1).startsWith(root))) throw new Error(`Database isolation failed: ${opened.join("\n")}`);
writeFileSync(join(root, `lsof-${label}.txt`), isolation.stdout);
const measurements: Record<string, number> = {};
function measure<T>(name: string, operation: () => T): T {
    const start = performance.now();
    try { return operation(); } finally { measurements[name] = performance.now() - start; }
}
const warmupStart = performance.now();
if (!await prewarmRawSessionOrdinalsForDb(oc, session)) throw new Error("Fixture ranks failed to warm");
measurements.workerWarmupElapsedMs = performance.now() - warmupStart;
const page = measure("restartedRawPageBlockedMs", () => raw.readRawSessionMessagePageFromDb(oc, session, 149_000, 100, 149_625));
const last = page.at(-1)!;
const next = measure("anchoredRawPageBlockedMs", () => raw.readRawSessionMessagePageFromDb(oc, session, last.ordinal, 100, 149_625, { id: last.id, timeCreated: last.createdAt! }));
const options = { db, sessionId: session, state: getOrCreateSessionMeta(db, session), temporalAwareness: true, injectDocs: false };
const m0 = measure("materializeDateBlockedMs", () => materializeM0(options));
// maxCompartmentSeq is the last compartment already included in the baseline.
// Setting it to zero makes renderM1 resolve dates for the fixture's new compartment.
const m1 = measure("softRefreshDateBlockedMs", () => renderM1(options, { ...m0.snapshotMarkers, maxCompartmentSeq: 0 }));
const eligible = new Set([69_999, 70_000]);
const retired = measure("protectedRetirementBlockedMs", () => markTagsCompactedByMessageIds(db, session, [id(149_373), id(149_374)], eligible));
const retiredRows = db.prepare("SELECT tag_number FROM tags WHERE session_id=? AND status='compacted' ORDER BY tag_number").all(session);
db.prepare("UPDATE message_fts_rowid_map SET message_time_ms=NULL WHERE session_id=? AND message_ordinal IN (149001,149002)").run(session);
const fallback = measure("fallbackDateBlockedMs", () => renderM1(options, { ...m0.snapshotMarkers, maxCompartmentSeq: 0 }));
db.exec("CREATE TABLE fixture_lock(value TEXT); PRAGMA busy_timeout=5000");
const locker = await startSqliteWriteLocker(contextPath, 1200);
let lockOutcome = "success";
measure("unscopedBusyWriteBlockedMs", () => {
    try { db.prepare("INSERT INTO fixture_lock VALUES ('probe') RETURNING value").all(); }
    catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        lockOutcome = "busy";
    }
});
if (await locker.exited !== 0) throw new Error("Concurrent writer failed");
db.exec("DELETE FROM fixture_lock");
const locker2 = await startSqliteWriteLocker(contextPath, 1200);
measure("foregroundBusyWriteBlockedMs", () => {
    try { withSqliteTransformPass(() => db.prepare("INSERT INTO fixture_lock VALUES ('probe') RETURNING value").all()); }
    catch (error) { if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error; }
});
if (await locker2.exited !== 0) throw new Error("Foreground concurrent writer failed");
const wire = JSON.stringify({ page, next, m0: m0.m0Text, m1, fallback, retired, retiredRows });
const wirePath = join(root, `wire-${label}.json`);
writeFileSync(wirePath, wire);
if (label === "fixed" && readFileSync(join(root, "wire-master.json"), "utf8") !== wire) throw new Error("Master/fixed served surfaces or retired state differ");
console.log(JSON.stringify({ label, bun: Bun.version, sqlite: oc.prepare("SELECT sqlite_version() AS v").get(), root, fixtureMessages: count,
        frozenUnits, openCodeBytes: statSync(dbPath).size, contextBytes: statSync(contextPath).size, measurements, lockOutcome, wireSha256: createHash("sha256").update(wire).digest("hex"), differential: label === "fixed" ? "master bytes identical" : "master captured", isolation: `lsof-${label}.txt` }, null, 2));
oc.close();
db.close();
