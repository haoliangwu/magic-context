import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    closeDatabase,
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
    resolveDatabasePath,
} from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { probeHostProcessesUsing } from "./doctor-opencode2-cache";
import { defaultInspectHolders } from "./doctor-repair-db";
import { parseRepairHistoryArgs, runDoctorSingleStoreRepair } from "./doctor-single-store-repair";

const STOP = "quit OpenCode, Pi and ck-mc (`ck stop magic-context`) and run again";
const SUFFIXES = ["", "-wal", "-shm"];

export interface SingleStoreOptions {
    ckMc?: string;
    backupRoot?: string;
    dryRun?: boolean;
    skipForeign?: boolean;
    prefer?: string[];
    /**
     * `<session>=store|context`: which file's compartments to keep for a session whose
     * history in store.db and context.db diverged and the migration would not choose.
     */
    preferHistory?: string[];
    acceptIdChange?: boolean;
}

interface Dependencies {
    now: () => Date;
    inspectHolders: typeof defaultInspectHolders;
    lsofSpawn: NonNullable<Parameters<typeof probeHostProcessesUsing>[1]>;
    freeBytes: (path: string) => number;
    print: (line: string) => void;
}

// Keep this resolution aligned with the engine's resolve_context_db_path. The
// engine independently checks the explicit path too, before moving any rows.
function engineContextPath(): string {
    const value = (key: string) => process.env[key]?.trim() || undefined;
    const test = value("MAGIC_CONTEXT_TEST_DATA_DIR");
    const xdg = value("XDG_DATA_HOME");
    const dir = test
        ? join(xdg && xdg !== test ? xdg : test, "cortexkit", "magic-context")
        : (value("MAGIC_CONTEXT_STORAGE_DIR") ??
          join(xdg ?? join(value("HOME") ?? ".", ".local", "share"), "cortexkit", "magic-context"));
    return join(dir, "context.db");
}

function existingAncestor(path: string): string {
    let current = resolve(path);
    while (!existsSync(current)) current = dirname(current);
    return current;
}

function undo(backup: string, data: string, print: (line: string) => void): void {
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    print(`Backup: ${backup}`);
    print("To undo: quit every host, then");
    print(
        `  rm -f ${["context.db-wal", "context.db-shm", "store.db-wal", "store.db-shm"].map((name) => quote(join(data, name))).join(" ")}`,
    );
    print(
        `  cp ${quote(join(backup, "context.db"))} ${quote(join(backup, "store.db"))} ${quote(data + "/")}`,
    );
    print(
        "This restores the unmigrated stores. Keep the current plugin and ck-mc: TypeScript mode works as before, and Rust mode will refuse with MC-C14 until you run this command again.",
    );
}

type MigrationState = {
    state: string;
    migrated_at: number | null;
    migrated_by: string | null;
    backup_dir: string | null;
};

type Counts = {
    source: number;
    copied: number;
    updated: number;
    kept: number;
    deleted: number;
    orphans_kept: number;
    superseded?: number;
};
interface Report {
    status: "migrated" | "already_migrated" | "dry_run" | "refused";
    backup_dir: string | null;
    projects: {
        project: string;
        winner: string;
        skipped: boolean;
        tables: Record<string, Counts>;
    }[];
    render_check: { sampled: number; passed: boolean | number; seed: number | string };
    history?: {
        session: string;
        project: string;
        kept: string;
        reason: string;
        store_compartments: number;
        context_compartments: number;
    }[];
    sessions_reset: number;
    normalized_context_compartments?: number;
    transaction_ms?: number | null;
    vacuum_ms?: number | null;
    store_db_bytes: { before: number; after: number };
    refusal?: { code: string; message: string };
}

export function runDoctorSingleStore(
    options: SingleStoreOptions = {},
    overrides: Partial<Dependencies> = {},
): number {
    const deps: Dependencies = {
        now: () => new Date(),
        inspectHolders: defaultInspectHolders,
        lsofSpawn: spawnSync,
        freeBytes: (path) => {
            const fs = statfsSync(path);
            return fs.bavail * fs.bsize;
        },
        print: console.log,
        ...overrides,
    };
    const refuse = (code: string, message: string): number => {
        deps.print(`${code}: ${message}`);
        return 2;
    };
    try {
        const { dbPath: context, dbDir: data } = resolveDatabasePath();
        const store = join(data, "store.db");
        if (!existsSync(context) || !existsSync(store))
            return refuse(
                "single_store_missing_database",
                `Both ${context} and ${store} must exist.`,
            );
        const probe = probeHostProcessesUsing(
            { files: [context, store].flatMap((p) => SUFFIXES.map((s) => p + s)), directories: [] },
            deps.lsofSpawn,
        );
        const holders = deps.inspectHolders(data);
        if (probe.status !== "free" || !holders.safe) {
            const lines = [...holders.blockers];
            if (probe.status === "in_use")
                lines.push(...probe.pids.map((pid) => `database holder (PID ${pid})`));
            if (probe.status === "unknown") lines.push(probe.reason);
            if (holders.uncertainty) lines.push(holders.uncertainty);
            return refuse("single_store_files_in_use", [...lines, STOP].join("\n"));
        }
        if (
            !existsSync(engineContextPath()) ||
            realpathSync(context) !== realpathSync(engineContextPath())
        )
            return refuse(
                "single_store_path_mismatch",
                `CLI ${context}; engine ${engineContextPath()}`,
            );
        const backupRoot = resolve(options.backupRoot ?? join(data, "backups"));
        const contextDb = new Database(context, { readonly: true });
        const storeDb = new Database(store, { readonly: true });
        let contextVersion: number;
        let storeVersion: number;
        let state: MigrationState | null = null;
        let marker: { single_store: number; single_store_set_at_ms: number | null } | null;
        try {
            contextVersion = getPersistedSchemaVersion(contextDb);
            storeVersion =
                (
                    storeDb
                        .prepare(
                            "SELECT COALESCE(MAX(version), 0) AS version FROM cortexkit_schema_version WHERE namespace = 'mc_cache'",
                        )
                        .get() as { version: number } | null
                )?.version ?? 0;
            if (
                contextDb
                    .prepare("SELECT 1 FROM sqlite_master WHERE name='single_store_state'")
                    .get()
            )
                state = contextDb
                    .prepare("SELECT * FROM single_store_state WHERE id=1")
                    .get() as MigrationState | null;
            marker =
                storeVersion >= 58
                    ? (storeDb
                          .prepare(
                              "SELECT single_store, single_store_set_at_ms FROM mc_privilege_state WHERE id=1",
                          )
                          .get() as typeof marker)
                    : null;
        } finally {
            contextDb.close();
            storeDb.close();
        }
        if (state?.state === "migrated" || marker?.single_store) {
            if (
                state?.state !== "migrated" ||
                marker?.single_store !== 1 ||
                state.migrated_at !== marker.single_store_set_at_ms
            )
                return refuse(
                    "single_store_state_split",
                    `context=${JSON.stringify(state)} store=${JSON.stringify(marker)}; restore the paired backup`,
                );
            if (contextVersion !== LATEST_SUPPORTED_VERSION || storeVersion < 61)
                return refuse(
                    "single_store_version_mismatch",
                    `context.db v${contextVersion}; store.db v${storeVersion}`,
                );
            deps.print(
                `already migrated at ${state.migrated_at} by ${state.migrated_by}; backup ${state.backup_dir}`,
            );
            return 0;
        }
        if (contextVersion > LATEST_SUPPORTED_VERSION || storeVersion !== 60)
            return refuse(
                "single_store_version_mismatch",
                `context.db v${contextVersion}; store.db v${storeVersion}; need context.db v${LATEST_SUPPORTED_VERSION} and store.db v60 (apply current plugin migrations to context.db; upgrade store.db with ck-mc first)`,
            );
        const backupBytes = statSync(context).size + statSync(store).size;
        const workingBytes = 2 * statSync(store).size;
        const backupVolume = existingAncestor(backupRoot);
        const sameVolume = statSync(data).dev === statSync(backupVolume).dev;
        const need = Math.ceil((workingBytes + (sameVolume ? backupBytes : 0)) * 1.1);
        const have = deps.freeBytes(data);
        if (have < need)
            return refuse(
                "single_store_disk_space",
                `need ${need} bytes; have ${have} bytes on ${data}`,
            );
        if (!sameVolume && deps.freeBytes(backupVolume) < Math.ceil(backupBytes * 1.1))
            return refuse(
                "single_store_disk_space",
                `backup needs ${Math.ceil(backupBytes * 1.1)} bytes; have ${deps.freeBytes(backupVolume)} bytes on ${backupVolume}`,
            );
        const backupDir = join(
            backupRoot,
            `single-store-${deps.now().toISOString().replaceAll(":", "-")}`,
        );
        undo(backupDir, data, deps.print);
        // Only after read-only preflight may the plugin apply its additive schema migration.
        const opened = openDatabase(context);
        if (!opened)
            return refuse(
                "single_store_version_mismatch",
                "Plugin opener refused context.db; stop every host and update the plugin.",
            );
        try {
            contextVersion = getPersistedSchemaVersion(opened);
        } finally {
            closeDatabase();
        }
        if (contextVersion !== LATEST_SUPPORTED_VERSION)
            return refuse(
                "single_store_version_mismatch",
                `context.db v${contextVersion}; store.db v${storeVersion}`,
            );
        const binary =
            options.ckMc ?? join(homedir(), ".local", "share", "cortexkit", "bin", "ck-mc");
        const args = [
            "single-store-migrate",
            "--context-db",
            context,
            "--store-db",
            store,
            "--backup-dir",
            backupDir,
        ];
        if (options.dryRun) args.push("--dry-run");
        if (options.skipForeign) args.push("--skip-foreign");
        for (const preference of options.prefer ?? []) args.push("--prefer", preference);
        for (const preference of options.preferHistory ?? [])
            args.push("--prefer-history", preference);
        if (options.acceptIdChange) args.push("--accept-id-change");
        const result = spawnSync(binary, args, {
            windowsHide: true,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        if (result.error) throw result.error;
        if (result.stderr.trim()) deps.print(result.stderr.trimEnd());
        if (result.status === 1) {
            deps.print(`single_store_internal_error: ${result.stdout || result.stderr}`);
            return 1;
        }
        const report = JSON.parse(result.stdout) as Report;
        if (!["migrated", "already_migrated", "dry_run", "refused"].includes(report.status))
            throw new Error("Invalid engine report status");
        if (report.backup_dir) undo(report.backup_dir, data, deps.print);
        if (report.transaction_ms != null) {
            deps.print(
                `Transaction: ${report.transaction_ms} ms; vacuum: ${report.vacuum_ms == null ? "not run" : `${report.vacuum_ms} ms`}`,
            );
        }
        if (report.status === "migrated" || report.status === "dry_run") {
            deps.print(
                `Normalized existing context compartment boundaries: ${report.normalized_context_compartments ?? 0}`,
            );
        }
        if (
            result.status === 2 &&
            report.status === "refused" &&
            report.refusal?.code &&
            report.refusal.message
        )
            return refuse(report.refusal.code, report.refusal.message);
        if (result.status !== 0 || report.status === "refused")
            throw new Error("Engine exit code disagrees with its report");
        deps.print(`Single-store: ${report.status}`);
        for (const project of report.projects) {
            deps.print(
                `${project.project}: winner ${project.winner}${project.skipped ? "; skipped (store rows retained only in backup)" : ""}`,
            );
            for (const [table, counts] of Object.entries(project.tables))
                deps.print(
                    `  ${table}: source ${counts.source} / copied ${counts.copied} / updated ${counts.updated} / kept ${counts.kept} / deleted ${counts.deleted} / orphans_kept ${counts.orphans_kept} / superseded ${counts.superseded ?? 0}`,
                );
        }
        for (const decision of report.history ?? [])
            deps.print(
                `history ${decision.session}: kept the ${decision.kept} copy (${decision.reason}; store ${decision.store_compartments} / context ${decision.context_compartments} compartments)`,
            );
        deps.print(
            `Render check: sampled ${report.render_check.sampled}, passed ${report.render_check.passed}, seed ${report.render_check.seed}`,
        );
        deps.print(
            `Sessions reset: ${report.sessions_reset}; store.db bytes: ${report.store_db_bytes.before} -> ${report.store_db_bytes.after}`,
        );
        return 0;
    } catch (error) {
        deps.print(
            `single_store_internal_error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
    }
}

export function runDoctorSingleStoreCli(args: string[]): number {
    const prefer: string[] = [];
    const preferHistory: string[] = [];
    const options: SingleStoreOptions = { prefer, preferHistory };
    const command = args.shift();
    if (command === "repair-history") {
        const parsed = parseRepairHistoryArgs(args);
        if (typeof parsed === "string") {
            console.error(parsed);
            console.error(
                "Usage: magic-context doctor single-store repair-history --from-backup <dir> [--session <id>]... [--apply [--live]]",
            );
            return 1;
        }
        return runDoctorSingleStoreRepair(parsed);
    }
    if (command !== "migrate") {
        console.error(
            "Usage: magic-context doctor single-store migrate [options] | repair-history --from-backup <dir> [options]",
        );
        return 1;
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--skip-foreign") options.skipForeign = true;
        else if (arg === "--accept-id-change") options.acceptIdChange = true;
        else if (
            arg === "--ck-mc" ||
            arg === "--backup-root" ||
            arg === "--prefer" ||
            arg === "--prefer-history"
        ) {
            const value = args[++i];
            if (!value || value.startsWith("--")) {
                console.error(`Missing value for ${arg}`);
                return 1;
            }
            if (arg === "--ck-mc") options.ckMc = value;
            else if (arg === "--backup-root") options.backupRoot = value;
            else if (!/^.+=(store|context)$/.test(value)) {
                console.error(
                    arg === "--prefer"
                        ? "--prefer requires <project>=store|context"
                        : "--prefer-history requires <session>=store|context",
                );
                return 1;
            } else if (arg === "--prefer") prefer.push(value);
            else preferHistory.push(value);
        } else {
            console.error(`Unknown option: ${arg}`);
            return 1;
        }
    }
    return runDoctorSingleStore(options);
}
