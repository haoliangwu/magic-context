/**
 * Cold- and warm-cache cost of the canonical ordinal count and of the tag owner
 * summary on a realistic store: one OpenCode 1.18 session of about 150k
 * messages with multi-KB message JSON and part rows, interleaved with other
 * sessions, several GB on disk.
 *
 *   ORDINAL_ROOT=<throwaway dir> bun scripts/perf-audit/stall-ordinal-real.ts
 *
 * Linux only for the cold-cache numbers: the page cache of the fixture files is
 * dropped with posix_fadvise(POSIX_FADV_DONTNEED) before each cold run, which
 * needs no privileges. Every database is created under ORDINAL_ROOT; the
 * script refuses a root inside a live store directory and, at the end, lists
 * the database files the process has open.
 */
import { existsSync, mkdirSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database as RawDatabase } from "bun:sqlite";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../src/features/magic-context/__tests__/opencode1-query-fixture";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { installTagIdentityRevisionTrigger } from "../../src/features/magic-context/storage-tag-identity-revision";
import {
    getMaxTagNumberByOwnerMessage,
    getReasoningTokenEstimatesByMessage,
    getTagOwnerRowsReadForTest,
    insertTag,
    resetTagOwnerRowsReadForTest,
} from "../../src/features/magic-context/storage-tags";
import { prewarmRawSessionOrdinalsForDb } from "../../src/hooks/magic-context/raw-ordinal-warmup";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionOrdinalJsonRowsReadForTest,
    readRawSessionMessageByIdFromDb,
    resetRawSessionOrdinalJsonRowsReadForTest,
} from "../../src/hooks/magic-context/read-session-raw";
import { Database } from "../../src/shared/sqlite";

const rootValue = process.env.ORDINAL_ROOT;
if (!rootValue) throw new Error("ORDINAL_ROOT (a throwaway directory) is required");
const root = resolve(rootValue);
for (const forbidden of ["/.local/share/opencode", "/cortexkit/magic-context", "/.config/"]) {
    if (`${root}/`.includes(forbidden)) throw new Error(`refusing a root inside ${forbidden}`);
}
mkdirSync(root, { recursive: true });

const MESSAGES = Number(process.env.ORDINAL_MESSAGES ?? 150_000);
const OTHER_SESSIONS = 3;
const OTHER_MESSAGES = Number(process.env.ORDINAL_OTHER_MESSAGES ?? 20_000);
const TAGS = Number(process.env.ORDINAL_TAGS ?? 100_000);
const SESSION = "ses_real_ordinal";
const opencodePath = join(root, "opencode.db");
const contextPath = join(root, "context.db");

/** Text that does not compress or repeat, sized like OpenCode assistant metadata and parts. */
function filler(seed: number, bytes: number): string {
    let state = seed >>> 0 || 1;
    const chars: string[] = [];
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
    for (let index = 0; index < bytes; index += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        chars.push(alphabet[state % alphabet.length] as string);
    }
    return chars.join("");
}

const id = (session: string, index: number) => `msg_${session.slice(-6)}_${String(index).padStart(8, "0")}`;

function buildOpenCodeStore(): void {
    if (existsSync(opencodePath)) return;
    const db = new RawDatabase(opencodePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
    db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    const sessions = [SESSION, ...Array.from({ length: OTHER_SESSIONS }, (_, n) => `ses_other_${n}`)];
    const counts = new Map(sessions.map((session) => [session, 0]));
    const totals = new Map(sessions.map((session) => [session, session === SESSION ? MESSAGES : OTHER_MESSAGES]));
    const pool = Array.from({ length: 64 }, (_, n) => filler(n + 7, 9_000));
    let step = 0;
    let remaining = MESSAGES + OTHER_SESSIONS * OTHER_MESSAGES;
    while (remaining > 0) {
        db.transaction(() => {
            for (let batch = 0; batch < 5_000 && remaining > 0; batch += 1) {
                // Sessions interleave on disk, as concurrent sessions do in a real store.
                const session = sessions[step % sessions.length] as string;
                step += 1;
                const index = counts.get(session) ?? 0;
                if (index >= (totals.get(session) ?? 0)) continue;
                counts.set(session, index + 1);
                remaining -= 1;
                const created = 1_700_000_000_000 + index * 10;
                const assistant = index % 2 === 1;
                const summary = index % 1000 === 999;
                const info = {
                    role: assistant ? "assistant" : "user",
                    ...(summary ? { summary: true, mode: "compaction", agent: "compaction" } : {}),
                    finish: assistant || summary ? "stop" : undefined,
                    time: { created, completed: created + 5 },
                    path: { cwd: "/work/project", root: "/work/project" },
                    tokens: { input: 1234, output: 567, reasoning: 89, cache: { read: 10, write: 2 } },
                    modelID: "model",
                    providerID: "provider",
                    // OpenCode message JSON on a busy host carries several KB.
                    system: pool[index % pool.length]?.slice(0, 3_000 + (index % 7) * 300),
                };
                const messageId = id(session, index);
                insertMessage.run(messageId, session, created, created, JSON.stringify(info));
                for (let part = 0; part < 2; part += 1) {
                    insertPart.run(
                        `prt_${messageId}_${part}`,
                        messageId,
                        session,
                        created + part,
                        created + part,
                        JSON.stringify({ type: part ? "tool" : "text", text: pool[(index + part) % pool.length] }),
                    );
                }
            }
        })();
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
}

function buildContextStore(): void {
    if (existsSync(contextPath)) return;
    const db = new Database(contextPath);
    initializeDatabase(db);
    db.transaction(() => {
        for (let tag = 1; tag <= TAGS; tag += 1) {
            const owner = `msg_${Math.ceil(tag / 2)}`;
            if (tag % 2)
                insertTag(db, SESSION, owner, "message", 100, tag, 40, null, 0, null, null, {
                    tokenCount: 25,
                    inputTokenCount: 0,
                    reasoningTokenCount: 30 + (tag % 50),
                });
            else insertTag(db, SESSION, `call_${tag}`, "tool", 300, tag, 0, "read", 20, owner);
        }
    })();
    db.close();
}

function dropPageCache(): void {
    Bun.spawnSync(["sync"]);
    for (const path of [opencodePath, `${opencodePath}-wal`, contextPath, `${contextPath}-wal`]) {
        if (!existsSync(path)) continue;
        const result = Bun.spawnSync([
            "python3",
            "-c",
            "import os,sys; fd=os.open(sys.argv[1], os.O_RDONLY); os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED); os.close(fd)",
            path,
        ]);
        if (result.exitCode !== 0) throw new Error(`posix_fadvise failed for ${path}`);
    }
}

/** Resident bytes of a file in the page cache, from fincore when present. */
function residentBytes(path: string): string {
    const result = Bun.spawnSync(["fincore", "--bytes", "--noheadings", "--output", "RES", path]);
    return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

function time<T>(run: () => T): { ms: number; value: T } {
    const started = performance.now();
    const value = run();
    return { ms: Math.round((performance.now() - started) * 100) / 100, value };
}

/** The count as it was before the index-only path: one statement reading every earlier message's JSON. */
const OLD_PREFIX_COUNT = `SELECT COUNT(*) AS visited,
       COALESCE(SUM(CASE WHEN (CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1)
                          AND (CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
                         THEN 0 ELSE 1 END), 0) AS eligible
FROM message WHERE session_id = ? AND (time_created, id) <= (?, ?)`;

buildOpenCodeStore();
buildContextStore();
const results: Record<string, unknown> = {
    messages: MESSAGES,
    other_sessions: `${OTHER_SESSIONS} x ${OTHER_MESSAGES}`,
    opencode_db_bytes: statSync(opencodePath).size,
    tags: TAGS,
};

// The newest message of the session, as the incremental index job looks up.
const targetIndex = MESSAGES - 2;
const targetId = id(SESSION, targetIndex);
const targetTime = 1_700_000_000_000 + targetIndex * 10;

// Old count, cold then warm.
{
    dropPageCache();
    results.cache_after_drop = residentBytes(opencodePath);
    const db = new RawDatabase(opencodePath, { readonly: true });
    const statement = db.prepare(OLD_PREFIX_COUNT);
    const cold = time(() => statement.get(SESSION, targetTime, targetId) as { eligible: number });
    const warm = time(() => statement.get(SESSION, targetTime, targetId) as { eligible: number });
    results.old_count = { cold_ms: cold.ms, warm_ms: warm.ms, ordinal: cold.value.eligible };
    db.close();
}

// New count through the real reader: first lookup of a connection, then
// lookups after another connection appended (the live host's ordinary case).
{
    dropPageCache();
    const reader = new Database(opencodePath, { readonly: true });
    const writer = new RawDatabase(opencodePath);
    writer.exec("PRAGMA busy_timeout = 5000");
    const insert = writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const read = (messageId: string) => readRawSessionMessageByIdFromDb(reader, SESSION, messageId)?.ordinal ?? -1;
    resetRawSessionOrdinalJsonRowsReadForTest();
    const first = time(() => read(targetId));
    const firstJson = getRawSessionOrdinalJsonRowsReadForTest();
    const firstWarm = time(() => read(targetId));
    const appendedCold: number[] = [];
    const appendedWarm: number[] = [];
    const appendedJson: number[] = [];
    let lastOrdinal = 0;
    for (let step = 0; step < 5; step += 1) {
        const index = MESSAGES + step * 2;
        const created = 1_700_000_000_000 + index * 10;
        insert.run(id(SESSION, index), SESSION, created, created, JSON.stringify({ role: "user", time: { created } }));
        dropPageCache();
        resetRawSessionOrdinalJsonRowsReadForTest();
        appendedCold.push(time(() => (lastOrdinal = read(id(SESSION, index)))).ms);
        appendedJson.push(getRawSessionOrdinalJsonRowsReadForTest());
        // Another commit, then the same lookup with the cache warm.
        insert.run(id(SESSION, index + 1), SESSION, created + 1, created + 1, JSON.stringify({ role: "user" }));
        appendedWarm.push(time(() => read(id(SESSION, index + 1))).ms);
    }
    resetRawSessionOrdinalJsonRowsReadForTest();
    const sessionCount = time(() => countRawSessionMessageOrdinalsFromDb(reader, SESSION));
    const sessionCountJson = getRawSessionOrdinalJsonRowsReadForTest();
    // Cost of the read transaction each indexed count runs in: the mean of
    // 2,000 warm session counts, and the extra time of BEGIN/ROLLBACK around a
    // trivial SELECT compared with the SELECT alone.
    const counts = time(() => {
        for (let step = 0; step < 2_000; step += 1) countRawSessionMessageOrdinalsFromDb(reader, SESSION);
    });
    const bare = reader.prepare("SELECT 1 AS one");
    const wrapped = time(() => {
        for (let step = 0; step < 2_000; step += 1) {
            reader.exec("BEGIN");
            bare.get();
            reader.exec("ROLLBACK");
        }
    });
    const plain = time(() => {
        for (let step = 0; step < 2_000; step += 1) bare.get();
    });
    results.read_snapshot_overhead = {
        session_count_warm_mean_ms: Math.round((counts.ms / 2_000) * 1000) / 1000,
        begin_rollback_mean_us: Math.round(((wrapped.ms - plain.ms) / 2_000) * 1000 * 10) / 10,
    };
    // Equality with the old statement on the last appended message.
    const lastId = id(SESSION, MESSAGES + 9);
    const lastRow = reader.prepare("SELECT time_created FROM message WHERE id = ?").get(lastId) as {
        time_created: number;
    };
    const expected = reader.prepare(OLD_PREFIX_COUNT).get(SESSION, lastRow.time_created, lastId) as {
        eligible: number;
    };
    results.new_count = {
        first_lookup_cold_ms: first.ms,
        first_lookup_json_rows: firstJson,
        first_lookup_ordinal: first.value,
        first_lookup_warm_ms: firstWarm.ms,
        after_foreign_append_cold_ms: appendedCold,
        after_foreign_append_json_rows: appendedJson,
        after_foreign_append_warm_ms: appendedWarm,
        session_count_ms: sessionCount.ms,
        session_count_json_rows: sessionCountJson,
        last_ordinal: read(lastId),
        old_statement_last_ordinal: expected.eligible,
        cold_lookup_last_ordinal: lastOrdinal,
    };
    // Leave the store as it was for the next run.
    writer.prepare("DELETE FROM message WHERE session_id = ? AND time_created >= ?").run(
        SESSION,
        1_700_000_000_000 + MESSAGES * 10,
    );
    writer.close();
    reader.close();
}

// The first pass after a restart: a fresh connection on a cold cache counts
// the newest message, once directly (the summary scan runs on this thread) and
// once after awaiting the off-thread warm-up. A 2 ms ticker records the
// longest time the event loop was held.
async function longestBlock(
    run: () => Promise<unknown>,
): Promise<{ total_ms: number; longest_block_ms: number }> {
    let last = performance.now();
    let longest = 0;
    const ticker = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
    }, 2);
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run();
    const total = performance.now() - started;
    clearInterval(ticker);
    longest = Math.max(longest, performance.now() - last);
    return { total_ms: Math.round(total), longest_block_ms: Math.round(longest * 10) / 10 };
}
{
    const restart: Record<string, unknown> = {};
    for (const mode of ["in-thread", "prewarmed"] as const) {
        dropPageCache();
        const reader = new Database(opencodePath, { readonly: true });
        let ordinal = -1;
        let warmup = "";
        const measured = await longestBlock(async () => {
            if (mode === "prewarmed") warmup = await prewarmRawSessionOrdinalsForDb(reader, SESSION);
            ordinal = readRawSessionMessageByIdFromDb(reader, SESSION, targetId)?.ordinal ?? -1;
        });
        restart[mode] = { ...measured, ordinal, ...(mode === "prewarmed" ? { warmup } : {}) };
        reader.close();
    }
    results.first_pass_after_restart_cold = restart;
}
// Tag owner summary: first read, a pass after another connection appended
// tags, and a pass after another connection's status write.
{
    dropPageCache();
    const db = new Database(contextPath);
    const other = new RawDatabase(contextPath);
    other.exec("PRAGMA busy_timeout = 5000");
    // The other connection stands in for another Magic Context host: it bumps
    // the session's tag identity revision on identity writes, as every Magic
    // Context connection does.
    installTagIdentityRevisionTrigger(other as unknown as Database);
    const pass = () => {
        resetTagOwnerRowsReadForTest();
        const elapsed = time(() => {
            getReasoningTokenEstimatesByMessage(db, SESSION, 1);
            getMaxTagNumberByOwnerMessage(db, SESSION);
        }).ms;
        return { ms: elapsed, rows: getTagOwnerRowsReadForTest() };
    };
    const first = pass();
    const appendCold: Array<{ ms: number; rows: number }> = [];
    const appendWarm: Array<{ ms: number; rows: number }> = [];
    const statusWarm: Array<{ ms: number; rows: number }> = [];
    let next = TAGS + 1;
    const insert = other.prepare(
        "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, reasoning_token_count) VALUES (?, ?, 'message', 10, ?, 'opencode', 40)",
    );
    for (let step = 0; step < 5; step += 1) {
        insert.run(SESSION, `msg_new_${next}`, next);
        next += 1;
        dropPageCache();
        appendCold.push(pass());
        insert.run(SESSION, `msg_new_${next}`, next);
        next += 1;
        appendWarm.push(pass());
        other.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?").run(SESSION, step + 10);
        statusWarm.push(pass());
    }
    results.tag_owner_summary = {
        first_read: first,
        after_foreign_append_cold: appendCold,
        after_foreign_append_warm: appendWarm,
        after_foreign_status_write_warm: statusWarm,
    };
    other.prepare("DELETE FROM tags WHERE session_id = ? AND tag_number > ?").run(SESSION, TAGS);
    other.prepare("UPDATE tags SET status = 'active' WHERE session_id = ?").run(SESSION);
    other.close();
    db.close();
}

// Every database file this process still has open must be under the root.
try {
    const open = readdirSync("/proc/self/fd")
        .map((fd) => {
            try {
                return readlinkSync(`/proc/self/fd/${fd}`);
            } catch {
                return "";
            }
        })
        .filter((path) => /\.db(-wal|-shm)?$/.test(path));
    results.open_db_files = open;
    if (open.some((path) => !path.startsWith(root))) throw new Error(`database outside the root: ${open}`);
} catch (error) {
    results.open_db_files = String(error);
}

const output = JSON.stringify(results, null, 2);
writeFileSync(join(root, "stall-ordinal-real.json"), output);
console.log(output);
