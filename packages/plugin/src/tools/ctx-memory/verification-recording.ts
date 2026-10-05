import type { Database } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction, committing on success and
 * rolling back on throw. Used by the in-session ctx_memory mutation actions so
 * a memory write + its mutation-log row commit atomically.
 */
export function runImmediateTransaction<T>(db: Database, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = performance.now();
    try {
        const result = fn();
        db.exec("COMMIT");
        logSlowWriteTransaction("ctx_memory_mutation", transactionStartedAt);
        return result;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
