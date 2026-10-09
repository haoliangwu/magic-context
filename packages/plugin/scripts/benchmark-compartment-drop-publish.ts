import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../src/features/magic-context/compartment-lease";
import {
    getCompartments,
    getLastCompartmentEndMessage,
} from "../src/features/magic-context/compartment-storage";
import { queuePendingOp } from "../src/features/magic-context/storage-ops";
import {
    getActiveTagsBySession,
    TAG_SELECT_COLUMNS,
} from "../src/features/magic-context/storage-tags";
import {
    prepareCompartmentDrops,
    queuePreparedCompartmentDrops,
} from "../src/hooks/magic-context/compartment-runner-drop-queue";
import { runCompartmentAgent } from "../src/hooks/magic-context/compartment-runner-incremental";
import type { HiddenCompartmentRunnerDeps } from "../src/hooks/magic-context/compartment-runner-types";
import { prepareProducerFixture } from "../src/hooks/magic-context/producer-window-test-support";
import { resolveWrapupProtectedTailBoundary } from "../src/hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../src/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../src/hooks/magic-context/read-session-raw";
import { Database } from "../src/shared/sqlite";

// Require a cloned backup under the same throwaway root as every host/config
// path. The queue microbenchmark rolls back; the synthetic publication commits
// only to this copy. No OpenCode process or remote provider is launched.
const root = realpathSync(process.env.MAGIC_CONTEXT_STORAGE_DIR ?? "");
for (const name of [
    "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB",
]) {
    const path = resolve(process.env[name] ?? "");
    if (!path.startsWith(`${root}/`)) throw new Error(`${name} must be below ${root}`);
}
const dbPath = realpathSync(process.argv[2] ?? "");
if (dbPath !== `${root}/context.db`) throw new Error("Pass the throwaway root's context.db copy");
const sessionId = "ses_114f158ccffet7znXAgI7lc3Kp";
let db = new Database(dbPath);
db.prepare("PRAGMA journal_mode=WAL").all();
db.exec("PRAGMA busy_timeout=250");
console.log(`Bun ${Bun.version}; SQLite`, db.prepare("SELECT sqlite_version() AS version").get());
function assertDatabaseIsolation(): void {
    const openFiles = execFileSync("lsof", ["-p", String(process.pid)], { encoding: "utf8" });
    const dbLines = openFiles.split("\n").filter((line) => /\.db(?:-wal|-shm)?\s*$/.test(line));
    if (dbLines.length === 0 || dbLines.some((line) => !line.includes(`${root}/`))) {
        throw new Error(`Database isolation failed:\n${dbLines.join("\n")}`);
    }
    console.log("lsof database paths:\n" + dbLines.join("\n"));
}
assertDatabaseIsolation();
const activeSql = `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number ASC, id ASC`;
console.log("active tag plan", db.prepare(`EXPLAIN QUERY PLAN ${activeSql}`).all(sessionId));
// The supplied backup predates the reported publish and includes no OpenCode
// raw-message database. Freeze five real active tag identities to isolate the
// queue's transaction cost; this is not a replay of the original provider run.
const first = db.prepare(`SELECT message_id FROM tags
    WHERE session_id = ? AND status = 'active' AND type = 'message'
    ORDER BY tag_number LIMIT 5`).all(sessionId) as Array<{ message_id: string }>;
const keys = {
    messageFileKeys: new Set(first.map((row) => row.message_id)),
    toolObservations: new Map<string, Set<string>>(),
};
for (let iteration = 0; iteration < 5; iteration++) {
    const selectionStart = performance.now();
    const prepared = prepareCompartmentDrops(db, sessionId, 54524, keys, 54427);
    const selectionMs = performance.now() - selectionStart;
    db.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    queuePreparedCompartmentDrops(db, prepared);
    db.exec("ROLLBACK");
    const preparedHoldMs = performance.now() - start;
    db.exec("BEGIN IMMEDIATE");
    const legacyStart = performance.now();
    const active = getActiveTagsBySession(db, sessionId);
    for (const tag of active) {
        if (keys.messageFileKeys.has(tag.messageId)) {
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
        }
    }
    db.exec("ROLLBACK");
    console.log(JSON.stringify({
        iteration, activeCount: active.length, candidates: prepared.candidates.length,
        selectionMs, preparedHoldMs, legacyHoldMs: performance.now() - legacyStart,
    }));
}
console.log("candidate revalidation plan", db.prepare(`EXPLAIN QUERY PLAN INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness)
    SELECT session_id, tag_number, 'drop', ?, ? FROM tags
    WHERE id = ? AND session_id = ? AND tag_number = ? AND message_id = ?
        AND type = ? AND tool_owner_message_id IS ? AND status = 'active'`).all(
    1234, "opencode", 1, sessionId, 1, "fixture", "message", null,
));

// Exercise the complete publisher on the copy with a deterministic 918-message
// provider and no network calls. The backup's last compartment fixes the next
// range; five existing source identities are represented in the synthetic chunk.
// Use a fresh handle so diagnostic statements cannot affect publication timing.
db.close();
db = new Database(dbPath);
const offset = getLastCompartmentEndMessage(db, sessionId) + 1;
const messages: RawMessage[] = Array.from({ length: 918 }, (_, index) => ({
    id: index < first.length ? first[index]!.message_id.replace(/:p0$/, "") : `perf-${index}`,
    ordinal: offset + index, role: "user", parts: [{ type: "text", text: `Fixture message ${index}` }],
}));
const unregister = setRawMessageProvider(sessionId, {
    readMessages: () => messages,
    getMessageCount: () => messages.at(-1)!.ordinal,
});
const holder = `perf-${process.pid}`;
if (!acquireCompartmentLease(db, sessionId, holder)) {
    throw new Error("Copy has an unexpired historian lease");
}
const snapshot = resolveWrapupProtectedTailBoundary({
    db, sessionId, mode: "manual-wrapup", contextLimit: 200_000,
    executeThresholdPercentage: 50, usage: { percentage: 0, inputTokens: 0 },
    usageSource: "provisional-zero", providerShapeVersion: "opencode-v1", cacheNamespace: "perf-fixture",
    messagesToKeep: 722,
}).snapshot;
const end = offset + 97;
// The second compartment supplies lookahead and is discarded. Anchoring the
// event to the first prevents the weak-final-compartment event filter skipping it.
const output = `<output>
<compartments>
<compartment start="${offset}" end="${end}" title="Fixture publish" episode_type="debug" importance="50">
<p1>Fixture history.</p1><p2>Fixture.</p2><p3>Fixture.</p3><p4>fixture</p4>
</compartment>
<compartment start="${end + 1}" end="${end + 98}" title="Fixture lookahead" episode_type="debug" importance="50">
<p1>Provisional history.</p1><p2>Provisional.</p2><p3>Provisional.</p3><p4>lookahead</p4>
</compartment>
</compartments>
<events><causal_incident at_compartment="1">
<summary>Fixture event</summary><disposition>fixed</disposition>
</causal_incident></events>
<meta><messages_processed>${offset}-${end + 98}</messages_processed><unprocessed_from>${end + 99}</unprocessed_from></meta>
</output>`;
const holds: Array<{ site: string; holdMs: number }> = [];
const exec = db.exec.bind(db);
const prepare = db.prepare.bind(db);
let started: number | undefined;
let publication = false;
db.prepare = (sql: string) => {
    if (sql.startsWith("INSERT") && sql.includes("INTO compartments")) publication = true;
    return prepare(sql);
};
db.exec = (sql: string) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") started = performance.now();
    if ((sql === "COMMIT" || sql === "ROLLBACK") && started !== undefined) {
        holds.push({ site: publication ? "publish" : "other", holdMs: performance.now() - started });
        started = undefined;
        publication = false;
    }
    return result;
};
const beforeCount = getCompartments(db, sessionId).length;
const pendingCount = () => (db.prepare(
    "SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?",
).get(sessionId) as { count: number }).count;
const pendingBefore = pendingCount();
const eventCount = () => (db.prepare(
    "SELECT COUNT(*) AS count FROM compartment_events WHERE session_id = ?",
).get(sessionId) as { count: number }).count;
const eventsBefore = eventCount();
try {
    await runCompartmentAgent(await prepareProducerFixture({
        client: undefined, model: "test/perf", db, sessionId, directory: root, boundarySnapshot: snapshot,
        currentContextLimit: 200_000, historianChunkTokens: 20_000,
        compartmentLeaseHolderId: holder, forceDrainQuota: true,
        memoryEnabled: false, preserveInjectionCacheUntilConsumed: true,
        compactionMarkerStrategy: { publish: () => true },
        hiddenCompletionExecutor: {
            capabilities: { tools: false, harness: "opencode" },
            open: async () => ({ id: "perf-fixture" }), attempt: async () => {},
            collect: async () => ({ text: output, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lengthCapped: false }),
            close: async () => {},
        },
    } satisfies HiddenCompartmentRunnerDeps));
    const afterCount = getCompartments(db, sessionId).length;
    const publishHolds = holds.filter((hold) => hold.site === "publish");
    if (afterCount !== beforeCount + 1 || publishHolds.length !== 1) throw new Error(`Publish did not execute: ${beforeCount} -> ${afterCount}, holds=${JSON.stringify(holds)}`);
    const dropsAdded = pendingCount() - pendingBefore;
    if (dropsAdded !== 5) throw new Error(`Publish queued ${dropsAdded} drops instead of five`);
    const eventsAdded = eventCount() - eventsBefore;
    if (eventsAdded !== 1) throw new Error(`Publish stored ${eventsAdded} events instead of one`);
    console.log(JSON.stringify({ fullPublish: { range: [offset, end], providerMessages: messages.length, beforeCount, afterCount, dropsAdded, eventsAdded, holds } }));
    assertDatabaseIsolation();
    if (publishHolds[0]!.holdMs >= 100) throw new Error(`Publish held writer for ${publishHolds[0]!.holdMs}ms (target <100ms)`);
} finally {
    db.exec = exec;
    db.prepare = prepare;
    unregister();
    releaseCompartmentLease(db, sessionId, holder);
}
db.close();
