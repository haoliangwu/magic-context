/** Cold-cache, file-backed host probes. All stores and environment roots are throwaway. */
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

if (process.platform !== "linux") throw new Error("cache residency probes require Linux");
const root = resolve(process.env.COLD_ROOT ?? "");
if (!process.env.COLD_ROOT || !root.startsWith(`${resolve(tmpdir(), "magic-context")}/`)) throw new Error("COLD_ROOT must be a throwaway root under TMPDIR/magic-context");
for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "MAGIC_CONTEXT_STORAGE_DIR"]) {
    process.env[name] = join(root, name.toLowerCase());
    mkdirSync(process.env[name], { recursive: true });
}
process.env.SQLITE_TMPDIR = join(root, "sqlite-tmp");
mkdirSync(process.env.SQLITE_TMPDIR, { recursive: true });
process.env.OPENCODE_DB = join(root, "opencode.db");
const source = resolve(process.env.COLD_SRC ?? join(import.meta.dir, "../../src"));
const label = process.env.COLD_LABEL ?? "after";
const length = Number(process.env.COLD_MESSAGES ?? 160_000);
const sessions = ["cold-at-start", "opened-hours-later"];
const load = (path: string) => import(join(source, path));
const { Database, withSqliteBackgroundWriter } = await load("shared/sqlite.ts") as typeof import("../../src/shared/sqlite");
const raw = await load("hooks/magic-context/read-session-raw.ts") as typeof import("../../src/hooks/magic-context/read-session-raw");
const { initializeDatabase } = await load("features/magic-context/storage-db.ts") as typeof import("../../src/features/magic-context/storage-db");
const budget = await load("hooks/magic-context/reasoning-budget.ts") as typeof import("../../src/hooks/magic-context/reasoning-budget");
const index = await load("features/magic-context/message-index.ts") as typeof import("../../src/features/magic-context/message-index");
const { installTagIdentityRevisionTrigger } = await load("features/magic-context/storage-tag-identity-revision.ts") as typeof import("../../src/features/magic-context/storage-tag-identity-revision");
const { configureContextDatabasePragmas } = await load("shared/sqlite-context-pragmas.ts") as typeof import("../../src/shared/sqlite-context-pragmas");
const ocPath = join(root, "opencode.db");
const seedPath = join(root, process.env.COLD_DEFAULT_FTS === "1" ? "context-default.db" : "context-seed.db");
const defaultSeedPath = join(root, "context-default.db");
const id = (session: string, i: number) => `${session}-${String(i).padStart(8, "0")}`;
const payload = "implementation worker cache context sqlite reasoning ".repeat(330);

function isolation() {
    const result = spawnSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`lsof failed: ${result.stderr}`);
    const paths = result.stdout.split("\n").filter(line => line.startsWith("n") && /\.db(?:-wal|-shm)?$/.test(line)).map(line => line.slice(1));
    if (!paths.length || paths.some(path => !path.startsWith(`${realpathSync(root)}/`))) throw new Error(`store isolation failed: ${JSON.stringify(paths)}`);
    console.log(JSON.stringify({ host_pid: process.pid, isolated_db_paths: paths }));
}

if (process.env.COLD_PREPARE === "1") {
    if (existsSync(ocPath) || existsSync(seedPath)) throw new Error("fixture already exists");
    const { OPENCODE1_MESSAGE_PART_SCHEMA } = await load("features/magic-context/__tests__/opencode1-query-fixture.ts") as typeof import("../../src/features/magic-context/__tests__/opencode1-query-fixture");
    const oc = new Database(ocPath);
    oc.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    oc.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const context = new Database(seedPath);
    initializeDatabase(context);
    configureContextDatabasePragmas(context);
    context.exec("INSERT INTO message_history_fts(message_history_fts, rank) VALUES ('automerge', 0), ('crisismerge', 64)");
    const defaults = new Database(defaultSeedPath);
    initializeDatabase(defaults);
    configureContextDatabasePragmas(defaults);
    const defaultTag = defaults.prepare("INSERT INTO tags(session_id, message_id, type, byte_size, tag_number, reasoning_token_count, tool_owner_message_id) VALUES (?, ?, ?, 16384, ?, ?, ?)");
    const defaultFts = defaults.prepare("INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)");
    const message = oc.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const part = oc.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    const tag = context.prepare("INSERT INTO tags(session_id, message_id, type, byte_size, tag_number, reasoning_token_count, tool_owner_message_id) VALUES (?, ?, ?, 16384, ?, ?, ?)");
    const fts = context.prepare("INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)");
    isolation();
    for (const session of sessions) {
        for (let start = 0; start < length; start += 1000) {
            if (start % 20_000 === 0) console.log(JSON.stringify({ setup_session: session, messages: start, disk: statfsSync(root), opencode_bytes: statSync(ocPath).size, context_bytes: statSync(seedPath).size }));
            try {
            oc.transaction(() => {
                for (let i = start; i < Math.min(length, start + 1000); i++) {
                    const owner = id(session, i);
                    const summary = i % 1000 === 999;
                    message.run(owner, session, Math.floor(i / 4), i, JSON.stringify({ role: "assistant", padding: payload, ...(summary ? { summary: true, finish: "stop" } : {}) }));
                    part.run(`p-${owner}`, owner, session, i, i, JSON.stringify({ type: "text", text: payload }));
                }
            })();
            context.transaction(() => {
                for (let i = start; i < Math.min(length, start + 1000); i++) {
                    const owner = id(session, i);
                    for (let n = 0; n < 4; n++) tag.run(session, n < 2 ? `${owner}:p${n}` : `call-${owner}-${n}`, n < 2 ? "message" : "tool", i * 4 + n + 1, n < 2 ? 100 + (i % 30) : null, n < 2 ? null : owner);
                    fts.run(session, i + 1, owner, `${payload} unique${i}`);
                }
            })();
            defaults.transaction(() => {
                for (let i = start; i < Math.min(length, start + 1000); i++) {
                    const owner = id(session, i);
                    for (let n = 0; n < 4; n++) defaultTag.run(session, n < 2 ? `${owner}:p${n}` : `call-${owner}-${n}`, n < 2 ? "message" : "tool", i * 4 + n + 1, n < 2 ? 100 + (i % 30) : null, n < 2 ? null : owner);
                    defaultFts.run(session, i + 1, owner, `${payload} unique${i}`);
                }
            })();
            } catch (error) {
                console.log(JSON.stringify({ failed_session: session, failed_start: start, disk: statfsSync(root), sqlite_limit: oc.prepare("PRAGMA max_page_count").get(), opencode_bytes: statSync(ocPath).size, opencode_wal_bytes: statSync(`${ocPath}-wal`).size, context_bytes: statSync(seedPath).size }));
                throw error;
            }
        }
        defaults.prepare("INSERT INTO message_history_index(session_id, last_indexed_ordinal, updated_at) VALUES (?, ?, 0)").run(session, length);
        context.prepare("INSERT INTO message_history_index(session_id, last_indexed_ordinal, updated_at) VALUES (?, ?, 0)").run(session, length);
    }
    context.exec("INSERT INTO message_history_fts(message_history_fts, rank) VALUES ('automerge', 4), ('crisismerge', 16)");
    oc.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    context.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    defaults.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    defaults.close();
    oc.close();
    context.close();
    console.log(JSON.stringify({ fixture_bytes: { opencode: statSync(ocPath).size, context: statSync(seedPath).size }, messages_per_session: length, message_payload_bytes: payload.length, sessions }));
    process.exit(0);
}

function coldCopy(from: string, to: string) {
    copyFileSync(from, to);
    evict(to);
}

function evict(path: string) {
    const result = spawnSync("python3", ["-c", `import os,sys,ctypes,mmap,json
p=sys.argv[1]; f=os.open(p,os.O_RDONLY); size=os.fstat(f).st_size
lib=ctypes.CDLL(None,use_errno=True)
os.fsync(f)
assert lib.posix_fadvise(f,0,0,4)==0
m=mmap.mmap(f,size,flags=mmap.MAP_PRIVATE,prot=mmap.PROT_READ|mmap.PROT_WRITE)
b=ctypes.c_char.from_buffer(m); pages=(size+4095)//4096; v=(ctypes.c_ubyte*pages)()
assert lib.mincore(ctypes.c_void_p(ctypes.addressof(b)),ctypes.c_size_t(size),v)==0
resident=sum(x&1 for x in v); print(json.dumps({'evicted':p,'pages':pages,'resident_pages':resident}))
assert resident/pages < .01
`, path], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`cache eviction failed: ${result.stdout} ${result.stderr}`);
    console.log(result.stdout.trim());
}

async function measure(run: () => unknown | Promise<unknown>) {
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 2);
    const start = performance.now();
    try {
        const result = await run();
        return { total_ms: performance.now() - start, longest_block_ms: Math.max(longest, performance.now() - last), result };
    } finally { clearInterval(timer); }
}

const results: Record<string, unknown> = { label, bun: Bun.version, source, fixture_bytes: { opencode: statSync(ocPath).size, context: statSync(seedPath).size }, sessions: [] };
const records: unknown[] = [];
for (const session of sessions) {
    evict(ocPath);
    const oc = new Database(ocPath, { readonly: true });
    isolation();
    const ordinal = process.env.COLD_INDEX_ONLY ? { skipped: true } : await measure(async () => {
        if (label !== "before") {
            try { raw.readRawSessionMessageByIdFromDb(oc, session, id(session, length - 2)); } catch (error) { if (!(error instanceof raw.RawOrdinalsNotReady)) throw error; }
            const warm = await load("hooks/magic-context/raw-ordinal-warmup.ts") as typeof import("../../src/hooks/magic-context/raw-ordinal-warmup");
            if (await warm.prewarmRawSessionOrdinalsForDb(oc, session) !== "warm") throw new Error("ordinal preparation failed");
        }
        return raw.readRawSessionMessageByIdFromDb(oc, session, id(session, length - 2))?.ordinal;
    });
    const ordinalWarm = process.env.COLD_INDEX_ONLY ? { skipped: true } : await measure(() => raw.readRawSessionMessageByIdFromDb(oc, session, id(session, length - 2))?.ordinal);
    oc.close();
    const ownerPath = seedPath;
    evict(ownerPath);
    const db = new Database(ownerPath);
    configureContextDatabasePragmas(db);
    installTagIdentityRevisionTrigger(db);
    isolation();
    const messages = Array.from({ length: 1000 }, (_, offset) => {
        const i = length - 1000 + offset;
        return { info: { id: id(session, i), role: "assistant", tokens: { reasoning: 0 } }, parts: [{ type: "reasoning", text: "thought ".repeat(40) }] };
    }) as unknown as Parameters<typeof budget.projectOpencodeReasoningBudgetCutoff>[2];
    const project = () => budget.projectOpencodeReasoningBudgetCutoff(db, session, messages, 10000, 0, 1);
    const prepareOwners = async () => {
        if (label === "before") return;
        const warm = await load("hooks/magic-context/tag-owner-warmup.ts") as typeof import("../../src/hooks/magic-context/tag-owner-warmup");
        if (!(await warm.prewarmTagOwners(db, session, 1))) throw new Error("tag preparation failed");
    };
    const owner = process.env.COLD_INDEX_ONLY ? { skipped: true } : await measure(async () => { await prepareOwners(); return project(); });
    const ownerWarm = process.env.COLD_INDEX_ONLY ? { skipped: true } : await measure(project);
    db.prepare("UPDATE tags SET reasoning_token_count=900 WHERE session_id=? AND tag_number=1").run(session);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory");
    evict(ownerPath);
    const rebuild = process.env.COLD_INDEX_ONLY ? { skipped: true } : await measure(async () => { await prepareOwners(); return project(); });
    db.close();
    const path = join(root, `${label}-${session}-index.db`);
    coldCopy(seedPath, path);
    const writer = new Database(path);
    configureContextDatabasePragmas(writer);
    installTagIdentityRevisionTrigger(writer);
    if (process.env.COLD_NO_MERGE === "1") writer.exec("INSERT INTO message_history_fts(message_history_fts, rank) VALUES ('automerge', 0), ('crisismerge', 64)");
    isolation();
    const endTimings: Record<string, number[]> = {};
    const execute = writer.exec.bind(writer);
    writer.exec = ((sql: string) => {
        const start = performance.now();
        try { return execute(sql); } finally { if (/BEGIN IMMEDIATE|COMMIT/.test(sql)) (endTimings[sql] ??= []).push(performance.now() - start); }
    }) as typeof writer.exec;
    const segments = () => (writer.prepare("SELECT COUNT(DISTINCT segid) AS n FROM message_history_fts_idx").get() as { n: number }).n;
    const revision = () => writer.prepare("SELECT value FROM schema_migrations_meta WHERE key=?").get(`tag_identity_revision:${session}`);
    const segmentBefore = segments();
    const revisionBefore = revision();
    const message = { id: `${session}-append`, ordinal: length + 1, role: "user", parts: [{ type: "text", text: payload }] };
    const commit = await measure(async () => {
        if (label === "before") return withSqliteBackgroundWriter(() => index.indexSingleMessage(writer, session, message));
        const worker = await load("features/magic-context/message-index-async.ts") as typeof import("../../src/features/magic-context/message-index-async");
        return worker.indexSingleMessageOffThread(writer, session, message);
    });
    const row = writer.prepare("SELECT content FROM message_history_fts WHERE rowid=(SELECT MAX(rowid) FROM message_history_fts)").get() as { content: string };
    if (row.content !== payload.trim()) throw new Error("indexed bytes differ");
    const record = { session, ordinal, ordinal_warm: ordinalWarm, owner, owner_warm: ownerWarm, rebuild, commit, main_transaction_ms: endTimings, fts_segments_before: segmentBefore, fts_segments_after: segments(), tag_revision_unchanged: JSON.stringify(revisionBefore) === JSON.stringify(revision()) };
    const warmCommits: Array<Awaited<ReturnType<typeof measure>>> = [];
    for (let step = 2; step <= 64; step++) {
        const timed = await measure(async () => {
            const next = { ...message, id: `${session}-append-${step}`, ordinal: length + step };
            if (label === "before") return withSqliteBackgroundWriter(() => index.indexSingleMessage(writer, session, next));
            const worker = await load("features/magic-context/message-index-async.ts") as typeof import("../../src/features/magic-context/message-index-async");
            return worker.indexSingleMessageOffThread(writer, session, next);
        });
        if (timed.result !== true) throw new Error("incremental index did not extend the prefix");
        warmCommits.push(timed);
    }
    Object.assign(record, { commit_warm: warmCommits[0], commit_warm_max_block_ms: Math.max(...warmCommits.map(run => run.longest_block_ms)), incremental_commits: 64, main_transaction_ms: Object.fromEntries(Object.entries(endTimings).map(([sql, values]) => [sql, { count: values.length, first_ms: values[0], max_ms: Math.max(...values) }])) });
    records.push(record);
    console.log(JSON.stringify(record));
    writer.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
}
results.sessions = records;
writeFileSync(join(root, `${label}${process.env.COLD_DEFAULT_FTS ? "-defaults" : ""}${process.env.COLD_NO_MERGE ? "-no-merge" : ""}.json`), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results));
