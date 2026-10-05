import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import {
    buildWorkspaceMemorySqlFilter,
    getMemorySelectColumns,
    isMemoryRow,
    toMemory,
} from "./storage-memory";
import type { Memory } from "./types";

const DEFAULT_SEARCH_LIMIT = 10;
const searchStatements = new WeakMap<Database, PreparedStatement>();
const datedSearchStatements = new WeakMap<Database, PreparedStatement>();
const unionSearchStatements = new Map<number, WeakMap<Database, PreparedStatement>>();
const datedUnionSearchStatements = new Map<number, WeakMap<Database, PreparedStatement>>();

export interface MemorySearchDateRange {
    from: number;
    to: number;
}

function getSearchStatement(db: Database, dated = false): PreparedStatement {
    const statements = dated ? datedSearchStatements : searchStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path = ? AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?)${dated ? " AND memories.created_at BETWEEN ? AND ?" : ""} AND memories_fts MATCH ? ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 *
 * FTS5 interprets characters like `-`, `:`, `*`, `(`, `)` as operators.
 * This wraps each whitespace-delimited token in double quotes so special
 * characters are treated as literal content rather than query syntax.
 */

function getUnionSearchStatement(db: Database, arity: number, dated = false): PreparedStatement {
    const statementRegistry = dated ? datedUnionSearchStatements : unionSearchStatements;
    let statements = statementRegistry.get(arity);
    if (!statements) {
        statements = new WeakMap<Database, PreparedStatement>();
        statementRegistry.set(arity, statements);
    }
    let stmt = statements.get(db);
    if (!stmt) {
        const placeholders = Array.from({ length: arity }, () => "?").join(", ");
        stmt = db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path IN (${placeholders}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?)${dated ? " AND memories.created_at BETWEEN ? AND ?" : ""} AND memories_fts MATCH ? ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

function uniqueProjectPaths(projectPaths: readonly string[]): string[] {
    return [...new Set(projectPaths.filter((path) => path.length > 0))];
}

export function relaxedFtsQuery(query: string): string {
    const tokens = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])]
        .filter((token) => token.length > 2 || /\d/.test(token))
        .slice(0, 16);
    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export function sanitizeFtsQuery(query: string): string {
    // FTS5 rejects a NUL byte inside a quoted string ("unterminated string"),
    // so treat it as a word break like any other separator.
    const tokens = query
        .replaceAll("\0", " ")
        .split(/\s+/)
        .filter((token) => token.length > 0);
    if (tokens.length === 0) return "";

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

export function searchMemoriesFTS(
    db: Database,
    projectPath: string,
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    dateRange: MemorySearchDateRange | null = null,
): Memory[] {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0 || limit <= 0) {
        return [];
    }

    const sanitized = sanitizeFtsQuery(trimmedQuery);
    if (sanitized.length === 0) {
        return [];
    }

    let rows = getSearchStatement(db, dateRange !== null)
        .all(
            projectPath,
            Date.now(),
            ...(dateRange === null ? [] : [dateRange.from, dateRange.to]),
            sanitized,
            limit,
        )
        .filter(isMemoryRow);
    if (rows.length === 0) {
        const relaxed = relaxedFtsQuery(trimmedQuery);
        if (relaxed)
            rows = getSearchStatement(db, dateRange !== null)
                .all(
                    projectPath,
                    Date.now(),
                    ...(dateRange === null ? [] : [dateRange.from, dateRange.to]),
                    relaxed,
                    limit,
                )
                .filter(isMemoryRow);
    }

    return rows.map(toMemory);
}

export function searchMemoriesFTSUnion(
    db: Database,
    projectPaths: readonly string[],
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    ownIdentities?: readonly string[],
    shareCategories?: readonly string[] | null,
    dateRange: MemorySearchDateRange | null = null,
): Memory[] {
    const identities = uniqueProjectPaths(projectPaths);
    if (identities.length === 0) return [];
    const sharingFilter = buildWorkspaceMemorySqlFilter({
        identities,
        ownIdentities,
        shareCategories,
        tableName: "memories",
        includeClassificationFields: (() => {
            const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{
                name?: string;
            }>;
            return (
                columns.some((row) => row.name === "shareable") &&
                columns.some((row) => row.name === "scope")
            );
        })(),
    });
    if (identities.length === 1 && !sharingFilter.active) {
        return searchMemoriesFTS(db, identities[0], query, limit, dateRange);
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0 || limit <= 0) return [];
    const sanitized = sanitizeFtsQuery(trimmedQuery);
    if (sanitized.length === 0) return [];

    let rows = sharingFilter.active
        ? db
              .prepare(
                  `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path IN (${identities.map(() => "?").join(", ")}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?)${dateRange === null ? "" : " AND memories.created_at BETWEEN ? AND ?"} AND memories_fts MATCH ?${sharingFilter.clause} ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?`,
              )
              .all(
                  ...identities,
                  Date.now(),
                  ...(dateRange === null ? [] : [dateRange.from, dateRange.to]),
                  sanitized,
                  ...sharingFilter.params,
                  limit,
              )
              .filter(isMemoryRow)
        : getUnionSearchStatement(db, identities.length, dateRange !== null)
              .all(
                  ...identities,
                  Date.now(),
                  ...(dateRange === null ? [] : [dateRange.from, dateRange.to]),
                  sanitized,
                  limit,
              )
              .filter(isMemoryRow);

    if (rows.length === 0) {
        const relaxed = relaxedFtsQuery(trimmedQuery);
        if (relaxed) {
            rows = (
                sharingFilter.active
                    ? db.prepare(
                          `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path IN (${identities.map(() => "?").join(", ")}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?)${dateRange === null ? "" : " AND memories.created_at BETWEEN ? AND ?"} AND memories_fts MATCH ?${sharingFilter.clause} ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?`,
                      )
                    : getUnionSearchStatement(db, identities.length, dateRange !== null)
            )
                .all(
                    ...identities,
                    Date.now(),
                    ...(dateRange === null ? [] : [dateRange.from, dateRange.to]),
                    relaxed,
                    ...sharingFilter.params,
                    limit,
                )
                .filter(isMemoryRow);
        }
    }
    return rows.map(toMemory);
}
