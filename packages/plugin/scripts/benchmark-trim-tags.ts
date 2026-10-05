import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { markTagsCompactedByMessageIds } from "../src/features/magic-context/storage-tags";
import { Database, registerSqliteDiagnosticSink } from "../src/shared/sqlite";

// Only the disposable backup is allowed here; never bootstrap/migrate a store.
const root = realpathSync(join(tmpdir(), "magic-context/trim-stall"));
const path = realpathSync(process.argv[2] ?? join(root, "context.db"));
if (!path.startsWith(root + sep)) throw new Error("Expected an isolated trim-stall copy");
const db = new Database(path);
const session = "ses_12a4fa38dffe81Fz7Y2AsWb5Cg";
// Reproduce the incident's host window (old marker at ordinal 82769) and the
// cached baseline end at 86964. Whole-message ends include the boundary row;
// partial ends keep it in the served tail.
const partialEnd =
    db.prepare(`SELECT 1 FROM compartments
        WHERE session_id = ? AND end_message_id = ? AND end_block_index IS NOT NULL LIMIT 1`)
        .get(session, "msg_101b473d0001wo4jRnxS8SQR9l") != null;
const boundaryOnly = process.argv.includes("--boundary-only");
const ids = db.prepare(`SELECT message_id FROM message_history_source
    WHERE session_id = ? AND message_ordinal >= ? AND message_ordinal < ?
    ORDER BY message_ordinal`)
    .all(session, boundaryOnly ? 86964 : 82769, partialEnd ? 86964 : 86965) as {
        message_id: string;
    }[];
const legacy = process.argv.includes("--legacy");
registerSqliteDiagnosticSink(console.log);
let scanMs = 0;
let batchStarted = 0;
let maxHoldMs = 0;
let batches = 0;
const exec = db.exec.bind(db);
db.exec = (sql: string) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") {
        batchStarted = performance.now();
        batches++;
    }
    if (sql === "COMMIT") maxHoldMs = Math.max(maxHoldMs, performance.now() - batchStarted);
    return result;
};
const prepare = db.prepare.bind(db);
Object.defineProperty(db, "prepare", {
    value: (sql: string) => {
        const stmt = prepare(sql);
        if (sql.includes("SELECT id, message_id, tool_owner_message_id")) {
            const all = stmt.all.bind(stmt);
            stmt.all = (...args: unknown[]) => {
                if (process.env.TRIM_PLAN)
                    console.log(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
                const scanStart = performance.now();
                const result = all(...args);
                scanMs += performance.now() - scanStart;
                return result;
            };
        }
        return stmt;
    },
});
const start = performance.now();
let count: number;
if (legacy) {
    const update = db.prepare(`UPDATE tags SET status = 'compacted'
        WHERE session_id = ? AND status IN ('active','dropped')
        AND (message_id = ? OR message_id LIKE ? ESCAPE '\\'
            OR message_id LIKE ? ESCAPE '\\' OR tool_owner_message_id = ?) RETURNING id`);
    count = db.transaction(() => {
        let changed = 0;
        for (const { message_id: id } of ids) {
            const escaped = id.replace(/[\\%_]/g, "\\$&");
            changed += update.all(session, id, `${escaped}:p%`, `${escaped}:file%`, id).length;
        }
        return changed;
    }).immediate();
} else {
    count = markTagsCompactedByMessageIds(db, session, ids.map((row) => row.message_id));
}
console.log(JSON.stringify({
    legacy,
    trimmedIds: ids.length,
    changed: count,
    elapsedMs: performance.now() - start,
    scanMs,
    batches,
    maxHoldMs,
}));
db.close();
