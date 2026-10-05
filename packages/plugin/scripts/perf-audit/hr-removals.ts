/** Run fixtures with timeout 300; live mode: timeout 2100 bun packages/plugin/scripts/perf-audit/hr-removals.ts <scrubbed-copy> */
import { scheduleClearAndReindex, isSessionReconciled, __resetMessageIndexAsyncForTests } from "../../src/features/magic-context/message-index-async";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { setBootQuietPeriodForTests } from "../../src/plugin/boot-quiet";
import { Database } from "../../src/shared/sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countRawSessionMessageOrdinalsFromDb, type RawMessageOrdinalAnchor, readRawSessionMessagePageFromDb } from "../../src/hooks/magic-context/read-session-raw";

console.log(`Bun ${Bun.version}`);
setBootQuietPeriodForTests(0);
const root = join(tmpdir(), "magic-context", "perf-hr");
mkdirSync(root, { recursive: true });
const copy = process.argv[2];
if (copy && !realpathSync(copy).startsWith(`${realpathSync(root)}/`)) throw new Error("Use a scrubbed throwaway copy");
const raw = copy ? new Database(copy, { readonly: true }) : null;
if (raw?.prepare("SELECT name FROM sqlite_master WHERE name IN ('credential','account','account_state','control_account')").all().length)
    throw new Error("Unscrubbed copy");
const fixtures = raw ? (raw.prepare("SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id ORDER BY n DESC LIMIT 3").all() as { session_id: string; n: number }[])
    .filter((_, i) => i !== 1).map(({ session_id }) => ({ session: session_id, count: countRawSessionMessageOrdinalsFromDb(raw, session_id) }))
    : [1000, 10_000, 60_000].map((count) => ({ session: "s", count }));
for (const { count, session } of fixtures) {
    const dir = raw ? mkdtempSync(join(root, "fts-")) : null;
    const db = new Database(dir ? join(dir, "context.db") : ":memory:");
    initializeDatabase(db);
    let pages = 0;
    let clears = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (!sql.startsWith("DELETE FROM message_fts_rowid_map")) return statement;
        return new Proxy(statement, { get(target, property) {
            const value = Reflect.get(target, property);
            if (property === "run") return (...args: unknown[]) => { clears++; return Reflect.apply(value, target, args); };
            return typeof value === "function" ? value.bind(target) : value;
        } });
    }) as typeof db.prepare;
    const source = {
        getCount: () => count,
        readPage: (_session: string, cursor: number, limit: number, _watermark: number, after?: RawMessageOrdinalAnchor) => {
            pages++;
            if (raw) return readRawSessionMessagePageFromDb(raw, session, cursor, limit, count, after);
            return Array.from({ length: Math.min(limit, count - cursor) }, (_, i) => ({
                id: `m-${cursor + i + 1}`, ordinal: cursor + i + 1, role: "user", parts: [{ type: "text", text: "Indexable text." }],
            }));
        },
    };
    const start = performance.now();
    for (let i = 0; i < 8; i++) scheduleClearAndReindex(db, "s", source);
    const deadline = performance.now() + (raw ? 1_000_000 : 90_000);
    while (!isSessionReconciled("s")) {
        if (performance.now() > deadline) throw new Error("reconciliation failed to settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log(JSON.stringify({ finding: "HR-2", count, removals: 8, ms: performance.now() - start, pages, clears }));
    if (raw) {
        const files = execFileSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8", timeout: 30_000 }).split("\n").filter((line) => /\.db(?:-wal|-shm)?$/.test(line));
        if (files.some((line) => !line.startsWith(`n${realpathSync(root)}/`))) throw new Error("FTS benchmark escaped throwaway paths");
        console.log(JSON.stringify({ isolation: "lsof", pid: process.pid, files }));
    }
    __resetMessageIndexAsyncForTests();
    db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
}
raw?.close();
