import type { ContextDatabase } from "../../features/magic-context/storage";
import { moduleRawBlockMappings } from "./module-wire";
import {
    readRawSessionMessageIdOrdinalsForRange,
    readRawSessionMessagePartsById,
} from "./read-session-chunk";
import { formatDate } from "./temporal-awareness";

interface StoredBoundary {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    start_block_index: number | null;
    end_block_index: number | null;
}

export interface ResolvedContextBoundary
    extends Omit<StoredBoundary, "start_block_index" | "end_block_index"> {
    source_start_message: number;
    source_end_message: number;
    source_start_message_id: string;
    source_end_message_id: string;
    source_start_block_index: number | null;
    source_end_block_index: number | null;
    start_date: string | null;
    end_date: string | null;
}

export class SharedCompartmentBoundaryError extends Error {
    readonly code = "context_compartment_boundary_unresolved";
    constructor(sessionId: string, sequence: number) {
        super(
            `context_compartment_boundary_unresolved: session ${sessionId}, sequence ${sequence}; no contiguous host-message range is provable.`,
        );
    }
}

/** Resolve host ordinals and module block IDs for rendering, leaving the shared rows unchanged. */
export function resolveSharedCompartmentBoundaries(
    db: ContextDatabase,
    sessionId: string,
): ResolvedContextBoundary[] {
    const rows = db
        .prepare(
            "SELECT sequence, start_message, end_message, COALESCE(start_message_id, '') AS start_message_id, COALESCE(end_message_id, '') AS end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id=? ORDER BY sequence",
        )
        .all(sessionId) as StoredBoundary[];
    // Indexed rows already identify exact message blocks. Their date labels remain
    // in the module's existing date cache, so they need no host-history lookup.
    if (rows.every((row) => row.start_block_index !== null && row.end_block_index !== null))
        return [];
    // Read message-ID ordinals once and reuse them for every compartment endpoint,
    // avoiding a separate scan of session history for each start and end.
    const ordinals = readRawSessionMessageIdOrdinalsForRange(sessionId, 1, Number.MAX_SAFE_INTEGER);
    const rawById = new Map<string, ReturnType<typeof readRawSessionMessagePartsById>>();
    const endpoint = (rawId: string, blockIndex: number | null, edge: "start" | "end") => {
        if (!rawById.has(rawId))
            rawById.set(rawId, readRawSessionMessagePartsById(sessionId, rawId));
        const raw = rawById.get(rawId) ?? null;
        const ordinal = raw?.id === rawId ? (ordinals.get(rawId) ?? null) : null;
        const block =
            blockIndex !== null
                ? blockIndex
                : edge === "start"
                  ? 0
                  : (moduleRawBlockMappings(raw).at(-1)?.blockIndex ?? 0);
        return { ordinal, id: `${rawId}#${block}`, raw };
    };
    const idsByOrdinal = rows.some((row) => !row.start_message_id || !row.end_message_id)
        ? new Map([...ordinals].map(([id, ordinal]) => [ordinal, id]))
        : null;
    const endpoints = rows.map((row) => ({
        start: endpoint(row.start_message_id, row.start_block_index, "start"),
        end: endpoint(row.end_message_id, row.end_block_index, "end"),
    }));
    return rows.map((row, index) => {
        let { start, end } = endpoints[index];
        let startOrdinal = start.ordinal;
        let endOrdinal = end.ordinal;
        if (startOrdinal !== null || endOrdinal !== null) {
            if (startOrdinal === null) {
                const previousEnd = endpoints[index - 1]?.end.ordinal;
                startOrdinal =
                    typeof previousEnd === "number"
                        ? previousEnd + 1
                        : index === 0
                          ? (readRawSessionMessageIdOrdinalsForRange(sessionId, 1, 1)
                                .values()
                                .next().value ?? null)
                          : null;
            }
            if (endOrdinal === null) {
                const nextStart = endpoints[index + 1]?.start.ordinal;
                endOrdinal = typeof nextStart === "number" ? nextStart - 1 : null;
            }
        }
        if (
            startOrdinal === null ||
            endOrdinal === null ||
            startOrdinal < 1 ||
            startOrdinal > endOrdinal
        ) {
            throw new SharedCompartmentBoundaryError(sessionId, row.sequence);
        }
        // Legacy summaries can lack an endpoint ID. Once neighboring endpoints
        // prove its ordinal, resolve the actual host message there; an empty ID
        // cannot be serialized as a valid module block address.
        const resolveMissingId = (
            sourceId: string,
            blockIndex: number | null,
            ordinal: number,
            edge: "start" | "end",
        ) => {
            const id = idsByOrdinal?.get(ordinal);
            if (sourceId || blockIndex !== null || !id)
                throw new SharedCompartmentBoundaryError(sessionId, row.sequence);
            return endpoint(id, null, edge);
        };
        if (!row.start_message_id)
            start = resolveMissingId(
                row.start_message_id,
                row.start_block_index,
                startOrdinal,
                "start",
            );
        if (!row.end_message_id)
            end = resolveMissingId(row.end_message_id, row.end_block_index, endOrdinal, "end");
        const dates =
            typeof start.raw?.createdAt === "number" && typeof end.raw?.createdAt === "number"
                ? {
                      start_date: formatDate(start.raw.createdAt),
                      end_date: formatDate(end.raw.createdAt),
                  }
                : { start_date: null, end_date: null };
        return {
            sequence: row.sequence,
            source_start_message: row.start_message,
            source_end_message: row.end_message,
            source_start_message_id: row.start_message_id,
            source_start_block_index: row.start_block_index,
            source_end_message_id: row.end_message_id,
            source_end_block_index: row.end_block_index,
            start_message: startOrdinal,
            end_message: endOrdinal,
            start_message_id: start.id,
            end_message_id: end.id,
            ...dates,
        };
    });
}
