import { spawnSync } from "node:child_process";
import { existsSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveDatabasePath } from "@magic-context/core/features/magic-context/storage-db";
import { probeHostProcessesUsing } from "./doctor-opencode2-cache";
import { defaultInspectHolders } from "./doctor-repair-db";

const SUFFIXES = ["", "-wal", "-shm"];

export interface RepairHistoryOptions {
    ckMc?: string;
    backupRoot?: string;
    /** The pre-migration backup directory the single-store migration wrote. */
    fromBackup?: string;
    sessions?: string[];
    apply?: boolean;
    /**
     * Apply while hosts hold the stores. Only for named sessions: each is repaired in one
     * short transaction, and the engine refuses a session a historian is writing.
     */
    live?: boolean;
}

interface Dependencies {
    now: () => Date;
    inspectHolders: typeof defaultInspectHolders;
    lsofSpawn: NonNullable<Parameters<typeof probeHostProcessesUsing>[1]>;
    freeBytes: (path: string) => number;
    print: (line: string) => void;
}

type Extent = { compartments: number; max_sequence: number | null; end_message: number | null };
type Change = { restored: number; removed: number };
interface SessionPlan {
    session: string;
    project: string | null;
    backup: Extent;
    live: Extent;
    after: Extent;
    kept: number;
    restored: number;
    removed: number;
    removed_sequences: [number, number] | null;
    straddling: number;
    tail: number;
    compartment_events: Change;
    chunk_embeddings: Change;
    user_memory_candidates: Change;
}
interface Report {
    status: "preview" | "repaired" | "refused" | "error";
    backup_dir?: string | null;
    sessions?: SessionPlan[];
    not_needed?: string[];
    refusal?: { code: string; message: string };
    error?: string;
}

function existingAncestor(path: string): string {
    let current = resolve(path);
    while (!existsSync(current)) current = dirname(current);
    return current;
}

function describe(plan: SessionPlan, print: (line: string) => void): void {
    const extent = (e: Extent) =>
        `${e.compartments} compartments, last sequence ${e.max_sequence ?? "-"}, last message ${e.end_message ?? "-"}`;
    print(`${plan.session}${plan.project ? ` (${plan.project})` : ""}`);
    print(`  backup: ${extent(plan.backup)}`);
    print(`  live:   ${extent(plan.live)}`);
    print(`  after:  ${extent(plan.after)}`);
    print(
        `  kept ${plan.kept} / restored ${plan.restored} / removed ${plan.removed}${plan.removed_sequences ? ` (sequences ${plan.removed_sequences[0]}-${plan.removed_sequences[1]})` : ""} / straddling ${plan.straddling} / kept past the backup ${plan.tail}`,
    );
    for (const [name, change] of [
        ["events", plan.compartment_events],
        ["chunk embeddings", plan.chunk_embeddings],
        ["user-memory candidates", plan.user_memory_candidates],
    ] as const)
        print(`  ${name}: restored ${change.restored} / removed ${change.removed}`);
}

/**
 * `doctor single-store repair-history`: put back session history the single-store
 * migration dropped, from the backup it took. Without `--apply` it only reports.
 */
export function runDoctorSingleStoreRepair(
    options: RepairHistoryOptions,
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
            return refuse("repair_missing_database", `Both ${context} and ${store} must exist.`);
        if (!options.fromBackup) return refuse("repair_usage", "--from-backup <dir> is required");
        const fromBackup = resolve(options.fromBackup);
        for (const name of ["context.db", "store.db"])
            if (!existsSync(join(fromBackup, name)))
                return refuse("repair_backup_missing", `${join(fromBackup, name)} does not exist`);
        const sessions = options.sessions ?? [];
        if (options.live && sessions.length === 0)
            return refuse(
                "repair_usage",
                "--live repairs named sessions only; pass --session <id>",
            );

        let backupDir: string | undefined;
        if (options.apply) {
            const probe = probeHostProcessesUsing(
                {
                    files: [context, store].flatMap((path) => SUFFIXES.map((s) => path + s)),
                    directories: [],
                },
                deps.lsofSpawn,
            );
            const holders = deps.inspectHolders(data);
            const blockers = [...holders.blockers];
            if (probe.status === "in_use")
                blockers.push(...probe.pids.map((pid) => `database holder (PID ${pid})`));
            if (probe.status === "unknown") blockers.push(probe.reason);
            if (holders.uncertainty) blockers.push(holders.uncertainty);
            if (probe.status !== "free" || !holders.safe) {
                if (!options.live)
                    return refuse(
                        "repair_files_in_use",
                        [
                            ...blockers,
                            "quit OpenCode, Pi and ck-mc (`ck stop magic-context`) and run again, or repair named sessions with --live",
                        ].join("\n"),
                    );
                deps.print(
                    `Repairing while hosts hold the stores (--live): ${blockers.join("; ") || "holders unknown"}`,
                );
            }
            const backupRoot = resolve(options.backupRoot ?? join(data, "backups"));
            const need = Math.ceil((statSync(context).size + statSync(store).size) * 1.1);
            const volume = existingAncestor(backupRoot);
            const have = deps.freeBytes(volume);
            if (have < need)
                return refuse(
                    "repair_disk_space",
                    `the backup needs ${need} bytes; have ${have} bytes on ${volume}`,
                );
            backupDir = join(
                backupRoot,
                `repair-history-${deps.now().toISOString().replaceAll(":", "-")}`,
            );
            deps.print(`Backing up the live stores to ${backupDir} before any write.`);
        }

        const binary =
            options.ckMc ?? join(homedir(), ".local", "share", "cortexkit", "bin", "ck-mc");
        const args = [
            "single-store-repair-history",
            "--context-db",
            context,
            "--store-db",
            store,
            "--from-backup",
            fromBackup,
        ];
        for (const session of sessions) args.push("--session", session);
        if (backupDir) args.push("--apply", "--backup-dir", backupDir);
        const result = spawnSync(binary, args, {
            windowsHide: true,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        if (result.error) throw result.error;
        if (result.stderr.trim()) deps.print(result.stderr.trimEnd());
        const report = JSON.parse(result.stdout) as Report;
        if (report.status === "error" || result.status === 1) {
            deps.print(`repair_internal_error: ${report.error ?? result.stdout}`);
            return 1;
        }
        if (report.status === "refused" && report.refusal)
            return refuse(report.refusal.code, report.refusal.message);
        if (result.status !== 0 || !["preview", "repaired"].includes(report.status))
            throw new Error("Engine exit code disagrees with its report");
        const plans = report.sessions ?? [];
        deps.print(
            report.status === "preview"
                ? `Sessions whose history the migration dropped: ${plans.length} (preview; nothing written)`
                : `Repaired ${plans.length} session(s); backup of the live stores: ${report.backup_dir}`,
        );
        for (const plan of plans) describe(plan, deps.print);
        for (const session of report.not_needed ?? []) deps.print(`${session}: nothing to restore`);
        if (report.status === "repaired" && plans.length > 0)
            deps.print(
                "Each repaired session rebuilds m[0] once on its next pass (one prompt-cache write). A running host needs no restart.",
            );
        return 0;
    } catch (error) {
        deps.print(
            `repair_internal_error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
    }
}

export function parseRepairHistoryArgs(args: string[]): RepairHistoryOptions | string {
    const sessions: string[] = [];
    const options: RepairHistoryOptions = { sessions };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--apply") options.apply = true;
        else if (arg === "--live") options.live = true;
        else if (["--from-backup", "--session", "--ck-mc", "--backup-root"].includes(arg)) {
            const value = args[++i];
            if (!value || value.startsWith("--")) return `Missing value for ${arg}`;
            if (arg === "--from-backup") options.fromBackup = value;
            else if (arg === "--session") sessions.push(value);
            else if (arg === "--ck-mc") options.ckMc = value;
            else options.backupRoot = value;
        } else return `Unknown option: ${arg}`;
    }
    if (!options.fromBackup) return "--from-backup <dir> is required";
    if (options.live && !options.apply) return "--live only applies with --apply";
    return options;
}
