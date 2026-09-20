import {
    assertOpenCodeStoreGeneration,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "@magic-context/core/shared/opencode-db-path";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { openExistingDatabase } from "../lib/database-access";

export interface HiddenSessionRow {
    id: string;
    title: string;
    directory: string;
    role: "historian" | "dreamer" | "unknown";
    updatedAt: number | null;
}

interface HiddenSessionDatabase {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
    };
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value !== "string") return null;
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** Read-only inventory used by doctor; it never archives, removes, or rewrites host rows. */
export function listHiddenSessionsFromDatabase(
    database: HiddenSessionDatabase,
): HiddenSessionRow[] {
    const columns = new Set(
        database
            .prepare("PRAGMA table_info(session)")
            .all()
            .flatMap((row) =>
                row &&
                typeof row === "object" &&
                typeof (row as { name?: unknown }).name === "string"
                    ? [(row as { name: string }).name]
                    : [],
            ),
    );
    if (!columns.has("metadata")) return [];
    const title = columns.has("title") ? "title" : "'' AS title";
    const directory = columns.has("directory") ? "directory" : "'' AS directory";
    const updatedAt = columns.has("time_updated")
        ? "time_updated"
        : columns.has("updated_at")
          ? "updated_at AS time_updated"
          : "NULL AS time_updated";
    const rows = database
        .prepare(
            `SELECT id, ${title}, ${directory}, ${updatedAt}, metadata
             FROM session
             WHERE metadata IS NOT NULL
             ORDER BY time_updated DESC, id ASC`,
        )
        .all() as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
        const metadata = parseMetadata(row.metadata);
        if (metadata?.magic_context !== "hidden-run" || typeof row.id !== "string") return [];
        const role = metadata.role;
        return [
            {
                id: row.id,
                title: typeof row.title === "string" ? row.title : "",
                directory: typeof row.directory === "string" ? row.directory : "",
                role: role === "historian" || role === "dreamer" ? role : "unknown",
                updatedAt: typeof row.time_updated === "number" ? row.time_updated : null,
            },
        ];
    });
}

export async function runListHiddenSessions(): Promise<number> {
    const resolution = resolveOpenCodeDbPath("v2");
    if (!openCodeDbPathExists(resolution)) {
        console.log(`No OpenCode 2 session database found at ${resolution.path}.`);
        return 0;
    }
    const db = openExistingDatabase(resolution.path, { readonly: true });
    if (!db) {
        console.log(`No OpenCode 2 session database found at ${resolution.path}.`);
        return 0;
    }
    try {
        assertOpenCodeStoreGeneration(db, "v2", resolution.path);
        const sessions = listHiddenSessionsFromDatabase(db as DatabaseType);
        if (sessions.length === 0) {
            console.log("No Magic Context hidden-run sessions found.");
            return 0;
        }
        console.log(`Magic Context hidden-run sessions (${sessions.length}):`);
        for (const session of sessions) {
            const location = session.directory ? `  ${session.directory}` : "";
            console.log(`- ${session.id}  ${session.role}  ${session.title}${location}`);
        }
        console.log(
            "These are visible OpenCode 2 root sessions and are never deleted by Magic Context. Remove unwanted sessions manually in OpenCode.",
        );
        return 0;
    } finally {
        db.close();
    }
}
