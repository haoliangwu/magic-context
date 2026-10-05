import { existsSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
    ensureContextStoreUuid,
    getContextStoreUuid,
} from "@magic-context/core/features/magic-context/context-store-uuid";
import {
    getPersistedSchemaVersion as getCorePersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { Database } from "@magic-context/core/shared/sqlite";
import { configureContextDatabasePragmas } from "@magic-context/core/shared/sqlite-context-pragmas";

export function getPersistedSchemaVersion(db: DatabaseType): number {
    return getCorePersistedSchemaVersion(db);
}

export class UnsupportedSchemaVersionError extends Error {
    readonly path: string;
    readonly persistedVersion: number;
    readonly supportedVersion: number;

    constructor(path: string, persistedVersion: number, supportedVersion: number) {
        super(
            `Refusing to open ${path}: database schema v${persistedVersion} is newer than this CLI supports (max v${supportedVersion}). Update Magic Context before using this database.`,
        );
        this.name = "UnsupportedSchemaVersionError";
        this.path = path;
        this.persistedVersion = persistedVersion;
        this.supportedVersion = supportedVersion;
    }
}

export class OutdatedSchemaVersionError extends Error {
    readonly path: string;
    readonly persistedVersion: number;
    readonly minimumSupportedVersion: number;

    constructor(path: string, persistedVersion: number, minimumSupportedVersion: number) {
        super(
            `Refusing to mutate ${path}: database schema v${persistedVersion} is behind this CLI's schema floor v${minimumSupportedVersion}. Run a session or doctor migrate first so the plugin can upgrade it, then retry.`,
        );
        this.name = "OutdatedSchemaVersionError";
        this.path = path;
        this.persistedVersion = persistedVersion;
        this.minimumSupportedVersion = minimumSupportedVersion;
    }
}

/**
 * A CLI write must not make a live database newer than a running plugin can
 * read. The current checkout is therefore the mutation floor; read-only
 * diagnostics may still inspect older supported schemas without changing them.
 */
export const CLI_SCHEMA_FLOOR_VERSION = LATEST_SUPPORTED_VERSION;

/**
 * Opens an existing SQLite file without silently creating an empty replacement.
 * Callers must treat null as a graceful missing-database path.
 */
export function openExistingDatabase(
    path: string,
    options: { readonly: boolean },
): DatabaseType | null {
    if (!existsSync(path)) return null;
    if (options.readonly) {
        const db = new Database(path, { readonly: true });
        return db;
    }

    // Open read-write WITHOUT SQLITE_OPEN_CREATE, so the race where the file
    // disappears between the existence check and the constructor errors instead
    // of silently creating an empty database. The two backends need different
    // spellings: bun:sqlite's Linux build rejects file:// URIs ("unable to open
    // database file") but honors { create: false }, while node:sqlite has no
    // create option and needs the URI's mode=rw.
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
        // create/readwrite are bun:sqlite-only options, absent from the shared
        // better-sqlite3-shaped Options type the wrapper exports.
        const db = new Database(path, { create: false, readwrite: true } as unknown as {
            readonly: boolean;
        });
        return db;
    }
    const uri = pathToFileURL(path);
    uri.searchParams.set("mode", "rw");
    const db = new Database(uri.href);
    return db;
}

/**
 * Applies the shared schema fence immediately after opening context.db. No query
 * or migration write may run until this check accepts the persisted version.
 */
export function openExistingContextDatabase(
    path: string,
    options: { readonly: boolean; minimumSupportedVersion?: number },
): DatabaseType | null {
    const db = openExistingDatabase(path, options);
    if (db === null) return null;

    try {
        const persistedVersion = getPersistedSchemaVersion(db);
        if (persistedVersion > LATEST_SUPPORTED_VERSION) {
            throw new UnsupportedSchemaVersionError(
                path,
                persistedVersion,
                LATEST_SUPPORTED_VERSION,
            );
        }
        const minimumSupportedVersion =
            options.minimumSupportedVersion ??
            (options.readonly ? undefined : CLI_SCHEMA_FLOOR_VERSION);
        if (minimumSupportedVersion !== undefined && persistedVersion < minimumSupportedVersion) {
            throw new OutdatedSchemaVersionError(path, persistedVersion, minimumSupportedVersion);
        }
        configureContextDatabasePragmas(db, options.readonly);
        if (!options.readonly) {
            // The CLI has no module route during database open. It can mint the
            // local store identity, but REGRESSED detection remains a later
            // module-reconciliation step when the module becomes reachable.
            const hasIdentityTable = Boolean(
                db
                    .prepare(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_store_meta'",
                    )
                    .get(),
            );
            if (hasIdentityTable && !getContextStoreUuid(db)) ensureContextStoreUuid(db);
        }
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

/**
 * Opens a live context database for a CLI mutation without running schema
 * migrations. The plugin boot path owns schema upgrades; while the plugin is
 * running, it may enforce an older maximum schema version.
 */
export function openExistingContextDatabaseForMutation(path: string): DatabaseType | null {
    return openExistingContextDatabase(path, {
        readonly: false,
        minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
    });
}

/**
 * Create a consistent SQLite snapshot of `sourcePath`, including committed WAL
 * contents, at `destination` (which must not exist yet).
 *
 * Callers may hold a write transaction on `db` so no other writer can change
 * the file between the snapshot and their own writes. Bun copies the open
 * connection's view with serialize(). node:sqlite has no serialize(), and its
 * backup API fails ("not an error") when the source connection is inside a
 * transaction, so the Node path reads through a second, read-only connection:
 * the caller's lock still keeps other writers out, and the reader sees the
 * same committed state.
 *
 * A failed snapshot removes the destination it created, so a half-written or
 * empty backup is never left behind looking like a real one.
 */
export async function backupDatabaseSnapshot(
    db: DatabaseType,
    sourcePath: string,
    destination: string,
): Promise<void> {
    const serializable = db as DatabaseType & { serialize?: () => Uint8Array };
    if (typeof serializable.serialize === "function") {
        writeFileSync(destination, serializable.serialize(), { flag: "wx" });
        return;
    }

    const moduleName = "node:" + "sqlite";
    const sqlite = (await import(moduleName)) as {
        backup?: (source: unknown, path: string) => Promise<void>;
    };
    if (typeof sqlite.backup !== "function") {
        throw new Error("The active SQLite runtime does not provide a snapshot backup API");
    }
    if (existsSync(destination)) {
        throw new Error(`Refusing to overwrite existing backup ${destination}`);
    }
    const reader = new Database(sourcePath, { readonly: true });
    try {
        await sqlite.backup(reader, destination);
    } catch (error) {
        rmSync(destination, { force: true });
        throw error;
    } finally {
        reader.close();
    }
}
