import { getErrorMessage } from "../../../shared/error-message";
import { harnessOwnsOpenCodeStore } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import {
    assertOpenCodeStoreGeneration,
    claimOpenCodeDbDiagnosticOnce,
    clearOpenCodeDbReadFailure,
    openCodeDbPathExists,
    recordOpenCodeDbReadFailure,
    resolveOpenCodeDbPath,
} from "../../../shared/opencode-db-path";
import { Database } from "../../../shared/sqlite";

/**
 * Open OpenCode's DB read-only (used by dreamer tasks that scan raw OpenCode
 * history, e.g. the retrospective scanner and the orphaned-child sweep).
 * Returns null when absent or unopenable — callers degrade gracefully.
 * Absence is normal on Pi-only installs, so it is not logged as an error.
 * A Pi or OMP process never opens OpenCode's store, even when one exists on
 * the machine: its sessions belong to OpenCode, not to the Pi project.
 */
export function openOpenCodeDb(): Database | null {
    if (!harnessOwnsOpenCodeStore()) return null;
    const resolution = resolveOpenCodeDbPath();
    const dbPath = resolution.path;
    if (!openCodeDbPathExists(resolution)) {
        if (claimOpenCodeDbDiagnosticOnce("dreamer-missing", resolution)) {
            log(
                `[dreamer] OpenCode DB not found at ${dbPath} (source=${resolution.source}) — skipping OpenCode history scan`,
            );
        }
        return null;
    }
    try {
        const db = new Database(dbPath, { readonly: true });
        try {
            assertOpenCodeStoreGeneration(db, "v1", dbPath);
        } catch (error) {
            db.close();
            throw error;
        }
        db.exec("PRAGMA busy_timeout = 5000");
        clearOpenCodeDbReadFailure();
        return db;
    } catch (error) {
        recordOpenCodeDbReadFailure(resolution, error);
        if (claimOpenCodeDbDiagnosticOnce("dreamer-open-failure", resolution)) {
            log(
                `[dreamer] failed to open OpenCode DB at ${dbPath} (source=${resolution.source}): ${getErrorMessage(error)}`,
            );
        }
        return null;
    }
}
