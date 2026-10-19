/**
 * Cost of the tag identity-revision trigger on a large backfill: one UPDATE of
 * `reasoning_token_count` over 10,000 tags of a session, on a connection with
 * the trigger (every Magic Context connection) and on one without it.
 *
 *   REVISION_ROOT=<throwaway dir> bun scripts/perf-audit/tag-revision-trigger-cost.ts
 *
 * The store is created under REVISION_ROOT; nothing outside it is opened.
 */
import { Database as RawDatabase } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { installTagIdentityRevisionTrigger } from "../../src/features/magic-context/storage-tag-identity-revision";
import { Database } from "../../src/shared/sqlite";

const rootValue = process.env.REVISION_ROOT;
if (!rootValue) throw new Error("REVISION_ROOT (a throwaway directory) is required");
const root = resolve(rootValue);
for (const forbidden of ["/.local/share/opencode", "/cortexkit/magic-context", "/.config/"]) {
    if (`${root}/`.includes(forbidden)) throw new Error(`refusing a root inside ${forbidden}`);
}
mkdirSync(root, { recursive: true });
const path = join(root, "context.db");
rmSync(path, { force: true });
const ROWS = Number(process.env.REVISION_ROWS ?? 10_000);
const RUNS = 7;
const SESSION = "ses_revision_cost";

const setup = new Database(path);
initializeDatabase(setup);
setup.exec("PRAGMA journal_mode = WAL");
const insert = setup.prepare(
    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, reasoning_token_count) VALUES (?, ?, 'message', 10, ?, 'opencode', 1)",
);
setup.transaction(() => {
    for (let tag = 1; tag <= ROWS; tag += 1) insert.run(SESSION, `m-${tag}`, tag);
})();
setup.close();

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(withTrigger: boolean): { median_ms: number; runs_ms: number[] } {
    const db = new RawDatabase(path);
    db.exec("PRAGMA busy_timeout = 5000");
    if (withTrigger) installTagIdentityRevisionTrigger(db as unknown as Database);
    const update = db.prepare(
        "UPDATE tags SET reasoning_token_count = reasoning_token_count + 1 WHERE session_id = ?",
    );
    const runs: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        // SQLite's change count includes the trigger's own writes, one per row.
        const changes = Number(update.run(SESSION).changes);
        runs.push(Math.round((performance.now() - started) * 100) / 100);
        if (changes !== (withTrigger ? 2 * ROWS : ROWS))
            throw new Error(`changed ${changes} rows, expected ${ROWS} tags`);
    }
    db.close();
    return { median_ms: median(runs), runs_ms: runs };
}

const without = measure(false);
const withTrigger = measure(true);
const check = new RawDatabase(path, { readonly: true });
const revision = check
    .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
    .get(`tag_identity_revision:${SESSION}`) as { value: string } | null;
check.close();
const result = {
    rows: ROWS,
    runs: RUNS,
    without_trigger: without,
    with_trigger: withTrigger,
    extra_per_row_us:
        Math.round(((withTrigger.median_ms - without.median_ms) / ROWS) * 1000 * 100) / 100,
    revision_after: revision?.value ?? null,
};
for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
console.log(JSON.stringify(result, null, 2));
