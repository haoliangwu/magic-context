/**
 * Cross-runtime helpers that smooth over the small bun:sqlite ↔ node:sqlite
 * API differences without leaking either backend into call sites.
 */

import type { Database } from "./sqlite";

/**
 * Close a database, ignoring errors.
 *
 * bun:sqlite supports `db.close(throwOnError = false)`. node:sqlite has only
 * `db.close()` and throws ("database is not open") on an already-closed
 * handle. This helper mirrors the bun "swallow errors" semantics for both
 * runtimes — useful in test teardown and `finally` blocks where the caller
 * doesn't care whether the close succeeded.
 */
export function closeQuietly(db: Database | null | undefined): void {
    if (!db) return;
    // Just attempt close and swallow errors. bun:sqlite has no `open` property,
    // and node:sqlite throws on an already-closed handle — both are handled by
    // the bare try/catch.
    try {
        db.close();
    } catch {
        // intentional: caller wants quiet close
    }
}

/**
 * True only when the connection reports that no transaction is open. Caches
 * keyed on SQLite's change counters must not keep a value read inside a
 * transaction: a rollback restores the rows without moving total_changes(),
 * data_version or schema_version, so the stale entry would look current.
 * Unknown state (a proxy that cannot read the native getter) counts as "in a
 * transaction" so callers fall back to a fresh read.
 */
export function isKnownAutocommit(db: Database): boolean {
    const state = db as unknown as { inTransaction?: boolean; isTransaction?: boolean };
    try {
        return state.inTransaction === false || state.isTransaction === false;
    } catch {
        return false;
    }
}
