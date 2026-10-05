import type { FailClosedReason } from "./fail-closed-block";
import { getMigrationOnOpenRefusal, getSchemaFenceRejection } from "./storage-db";

/**
 * Explain why the most recent `openDatabase`/`openDatabaseAsync` call in this
 * process left no usable storage, as the structured reason every host formats
 * with `formatFailClosedBlockingMessage`.
 *
 * The open functions return `null` for two deliberate refusals and record the
 * detail in module state: a migration refused because another live host may
 * still run an older build (with the blocking processes), and a database newer
 * than this build. Anything else (an open that threw, or a handle that is not
 * durable) is a plain storage failure described by `fallbackCause`, which the
 * caller takes from the thrown error or the handle's persistence error.
 *
 * Call it right after the failed open: the next open clears the recorded state.
 */
export function describeStorageUnavailability(fallbackCause: string): FailClosedReason {
    const migration = getMigrationOnOpenRefusal();
    const blockingProcesses =
        migration?.blockingProcesses ??
        migration?.serverPids.map((pid) => ({ kind: "process" as const, pid })) ??
        [];
    if (migration && (blockingProcesses.length > 0 || migration.unreadableFile)) {
        return {
            kind: "migration_guard",
            persistedVersion: migration.persistedVersion,
            supportedVersion: migration.supportedVersion,
            blockingProcesses,
            ...(migration.unreadableFile ? { unreadableFile: migration.unreadableFile } : {}),
            ...(migration.unreadableArm ? { unreadableArm: migration.unreadableArm } : {}),
        };
    }
    const fence = getSchemaFenceRejection();
    if (fence) {
        return {
            kind: "schema_fence",
            persistedVersion: fence.persistedVersion,
            supportedVersion: fence.supportedVersion,
        };
    }
    return { kind: "storage_failure", cause: fallbackCause };
}
