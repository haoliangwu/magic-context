import {
    projectNeedsSingleStoreMigration,
    SingleStoreMigrationRequiredError,
} from "../../../hooks/magic-context/single-store-refusal";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import type { ClassifyModuleClient } from "./classify";

const loggedNotOwnerProjects = new Set<string>();

export function logDreamerNotOwnerOnce(projectIdentity: string): void {
    if (loggedNotOwnerProjects.has(projectIdentity)) return;
    loggedNotOwnerProjects.add(projectIdentity);
    log(`[dreamer] ${projectIdentity}: ${new SingleStoreMigrationRequiredError().message}`);
}

export class DreamerModuleFailureError extends Error {
    readonly transient = true;
    constructor(operation: string, cause: unknown) {
        super(
            `Rust dreamer ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
        this.name = "DreamerModuleFailureError";
    }
}

export type DreamerModuleClient = ClassifyModuleClient;

export interface DreamerModuleRoute {
    moduleClient: DreamerModuleClient;
    moduleSessionId: string;
    moduleProjectRoot: string;
    moduleCommandId: string;
}

/** Both writers use the same rows; routing no longer changes ownership or row ids. */
export async function resolveDreamerModuleRoute(args: {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    transformMode?: "ts" | "rust";
    moduleClient?: DreamerModuleClient;
    commandId: string;
}): Promise<DreamerModuleRoute | undefined> {
    if (projectNeedsSingleStoreMigration(args.db, args.projectIdentity)) {
        throw new SingleStoreMigrationRequiredError();
    }
    if (args.transformMode === "ts" || !args.moduleClient) return undefined;
    return {
        moduleClient: args.moduleClient,
        moduleSessionId: args.projectIdentity,
        moduleProjectRoot: args.projectRoot,
        moduleCommandId: args.commandId,
    };
}

export interface ModuleMemoryIdentity {
    moduleId: number;
    normalizedHash: string;
}

/** Capture the shared row's hash for the module's compare-before-write check. */
export function getModuleMemoryIdentities(
    db: Database,
    projectIdentity: string,
    contextIds: readonly number[],
): Map<number, ModuleMemoryIdentity> {
    if (contextIds.length === 0) return new Map();
    const placeholders = contextIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT id, normalized_hash FROM memories WHERE project_path = ? AND id IN (${placeholders})`,
        )
        .all(projectIdentity, ...contextIds) as Array<{ id: number; normalized_hash: string }>;
    return new Map(
        rows.map((row) => [row.id, { moduleId: row.id, normalizedHash: row.normalized_hash }]),
    );
}
