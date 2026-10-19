#!/usr/bin/env bun
/**
 * Isolated measurement of two main-thread stalls seen on a long OpenCode
 * session (about 2,070 wire messages, ~90 compartments, ~72k tags):
 *
 *  1. compartment boundary resolution inside the Rust-mode state-sync payload;
 *  2. ctx_reduce's inert-whitespace tag lookup.
 *
 * Every store lives under the throwaway root in MC_BENCH_ROOT. The script
 * refuses to start unless the OpenCode and Magic Context store locations all
 * point inside that root, so it can never open a live store.
 *
 * Usage (from packages/plugin):
 *   MC_BENCH_ROOT=$TMPDIR/magic-context/<task> XDG_DATA_HOME=$MC_BENCH_ROOT/data \
 *   XDG_CONFIG_HOME=... XDG_STATE_HOME=... XDG_RUNTIME_DIR=... \
 *   OPENCODE_DB=$MC_BENCH_ROOT/data/opencode/opencode.db \
 *   MAGIC_CONTEXT_STORAGE_DIR=$MC_BENCH_ROOT/storage \
 *   bun scripts/perf-audit/stall-boundaries-inert.ts --out=<result.json>
 *
 * The result file holds medians and sha256 digests of every output, so a run
 * on the old code and a run on the new code can be compared byte for byte.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendCompartments } from "../../src/features/magic-context/compartment-storage";
import { runMigrations } from "../../src/features/magic-context/migrations";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../src/features/magic-context/storage-meta-session";
import {
    insertTag,
    markWhitespaceAssistantTagInert,
} from "../../src/features/magic-context/storage-tags";
import { buildModuleStateSyncPayload } from "../../src/hooks/magic-context/module-state-sync";
import { closeReadOnlySessionDb } from "../../src/hooks/magic-context/read-session-db";
import { resolveSharedCompartmentBoundaries } from "../../src/hooks/magic-context/shared-compartment-boundaries";
import { Database } from "../../src/shared/sqlite";
import { createCtxReduceTools } from "../../src/tools/ctx-reduce/tools";

const root = process.env.MC_BENCH_ROOT ? resolve(process.env.MC_BENCH_ROOT) : "";
const isolatedVariables = [
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "OPENCODE_DB",
    "MAGIC_CONTEXT_STORAGE_DIR",
] as const;
if (!root || !root.startsWith(resolve(tmpdir()))) {
    throw new Error("MC_BENCH_ROOT must name a directory under the system temp directory");
}
for (const name of isolatedVariables) {
    const value = process.env[name];
    if (!value || !resolve(value).startsWith(`${root}/`)) {
        throw new Error(`${name} must point inside MC_BENCH_ROOT (${root}); got ${value ?? "unset"}`);
    }
}
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "bench.log");

const outPath = Bun.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
const SESSION = "ses-alf-scale";
const WIRE_MESSAGES = 2_070;
const COMPARTMENTS = 92;
const TAGS = 72_000;
const OTHER_SESSIONS = 30;
const OTHER_SESSION_TAGS = 11_000;
const REPEATS = 7;

function sha(value: unknown): string {
    return createHash("sha256")
        .update(typeof value === "string" ? value : JSON.stringify(value))
        .digest("hex");
}

function median(samples: number[]): number {
    const sorted = [...samples].sort((left, right) => left - right);
    return +sorted[Math.floor(sorted.length / 2)].toFixed(3);
}

function messageId(index: number): string {
    return `msg_${String(index).padStart(6, "0")}`;
}

/** Writes the host store: user/assistant turns with heavy tool parts, plus finished compaction summaries. */
function writeOpenCodeStore(path: string): string[] {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    const canonical: string[] = [];
    try {
        db.exec(`
            CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
            CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
            CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
            CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
            CREATE INDEX part_message_id_id_idx ON part(message_id, id);
            CREATE INDEX part_session_idx ON part(session_id);
        `);
        db.prepare("INSERT INTO session VALUES (?, ?)").run(SESSION, "/fixture/alf");
        const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
        const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
        const output = "tool output line\n".repeat(400);
        const diagnosticsOf = (count: number) =>
            Array.from({ length: count }, (_, index) => ({
                severity: 1,
                message: `Unresolved reference: symbol${index}`,
                range: { start: { line: index, character: 0 } },
            }));
        // Edit/write tools store workspace-wide diagnostics in metadata; some
        // parts reach several MiB on real sessions.
        const diagnostics = diagnosticsOf(300);
        const heavyDiagnostics = diagnosticsOf(12_000);
        db.transaction(() => {
            let partSeq = 0;
            const part = (owner: string, time: number, data: unknown) => {
                partSeq += 1;
                insertPart.run(
                    `prt_${String(partSeq).padStart(8, "0")}`,
                    owner,
                    SESSION,
                    time,
                    time,
                    JSON.stringify(data),
                );
            };
            for (let index = 0; index < WIRE_MESSAGES + 3; index += 1) {
                const id = messageId(index);
                // Pairs share a timestamp so ordering must fall back to the id.
                const time = 1_760_000_000_000 + Math.floor(index / 2) * 1_000;
                const isSummary = index === 700 || index === 1400 || index === 1900;
                const isUser = !isSummary && index % 2 === 0;
                const info = isSummary
                    ? { id, role: "assistant", summary: true, finish: "stop" }
                    : isUser
                      ? { id, role: "user", time: { created: time } }
                      : { id, role: "assistant", finish: "tool-calls", time: { created: time } };
                insertMessage.run(id, SESSION, time, time, JSON.stringify(info));
                if (!isSummary) canonical.push(id);
                if (isSummary) {
                    part(id, time, { type: "text", text: "summary" });
                    continue;
                }
                if (isUser) {
                    part(id, time, { type: "text", text: `question ${index}` });
                    if (index % 10 === 0)
                        part(id, time, { type: "text", text: "hidden", ignored: true });
                    continue;
                }
                part(id, time, { type: "step-start" });
                part(id, time, { type: "reasoning", text: "thinking ".repeat(200) });
                part(id, time, { type: "text", text: `answer ${index}` });
                const status = index % 7 === 0 ? "error" : index % 11 === 0 ? "running" : "completed";
                part(id, time, {
                    type: "tool",
                    tool: "read",
                    callID: `call-${index}`,
                    state: {
                        status,
                        input: { filePath: `/src/File${index}.kt` },
                        output,
                        metadata: {
                            diagnostics: {
                                [`/src/File${index}.kt`]:
                                    index % 6 === 1 ? heavyDiagnostics : diagnostics,
                            },
                        },
                    },
                });
                if (index % 3 === 0) part(id, time, { type: "step-finish", reason: "tool-calls" });
            }
        }).immediate();
    } finally {
        db.close();
    }
    return canonical;
}

function writeContextStore(path: string, canonical: readonly string[]): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, SESSION);
    // Contiguous compartments over the canonical (summary-free) ordinal space,
    // leaving a live tail uncovered. Most rows are legacy (whole-message)
    // boundaries; every tenth carries explicit block indexes.
    const covered = 1_980;
    const span = Math.floor(covered / COMPARTMENTS);
    appendCompartments(
        db,
        SESSION,
        Array.from({ length: COMPARTMENTS }, (_, sequence) => {
            const start = sequence * span + 1;
            const end = sequence === COMPARTMENTS - 1 ? covered : (sequence + 1) * span;
            return {
                sequence,
                startMessage: start,
                endMessage: end,
                startMessageId: canonical[start - 1],
                endMessageId: canonical[end - 1],
                startBlockIndex: sequence % 10 === 5 ? 0 : null,
                endBlockIndex: sequence % 10 === 5 ? 1 : null,
                title: `Compartment ${sequence}`,
                content: `Summary of messages ${start}-${end}. `.repeat(20),
            };
        }),
    );
    db.prepare("UPDATE compartments SET created_at = 1 WHERE session_id = ?").run(SESSION);
    db.transaction(() => {
        for (let tag = 1; tag <= TAGS; tag += 1) {
            const owner = canonical[(tag * 7) % canonical.length];
            const type = tag % 3 === 0 ? "tool" : "message";
            const fingerprint = tag % 5 === 0 ? `fp:${owner}:${tag}` : null;
            insertTag(db, SESSION, `${owner}:p${tag % 4}`, type, 400, tag, 0, null, 0, null, fingerprint);
        }
        // Other sessions share the table, as they do in a real store.
        for (let other = 0; other < OTHER_SESSIONS; other += 1) {
            for (let tag = 1; tag <= OTHER_SESSION_TAGS; tag += 1) {
                insertTag(db, `ses-other-${other}`, `m${tag}:p0`, "message", 400, tag, 0, null, 0, null, tag % 5 === 0 ? `fp:${tag}` : null);
            }
        }
        db.prepare(
            "UPDATE tags SET status = 'compacted' WHERE session_id = ? AND tag_number <= ?",
        ).run(SESSION, 60_000);
        db.prepare(
            "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number > ? AND tag_number <= ?",
        ).run(SESSION, 60_000, 70_000);
        // Whitespace-only assistant tags from older sessions are kept as inert
        // compacted rows (see markWhitespaceAssistantTagInert); scatter a few
        // hundred message tags across the session in that state.
        for (let tag = 4; tag <= TAGS; tag += 360) {
            if (tag % 3 === 0) continue;
            markWhitespaceAssistantTagInert(db, SESSION, tag, `${canonical[tag % canonical.length]}:p1`);
        }
    })();
    db.exec("ANALYZE");
    return db;
}

const opencodePath = process.env.OPENCODE_DB as string;
rmSync(dirname(opencodePath), { recursive: true, force: true });
const contextPath = join(process.env.MAGIC_CONTEXT_STORAGE_DIR as string, "bench-context.db");
mkdirSync(dirname(contextPath), { recursive: true });
rmSync(contextPath, { force: true });

const canonical = writeOpenCodeStore(opencodePath);
const db = writeContextStore(contextPath, canonical);
const result: Record<string, unknown> = {
    bun: Bun.version,
    sqlite: (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
    messages: canonical.length,
    compartments: COMPARTMENTS,
    tags: (
        db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?").get(SESSION) as {
            n: number;
        }
    ).n,
    allTags: (db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n,
};

// --- 1. Compartment boundary resolution ------------------------------------
const coldStart = performance.now();
const resolved = resolveSharedCompartmentBoundaries(db, SESSION);
result.boundariesColdMs = +(performance.now() - coldStart).toFixed(3);
result.boundariesSha = sha(resolved);
result.boundariesWarmSameStoreMs = median(
    Array.from({ length: REPEATS }, () => {
        const start = performance.now();
        resolveSharedCompartmentBoundaries(db, SESSION);
        return performance.now() - start;
    }),
);
// The live case: the host has written between syncs, so nothing about the
// store can be assumed unchanged.
const writer = new Database(opencodePath);
let appended = 0;
result.boundariesAfterHostWriteMs = median(
    Array.from({ length: REPEATS }, () => {
        appended += 1;
        const time = 1_770_000_000_000 + appended;
        const id = `msg_tail_${appended}`;
        writer
            .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
            .run(id, SESSION, time, time, JSON.stringify({ id, role: "user" }));
        const start = performance.now();
        resolveSharedCompartmentBoundaries(db, SESSION);
        return performance.now() - start;
    }),
);
result.boundariesAfterHostWriteSha = sha(resolveSharedCompartmentBoundaries(db, SESSION));

const syncSamples: number[] = [];
let payloadSha = "";
for (let run = 0; run < REPEATS; run += 1) {
    const start = performance.now();
    const payload = await buildModuleStateSyncPayload({
        state: {
            moduleGeneration: 1,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 1,
            idOrdinalMemo: new Map(),
            seedPassPending: false,
        } as never,
        pass: { db, sessionId: SESSION, projectPath: "/fixture/alf", nowMs: 1 },
        force: false,
    });
    syncSamples.push(performance.now() - start);
    const digest = sha(payload);
    if (payloadSha && payloadSha !== digest) throw new Error("state-sync payload is not stable");
    payloadSha = digest;
}
result.stateSyncPayloadMs = median(syncSamples);
result.stateSyncPayloadSha = payloadSha;
// The same payload when the host has written since the previous sync.
const syncAfterWriteSamples: number[] = [];
for (let run = 0; run < REPEATS; run += 1) {
    appended += 1;
    const time = 1_770_000_000_000 + appended;
    const id = `msg_tail_${appended}`;
    writer
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
        .run(id, SESSION, time, time, JSON.stringify({ id, role: "user" }));
    const start = performance.now();
    const payload = await buildModuleStateSyncPayload({
        state: {
            moduleGeneration: 1,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 1,
            idOrdinalMemo: new Map(),
            seedPassPending: false,
        } as never,
        pass: { db, sessionId: SESSION, projectPath: "/fixture/alf", nowMs: 1 },
        force: false,
    });
    syncAfterWriteSamples.push(performance.now() - start);
    if (sha(payload) !== payloadSha) throw new Error("state-sync payload changed after a tail write");
}
result.stateSyncPayloadAfterHostWriteMs = median(syncAfterWriteSamples);

// --- 2. ctx_reduce ------------------------------------------------------------
// The lookup on its own: the unscoped read every version has, and the
// per-number read where this version of the code provides it.
const tagsModule = (await import("../../src/features/magic-context/storage-tags")) as Record<
    string,
    unknown
>;
const unscoped = tagsModule.getInertWhitespaceAssistantTags as (
    database: Database,
    sessionId: string,
) => Array<{ tagNumber: number }>;
result.inertLookupUnscopedMs = median(
    Array.from({ length: REPEATS }, () => {
        const start = performance.now();
        unscoped(db, SESSION);
        return performance.now() - start;
    }),
);
const byNumbers = tagsModule.getInertWhitespaceAssistantTagsByNumbers as
    | ((database: Database, sessionId: string, numbers: number[]) => unknown)
    | undefined;
if (byNumbers) {
    result.inertLookupByNumbersMs = median(
        Array.from({ length: REPEATS }, () => {
            const start = performance.now();
            byNumbers(db, SESSION, [4, 364, 7, 70_001, 70_002, 724, 999_999]);
            return performance.now() - start;
        }),
    );
}
const reduce = createCtxReduceTools({ db, protectedSet: new Set<number>() }).ctx_reduce;
const context = { sessionID: SESSION, directory: "/fixture/alf", callID: "bench" } as never;
const calls = [
    "4,364",
    "4,364,7",
    "70001-70010,724",
    "71990-72000",
    "999999",
    "70500,70501,1084",
];
const reduceResults: string[] = [];
const reduceSamples: number[] = [];
for (const drop of calls) {
    const start = performance.now();
    reduceResults.push(String(await reduce.execute({ drop } as never, context)));
    reduceSamples.push(performance.now() - start);
}
result.ctxReduceCallMs = reduceSamples.map((ms) => +ms.toFixed(3));
result.ctxReduceResults = reduceResults;
result.ctxReduceSha = sha(reduceResults);
result.pendingOpsSha = sha(
    db
        .prepare(
            "SELECT tag_id, operation FROM pending_ops WHERE session_id = ? ORDER BY tag_id, operation",
        )
        .all(SESSION),
);

writer.close();
closeReadOnlySessionDb();
db.close();
const text = JSON.stringify(result, null, 2);
console.log(text);
if (outPath) writeFileSync(outPath, `${text}\n`);
