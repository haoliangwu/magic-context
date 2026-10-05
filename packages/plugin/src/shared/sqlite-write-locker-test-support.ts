/**
 * Holds a SQLite write lock from a separate process, for lock-contention tests.
 *
 * Run directly as `bun sqlite-write-locker-test-support.ts <db> <holdMs>`, the file
 * opens the database, takes the write lock with BEGIN IMMEDIATE, prints `LOCKED`,
 * holds the lock for `holdMs`, commits and prints `RELEASED`. Tests start it
 * through `startSqliteWriteLocker`.
 *
 * The lock has to come from a different process. A second connection in the
 * test's own process cannot release its lock while the test's main thread is
 * blocked inside SQLite's busy wait, so the wait would always time out and a test
 * could never observe a writer that waits and then succeeds.
 */
import { Database } from "bun:sqlite";

export interface SqliteWriteLocker {
    /** Resolves with the locker's exit code after it has committed and exited. */
    exited: Promise<number>;
}

/** Start the locker and resolve once it reports that it holds the write lock. */
export async function startSqliteWriteLocker(
    dbPath: string,
    holdMs: number,
): Promise<SqliteWriteLocker> {
    const child = Bun.spawn(["bun", import.meta.path, dbPath, String(holdMs)], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("LOCKED\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
            const stderr = await new Response(child.stderr).text();
            throw new Error(`sqlite write locker exited before locking: ${stderr}`);
        }
        seen += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    return { exited: child.exited };
}

function main(): void {
    const [dbPath, holdArg] = process.argv.slice(2);
    const holdMs = Number(holdArg);
    if (!dbPath || !Number.isFinite(holdMs) || holdMs < 0) {
        process.stderr.write("usage: sqlite-write-locker-test-support.ts <db> <holdMs>\n");
        process.exit(2);
    }
    const db = new Database(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("LOCKED\n");
    Bun.sleepSync(holdMs);
    db.exec("COMMIT");
    db.close();
    process.stdout.write("RELEASED\n");
}

if (import.meta.main) main();
