/**
 * Approval gates for the proposed storage batch, before a production migration exists.
 * Run: timeout 1200 bun packages/plugin/scripts/perf-audit/migration-batch-gates.ts <copy-root>
 * The root must contain a read-only VACUUM copy named context.db; only its disposable
 * copies are written. SQL is taken from the reviewed design, not installed at startup.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Database as ContextDatabase } from "../../src/shared/sqlite";

const root = realpathSync(process.argv[2] ?? "");
assert.ok(root.startsWith(`${realpathSync(join(tmpdir(), "magic-context"))}${sep}`));
const seed = join(root, "context.db");
assert.ok(statSync(seed).isFile());
for (const [key, path] of Object.entries({
    HOME: "home",
    XDG_DATA_HOME: "data",
    XDG_CONFIG_HOME: "config",
    XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "state",
    XDG_RUNTIME_DIR: "runtime",
    MAGIC_CONTEXT_STORAGE_DIR: "context",
    MAGIC_CONTEXT_TEST_DATA_DIR: "context",
})) {
    process.env[key] = join(root, path);
    mkdirSync(process.env[key], { recursive: true });
}
process.env.OPENCODE_DB = join(root, "synthetic-opencode.db");

const { Database } = await import("../../src/shared/sqlite");
const { initializeDatabase } = await import("../../src/features/magic-context/storage-db");
const { MIGRATIONS } = await import("../../src/features/magic-context/migrations");
const { insertTag, updateTagStatus } = await import("../../src/features/magic-context/storage-tags");
const { createTagger } = await import("../../src/features/magic-context/tagger");
const design = readFileSync(
    resolve(import.meta.dir, "../../../../docs/designs/perf-audit-migration-batch.md"),
    "utf8",
);
// Later repair/review examples are not part of the original approval-gate prototype.
const sql = [...design.matchAll(/```sql\n([\s\S]*?)\n```/g)].slice(0, 11).map((match) => match[1]!);
assert.equal(sql.length, 11, "review the extractor if the design SQL block layout changes");
assert.ok(sql[0]!.includes("CREATE TABLE IF NOT EXISTS session_meta_payloads"));
assert.ok(sql[9]!.includes("CREATE TABLE IF NOT EXISTS git_commit_fts_rowid_map"));
assert.ok(sql[10]!.includes("CREATE TABLE mc_chunk_transcript_payloads"));
let checks = 1;

function open(path: string): ContextDatabase {
    assert.ok(realpathSync(path).startsWith(`${root}${sep}`));
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    return db;
}

function clone(source: string, target: string): void {
    assert.ok(source.startsWith(`${root}${sep}`) && target.startsWith(`${root}${sep}`));
    const result = spawnSync("timeout", ["60", "cp", "-c", source, target], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    checks++;
}

function fds(): string[] {
    const result = spawnSync("timeout", ["30", "lsof", "-p", String(process.pid), "-Fn"], {
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const files = result.stdout.split("\n").filter((line) => /^n.*\.db(?:-wal|-shm|-journal)?$/.test(line));
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(file.slice(1).startsWith(`${root}${sep}`), file);
    checks++;
    return files.map((file) => file.slice(1));
}

function distribution(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    return { rows: values.length, nonempty: values.filter((v) => v > 0).length,
        total: values.reduce((a, b) => a + b, 0), p50: percentile(0.5), p90: percentile(0.9),
        p99: percentile(0.99), max: percentile(1) };
}

function median(values: number[]): number {
    return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function walBytes(path: string): number {
    try { return statSync(`${path}-wal`).size; } catch { return 0; }
}

/** Start the clock after BEGIN has succeeded, stop after COMMIT. No lock-wait attribution. */
function sample(db: ContextDatabase, path: string, operation: (index: number) => void, count: number) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = walBytes(path);
    let holdMs = 0;
    const started = performance.now();
    for (let index = 0; index < count; index++) {
        let heldAt = 0;
        db.transaction(() => { heldAt = performance.now(); operation(index); }).immediate();
        holdMs += performance.now() - heldAt;
    }
    return { operations: count, walBytes: walBytes(path) - before, holdMs, wallMs: performance.now() - started };
}

function summarize(samples: ReturnType<typeof sample>[]) {
    return { operations: samples[0]!.operations, repetitions: samples.length,
        walBytes: median(samples.map((s) => s.walBytes)), holdMs: median(samples.map((s) => s.holdMs)),
        wallMs: median(samples.map((s) => s.wallMs)) };
}

const fields = ["cached_m0_bytes", "cached_m1_bytes", "cached_m0_mural_data_url", "memory_block_cache", "note_nudge_anchors"];
const hotOnly = process.argv.includes("--hot-only");
const indexOnly = process.argv.includes("--index-only");
const inventoryDb = new Database(seed, { readonly: true });
const version = (inventoryDb.prepare("SELECT MAX(version) AS v FROM schema_migrations WHERE version<10000").get() as { v: number }).v;
assert.equal(version, 94, "this gate measures residual v94, not an older migration");
checks++;
const sqlite = (inventoryDb.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
const columns = (inventoryDb.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]).map((c) => c.name);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const length = (name: string) => `COALESCE(length(CAST(${quote(name)} AS BLOB)),0)`;
// Logical field bytes include decimal representations of numeric values; record_bytes below
// separately computes the exact SQLite record header and integer serial-type widths.
const logical = columns.map(length).join("+");
const sizes = Object.fromEntries([...fields, "whole_row_logical"].map((field) => {
    const expression = field === "whole_row_logical" ? logical : length(field);
    const rows = inventoryDb.prepare(`SELECT ${expression} AS n FROM session_meta`).all() as { n: number }[];
    return [field, distribution(rows.map((row) => row.n))];
}));
const largest = inventoryDb.prepare(`SELECT session_id, ${logical} AS logical_bytes FROM session_meta ORDER BY logical_bytes DESC LIMIT 10`).all() as { session_id: string; logical_bytes: number }[];

function serialType(column: string): string {
    const q = quote(column);
    return `CASE typeof(${q}) WHEN 'null' THEN 0 WHEN 'integer' THEN CASE
        WHEN ${q}=0 THEN 8 WHEN ${q}=1 THEN 9 WHEN ${q} BETWEEN -128 AND 127 THEN 1
        WHEN ${q} BETWEEN -32768 AND 32767 THEN 2 WHEN ${q} BETWEEN -8388608 AND 8388607 THEN 3
        WHEN ${q} BETWEEN -2147483648 AND 2147483647 THEN 4
        WHEN ${q} BETWEEN -140737488355328 AND 140737488355327 THEN 5 ELSE 6 END
        WHEN 'real' THEN 7 WHEN 'text' THEN length(CAST(${q} AS BLOB))*2+13
        WHEN 'blob' THEN length(${q})*2+12 END`;
}
function varintBytes(value: number): number {
    let bytes = 1;
    while (value >= 128 && bytes < 9) { value = Math.floor(value / 128); bytes++; }
    return bytes;
}
function recordSize(types: number[]): number {
    const serialBytes = types.reduce((total, type) => total + varintBytes(type), 0);
    let header = serialBytes + 1;
    while (header !== serialBytes + varintBytes(header)) header = serialBytes + varintBytes(header);
    const fixed = [0, 1, 2, 3, 4, 6, 8, 8, 0, 0];
    return header + types.reduce((total, type) => total + (type < 10 ? fixed[type]! : Math.floor((type - 12) / 2)), 0);
}
const largestRows = largest.map((row) => {
    const types = inventoryDb.prepare(`SELECT ${columns.map((c, i) => `${serialType(c)} AS c${i}`).join(",")} FROM session_meta WHERE session_id=?`).get(row.session_id) as Record<string, number>;
    const payloads = inventoryDb.prepare(`SELECT ${fields.map((f) => `${length(f)} AS ${quote(f)}`).join(",")} FROM session_meta WHERE session_id=?`).get(row.session_id) as Record<string, number>;
    return { ...row, record_bytes: recordSize(columns.map((_, i) => types[`c${i}`]!)), fields: payloads };
});
const inventoryFds = fds();
inventoryDb.close();
console.log(JSON.stringify({ stage: "inventory", bun: Bun.version, sqlite, version, sizes, largestRows, inventoryFds }));

const scalarResults: { arm: string; session: string; mode: string; result: ReturnType<typeof summarize> }[] = [];
let splitDurationMs = 0;
for (const arm of hotOnly ? [] : ["before", "split"]) {
    const path = join(root, `scalar-${arm}.db`);
    clone(seed, path);
    const db = open(path);
    if (arm === "split") {
        const start = performance.now();
        db.transaction(() => db.exec(sql[0]!)).immediate();
        splitDurationMs = performance.now() - start;
        assert.equal((db.prepare("SELECT count(*) AS n FROM session_meta_payloads").get() as { n: number }).n,
            (db.prepare("SELECT count(*)*5 AS n FROM session_meta").get() as { n: number }).n);
        checks++;
    }
    const write = db.prepare("UPDATE session_meta SET last_nudge_band=? WHERE session_id=?");
    for (const row of largestRows.slice(0, 3)) {
        for (const mode of ["fixed", "length-changing"]) {
            const samples = [];
            for (let repetition = 0; repetition < 5; repetition++) {
                write.run("band-aaaa", row.session_id);
                samples.push(sample(db, path, (i) => write.run(i % 2 ? "band-aaaa" : mode === "fixed" ? "band-bbbb" : "band-aaaaaaaa", row.session_id), 8));
            }
            const result = summarize(samples);
            scalarResults.push({ arm, session: row.session_id, mode, result });
            console.log(JSON.stringify({ stage: "scalar", arm, session: row.session_id, mode, result }));
        }
    }
    fds(); db.close();
}

function installLedger(db: ContextDatabase): void {
    db.exec(sql[1]!);
    const identity = sql[3]!.trim();
    const binding = `(${identity} OR OLD.byte_size IS NOT NEW.byte_size OR OLD.input_byte_size IS NOT NEW.input_byte_size OR OLD.token_count IS NOT NEW.token_count OR OLD.input_token_count IS NOT NEW.input_token_count)`;
    for (const [name, event, row] of [["tags_ledger_ai", "INSERT", "NEW"], ["tags_ledger_ad", "DELETE", "OLD"]])
        db.exec(sql[2]!.replaceAll("$NAME", name!).replaceAll("$EVENT", event!).replaceAll("$ROW", row!));
    db.exec(sql[4]!.replaceAll("$I", identity).replaceAll("$B", binding));
    for (const [name, event, row] of [["pending_ledger_ai", "INSERT", "NEW"], ["pending_ledger_ad", "DELETE", "OLD"]])
        db.exec(sql[5]!.replaceAll("$NAME", name!).replaceAll("$EVENT", event!).replaceAll("$ROW", row!));
    db.exec(sql[6]!);
}

const hotResults: { n: number; arm: string; operation: string; result: ReturnType<typeof summarize> }[] = [];
for (const n of [1000, 10000, 60000]) {
    const fixture = join(root, `tags-${n}.db`);
    const seedDb = new Database(fixture);
    initializeDatabase(seedDb);
    for (const name of ["idx_message_fts_rowid_map_session_rowid", "idx_transform_decisions_retention", "idx_plugin_messages_session", "idx_user_memory_candidates_session"])
        seedDb.exec(`DROP INDEX IF EXISTS ${name}`);
    seedDb.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL,description TEXT)");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 94)) {
        migration.up(seedDb);
        seedDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,0)").run(migration.version);
    }
    for (const [name, table, columns] of [
        ["idx_tags_session_tag_number", "tags", "session_id,tag_number"],
        ["idx_compartments_session", "compartments", "session_id"],
        ["idx_pending_ops_session", "pending_ops", "session_id"],
        ["idx_source_contents_session", "source_contents", "session_id"],
        ["idx_compression_depth_session", "compression_depth", "session_id"],
        ["idx_transform_decisions_session_harness", "transform_decisions", "session_id,harness"],
        ["idx_project_key_files_project", "project_key_files", "project_path"],
    ]) seedDb.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`);
    seedDb.transaction(() => {
        for (let i = 1; i <= n; i++) insertTag(seedDb, "fixture", `m${i}`, "message", 256, i);
    }).immediate();
    seedDb.close();
    for (const arm of ["before", indexOnly ? "indexes-only" : "ledger-minus-indexes"]) {
        const path = join(root, `tags-${n}-${arm}.db`);
        clone(fixture, path);
        const db = open(path);
        if (arm !== "before") {
            if (!indexOnly) installLedger(db);
            db.exec(sql[7]!); db.exec(sql[8]!); db.exec(sql[9]!);
        }
        const tagger = createTagger(); tagger.initFromDb("fixture", db);
        const mintSamples = [];
        for (let repetition = 0; repetition < 5; repetition++) {
            mintSamples.push(sample(db, path, (i) => tagger.assignTag("fixture", `new-${repetition}-${i}`, "message", 256, db), 32));
        }
        const statusSamples = [];
        for (let repetition = 0; repetition < 5; repetition++) {
            for (let i = 1; i <= 32; i++) updateTagStatus(db, "fixture", i, "active");
            statusSamples.push(sample(db, path, (i) => updateTagStatus(db, "fixture", i + 1, "dropped"), 32));
        }
        for (const [operation, samples] of [["mint", mintSamples], ["status", statusSamples]] as const) {
            const result = summarize(samples);
            hotResults.push({ n, arm, operation, result });
            console.log(JSON.stringify({ stage: "hot", n, arm, operation, result }));
        }
        fds(); db.close();
    }
}
const report = { bun: Bun.version, sqlite, version, sizes, largestRows, scalarResults, splitDurationMs, hotResults, checks };
writeFileSync(join(root, "gates.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`PASS ${checks} fixture/isolation checks; ${scalarResults.length} scalar and ${hotResults.length} hot-path records; report ${join(root, "gates.json")}`);
