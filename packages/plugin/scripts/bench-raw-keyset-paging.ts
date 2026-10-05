import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";
import { type RawMessage, type RawMessageOrdinalAnchor, readRawSessionMessagePageFromDb } from "../src/hooks/magic-context/read-session-raw";

// Compare skipping earlier filtered rows with resuming after the last row's
// timestamp and id. Both runs hydrate identical pages, but OFFSET repeats the
// scan of earlier JSON on every page while a cursor seeks the index.
const root = join(tmpdir(), "magic-context", "issue-576");
mkdirSync(root, { recursive: true });
for (const count of [20_000, 50_000]) {
    const dir = mkdtempSync(join(root, "bench-"));
    const db = new Database(join(dir, "opencode.db"));
    try {
        db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX part_message_id_idx ON part(message_id);`);
        const insert = db.prepare("INSERT INTO message VALUES (?, 's', ?, ?, ?)");
        db.transaction(() => {
            for (let i = 0; i < count; i++) insert.run(`m-${String(i).padStart(8, "0")}`, Math.floor(i / 5), i, JSON.stringify({ role: i % 2 ? "assistant" : "user", pad: "x".repeat(290), summary: i % 400 === 399, finish: "stop" }));
        })();
        const filteredCount = count - Math.floor(count / 400);
        const pass = (keyset: boolean, from = 1): { rows: string[]; ms: number } => {
            const started = performance.now();
            const rows: string[] = [];
            let after: RawMessageOrdinalAnchor | undefined;
            for (let ordinal = from - 1; ordinal < filteredCount;) {
                const page: RawMessage[] = readRawSessionMessagePageFromDb(db, "s", ordinal, 100, filteredCount, keyset ? after : undefined);
                if (!page.length) break;
                rows.push(...page.map((m) => `${m.ordinal}:${m.id}`));
                const last = page[page.length - 1];
                ordinal = last.ordinal;
                after = { timeCreated: last.createdAt ?? 0, id: last.id };
            }
            return { rows, ms: performance.now() - started };
        };
        const before = pass(false);
        const after = pass(true);
        const tailBefore = pass(false, filteredCount - 499);
        const tailAfter = pass(true, filteredCount - 499);
        if (JSON.stringify(before.rows) !== JSON.stringify(after.rows) || JSON.stringify(tailBefore.rows) !== JSON.stringify(tailAfter.rows)) throw new Error("Paging changed rows or ordinals");
        console.log(JSON.stringify({ count, filteredCount, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), fullOffsetMs: before.ms, fullKeysetMs: after.ms, tail500OffsetMs: tailBefore.ms, tail500KeysetMs: tailAfter.ms }));
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
