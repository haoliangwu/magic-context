/**
 * Run with: timeout 600 bun packages/plugin/scripts/perf-audit/sqlite-storage.ts
 * All stores are synthetic, under a throwaway root, and removed on exit.
 * Autocommit hold is an upper bound (statement execution includes admission);
 * explicit transaction hold starts after BEGIN returns and includes COMMIT.
 * Commit scopes include no-op writes; WAL bytes distinguish dirty commits.
 */
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Database,
    getSqliteMemoryStats,
    withAsyncPrivilegedWriter,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "../../src/shared/sqlite";
import { closeQuietly } from "../../src/shared/sqlite-helpers";
import { getCompartments } from "../../src/features/magic-context/compartment-storage";
import { withMessageFtsSessionFilter } from "../../src/features/magic-context/message-fts-session-filter";
import { closeDatabase, openDatabase } from "../../src/features/magic-context/storage-db";
import {
    getHiddenSeamPlaceholderIds,
    getStrippedPlaceholderIds,
    setLastNudgeUndropped,
} from "../../src/features/magic-context/storage-meta-persisted";
import { getOrCreateSessionMeta } from "../../src/features/magic-context/storage-meta-session";
import { ensureColumn } from "../../src/features/magic-context/storage-schema-helpers";
import { getSourceContents } from "../../src/features/magic-context/storage-source";
import {
    getActiveTagTokenTotalsByMessage,
    getAllStatusTagTokenTotalsFlat,
    getOldestActiveUnprotectedToolTags,
    getTagsByNumbers,
    getTriggerTagTokenUpperBound,
    updateTagStatus,
} from "../../src/features/magic-context/storage-tags";
import { createTagger } from "../../src/features/magic-context/tagger";

const root = mkdtempSync(join(tmpdir(), "magic-context-perf-db-"));
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.OPENCODE_DB = join(root, "absent-opencode.db");
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "perf.log");
process.env.NODE_ENV = "test";
const sizes = [1_000, 10_000, 60_000];
const records: Record<string, unknown>[] = [];
const session = "target";

function walBytes(path: string): number {
    try {
        return statSync(`${path}-wal`).size;
    } catch {
        return 0;
    }
}

const redundantIndexes = ['idx_tags_session_tag_number', 'idx_compartments_session', 'idx_pending_ops_session', 'idx_source_contents_session', 'idx_compression_depth_session', 'idx_transform_decisions_session_harness', 'idx_project_key_files_project'];
function redundantIndexFrames(db: Database, path: string, start: number, end: number): number {
    const pages = db.prepare(`SELECT pageno FROM dbstat WHERE name IN (${redundantIndexes.map(() => '?').join(',')})`).all(...redundantIndexes) as { pageno: number }[];
    const pageIds = new Set(pages.map(row => row.pageno));
    const [{ page_size: pageSize }] = db.prepare('PRAGMA page_size').all() as { page_size: number }[];
    const fd = openSync(`${path}-wal`, 'r');
    let count = 0;
    try {
        const header = Buffer.alloc(24);
        for (let pos = Math.max(start, 32); pos < end; pos += pageSize + 24) {
            readSync(fd, header, 0, 24, pos);
            if (pageIds.has(header.readUInt32BE(0))) count++;
        }
    } finally { closeSync(fd); }
    return count;
}

function instrumentation(db: Database) {
    const counters = { prepares: 0, commits: 0, rollbacks: 0, writes: 0, holdMs: 0 };
    const nativeExec = db.exec.bind(db);
    const nativePrepare = db.prepare.bind(db);
    let heldAt: number | undefined;
    db.exec = (sql: string) => {
        const begin = /^BEGIN (IMMEDIATE|EXCLUSIVE)$/i.test(sql);
        const end = /^(COMMIT|ROLLBACK)$/i.test(sql);
        const result = nativeExec(sql);
        if (begin) heldAt = performance.now();
        if (end && heldAt !== undefined) {
            counters.holdMs += performance.now() - heldAt;
            if (sql === "COMMIT") counters.commits++;
            else counters.rollbacks++;
            heldAt = undefined;
        }
        return result;
    };
    db.prepare = ((sql: string) => {
        counters.prepares++;
        const statement = nativePrepare(sql);
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
            for (const method of ["run", "get", "all"] as const) {
                const execute = statement[method].bind(statement);
                Object.defineProperty(statement, method, {
                    value: (...args: unknown[]) => {
                        const autocommit = heldAt === undefined;
                        const start = performance.now();
                        const result = execute(...args);
                        counters.writes++;
                        if (autocommit) {
                            counters.commits++;
                            counters.holdMs += performance.now() - start;
                        }
                        return result;
                    },
                });
            }
        }
        return statement;
    }) as Database["prepare"];
    return counters;
}

async function measure(
    db: Database,
    path: string,
    n: number,
    finding: string,
    operation: string,
    run: () => unknown | Promise<unknown>,
    repeats = 5,
) {
    const counters = metrics.get(db);
    if (!counters) throw new Error("untracked fixture");
    const samples = [];
    for (let i = 0; i < repeats; i++) {
        const startMetrics = { ...counters };
        const bytes = walBytes(path);
        const start = performance.now();
        await run();
        const elapsed = performance.now() - start;
        const afterBytes = walBytes(path);
        const indexFrames = finding === 'DB-1/DB-4' ? redundantIndexFrames(db, path, bytes, afterBytes) : undefined;
        samples.push({
            ms: elapsed,
            holdMs: counters.holdMs - startMetrics.holdMs,
            commits: counters.commits - startMetrics.commits,
            rollbacks: counters.rollbacks - startMetrics.rollbacks,
            writes: counters.writes - startMetrics.writes,
            prepares: counters.prepares - startMetrics.prepares,
            walBytes: afterBytes - bytes,
            redundantIndexFrames: indexFrames,
        });
    }
    samples.sort((a, b) => a.ms - b.ms);
    const result = { finding, n, operation, ...samples[Math.floor(samples.length / 2)] };
    records.push(result);
    console.log(JSON.stringify(result));
}

const metrics = new WeakMap<Database, ReturnType<typeof instrumentation>>();
function plan(db: Database, n: number, finding: string, sql: string, ...args: unknown[]) {
    const result = { finding, n, operation: sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) };
    records.push(result);
    console.log(JSON.stringify(result));
}

function seed(db: Database, n: number) {
    withPrivilegedWriter(db, () => {
        const meta = db.prepare("INSERT INTO session_meta(session_id, harness) VALUES (?, 'opencode')");
        meta.run(session);
        for (let i = 0; i < Math.ceil(n / 100); i++) meta.run(`other-${i}`);
        const tag = db.prepare(`INSERT INTO tags(session_id, message_id, type, byte_size, tag_number,
            tool_owner_message_id, tool_name, token_count, input_token_count, reasoning_token_count)
            VALUES (?, ?, ?, 256, ?, ?, ?, 2000, 100, 0)`);
        const source = db.prepare("INSERT INTO source_contents(session_id, tag_id, content, created_at) VALUES (?, ?, ?, 0)");
        const fts = db.prepare("INSERT INTO message_history_fts(session_id, message_id, role, content, message_ordinal) VALUES (?, ?, 'assistant', ?, ?)");
        const map = db.prepare("INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid) VALUES (?, ?, ?)");
        for (let i = 1; i <= n; i++) {
            tag.run(session, `msg-${i}`, i % 2 ? "message" : "tool", i, i % 2 ? null : `owner-${i}`, i % 2 ? null : "read");
            source.run(session, i, "x".repeat(256));
            const inserted = fts.run(session, `msg-${i}`, "fixture message ".repeat(16), i);
            map.run(session, i, inserted.lastInsertRowid);
        }
        const compartment = db.prepare(`INSERT INTO compartments(session_id, sequence, start_message, end_message,
            start_message_id, end_message_id, title, content, created_at, p1_embedding)
            VALUES (?, ?, 0, 1, 'a', 'b', 'fixture', 'summary', 0, ?)`);
        for (let i = 0; i < Math.ceil(n / 100); i++) compartment.run(session, i, Buffer.alloc(6144));
        const decision = db.prepare(`INSERT INTO transform_decisions(session_id, harness, message_id, ts_ms, decision)
            VALUES (?, 'opencode', ?, ?, 'defer')`);
        for (let i = 0; i < Math.min(n, 2000); i++) decision.run(session, `decision-${i}`, i);
        const pluginMessage = db.prepare("INSERT INTO plugin_messages(direction, type, session_id, created_at) VALUES ('server', 'fixture', ?, 0)");
        for (let i = 0; i < n; i++) pluginMessage.run(`other-${i % Math.ceil(n / 100)}`);
        const candidate = db.prepare("INSERT INTO user_memory_candidates(session_id, content, created_at) VALUES (?, 'fixture memory', 0)");
        for (let i = 0; i < n / 10; i++) candidate.run(`other-${i % Math.ceil(n / 100)}`);
        db.prepare(`UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ?, stripped_placeholder_ids = ? WHERE session_id = ?`)
            .run(Buffer.alloc(262144, "m"), Buffer.alloc(65536, "d"), JSON.stringify(Array.from({ length: 4096 }, (_, i) => `placeholder-${i}`)), session);
    });
}

try {
    console.log(JSON.stringify({ runtime: Bun.version, sqlite: new Database(":memory:").prepare("SELECT sqlite_version() AS version").get(), fixture: "one long session; 256-byte messages, 2k-token tags; one other session and 6KiB retired embedding per 100 messages; m0=256KiB/m1=64KiB; 4096 placeholders", repeats: 5 }));
    for (const n of sizes) {
        const path = join(root, `${n}.db`);
        const db = openDatabase(path);
        if (!db) throw new Error("fixture failed to open");
        db.exec("PRAGMA wal_autocheckpoint=0");
        seed(db, n);
        if (getOrCreateSessionMeta(db, session).cachedM0Bytes?.length !== 262144) throw new Error('fixture m0 did not survive metadata validation');
        metrics.set(db, instrumentation(db));

        // 32 new tags approximates a tool-heavy turn; FULL/NORMAL is diagnostic only.
        for (const sync of ["FULL", "NORMAL"]) {
            db.exec(`PRAGMA synchronous=${sync}`);
            let pass = 0;
            await measure(db, path, n, "DB-1/DB-4", `mint 32 tags synchronous=${sync}`, () => {
                const tagger = createTagger();
                tagger.initFromDb(session, db, n - 100);
                const prefix = `${sync}-${pass++}`;
                return withSqliteTransformPass(() => {
                    for (let i = 0; i < 32; i++) tagger.assignTag(session, `${prefix}-${i}`, "message", 256, db);
                });
            });
        }
        db.exec("PRAGMA synchronous=FULL");

        await measure(db, path, n, "DB-2", "getOrCreateSessionMeta x20 (large row)", () => {
            for (let i = 0; i < 20; i++) getOrCreateSessionMeta(db, session);
        });
        await measure(db, path, n, "DB-2", "scalar late-column reads x20", () => {
            for (let i = 0; i < 20; i++) db.prepare("SELECT is_subagent, channel2_nudge_state FROM session_meta WHERE session_id = ?").get(session);
        });
        let scalar = 0;
        await measure(db, path, n, "DB-2", "vary-sized early scalar writes x20 (large row)", () => {
            const stmt = db.prepare("UPDATE session_meta SET last_transform_error = ? WHERE session_id = ?");
            for (let i = 0; i < 20; i++) stmt.run(`error-${scalar++}`, session);
        });
        await measure(db, path, n, "DB-3", "cached open x3, no stale claims", () => withSqliteTransformPass(() => {
            for (let i = 0; i < 3; i++) openDatabase(path);
        }));
        const sibling = new Database(path);
        sibling.exec("BEGIN IMMEDIATE");
        const start = performance.now();
        withSqliteTransformPass(() => openDatabase(path));
        console.log(JSON.stringify({ finding: "DB-3", n, operation: "cached open with sibling writer held", ms: performance.now() - start }));
        sibling.exec("ROLLBACK");
        closeQuietly(sibling);

        const tagger = createTagger();
        tagger.initFromDb(session, db);
        await measure(db, path, n, "DB-5", "initFromDb hot floor=0", () => tagger.initFromDb(session, db));
        await measure(db, path, n, "DB-5", "status update + initFromDb floor=0", () => {
            updateTagStatus(db, session, 1, "dropped");
            tagger.initFromDb(session, db);
        });
        await measure(db, path, n, "DB-6", "async privileged admission (no callback work)", () => withAsyncPrivilegedWriter(db, () => undefined));
        await measure(db, path, n, "DB-6/DB-7", "20 persisted setters in transform scope", () => withSqliteTransformPass(() => {
            for (let i = 0; i < 20; i++) setLastNudgeUndropped(db, session, i);
        }));
        await measure(db, path, n, "DB-6", "20 busy_timeout read/set/restore cycles only", () => {
            for (let i = 0; i < 20; i++) {
                const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
                db.exec("PRAGMA busy_timeout=25");
                db.exec(`PRAGMA busy_timeout=${row.timeout}`);
            }
        });
        await measure(db, path, n, "DB-8", "both placeholder getters (4096 ids)", () => {
            getStrippedPlaceholderIds(db, session);
            getHiddenSeamPlaceholderIds(db, session);
        });
        await measure(db, path, n, "DB-9", "FTS coverage proof after local write", () => {
            db.prepare("UPDATE session_meta SET last_nudge_tokens = last_nudge_tokens + 1 WHERE session_id = ?").run(session);
            withMessageFtsSessionFilter(db, session, (covered) => { if (!covered) throw new Error("unexpected missing coverage"); });
        });
        await measure(db, path, n, "DB-9", "FTS coverage hot read", () => withMessageFtsSessionFilter(db, session, () => undefined));
        plan(db, n, "DB-10", "SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ?", session);
        await measure(db, path, n, "DB-11", "trigger bound floor=0 + active totals + all-status totals + oldest4", () => {
            getTriggerTagTokenUpperBound(db, session);
            getActiveTagTokenTotalsByMessage(db, session);
            getAllStatusTagTokenTotalsFlat(db, session);
            getOldestActiveUnprotectedToolTags(db, session);
        });
        await measure(db, path, n, "DB-11", "trigger bound floor=0 alone", () => getTriggerTagTokenUpperBound(db, session));
        const ids = Array.from({ length: 900 }, (_, i) => i + 1);
        await measure(db, path, n, "DB-12", "prepare two 900-parameter IN reads only", () => {
            const placeholders = ids.map(() => '?').join(',');
            db.prepare(`SELECT tag_id, content FROM source_contents WHERE session_id = ? AND tag_id IN (${placeholders})`);
            db.prepare(`SELECT tag_number FROM tags WHERE session_id = ? AND tag_number IN (${placeholders})`);
        });
        await measure(db, path, n, "DB-12", "900 tag and source IN reads", () => { getTagsByNumbers(db, session, ids); getSourceContents(db, session, ids); });
        await measure(db, path, n, "DB-13", "decision open + write + prune + close (2000 retained)", () => {
            const handle = new Database(path);
            try {
                handle.exec("PRAGMA busy_timeout=0");
                handle.prepare("INSERT OR REPLACE INTO transform_decisions(session_id, harness, message_id, ts_ms, decision) VALUES (?, 'opencode', 'next', 99999, 'defer')").run(session);
                handle.prepare(`DELETE FROM transform_decisions WHERE session_id = ? AND harness = 'opencode' AND rowid NOT IN (SELECT rowid FROM transform_decisions WHERE session_id = ? AND harness = 'opencode' ORDER BY ts_ms DESC, rowid DESC LIMIT 2000)`).run(session, session);
            } finally { closeQuietly(handle); }
        });
        plan(db, n, "DB-13", "SELECT rowid FROM transform_decisions WHERE session_id = ? AND harness = 'opencode' ORDER BY ts_ms DESC, rowid DESC LIMIT 2000", session);
        console.log(JSON.stringify({ finding: "DB-14", n, operation: "redundant index pages (no schema mutation)", pages: db.prepare("SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('idx_tags_session_tag_number', 'idx_compartments_session', 'idx_pending_ops_session', 'idx_source_contents_session', 'idx_compression_depth_session', 'idx_transform_decisions_session_harness', 'idx_project_key_files_project') GROUP BY name").all() }));
        await measure(db, path, n, "DB-15", "getCompartments with retired embeddings", () => getCompartments(db, session));
        await measure(db, path, n, "DB-16", "171 ensureColumn calls on existing columns (boot only)", () => {
            for (let i = 0; i < 171; i++) ensureColumn(db, "session_meta", "counter", "INTEGER DEFAULT 0");
        });
        const heap = createTagger();
        for (let i = 0; i < Math.ceil(n / 100); i++) for (let j = 0; j < 100; j++) heap.bindTag(`heap-${i}`, `msg-${j}`, j);
        console.log(JSON.stringify({ finding: "DB-17", n, beforeCleanup: heap.getHeapStats?.() }));
        for (let i = 0; i < Math.ceil(n / 100); i++) heap.cleanup(`heap-${i}`);
        console.log(JSON.stringify({ finding: "DB-17", n, afterCleanup: heap.getHeapStats?.() }));
        // A separate cleanup host avoids reusing the search reader's snapshot
        // after the decision-log writer has committed on another connection.
        const cleanup = new Database(path);
        metrics.set(cleanup, instrumentation(cleanup));
        try {
            for (const table of ["plugin_messages", "user_memory_candidates"]) {
                plan(cleanup, n, "DB-18", `DELETE FROM ${table} WHERE session_id = ?`, "absent");
                await measure(cleanup, path, n, "DB-18", `no-match cleanup scan of ${table} (${table === 'plugin_messages' ? n : n / 10} rows)`, () => {
                    cleanup.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run('absent');
                });
            }
        } finally { cleanup.close(); }
        for (const connection of getSqliteMemoryStats().connections) {
            if (connection.filename !== ":memory:" && !connection.filename.startsWith(`${root}/`)) {
                throw new Error(`non-fixture SQLite connection: ${connection.filename}`);
            }
        }
        closeDatabase();
    }
    console.log(JSON.stringify({ completed: sizes.length, records: records.length, root, removed: true }));
} finally {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
}
