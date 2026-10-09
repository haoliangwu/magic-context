import { existsSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    GIT_COMMIT_FTS_ROWID_MAP_DDL,
    GIT_FTS_MAP_DISAGREEMENT_SQL,
    GIT_FTS_MAP_REPAIR_COMMAND,
} from "@magic-context/core/features/magic-context/migration-v95-perf-indexes";
import { LATEST_SUPPORTED_VERSION } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
    ensureStorageDirectorySync,
    writeStorageFileSync,
} from "@magic-context/core/shared/storage-permissions";
import {
    getPersistedSchemaVersion,
    openExistingContextDatabase,
    openExistingDatabase,
} from "../lib/database-access";
import { defaultInspectHolders } from "./doctor-repair-db";

export interface GitFtsMapInventory {
    indexed: boolean;
    mapPresent: boolean;
    missing: number;
    mismatched: number;
    extra: number;
}

/** Explicit offline diagnostic, never part of an ordinary database open. */
export function inspectGitFtsMap(db: Database): GitFtsMapInventory {
    const has = (name: string) =>
        Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name));
    const indexed = has("git_commits_fts");
    const mapPresent = has("git_commit_fts_rowid_map");
    if (!indexed) return { indexed, mapPresent, missing: 0, mismatched: 0, extra: 0 };
    if (!mapPresent)
        return {
            indexed,
            mapPresent,
            missing: (
                db.prepare("SELECT count(*) AS n FROM git_commits_fts").get() as { n: number }
            ).n,
            mismatched: 0,
            extra: 0,
        };
    const row = db
        .prepare(`SELECT
        (SELECT count(*) FROM git_commits_fts f LEFT JOIN git_commit_fts_rowid_map m ON m.fts_rowid=f.rowid WHERE m.fts_rowid IS NULL) AS missing,
        (SELECT count(*) FROM git_commits_fts f JOIN git_commit_fts_rowid_map m ON m.fts_rowid=f.rowid WHERE m.sha IS NOT f.sha OR typeof(m.sha) IS NOT typeof(f.sha)) AS mismatched,
        (SELECT count(*) FROM git_commit_fts_rowid_map m WHERE NOT EXISTS (SELECT 1 FROM git_commits_fts f WHERE f.rowid=m.fts_rowid)) AS extra`)
        .get() as { missing: number; mismatched: number; extra: number };
    return { indexed, mapPresent, ...row };
}

interface Options {
    repair?: boolean;
    backupRoot?: string;
}
interface Dependencies {
    storageDir: string;
    inspectHolders: typeof defaultInspectHolders;
    print: (line: string) => void;
    /** Testable verification boundary; production always runs both anti-joins. */
    verify: (db: Database) => void;
}

function verifyInventory(db: Database): void {
    if (db.prepare(GIT_FTS_MAP_DISAGREEMENT_SQL).get())
        throw new Error("git FTS map verification failed; repair rolled back");
}

function snapshot(source: string, destination: string): void {
    const reader = openExistingDatabase(source, { readonly: true });
    if (!reader) throw new Error(`Backup source disappeared: ${source}`);
    try {
        reader.prepare("VACUUM INTO ?").run(destination);
    } finally {
        reader.close();
    }
    const backup = openExistingDatabase(destination, { readonly: true });
    if (!backup) throw new Error(`Backup disappeared: ${destination}`);
    try {
        const rows = backup.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
        if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
            throw new Error(`Backup quick_check failed: ${destination}`);
    } finally {
        backup.close();
    }
}

/** No migration, rendered-cache invalidation or FTS rebuild occurs in this repair. */
export function runDoctorGitFtsMap(
    options: Options = {},
    overrides: Partial<Dependencies> = {},
): number {
    const deps: Dependencies = {
        storageDir: getMagicContextStorageDir(),
        inspectHolders: defaultInspectHolders,
        print: console.log,
        verify: verifyInventory,
        ...overrides,
    };
    const context = join(deps.storageDir, "context.db");
    const store = join(deps.storageDir, "store.db");
    let db: Database | null = null,
        storeDb: Database | null = null;
    let contextLocked = false,
        storeLocked = false;
    try {
        if (!options.repair) {
            db = openExistingContextDatabase(context, { readonly: true });
            if (!db) {
                deps.print("No context.db found; no files changed.");
                return 0;
            }
            const diagnosticDb = db;
            const inventory = db.transaction(() => inspectGitFtsMap(diagnosticDb)).deferred();
            deps.print(`git FTS map: ${JSON.stringify(inventory)}`);
            if (!inventory.indexed) {
                deps.print("Git FTS is not initialized; no inventory to check.");
                return 0;
            }
            const damaged =
                !inventory.mapPresent ||
                inventory.missing + inventory.mismatched + inventory.extra > 0;
            if (damaged)
                deps.print(
                    `Stop every host, then run \`${GIT_FTS_MAP_REPAIR_COMMAND}\`. The repair backs up context.db and store.db first.`,
                );
            return damaged ? 1 : 0;
        }
        if (!existsSync(context) || !existsSync(store))
            throw new Error(
                "Both context.db and store.db must exist before paired-backup repair; no replacement store will be created",
            );
        const cstat = statSync(context),
            sstat = statSync(store);
        if (cstat.dev === sstat.dev && cstat.ino === sstat.ino)
            throw new Error("context.db and store.db must be distinct files");
        const holders = deps.inspectHolders(deps.storageDir);
        if (!holders.safe)
            throw new Error(
                `Stop OpenCode, Pi/OMP, dashboard and ck-mc before repair: ${[...holders.blockers, holders.uncertainty].filter(Boolean).join("; ")}`,
            );
        // Do not use the general mutation opener: it can mint the store UUID before
        // backup, and its floor would reject a lost-v95-ledger store at 94.
        db = openExistingDatabase(context, { readonly: false });
        storeDb = openExistingDatabase(store, { readonly: false });
        if (!db || !storeDb) throw new Error("A database disappeared before repair");
        const version = getPersistedSchemaVersion(db);
        if (version < 94 || version > LATEST_SUPPORTED_VERSION)
            throw new Error(
                `Refusing map repair at context schema ${version}; expected 94..${LATEST_SUPPORTED_VERSION}`,
            );
        const inventory = inspectGitFtsMap(db);
        if (!inventory.indexed)
            throw new Error("git_commits_fts is absent; map-only repair cannot recover its corpus");
        const shape = db
            .prepare("SELECT sql FROM sqlite_master WHERE name='git_commit_fts_rowid_map'")
            .get() as { sql: string } | null;
        if (shape && shape.sql !== GIT_COMMIT_FTS_ROWID_MAP_DDL)
            throw new Error(
                "Unexpected map schema; update the plugin/CLI before repairing, without converting or retokenizing FTS",
            );
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("BEGIN IMMEDIATE");
        contextLocked = true;
        storeDb.exec("PRAGMA busy_timeout=5000");
        storeDb.exec("BEGIN IMMEDIATE");
        storeLocked = true;
        // Lock both files before snapshots so a new writer cannot split the backup
        // consistency unit. Separate read-only connections see committed data.
        const stillFree = deps.inspectHolders(deps.storageDir);
        if (!stillFree.safe)
            throw new Error(
                `A host appeared before backup: ${[...stillFree.blockers, stillFree.uncertainty].filter(Boolean).join("; ")}`,
            );
        const backupRoot = resolve(options.backupRoot ?? join(deps.storageDir, "backups"));
        ensureStorageDirectorySync(backupRoot, true);
        const backup = mkdtempSync(join(backupRoot, "git-fts-map-"));
        snapshot(context, join(backup, "context.db"));
        snapshot(store, join(backup, "store.db"));
        writeStorageFileSync(
            join(backup, "manifest.json"),
            JSON.stringify(
                {
                    contextVersion: version,
                    createdAt: new Date().toISOString(),
                    repair: "git-fts-map",
                    restore: "Restore both stores from this directory or neither",
                },
                null,
                2,
            ),
            { forcePrivate: true },
        );
        deps.print(`Paired backup verified: ${backup}. Restore both stores or neither.`);
        if (!shape) {
            db.exec(GIT_COMMIT_FTS_ROWID_MAP_DDL);
            db.exec(
                "CREATE INDEX idx_git_commit_fts_rowid_map_sha ON git_commit_fts_rowid_map(sha)",
            );
        }
        db.exec(
            "DELETE FROM git_commit_fts_rowid_map; INSERT INTO git_commit_fts_rowid_map(fts_rowid,sha) SELECT rowid,sha FROM git_commits_fts",
        );
        deps.verify(db);
        db.exec("COMMIT");
        contextLocked = false;
        storeDb.exec("ROLLBACK");
        storeLocked = false;
        deps.print(
            "Repaired only the git FTS rowid map; both anti-joins are empty. FTS content/rowids and the schema ledger are unchanged. Restart updated hosts; a missing v95 ledger row will replay normally.",
        );
        return 0;
    } catch (error) {
        deps.print(
            `git-fts-map refused/failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 2;
    } finally {
        if (contextLocked) {
            try {
                db?.exec("ROLLBACK");
            } catch {}
        }
        if (storeLocked) {
            try {
                storeDb?.exec("ROLLBACK");
            } catch {}
        }
        db?.close();
        storeDb?.close();
    }
}

export function runDoctorGitFtsMapCli(args: string[]): number {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(
            "Usage: magic-context doctor git-fts-map [--repair] [--backup-root <dir>]\nRead-only inventory diagnosis by default. --repair requires all hosts stopped and backs up both stores before rewriting only the map. Never rebuilds FTS or advances a schema ledger.",
        );
        return 0;
    }
    const options: Options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--repair") options.repair = true;
        else if (args[i] === "--backup-root" && args[i + 1] && !args[i + 1]?.startsWith("--"))
            options.backupRoot = args[++i];
        else {
            console.error(`Unknown/incomplete git-fts-map option: ${args[i]}`);
            return 2;
        }
    }
    return runDoctorGitFtsMap(options);
}
