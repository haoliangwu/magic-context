/**
 * Re-run with: timeout 900 bun packages/plugin/scripts/perf-audit/hr.ts fixture
 * or: timeout 1800 bun packages/plugin/scripts/perf-audit/hr.ts live <scrubbed-copy>
 * Live mode refuses paths outside the throwaway audit root and opens them read-only.
 * Only timings, sizes, query plans and content hashes are printed, never message text.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCompartments } from "../../src/features/magic-context/compartment-storage";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { getActiveTagsBySession, getTagsBySession } from "../../src/features/magic-context/storage-tags";
import { captureSlot, lkgContentDigest, noteEntry, resetLkgSlotsForTest } from "../../src/hooks/magic-context/lkg-slot";
import { getRawSessionTagKeysThrough, hasRawSessionMessageById, readRawSessionMessageIdOrdinalsForRange, readRawSessionMessages, readSessionChunk, withRawMessageProvider } from "../../src/hooks/magic-context/read-session-chunk";
import { __openCodeTurnStateTest, closeReadOnlySessionDb, findLastAssistantModelFromOpenCodeDb, observeOpenCodeTurnEvent, shouldHoldIgnoredNotification, shouldHoldIgnoredNotificationFromOpenCodeDb } from "../../src/hooks/magic-context/read-session-db";
import { estimateTokens } from "../../src/hooks/magic-context/read-session-formatting";
import { countRawSessionMessageOrdinalsFromDb, type RawMessage, type RawMessageOrdinalAnchor, readRawSeedTailFromDb, readRawSessionMessageByIdFromDb, readRawSessionMessagePageFromDb, readRawSessionMessagesFromDb } from "../../src/hooks/magic-context/read-session-raw";
import { buildTrueRawTokenIndex, invalidateTrueRawTokenCache } from "../../src/hooks/magic-context/read-session-true-raw-tokens";
import { Database } from "../../src/shared/sqlite";
import { ensureCortexKitArtifactGitignore } from "../../src/shared/data-path";

const root = join(tmpdir(), "magic-context", "perf-hr");
mkdirSync(root, { recursive: true });
console.log(JSON.stringify({ bun: Bun.version, mode: process.argv[2] }));
function hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}
function measure<T>(id: string, fixture: string, fn: () => T): T {
    const start = performance.now();
    const value = fn();
    console.log(JSON.stringify({ id, fixture, ms: performance.now() - start, hash: hash(value) }));
    return value;
}
function fixtureDb(path: string, n: number): Database {
    const db = new Database(path);
    db.exec(`CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE INDEX part_message_id_idx ON part(message_id);
        CREATE INDEX part_session_idx ON part(session_id);`);
    const m = db.prepare("INSERT INTO message VALUES (?, 's', ?, ?, ?)");
    const p = db.prepare("INSERT INTO part VALUES (?, ?, 's', ?, ?, ?)");
    db.transaction(() => {
        for (let i = 1; i <= n; i++) {
            const id = `m-${String(i).padStart(8, "0")}`;
            m.run(id, Math.floor(i / 5), i, JSON.stringify({ role: i % 2 ? "user" : "assistant", finish: "stop", pad: "x".repeat(300) }));
            p.run(`p-${i}`, id, i, i, JSON.stringify(i % 10 === 0
                ? { type: "tool", callID: `c-${i}`, state: { input: { command: "echo done" }, output: "result ".repeat(2048), status: "completed" } }
                : { type: "text", text: "A representative message with useful narrative and punctuation. ".repeat(8) }));
        }
    })();
    return db;
}
async function pagePass(session: string, count: number, size: number): Promise<string> {
    const digest = createHash("sha256");
    let after: RawMessageOrdinalAnchor | undefined;
    for (let cursor = 0; cursor < count;) {
        const page = readRawSessionMessages.readPage(session, cursor, size, count, after);
        if (!page.length) break;
        digest.update(JSON.stringify(page));
        const last = page.at(-1)!;
        cursor = last.ordinal;
        after = { timeCreated: last.createdAt ?? 0, id: last.id };
    }
    return digest.digest("hex");
}
async function readers(db: Database, session: string, count: number, label: string): Promise<void> {
    const cursor = Math.max(0, count - 101);
    const page = measure("HR-1 late page OFFSET", label, () => readRawSessionMessages.readPage(session, cursor, 100, count));
    const prior = readRawSessionMessagePageFromDb(db, session, cursor - 1, 1, count).at(-1)!;
    const anchor = { timeCreated: prior.createdAt ?? 0, id: prior.id };
    measure("HR-1 late page cursor", label, () => readRawSessionMessages.readPage(session, cursor, 100, count, anchor));
    measure("HR-4 range id", label, () => [...readRawSessionMessageIdOrdinalsForRange(session, count - 1, count)]);
    const target = page.at(-1)!.id;
    measure("HR-5 point lookup", label, () => readRawSessionMessageByIdFromDb(db, session, target));
    measure("HR-5 existence", label, () => hasRawSessionMessageById(session, target));
    measure("HR-12 seed last 100", label, () => [...readRawSeedTailFromDb(db, session, page[0].id)]);
    measure("HR-14 notice hold", label, () => shouldHoldIgnoredNotificationFromOpenCodeDb(db, session));
    measure("HR-3 count", label, () => countRawSessionMessageOrdinalsFromDb(db, session));
}
if (process.argv[2] === "live") {
    const path = resolve(process.argv[3] ?? "");
    if (!path.startsWith(`${resolve(root)}/`)) throw new Error("Use a scrubbed copy under the throwaway perf-hr root");
    process.env.OPENCODE_DB = path;
    const db = new Database(path, { readonly: true });
    try {
        const secrets = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('credential','account','account_state','control_account')").all();
        if (secrets.length) throw new Error("Copy still contains credential/account tables");
        console.log(JSON.stringify({ sqlite: db.prepare("SELECT sqlite_version() AS version").get() }));
        const sessions = db.prepare("SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id ORDER BY n DESC LIMIT 3").all() as { session_id: string; n: number }[];
        for (const { session_id: session, n } of sessions.filter((_, i) => i !== 1)) {
            const count = countRawSessionMessageOrdinalsFromDb(db, session);
            const label = `live ${n} stored / ${count} canonical`;
            await readers(db, session, count, label);
            // Bounded hydration measures the cost of the full eligible read without
            // retaining several GB of tool outputs in the benchmark process.
            let cursor = 0;
            let after: RawMessageOrdinalAnchor | undefined;
            let bytes = 0;
            let hydrationMs = 0;
            let pages = 0;
            const digest = createHash("sha256");
            while (cursor < count) {
                const start = performance.now();
                const page = readRawSessionMessagePageFromDb(db, session, cursor, 100, count, after);
                hydrationMs += performance.now() - start;
                if (!page.length) break;
                const wire = JSON.stringify(page);
                bytes += Buffer.byteLength(wire);
                digest.update(wire);
                const last = page.at(-1)!;
                cursor = last.ordinal;
                after = { timeCreated: last.createdAt ?? 0, id: last.id };
                pages++;
            }
            console.log(JSON.stringify({ id: "HR-3 full-range hydration lower bound", fixture: label, hydrationMs, bytes, pages, hash: digest.digest("hex") }));
        }
        const files = execFileSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8", timeout: 30_000 }).split("\n").filter((line) => /\.db(?:-wal|-shm)?$/.test(line));
        if (files.some((line) => !line.startsWith(`n${realpathSync(root)}/`))) throw new Error("Database handle escaped the throwaway root");
        console.log(JSON.stringify({ isolation: "lsof", pid: process.pid, databaseHandles: files }));
    } finally { closeReadOnlySessionDb(); db.close(); }
} else if (process.argv[2] === "fixture") {
    for (const n of [1000, 10_000, 60_000]) {
        const dir = mkdtempSync(join(root, "fixture-"));
        const path = join(dir, "opencode.db");
        process.env.OPENCODE_DB = path;
        const db = fixtureDb(path, n);
        try {
            const label = `${n} messages`;
            await readers(db, "s", n, label);
            for (const size of [100, 32]) {
                const start = performance.now();
                const digest = await pagePass("s", n, size);
                console.log(JSON.stringify({ id: `HR-1 full pages ${size}`, fixture: label, ms: performance.now() - start, hash: digest }));
            }
            const start = performance.now();
            const keys = await getRawSessionTagKeysThrough("s", n, { yieldToEventLoop: async () => {} });
            console.log(JSON.stringify({ id: "HR-1 tag keys", fixture: label, ms: performance.now() - start, hash: hash([[...keys.messageFileKeys], [...keys.toolObservations].map(([k, v]) => [k, [...v]])]) }));
            const raw = measure("HR-15 full reader", label, () => readRawSessionMessagesFromDb(db, "s"));
            measure("HR-3 chunk", label, () => readSessionChunk("s", 4096, 1, n + 1));
            measure("HR-10 warm chunk", label, () => readSessionChunk("s", 4096, 1, n + 1));
            // Separate the tokenizer from the range hydration to expose the running
            // block sum on a provider whose history is already resident.
            withRawMessageProvider("memo", { readMessages: () => raw, getMessageCount: () => raw.length }, () => {
                measure("HR-10 resident warm", label, () => readSessionChunk("memo", 4096, 1, n + 1));
                measure("HR-10 resident warm", label, () => readSessionChunk("memo", 4096, 1, n + 1));
            });
            __openCodeTurnStateTest.reset();
            const eventsStarted = performance.now();
            for (const message of raw) {
                observeOpenCodeTurnEvent("message.updated", { info: { id: message.id, sessionID: "tracked", role: message.role, finish: "stop", time: { created: message.ordinal } } });
                for (const [i, part] of message.parts.entries()) observeOpenCodeTurnEvent("message.part.updated", { part: { ...(part as object), id: `p-${i}`, sessionID: "tracked", messageID: message.id } });
            }
            console.log(JSON.stringify({ id: "HR-6 event retention", fixture: label, ms: performance.now() - eventsStarted, rawPayloadBytes: Buffer.byteLength(JSON.stringify(raw)) }));
            console.log(JSON.stringify({ id: "HR-6 retained part representation", fixture: label, bytes: __openCodeTurnStateTest.retainedPartBytes() }));
            measure("HR-6 tracked probe", label, () => shouldHoldIgnoredNotification("tracked"));
            __openCodeTurnStateTest.reset();
            invalidateTrueRawTokenCache({ reason: "schema.migration" });
            buildTrueRawTokenIndex("s", raw.map((m) => ({ ...m, parts: [] })), { cacheNamespace: "s", providerShapeVersion: "opencode-v1" });
            measure("HR-8 message invalidation", label, () => invalidateTrueRawTokenCache({ sessionId: "s", messageId: raw.at(-1)!.id, reason: "message.updated" }));
            invalidateTrueRawTokenCache({ reason: "schema.migration" });
            const wire = raw.slice(0, Math.min(n, 10_000)).map((m) => ({ info: { id: m.id, role: m.role }, parts: [{ type: "text", text: "Pristine LKG content. ".repeat(8) }] }));
            resetLkgSlotsForTest();
            captureSlot("lkg", { jsonPrefix: JSON.stringify(wire), inputIdSeq: wire.map((m) => m.info.id), inputContentDigests: wire.map(lkgContentDigest) as string[], lastInputMessageId: wire.at(-1)!.info.id, modelKey: null, providerKey: null, capturedAt: 1 });
            measure("HR-7 note entry", `${wire.length} wire messages`, () => noteEntry("lkg", wire));
            measure("HR-7 warm note entry", `${wire.length} wire messages`, () => noteEntry("lkg", wire));
            resetLkgSlotsForTest();
            const text = "A detailed historian prompt with prose and tool examples. ".repeat(n);
            measure("HR-11 binary prefix fit", label, () => {
                const budget = 4096;
                const marker = "\n[… tokens truncated by Magic Context to fit the historian window …]";
                let lo = 0; let hi = text.length; let best = 0;
                while (lo <= hi) { const mid = (lo + hi) >> 1; if (estimateTokens(text.slice(0, mid) + marker) <= budget) { best = mid; lo = mid + 1; } else hi = mid - 1; }
                return best;
            });
            measure("HR-15 JSON twice", label, () => { for (let i = 0; i < n; i++) { JSON.parse('{"role":"user","finish":"stop"}'); JSON.parse('{"role":"user","finish":"stop"}'); } });
            const messageJson = db.prepare("SELECT data FROM message WHERE session_id = 's'").all() as { data: string }[];
            measure("HR-15 actual message JSON twice", label, () => { for (const row of messageJson) { JSON.parse(row.data); JSON.parse(row.data); } });
            measure("HR-15 actual message JSON once", label, () => { for (const row of messageJson) JSON.parse(row.data); });
            measure("HR-16 dump write", label, () => { const dump = join(dir, "dump"); mkdirSync(dump, { recursive: true }); writeFileSync(join(dump, "response.xml"), "response ".repeat(8192)); ensureCortexKitArtifactGitignore(dir); });
            const usage = new Map(Array.from({ length: 1000 }, (_, i) => [String(i), { updatedAt: Date.now() }]));
            measure("HR-17 TTL scan", "1000 session usage entries", () => { const now = Date.now(); for (const [id, entry] of usage) if (now - entry.updatedAt > 300_000) usage.delete(id); });
            measure("HR-18 connection and schema", label, () => { const probe = new Database(path, { readonly: true }); probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(); probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(); probe.close(); });
            measure("HR-18 model probe", label, () => findLastAssistantModelFromOpenCodeDb("s"));
            const store = new Database(":memory:");
            try {
                initializeDatabase(store);
                store.transaction(() => {
                    const insert = store.prepare("INSERT INTO tags(session_id, message_id, type, status, tag_number, byte_size) VALUES ('s', ?, 'message', ?, ?, 100)");
                    for (let i = 1; i <= n; i++) insert.run(`m-${i}`, i > n - 100 ? "active" : "dropped", i);
                })();
                measure("HR-9 all tags", label, () => getTagsBySession(store, "s").filter((t) => t.status === "active"));
                measure("HR-9/13 active tags", label, () => getActiveTagsBySession(store, "s"));
                measure("HR-9 compartments", label, () => getCompartments(store, "s").slice(-3).map((c) => c.id));
            } finally { store.close(); }
        } finally { closeReadOnlySessionDb(); db.close(); rmSync(dir, { recursive: true, force: true }); }
    }
} else throw new Error("Expected fixture or live <scrubbed-copy>");
