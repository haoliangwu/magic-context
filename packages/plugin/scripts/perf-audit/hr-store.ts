/** Run with: timeout 120 bun packages/plugin/scripts/perf-audit/hr-store.ts */
import { appendCompartments, getCompartments } from "../../src/features/magic-context/compartment-storage";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { getActiveTagsBySession, getTagsBySession } from "../../src/features/magic-context/storage-tags";
import { Database } from "../../src/shared/sqlite";

console.log(`Bun ${Bun.version}`);
for (const messages of [1000, 10_000, 60_000]) {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        const count = messages / 100;
        appendCompartments(db, "s", Array.from({ length: count }, (_, i) => ({
            sequence: i + 1, startMessage: i * 100 + 1, endMessage: (i + 1) * 100,
            startMessageId: `m-${i * 100 + 1}`, endMessageId: `m-${(i + 1) * 100}`,
            title: "A compartment", content: "Historian narrative. ".repeat(150),
        })));
        db.transaction(() => {
            const insert = db.prepare("INSERT INTO tags(session_id, message_id, type, status, tag_number, byte_size) VALUES ('s', ?, 'message', ?, ?, 100)");
            for (let i = 1; i <= messages; i++) insert.run(`m-${i}`, i > messages - 100 ? "active" : "dropped", i);
        })();
        const time = (name: string, fn: () => unknown) => {
            fn();
            const runs: number[] = [];
            for (let i = 0; i < 5; i++) { const start = performance.now(); fn(); runs.push(performance.now() - start); }
            console.log(JSON.stringify({ name, messages, compartments: count, medianMs: runs.sort((a, b) => a - b)[2] }));
        };
        time("HR-9 compartments slice IDs", () => getCompartments(db, "s").slice(-3).map((c) => c.id));
        time("HR-9 all tags then active", () => getTagsBySession(db, "s").filter((t) => t.status === "active"));
        time("HR-9/13 active tags", () => getActiveTagsBySession(db, "s"));
        console.log(JSON.stringify({ name: "HR-9/13 active query plan", plan: db.prepare("EXPLAIN QUERY PLAN SELECT id FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number, id").all("s") }));
    } finally { db.close(); }
}
