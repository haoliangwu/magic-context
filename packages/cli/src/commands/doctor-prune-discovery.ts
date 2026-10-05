/**
 * RPC discovery records (`<storage>/rpc/<project>/port-*.json`) tell the
 * storage guard which hosts may still hold the shared database. A record whose
 * PID is alive but cannot be matched to the process that wrote it is kept and
 * blocks offline maintenance such as `doctor merge-identities --apply`.
 *
 * Inspection already deletes records proven stale (dead PID, a process that
 * started after the record was written, or an image no host can run). This
 * module reports what is left and lets the user remove it explicitly. Empty
 * project directories are pruned only here, never during storage opens.
 */
import {
    inspectRpcServerDiscovery,
    pruneEmptyRpcDiscoveryDirs,
    type RpcDiscoveryRecordEvidence,
    type RpcServerDiscovery,
    removeRpcDiscoveryRecords,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { inspectWindowsProcessesSync } from "@magic-context/core/shared/rpc-utils";

import { confirm } from "../lib/prompts";

export const PRUNE_DISCOVERY_COMMAND = "magic-context doctor --prune-discovery";

/** Inspect discovery records with the same bounded process scan the merge guard uses. */
export function inspectDiscoveryRecords(storageDir: string): RpcServerDiscovery {
    const processes = process.platform === "win32" ? inspectWindowsProcessesSync() : undefined;
    return inspectRpcServerDiscovery(storageDir, processes, {
        deadlineMs: 15_000,
        onProgress: (checked, total) =>
            console.error(`Inspecting RPC discovery records: ${checked}/${total} records checked`),
    });
}

function formatTime(ms: number | null): string {
    return ms === null || !Number.isFinite(ms) ? "unreadable" : new Date(ms).toISOString();
}

function imageLabel(record: RpcDiscoveryRecordEvidence): string {
    if (record.imageName) return record.imageName;
    const command = record.commandLine?.replaceAll("\u0000", " ").trim();
    if (!command) return "unknown";
    return command.length > 80 ? `${command.slice(0, 77)}...` : command;
}

/** One line per record: what the record claims and what the PID is now. */
export function formatDiscoveryRecordEvidence(record: RpcDiscoveryRecordEvidence): string {
    const liveness = record.liveness === "alive" ? "" : `; process liveness ${record.liveness}`;
    return `PID ${record.pid}: recorded start ${record.recordedStartedAt === null ? "none" : formatTime(record.recordedStartedAt)}, actual start ${formatTime(record.processStartTime)}, image ${imageLabel(record)}${liveness} (${record.file})`;
}

interface DiscoveryReportSink {
    pass(message: string): void;
    warn(message: string): void;
    info(message: string): void;
}

/**
 * The main doctor's discovery check: inspect, report, and with `--fix` prune
 * empty project directories. Returns true when the doctor should count an issue.
 */
export function runDiscoveryDoctorCheck(
    storageDir: string,
    options: { fix?: boolean; inspect?: (storageDir: string) => RpcServerDiscovery },
    sink: DiscoveryReportSink,
): boolean {
    const issue = reportDiscoveryRecords(
        (options.inspect ?? inspectDiscoveryRecords)(storageDir),
        sink,
    );
    if (options.fix) {
        const pruned = pruneEmptyRpcDiscoveryDirs(storageDir);
        if (pruned.length > 0) {
            sink.info(`Removed ${pruned.length} empty RPC discovery director(ies)`);
        }
    }
    return issue;
}

/**
 * Report discovery records in the main doctor. Returns true when records remain
 * that nothing could resolve, so the doctor does not end with a clean bill.
 */
export function reportDiscoveryRecords(
    discovery: RpcServerDiscovery,
    sink: DiscoveryReportSink,
): boolean {
    if (discovery.staleFiles.length > 0) {
        sink.info(
            `Removed ${discovery.staleFiles.length} stale RPC discovery record(s) whose process had exited or whose PID was reused`,
        );
    }
    if (discovery.state === "unreadable") {
        sink.warn(
            `RPC discovery record ${discovery.unreadableFile ?? "<unknown>"} ${discovery.unreadableArm === "parse" ? "could not be parsed" : "could not be read"}; offline maintenance will refuse until it is fixed or removed`,
        );
        return true;
    }
    const unresolved = discovery.inconclusiveRecords ?? [];
    if (unresolved.length === 0) {
        sink.pass(
            discovery.serverPids.length > 0
                ? `RPC discovery records match running hosts (PID ${discovery.serverPids.join(", ")})`
                : "RPC discovery records: none unresolved",
        );
        return false;
    }
    sink.warn(
        `${unresolved.length} RPC discovery record(s) could not be matched to a running host or proven stale; they block \`doctor merge-identities --apply\`. Review and remove them with \`${PRUNE_DISCOVERY_COMMAND}\`.`,
    );
    for (const record of unresolved) sink.info(`  ${formatDiscoveryRecordEvidence(record)}`);
    return true;
}

export interface PruneDiscoveryDeps {
    storageDir: string;
    inspect: (storageDir: string) => RpcServerDiscovery;
    confirm: (message: string) => Promise<boolean>;
    remove: typeof removeRpcDiscoveryRecords;
    pruneDirs: typeof pruneEmptyRpcDiscoveryDirs;
    print: (line: string) => void;
    interactive: boolean;
}

/**
 * `doctor --prune-discovery [--yes]`: remove proven-stale records, list the
 * unresolved ones with their evidence, and delete those only after the user
 * confirms (or passes `--yes`).
 */
export async function runPruneDiscoveryCli(
    args: string[],
    overrides: Partial<PruneDiscoveryDeps> = {},
): Promise<number> {
    for (const arg of args) {
        if (!["--prune-discovery", "--yes", "-y"].includes(arg)) {
            throw new Error(`Unknown doctor --prune-discovery option: ${arg}`);
        }
    }
    const yes = args.includes("--yes") || args.includes("-y");
    const deps: PruneDiscoveryDeps = {
        storageDir: getMagicContextStorageDir(),
        inspect: inspectDiscoveryRecords,
        confirm: (message) => confirm(message, false),
        remove: removeRpcDiscoveryRecords,
        pruneDirs: pruneEmptyRpcDiscoveryDirs,
        print: (line) => console.log(line),
        interactive: Boolean(process.stdin.isTTY),
        ...overrides,
    };
    const discovery = deps.inspect(deps.storageDir);
    if (discovery.staleFiles.length > 0) {
        deps.print(
            `Removed ${discovery.staleFiles.length} stale discovery record(s) (exited process, reused PID, or a process that cannot be a host).`,
        );
    }
    if (discovery.state === "unreadable") {
        deps.print(
            `Discovery record ${discovery.unreadableFile ?? "<unknown>"} ${discovery.unreadableArm === "parse" ? "could not be parsed (it may still be being written; retry in ten minutes)" : "could not be read"}. Nothing else was removed.`,
        );
        return 1;
    }
    // Directories emptied a moment ago are skipped by the age rule, so they are
    // pruned on a later run rather than here.
    const prunedDirs = deps.pruneDirs(deps.storageDir);
    if (prunedDirs.length > 0) {
        deps.print(`Removed ${prunedDirs.length} empty discovery director(ies).`);
    }
    if (discovery.serverPids.length > 0) {
        deps.print(
            `Kept the records of running hosts (PID ${discovery.serverPids.join(", ")}); close them before offline maintenance.`,
        );
    }
    const unresolved = discovery.inconclusiveRecords ?? [];
    if (unresolved.length === 0) {
        deps.print("No unresolved discovery records remain.");
        return 0;
    }
    deps.print(
        `${unresolved.length} discovery record(s) could not be matched to a running host or proven stale:`,
    );
    for (const record of unresolved) deps.print(`  ${formatDiscoveryRecordEvidence(record)}`);
    deps.print(
        "Remove them only if OpenCode, OpenChamber, Pi and ck-mc are all closed. A running host whose record is removed keeps working, but the TUI and the storage guard can no longer find it.",
    );
    if (!yes) {
        if (!deps.interactive) {
            deps.print("Nothing removed. Re-run with --yes to remove these records.");
            return 1;
        }
        if (!(await deps.confirm(`Remove ${unresolved.length} discovery record(s)?`))) {
            deps.print("Nothing removed.");
            return 1;
        }
    }
    const result = deps.remove(
        deps.storageDir,
        unresolved.map((record) => record.file),
    );
    deps.print(`Removed ${result.removed.length} discovery record(s).`);
    for (const failure of result.failed) {
        deps.print(`  Could not remove ${failure.file}: ${failure.error}`);
    }
    return result.failed.length > 0 ? 1 : 0;
}
