/** Messages between the main thread and the migration worker (migration-worker.ts). */

export interface MigrationWorkerData {
    dbPath: string;
    busyTimeoutMs: number;
    sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number };
}

export type MigrationWorkerMessage =
    /** The worker loaded its modules; failures after this are migration failures. */
    | { type: "ready" }
    /** A log line already formatted by the worker, for the main thread's log file. */
    | { type: "log"; line: string }
    /** The worker started or stopped sleeping before retrying a busy write lock. */
    | { type: "lock-wait"; waiting: boolean }
    | { type: "done" }
    | { type: "failed"; message: string };
