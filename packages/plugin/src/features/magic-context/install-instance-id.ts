// The shared chokepoint type, not `bun:sqlite`: the same plugin artifact runs on
// Bun and on Node/Electron, and this row is read on both.
import type { Database } from "../../shared/sqlite";

const INSTALL_INSTANCE_ID_KEY = "install_instance_id";

interface MetaValueRow {
    value: string;
}

function readRaw(db: Database): string | null {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(INSTALL_INSTANCE_ID_KEY) as MetaValueRow | undefined;
    const value = row?.value?.trim();
    return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Read the id without minting one, returning null on an install that has never
 * claimed anything. Separate from {@link ensureInstallInstanceId} so diagnostics
 * can look without creating state as a side effect of being looked at.
 */
export function readInstallInstanceId(db: Database): string | null {
    return readRaw(db);
}

/**
 * The identity one installation of this host presents when it claims a historian
 * run, minting and persisting it on first use.
 *
 * It is persisted in `context.db`, so it names the INSTALLATION, not the process:
 * every host process that opens the same `context.db` (two OpenCode windows on one
 * machine, say) presents the same id, and the same install keeps presenting it
 * after a restart. That is acceptable because nothing in the claim lane keys
 * admission on this id. A claim is won by the compare-and-swap on the queued run's
 * row, and a report is authorised only by the attempt-scoped token the module
 * mints for that claim, so two processes presenting one id still cannot both hold
 * a claim or report under each other's attempt. The id records which installation
 * took a piece of work, for diagnosis; telling two processes of one install apart
 * is the token's job, not this id's.
 *
 * Minted once and never rotated. It is not a credential, so an id that leaks
 * grants nothing.
 *
 * Safe against two processes reaching it at once: the insert ignores a row that
 * is already there and the value is re-read afterwards, so both callers return
 * the id that actually landed rather than the one they generated.
 */
export function ensureInstallInstanceId(db: Database): string {
    const existing = readRaw(db);
    if (existing !== null) return existing;

    const minted = crypto.randomUUID();
    db.prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        INSTALL_INSTANCE_ID_KEY,
        minted,
    );
    // Re-read rather than returning `minted`: another process may have won the
    // insert, and the id this install presents has to be the persisted one.
    return readRaw(db) ?? minted;
}

export { INSTALL_INSTANCE_ID_KEY };
