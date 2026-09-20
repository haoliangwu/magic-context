import {
    hostMemoryIdentityForModuleId,
    moduleMemoryIdentityForHostId,
} from "../features/magic-context/context-authority";
import type { Database } from "../shared/sqlite";

export interface ModuleMemoryOperation {
    action: string;
    module_id?: number;
    canonical_module_id?: number;
    superseded_module_ids?: number[];
    category?: string;
}

export function unmappedMemoryIdMessage(id: number): string {
    return `Error: memory id ${id} has no module mapping yet — it was written seconds ago or the mirror is behind; retry or use the id shown in <project-memory>.`;
}

export function translateHostMemoryIds(
    db: Database,
    hostIds: readonly number[],
): { moduleIds: number[] } | { error: string } {
    const moduleIds: number[] = [];
    for (const hostId of hostIds) {
        const identity = moduleMemoryIdentityForHostId(db, hostId);
        if (!identity) return { error: unmappedMemoryIdMessage(hostId) };
        moduleIds.push(identity.moduleRowId);
    }
    return { moduleIds };
}

export function moduleMemoryOperation(response: unknown, depth = 0): ModuleMemoryOperation | null {
    if (depth > 4 || response === null || typeof response !== "object") return null;
    if (Array.isArray(response)) {
        for (const item of response) {
            const operation = moduleMemoryOperation(item, depth + 1);
            if (operation) return operation;
        }
        return null;
    }
    const record = response as Record<string, unknown>;
    if (
        record.memory_operation !== null &&
        typeof record.memory_operation === "object" &&
        typeof (record.memory_operation as Record<string, unknown>).action === "string"
    ) {
        return record.memory_operation as unknown as ModuleMemoryOperation;
    }
    return moduleMemoryOperation(record.result, depth + 1);
}

export function translateModuleMemoryMutationReply(args: {
    db: Database;
    moduleProject: string;
    response: unknown;
    requestedHostIds: readonly number[];
    requestedCategory?: string;
}): string | null {
    const operation = moduleMemoryOperation(args.response);
    if (operation?.action === "write" && operation.module_id !== undefined) {
        const identity = hostMemoryIdentityForModuleId(
            args.db,
            args.moduleProject,
            operation.module_id,
        );
        const category = operation.category ?? args.requestedCategory;
        return identity
            ? `Saved memory [ID: ${identity.contextRowId}] in ${category}.`
            : `Saved memory in ${category}. Its id will appear in <project-memory> on the next pass.`;
    }
    if (operation?.action === "merge" && operation.canonical_module_id !== undefined) {
        const canonical = hostMemoryIdentityForModuleId(
            args.db,
            args.moduleProject,
            operation.canonical_module_id,
        );
        const superseded = (operation.superseded_module_ids ?? [])
            .map(
                (moduleId) =>
                    hostMemoryIdentityForModuleId(args.db, args.moduleProject, moduleId)
                        ?.contextRowId,
            )
            .filter((id): id is number => id !== undefined);
        const category = operation.category ?? args.requestedCategory;
        if (canonical) {
            return `Merged memories [${args.requestedHostIds.join(", ")}] into canonical memory [ID: ${canonical.contextRowId}] in ${category}; superseded [${superseded.join(", ")}].`;
        }
        return `Merged memories [${args.requestedHostIds.join(", ")}] into a canonical memory in ${category}. Its id will appear in <project-memory> on the next pass.`;
    }
    return null;
}
