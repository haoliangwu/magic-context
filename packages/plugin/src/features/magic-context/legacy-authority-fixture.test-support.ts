import { type Database, withPrivilegedWriter } from "../../shared/sqlite";
import { ensureContextStoreUuid } from "./context-store-uuid";

export { ensureContextStoreUuid } from "./context-store-uuid";

/** Seed the historical guard marker in tests of pre-migration files. */
export function installAuthorityManagedMarker(
    db: Database,
    projectPath: string,
    contextStoreUuid = ensureContextStoreUuid(db),
): void {
    withPrivilegedWriter(db, () => {
        db.prepare(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET context_store_uuid = excluded.context_store_uuid, marked_at = excluded.marked_at",
        ).run(projectPath, contextStoreUuid, Date.now());
    });
}

export function getAuthorityManagedMarker(db: Database, projectPath: string): unknown {
    return (
        db.prepare("SELECT * FROM authority_managed WHERE project_path = ?").get(projectPath) ??
        null
    );
}
