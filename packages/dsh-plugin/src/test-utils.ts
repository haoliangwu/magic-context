/**
 * DSH adapter test utilities (mirrors pi-plugin test-utils).
 *
 * The shared DB must be opened AFTER the harness identity is locked: tests
 * call `setDshHarness()` exactly like the Pi suite calls `setHarness("pi")`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database } from "@magic-context/core/shared/sqlite";
import { setDshHarness } from "./shared/dsh-harness";

export type { Database };

/** Create a temp storage directory for an isolated DSH test home. */
export function createTestStorageDir(): string {
  return mkdtempSync(join(tmpdir(), "dsh-magic-test-"));
}

/** Open a fresh, migrated test DB (harness locked to dsh first). */
export async function createTestDb(dbPath: string): Promise<Database> {
  setDshHarness();
  const db = await openDatabaseAsync({ dbPath });
  if (db === null) throw new Error("createTestDb: openDatabaseAsync refused");
  initializeDatabase(db);
  return db;
}

/** Isolated env: temp dir + migrated DB + cleanup (Windows WAL retry). */
export interface TestEnv {
  dir: string;
  db: Database;
  cleanup: () => Promise<void>;
}

async function cleanupDirWithDb(dir: string, db?: Database): Promise<void> {
  try {
    db?.close();
  } catch {
    // already closed
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function createTestEnv(prefix = "dsh-magic-test-"): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = await createTestDb(join(dir, "context.db"));
  return {
    dir,
    db,
    cleanup: () => cleanupDirWithDb(dir, db),
  };
}

/** Run fn with an isolated env; always cleans up (mkdtemp + createTestDb + rmSync). */
export async function withTestDb<T>(
  fn: (env: TestEnv) => Promise<T>,
  prefix = "dsh-magic-test-",
): Promise<T> {
  const env = await createTestEnv(prefix);
  try {
    return await fn(env);
  } finally {
    await env.cleanup();
  }
}
