/// <reference types="bun-types" />

/**
 * Single-store rehearsal spot check: after migration, do the dashboard reader and the
 * plugin's ctx_expand see a session's full compartment history in context.db?
 *
 *   bun scripts/b2-drill/alf-spot-check.ts <host-root> [session-id]
 *
 * <host-root> is a throwaway copy under $TMPDIR/magic-context/ holding the migrated
 * data/cortexkit/magic-context/context.db and data/opencode/opencode.db (the subset
 * copy keeps this session's raw messages). Nothing outside the root is opened.
 *
 * The dashboard reader is checked by running its get_compartments SQL verbatim
 * (packages/dashboard/src-tauri/src/db.rs) against the copy. ctx_expand is the
 * plugin's real tool, executed in-process for that session over the oldest, a middle
 * and the newest compartment ranges.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [rootArg, sessionArg] = process.argv.slice(2);
if (!rootArg) {
    console.error("usage: alf-spot-check.ts <host-root> [session-id]");
    process.exit(2);
}
const root = realpathSync(rootArg);
if (!root.startsWith(`${realpathSync(tmpdir())}/magic-context/`)) {
    console.error(`refusing root outside $TMPDIR/magic-context: ${root}`);
    process.exit(2);
}
const sessionId = sessionArg ?? "ses_227ce5788ffeRPA9THoPLOQreO";
const dataDir = join(root, "data");
// Point every path resolver at the copy before any plugin module loads.
process.env.XDG_DATA_HOME = dataDir;
process.env.OPENCODE_DB = join(dataDir, "opencode", "opencode.db");
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(dataDir, "cortexkit", "magic-context");
process.env.HOME = root;

const { Database } = await import("bun:sqlite");
const { openDatabase } = await import(
    "../../packages/plugin/src/features/magic-context/storage-db"
);
const { createCtxExpandTools } = await import("../../packages/plugin/src/tools/ctx-expand/tools");

const contextPath = join(dataDir, "cortexkit", "magic-context", "context.db");
// Opened read-write: a WAL-mode copy without its -shm file cannot be opened read-only.
// This is the throwaway copy; the query below only reads.
const dashboard = new Database(contextPath);
const rows = dashboard
    .query(
        `SELECT c.id, c.session_id, c.sequence, c.start_message, c.end_message,
                c.start_message_id, c.end_message_id, c.title, c.content, c.created_at,
                c.importance, c.episode_type, c.p1, c.p2, c.p3, c.p4, c.legacy
         FROM compartments c
         WHERE c.session_id = ?1
         ORDER BY c.sequence DESC`,
    )
    .all(sessionId) as Array<{ sequence: number; start_message: number; end_message: number }>;
dashboard.close();
const sequences = rows.map((row) => row.sequence).sort((a, b) => a - b);
const contiguous = sequences.every((sequence, index) => sequence === index);
console.log(
    JSON.stringify({
        check: "dashboard get_compartments",
        sessionId,
        compartments: rows.length,
        maxSequence: sequences.at(-1),
        contiguousFromZero: contiguous,
    }),
);

const db = openDatabase(contextPath);
if (!db) throw new Error("could not open the copied context.db");
const expand = createCtxExpandTools({ db } as never).ctx_expand as unknown as {
    execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string>;
};
const ascending = [...rows].sort((a, b) => a.sequence - b.sequence);
const picks = [ascending[0], ascending[Math.floor(ascending.length / 2)], ascending.at(-1)];
let failures = 0;
for (const pick of picks) {
    if (!pick) continue;
    const text = await expand.execute(
        { start: pick.start_message, end: pick.end_message },
        { sessionID: sessionId, agent: "build", directory: root, messageID: "drill" },
    );
    const ok = text.startsWith("Messages ");
    if (!ok) failures += 1;
    console.log(
        JSON.stringify({
            check: "ctx_expand",
            sequence: pick.sequence,
            range: [pick.start_message, pick.end_message],
            ok,
            head: text.slice(0, 160),
            bytes: text.length,
        }),
    );
}
if (!contiguous || failures > 0) process.exit(1);
