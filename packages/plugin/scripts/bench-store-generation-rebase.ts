#!/usr/bin/env bun
/**
 * Measure `rebaseSessionCoordinates` on one large session, and check that two
 * implementations leave the same rows behind.
 *
 * The rebase runs on the first OpenCode 2 request of a session last served under
 * OpenCode 1, inside the request path, so its cost is paid by a user who is
 * waiting for an answer. This script reproduces that call outside the host:
 *
 *   prepare-synthetic --out <dir> [--messages N] [--compartments N]
 *       Write <dir>/context.db: a session stamped `v1` with id-anchored
 *       compartments, part tags a host store conversion folds, queued drops and
 *       a complete search index filed against the 1.x ordinals. The 2.x
 *       projection it is rebased against is regenerated from the same
 *       parameters at run time.
 *
 *   run --context <context.db> (--synthetic <dir> | --opencode <opencode.db> --session <id>)
 *       [--src <plugin src dir>] [--dump <out.json>] [--sync]
 *       Copy the context database to <context.db>.work, stamp the session `v1`,
 *       run the rebase twice and print elapsed time, the longest event-loop gap a
 *       10 ms heartbeat saw, RSS growth and the number of full-history reads.
 *       A tree that has `rebaseSessionCoordinatesAsync` is run through it with
 *       the paged reader, as the OpenCode 2 request path runs it; `--sync`
 *       forces the synchronous form.
 *       `--src` points at another checkout's `packages/plugin/src`, which is how
 *       an older implementation is measured on the same input. `--dump` writes a
 *       digest of every session-scoped row the rebase can touch.
 *
 *   compare <a.json> <b.json>
 *       Report every table whose rows differ between two dumps.
 *
 * Every path is caller-supplied; nothing here opens a host store by default.
 * Profile with `bun --cpu-prof-md scripts/bench-store-generation-rebase.ts run ...`.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

type Flags = Record<string, string>;

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
    const positional: string[] = [];
    const flags: Flags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? "";
        if (arg.startsWith("--")) {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith("--")) flags[arg.slice(2)] = "true";
            else {
                flags[arg.slice(2)] = next;
                index += 1;
            }
        } else positional.push(arg);
    }
    return { positional, flags };
}

const DEFAULT_SRC = resolve(import.meta.dir, "../src");

// Loaded from the chosen source tree so the database class, migrations and the
// rebase all come from the same implementation.
// biome-ignore lint/suspicious/noExplicitAny: modules are loaded from a caller-chosen tree
async function loadModules(src: string): Promise<Record<string, any>> {
    const load = (path: string) => import(join(src, path));
    const [sqlite, storageDb, migrations, rebase, messageIndex, store, storeReader] =
        await Promise.all([
            load("shared/sqlite.ts"),
            load("features/magic-context/storage-db.ts"),
            load("features/magic-context/migrations.ts"),
            load("features/magic-context/store-generation-rebase.ts"),
            load("features/magic-context/message-index.ts"),
            load("v2/hooks/store.ts"),
            load("v2/store-reader.ts"),
        ]);
    return { ...sqlite, ...storageDb, ...migrations, ...rebase, ...messageIndex, ...store, ...storeReader };
}

// ── Synthetic session of the reported shape ──────────────────────────────────

const SYNTHETIC_SESSION = "ses_synthetic_rebase_bench";

interface SyntheticParams {
    messages: number;
    compartments: number;
}

interface SyntheticMessage {
    id: string;
    role: "user" | "assistant";
    /** Text of each 1.x part. A 2.x host joins a multi-part user turn into one part. */
    texts: string[];
    tools: number;
    /** The 2.x host splits a synthetic reminder out of this turn into its own row. */
    splitAfter: boolean;
    createdAt: number;
}

const pad = (value: number) => String(value).padStart(7, "0");

function lorem(seed: number, words: number): string {
    const vocabulary = [
        "compartment", "boundary", "ordinal", "session", "rebase", "anchor", "index",
        "historian", "fold", "projection", "message", "part", "tag", "reduce", "cache",
        "prefix", "render", "store", "convert", "window",
    ];
    const out: string[] = [];
    let state = seed * 2654435761;
    for (let index = 0; index < words; index += 1) {
        state = (state * 1103515245 + 12345) >>> 0;
        out.push(vocabulary[state % vocabulary.length] ?? "word");
    }
    return out.join(" ");
}

/**
 * One user turn followed by two assistant turns, repeated. Every second user turn
 * carries two or three text parts (the host joins them, which is what makes part tags
 * fold), and every 97th message is a user turn the host splits a synthetic row
 * out of, which moves every later ordinal and so forces the index rebuild.
 */
function syntheticMessages(params: SyntheticParams): SyntheticMessage[] {
    const out: SyntheticMessage[] = [];
    for (let index = 0; index < params.messages; index += 1) {
        const role = index % 3 === 0 ? "user" : "assistant";
        const multi = role === "user" && index % 6 === 0;
        out.push({
            id: `msg_${pad(index)}`,
            role,
            texts: multi
                ? [lorem(index, 30), lorem(index + 1, 25), ...(index % 18 === 0 ? [lorem(index + 2, 20)] : [])]
                : [lorem(index, role === "user" ? 30 : 60)],
            tools: role === "assistant" ? 2 : 0,
            splitAfter: role === "user" && index % 97 === 0,
            createdAt: 1_700_000_000_000 + index * 1000,
        });
    }
    return out;
}

// biome-ignore lint/suspicious/noExplicitAny: RawMessage from the chosen tree
function v1Projection(messages: SyntheticMessage[]): any[] {
    return messages.map((message, index) => ({
        id: message.id,
        role: message.role,
        ordinal: index + 1,
        createdAt: message.createdAt,
        parts: [
            ...message.texts.map((text) => ({ type: "text", text })),
            ...Array.from({ length: message.tools }, (_, tool) => ({
                type: "tool",
                tool: "bash",
                callID: `call_${message.id}_${tool}`,
                state: { status: "completed", output: lorem(tool, 10) },
            })),
        ],
    }));
}

// biome-ignore lint/suspicious/noExplicitAny: RawMessage from the chosen tree
function v2Projection(messages: SyntheticMessage[]): any[] {
    // biome-ignore lint/suspicious/noExplicitAny: RawMessage from the chosen tree
    const out: any[] = [];
    for (const message of messages) {
        out.push({
            id: message.id,
            role: message.role,
            ordinal: out.length + 1,
            createdAt: message.createdAt,
            parts: [
                ...(message.role === "user"
                    ? [{ type: "text", text: message.texts.join("\n\n") }]
                    : message.texts.map((text) => ({ type: "text", text }))),
                ...Array.from({ length: message.tools }, (_, tool) => ({
                    type: "tool",
                    tool: "bash",
                    callID: `call_${message.id}_${tool}`,
                    state: { status: "completed", output: lorem(tool, 10) },
                })),
            ],
        });
        if (message.splitAfter) {
            const synthetic = {
                id: `${message.id}_syn`,
                role: "user",
                ordinal: out.length + 1,
                createdAt: message.createdAt,
                parts: [{ type: "text", text: "<system-reminder>synthetic</system-reminder>" }],
            };
            Object.defineProperty(synthetic, "storeType", { value: "synthetic", enumerable: false });
            out.push(synthetic);
        }
    }
    return out;
}

async function prepareSynthetic(flags: Flags): Promise<void> {
    const outDir = flags.out;
    if (!outDir) throw new Error("--out is required");
    const params: SyntheticParams = {
        messages: Number(flags.messages ?? 42534),
        compartments: Number(flags.compartments ?? 1478),
    };
    const m = await loadModules(flags.src ?? DEFAULT_SRC);
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, "context.db");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    writeFileSync(join(outDir, "params.json"), JSON.stringify(params));
    const db = new m.Database(path);
    m.initializeDatabase(db);
    m.runMigrations(db);
    const messages = syntheticMessages(params);
    const v1 = v1Projection(messages);
    const sessionId = SYNTHETIC_SESSION;

    db.exec("BEGIN");
    db.prepare("INSERT OR IGNORE INTO session_meta (session_id, harness) VALUES (?, 'opencode')").run(
        sessionId,
    );
    const perCompartment = Math.floor(params.messages / params.compartments);
    const insertCompartment = db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, importance, legacy, created_at, harness)
         VALUES (?, ?, ?, ?, ?, ?, 'compartment', 'summary text', 50, 0, 1000, 'opencode')`,
    );
    // The last compartment ends a little before the tail, like a live session
    // whose newest turns the historian has not summarised yet.
    const covered = perCompartment * params.compartments;
    for (let sequence = 0; sequence < params.compartments; sequence += 1) {
        const start = sequence * perCompartment + 1;
        const end = Math.min(covered, start + perCompartment - 1);
        insertCompartment.run(
            sessionId,
            sequence + 1,
            start,
            end,
            v1[start - 1].id,
            v1[end - 1].id,
        );
    }

    const insertTag = db.prepare(
        `INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness,
                           tool_owner_message_id, token_count)
         VALUES (?, ?, ?, 'active', ?, ?, 'opencode', ?, ?)`,
    );
    const insertDrop = db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', 1, 'opencode')",
    );
    let tagNumber = 0;
    let multiSeen = 0;
    for (const message of messages) {
        if (message.role === "user" && message.texts.length > 1) {
            multiSeen += 1;
            // Most joined turns never had their first fragment tagged (it was an
            // empty or synthetic lead-in), so the surviving tag is re-keyed down
            // to part 0; the rest keep a part-0 tag the others fold into.
            const tagFirst = multiSeen % 5 < 2;
            message.texts.forEach((text, part) => {
                if (part === 0 && !tagFirst) return;
                tagNumber += 1;
                insertTag.run(sessionId, `${message.id}:p${part}`, "message", text.length, tagNumber, null, 10);
                if (part === 1 && multiSeen % 40 === 0) insertDrop.run(sessionId, tagNumber);
            });
        } else {
            tagNumber += 1;
            insertTag.run(sessionId, `${message.id}:p0`, "message", 100, tagNumber, null, 10);
        }
        for (let tool = 0; tool < message.tools; tool += 1) {
            tagNumber += 1;
            insertTag.run(sessionId, `call_${message.id}_${tool}`, "tool", 50, tagNumber, message.id, 5);
        }
    }
    db.prepare(
        "UPDATE session_meta SET coordinate_generation = 'v1', counter = ? WHERE session_id = ?",
    ).run(tagNumber, sessionId);
    db.exec("COMMIT");

    // A complete index filed against the 1.x ordinals, as the 1.x host left it.
    m.ensureMessagesIndexed(db, sessionId, () => v1);
    db.close();
    console.log(JSON.stringify({ path, sessionId, ...params, tags: tagNumber }));
}

// ── Run ──────────────────────────────────────────────────────────────────────

interface RunReport {
    label: string;
    src: string;
    sessionId: string;
    mode: "sync" | "async";
    first: CallReport;
    second: CallReport;
}

interface CallReport {
    status: string;
    elapsedMs: number;
    maxEventLoopGapMs: number;
    rssBeforeMb: number;
    rssAfterMb: number;
    rssDeltaMb: number;
    peakRssMb: number;
    historyReads: number;
    messagesRead: number;
    readMs: number;
    // biome-ignore lint/suspicious/noExplicitAny: the outcome shape belongs to the chosen tree
    outcome: any;
}

const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

interface HistorySource {
    // biome-ignore lint/suspicious/noExplicitAny: RawMessage from the chosen tree
    all: () => any[];
    // biome-ignore lint/suspicious/noExplicitAny: RawMessage from the chosen tree
    pages: () => Iterable<any[]>;
}

async function measure(
    // biome-ignore lint/suspicious/noExplicitAny: loaded module surface
    m: Record<string, any>,
    db: unknown,
    sessionId: string,
    source: HistorySource,
    useAsync: boolean,
) {
    let reads = 0;
    let messagesRead = 0;
    let readMs = 0;
    const readMessages = () => {
        const started = performance.now();
        reads += 1;
        const out = source.all();
        messagesRead += out.length;
        readMs += performance.now() - started;
        return out;
    };
    // Counts one read per full pass over the pages; time spent inside the
    // reader is summed across pages.
    // biome-ignore lint/suspicious/noExplicitAny: RawMessage from the chosen tree
    function* readMessagePages(): Generator<any[]> {
        reads += 1;
        const iterator = source.pages()[Symbol.iterator]();
        try {
            for (;;) {
                const started = performance.now();
                const next = iterator.next();
                readMs += performance.now() - started;
                if (next.done) return;
                messagesRead += next.value.length;
                yield next.value;
            }
        } finally {
            iterator.return?.();
        }
    }
    Bun.gc(true);
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    let last = performance.now();
    let maxGap = 0;
    const heartbeat = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);
    await new Promise((done) => setTimeout(done, 30));
    last = performance.now();
    const started = performance.now();
    const outcome = useAsync
        ? await m.rebaseSessionCoordinatesAsync({
              db,
              sessionId,
              generation: "v2",
              readMessages,
              readMessagePages,
          })
        : m.rebaseSessionCoordinates({ db, sessionId, generation: "v2", readMessages });
    const elapsedMs = performance.now() - started;
    // One more tick so a heartbeat that was starved by a synchronous call is
    // counted before the timer stops.
    await new Promise((done) => setTimeout(done, 30));
    clearInterval(heartbeat);
    const rssAfter = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rssAfter);
    const report: CallReport = {
        status: outcome.status,
        elapsedMs: Math.round(elapsedMs),
        maxEventLoopGapMs: Math.round(maxGap),
        rssBeforeMb: mb(rssBefore),
        rssAfterMb: mb(rssAfter),
        rssDeltaMb: mb(rssAfter - rssBefore),
        peakRssMb: mb(peakRss),
        historyReads: reads,
        messagesRead,
        readMs: Math.round(readMs),
        outcome,
    };
    return report;
}

async function run(flags: Flags): Promise<void> {
    const src = resolve(flags.src ?? DEFAULT_SRC);
    const contextPath = flags.context;
    if (!contextPath) throw new Error("--context is required");
    const m = await loadModules(src);
    const workPath = `${contextPath}.work`;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(workPath + suffix, { force: true });
    copyFileSync(contextPath, workPath);

    let source: HistorySource;
    let sessionId: string;
    if (flags.synthetic) {
        const params = JSON.parse(readFileSync(join(flags.synthetic, "params.json"), "utf8"));
        sessionId = SYNTHETIC_SESSION;
        const messages = syntheticMessages(params);
        source = {
            all: () => v2Projection(messages),
            // The whole projection is built first either way; the synthetic
            // input measures the rebase, not a reader.
            pages: function* () {
                const all = v2Projection(messages);
                for (let start = 0; start < all.length; start += 1000) {
                    yield all.slice(start, start + 1000);
                }
            },
        };
    } else {
        const opencode = flags.opencode;
        sessionId = flags.session ?? "";
        if (!opencode || !sessionId) throw new Error("--opencode and --session are required");
        const open = () => new m.V2StoreReader(opencode);
        source = {
            all: () => m.readAllV2RawMessagesForConversion(open, sessionId),
            pages: () => m.readV2RawMessagePagesForConversion(open, sessionId),
        };
    }
    // The request path's form, when the tree has it: released between pages and
    // index chunks, and fed by the paged reader.
    const useAsync = flags.sync !== "true" && typeof m.rebaseSessionCoordinatesAsync === "function";

    const db = new m.Database(workPath);
    m.initializeDatabase(db);
    m.runMigrations(db);
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        sessionId,
    );

    const first = await measure(m, db, sessionId, source, useAsync);
    const second = await measure(m, db, sessionId, source, useAsync);
    const report: RunReport = {
        label: flags.label ?? "",
        src,
        sessionId,
        mode: useAsync ? "async" : "sync",
        first,
        second,
    };
    if (flags.dump) {
        mkdirSync(dirname(flags.dump), { recursive: true });
        writeFileSync(flags.dump, JSON.stringify(dumpSession(db, sessionId), null, 1));
    }
    db.close();
    if (flags.keep !== "true") {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(workPath + suffix, { force: true });
    }
    console.log(JSON.stringify(report, null, 2));
}

/** Columns whose value is a wall-clock time or an FTS row identity, not a coordinate. */
const VOLATILE_COLUMNS = new Set(["updated_at", "fts_rowid", "queued_at"]);

// biome-ignore lint/suspicious/noExplicitAny: bun/node sqlite handle
function dumpSession(db: any, sessionId: string): Record<string, unknown> {
    const tables = [
        "compartments",
        "recomp_compartments",
        "tags",
        "pending_ops",
        "source_contents",
        "notes",
        "compression_depth",
        "compartment_chunk_embeddings",
        "message_history_source",
        "message_history_index",
        "message_fts_rowid_map",
        "lkg_slots",
        "session_meta",
    ];
    const out: Record<string, unknown> = {};
    for (const table of tables) {
        const rows = (db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(sessionId) as Array<
            Record<string, unknown>
        >).map((row) => {
            const kept: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row)) {
                if (VOLATILE_COLUMNS.has(key)) continue;
                if (key === "coordinate_rebase_notice" && typeof value === "string" && value) {
                    const notice = JSON.parse(value);
                    delete notice.at;
                    delete notice.neighbourRecoveryAt;
                    kept[key] = notice;
                    continue;
                }
                kept[key] = value instanceof Uint8Array ? createHash("sha256").update(value).digest("hex") : value;
            }
            return kept;
        });
        rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        out[table] = { count: rows.length, sha256: sha(rows), rows: table === "session_meta" ? rows : undefined };
    }
    // The indexed documents themselves, keyed by the ordinal they were filed under.
    const documents = db
        .prepare(
            `SELECT map.message_ordinal AS ordinal, fts.message_id AS messageId, fts.role AS role,
                    fts.content AS content, map.message_time_ms AS time
             FROM message_fts_rowid_map AS map
             JOIN message_history_fts AS fts ON fts.rowid = map.fts_rowid
             WHERE map.session_id = ?
             ORDER BY map.message_ordinal`,
        )
        .all(sessionId);
    out.message_history_fts = { count: documents.length, sha256: sha(documents) };
    return out;
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function compare(a: string, b: string): void {
    const left = JSON.parse(readFileSync(a, "utf8")) as Record<string, { count: number; sha256: string; rows?: unknown }>;
    const right = JSON.parse(readFileSync(b, "utf8")) as typeof left;
    const differing: string[] = [];
    for (const table of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const l = left[table];
        const r = right[table];
        const same = l?.sha256 === r?.sha256 && l?.count === r?.count;
        console.log(`${same ? "same  " : "DIFFER"} ${table} ${l?.count ?? "-"} ${r?.count ?? "-"}`);
        if (!same) {
            differing.push(table);
            if (l?.rows || r?.rows) console.log(JSON.stringify({ left: l?.rows, right: r?.rows }, null, 1));
        }
    }
    if (differing.length > 0) process.exitCode = 1;
}

const { positional, flags } = parseFlags(process.argv.slice(2));
const command = positional[0];
if (command === "prepare-synthetic") await prepareSynthetic(flags);
else if (command === "run") await run(flags);
else if (command === "compare") compare(positional[1] ?? "", positional[2] ?? "");
else {
    console.error("usage: prepare-synthetic | run | compare (see the header of this file)");
    process.exitCode = 2;
}
