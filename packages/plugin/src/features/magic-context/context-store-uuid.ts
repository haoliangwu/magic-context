import { randomUUID } from "node:crypto";
import type { Database } from "../../shared/sqlite";
import { withPrivilegedWriter } from "../../shared/sqlite";

interface StoreMetaRow {
    value: string;
}

/** The identity of this context.db file, or null before one has been minted. */
export function getContextStoreUuid(db: Database): string | null {
    const row = db.prepare("SELECT value FROM context_store_meta WHERE key = 'store_uuid'").get() as
        | StoreMetaRow
        | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
}

/** Mint the store identity once. Restoring a database restores this value too,
 * which is how the module and the migration recognize which file they are on. */
export function ensureContextStoreUuid(db: Database): string {
    const existing = getContextStoreUuid(db);
    if (existing) return existing;
    const minted = randomUUID();
    withPrivilegedWriter(db, () => {
        db.transaction(() => {
            db.prepare(
                "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?) ON CONFLICT(key) DO NOTHING",
            ).run(minted);
        }).immediate();
    });
    return getContextStoreUuid(db) ?? minted;
}
