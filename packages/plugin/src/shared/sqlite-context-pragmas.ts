import type { Database } from "./sqlite";

/**
 * NORMAL avoids a WAL sync on each commit. WAL still recovers consistently after
 * a crash, but the latest committed work may be lost on power failure. Never use
 * this durability policy in a rollback journal. In-memory test stores cannot use
 * WAL and keep their existing synchronous mode.
 *
 * Call after the schema fence and busy timeout, before any context-store writes.
 * Read-only diagnostics must not switch a legacy store's journal mode.
 */
export function configureContextDatabasePragmas(db: Database, readonly = false): void {
    const [row] = db
        .prepare(readonly ? "PRAGMA journal_mode" : "PRAGMA journal_mode=WAL")
        .all() as { journal_mode?: string }[];
    const mode = row?.journal_mode?.toLowerCase();
    if (mode === "memory" || (readonly && mode !== "wal")) return;
    if (mode !== "wal") {
        throw new Error(
            `context.db requires WAL before synchronous=NORMAL (got ${mode ?? "unknown"})`,
        );
    }
    db.exec("PRAGMA synchronous=NORMAL");
}
