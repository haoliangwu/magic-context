import type { Database } from "@magic-context/core/shared/sqlite";

export const SINGLE_STORE_REQUIRED =
    "Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)";

/** Unmigrated module-owned rows may exist only in store.db, so context-only moves are unsafe. */
export function assertNoUnmigratedAuthority(db: Pick<Database, "prepare">): void {
    const hasTable = (name: string) =>
        Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const state = hasTable("single_store_state")
        ? (db.prepare("SELECT state FROM single_store_state WHERE id=1").get() as {
              state: string;
          } | null)
        : null;
    if (
        state?.state !== "migrated" &&
        hasTable("authority_managed") &&
        db.prepare("SELECT 1 FROM authority_managed LIMIT 1").get()
    ) {
        throw new Error(SINGLE_STORE_REQUIRED);
    }
}
