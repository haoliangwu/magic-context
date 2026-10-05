/** Run with: timeout 180 bun packages/plugin/scripts/perf-audit/hr-ranges.ts <scrubbed-copy> */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countRawSessionMessageOrdinalsFromDb, readRawSessionMessageIdOrdinalsFromDb, readRawSessionMessageIdOrdinalsForRangeFromDb, readRawSessionMessagePageFromDb } from "../../src/hooks/magic-context/read-session-raw";
import { Database } from "../../src/shared/sqlite";

const root = realpathSync(join(tmpdir(), "magic-context", "perf-hr"));
const path = realpathSync(resolve(process.argv[2] ?? ""));
if (!path.startsWith(`${root}/`)) throw new Error("Use a scrubbed copy under the throwaway audit root");
console.log(`Bun ${Bun.version}`);
const db = new Database(path, { readonly: true });
try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name IN ('credential','account','account_state','control_account')").all().length)
        throw new Error("Unscrubbed copy");
    const sessions = db.prepare("SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id ORDER BY n DESC LIMIT 3").all() as { session_id: string; n: number }[];
    for (const { session_id: session, n } of sessions.filter((_, i) => i !== 1)) {
        const count = countRawSessionMessageOrdinalsFromDb(db, session);
        const old = () => new Map([...readRawSessionMessageIdOrdinalsFromDb(db, session)].filter(([, ordinal]) => ordinal >= count - 1));
        const current = () => readRawSessionMessageIdOrdinalsForRangeFromDb(db, session, count - 1, count);
        const times = (fn: () => Map<string, number>) => {
            const values: number[] = [];
            for (let i = 0; i < 5; i++) { const start = performance.now(); fn(); values.push(performance.now() - start); }
            return values.sort((a, b) => a - b)[2];
        };
        if (JSON.stringify([...old()]) !== JSON.stringify([...current()])) throw new Error("Range bytes changed");
        console.log(JSON.stringify({ finding: "HR-4 paired", stored: n, beforeMedianMs: times(old), afterMedianMs: times(current), hydratedBefore: count, hydratedAfter: 2 }));
        const prepare = db.prepare.bind(db);
        const seen = new Set<string>();
        db.prepare = ((sql: string) => {
            const stmt = prepare(sql);
            if (!sql.includes("FROM message") || !sql.includes("LIMIT ?")) return stmt;
            return new Proxy(stmt, { get(target, property) {
                const value = Reflect.get(target, property);
                if (property === "all") return (...args: unknown[]) => {
                    const kind = sql.includes("OFFSET") ? "offset" : "keyset";
                    if (!seen.has(kind)) {
                        seen.add(kind);
                        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`);
                        console.log(JSON.stringify({ finding: "HR-1 plan", kind, plan: Reflect.apply(plan.all, plan, args) }));
                    }
                    return Reflect.apply(value, target, args);
                };
                return typeof value === "function" ? value.bind(target) : value;
            } });
        }) as typeof db.prepare;
        const prior = readRawSessionMessagePageFromDb(db, session, count - 102, 1, count).at(-1)!;
        readRawSessionMessagePageFromDb(db, session, count - 101, 100, count, { timeCreated: prior.createdAt ?? 0, id: prior.id });
        db.prepare = prepare;
    }
} finally { db.close(); }
