import type { OpenCodeHostGeneration } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";

interface BoundaryRow {
    session_id: string;
    sequence: number;
    start_message_id: string;
    end_message_id: string;
}

export interface DanglingCompartmentBoundary {
    sessionId: string;
    sequence: number;
    missingStartMessageId: string | null;
    missingEndMessageId: string | null;
}

type BoundaryMessageTable = "message" | "session_message";

interface BoundaryMessageTableSelection {
    table: BoundaryMessageTable;
    diagnostic: string | null;
}

function selectBoundaryMessageTable(
    openCodeDb: Pick<Database, "prepare">,
    hostGeneration?: OpenCodeHostGeneration,
): BoundaryMessageTableSelection {
    const rows = openCodeDb
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part', 'session_message', 'session_v2')",
        )
        .all() as Array<{ name?: unknown }>;
    const tables = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
    const hasV1Messages = tables.has("message") && tables.has("part");
    const hasV2Messages = tables.has("session_message") && tables.has("session_v2");

    if (hostGeneration === "v1") {
        if (!hasV1Messages) {
            throw new Error("OpenCode session database has no v1 message tables");
        }
        return { table: "message", diagnostic: null };
    }

    if (hostGeneration === "v2") {
        if (hasV2Messages) return { table: "session_message", diagnostic: null };
        if (hasV1Messages) {
            return {
                table: "message",
                diagnostic:
                    "Compartment boundary check: OpenCode 2 pre-migration window; using message table",
            };
        }
        throw new Error("OpenCode session database has an unrecognized schema");
    }

    // When Desktop provides no host version, the same tables can mean migrated v2 or downgraded
    // v1. Choosing populated v2 history fixes migrated Desktop stores but may read frozen v2
    // history after a downgrade, so this branch is deliberately only a heuristic.
    const hasV2Rows =
        hasV2Messages && openCodeDb.prepare("SELECT 1 FROM session_message LIMIT 1").get() != null;
    if (hasV2Rows) return { table: "session_message", diagnostic: null };
    if (hasV1Messages) return { table: "message", diagnostic: null };
    throw new Error("OpenCode session database has an unrecognized schema");
}

/** Read-only comparison of durable compartment ids with the active OpenCode store. */
export function listDanglingCompartmentBoundaries(
    contextDb: Pick<Database, "prepare">,
    openCodeDb: Pick<Database, "prepare">,
    hostGeneration?: OpenCodeHostGeneration,
    onDiagnostic?: (line: string) => void,
): DanglingCompartmentBoundary[] {
    const selection = selectBoundaryMessageTable(openCodeDb, hostGeneration);
    if (selection.diagnostic) onDiagnostic?.(selection.diagnostic);

    const rows = contextDb
        .prepare(
            `SELECT c.session_id, c.sequence, c.start_message_id, c.end_message_id
               FROM compartments AS c
               LEFT JOIN session_meta AS sm ON sm.session_id = c.session_id
              WHERE sm.harness IS NULL OR sm.harness IN ('opencode', 'opencode2')
              ORDER BY c.session_id ASC, c.sequence ASC`,
        )
        .all() as BoundaryRow[];
    const statement = openCodeDb.prepare(
        `SELECT 1 AS found FROM ${selection.table} WHERE session_id = ? AND id = ? LIMIT 1`,
    );
    const exists = (sessionId: string, messageId: string): boolean =>
        statement.get(sessionId, messageId) != null;

    return rows.flatMap((row) => {
        const missingStart = !exists(row.session_id, row.start_message_id);
        const missingEnd = !exists(row.session_id, row.end_message_id);
        if (!missingStart && !missingEnd) return [];
        return [
            {
                sessionId: row.session_id,
                sequence: row.sequence,
                missingStartMessageId: missingStart ? row.start_message_id : null,
                missingEndMessageId: missingEnd ? row.end_message_id : null,
            },
        ];
    });
}

export function formatDanglingCompartmentBoundary(boundary: DanglingCompartmentBoundary): string {
    const missing = [
        boundary.missingStartMessageId
            ? `start_message_id=${boundary.missingStartMessageId}`
            : null,
        boundary.missingEndMessageId ? `end_message_id=${boundary.missingEndMessageId}` : null,
    ].filter((value): value is string => value !== null);
    return `session=${boundary.sessionId} sequence=${boundary.sequence} missing ${missing.join(" ")}`;
}
