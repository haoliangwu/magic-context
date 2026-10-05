/**
 * Hybrid FTS + semantic search for indexed git commits.
 *
 * Returns raw scored matches; the caller (unifiedSearch) slots these into
 * the existing merged ranking with source boosts.
 */

import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { isKnownAutocommit } from "../../../shared/sqlite-helpers";
import { cosineSimilarity } from "../memory/cosine-similarity";
import { sanitizeFtsQuery } from "../memory/storage-memory-fts";
import { loadProjectCommitEmbeddings } from "./storage-git-commit-embeddings";
import type { StoredGitCommit } from "./storage-git-commits";

const ftsStatements = new WeakMap<Database, PreparedStatement>();
const datedFtsStatements = new WeakMap<Database, PreparedStatement>();
const ftsPlainStatements = new WeakMap<Database, PreparedStatement>();
const datedFtsPlainStatements = new WeakMap<Database, PreparedStatement>();
const getBySHAsStatements = new WeakMap<Database, PreparedStatement>();
const datedGetBySHAsStatements = new WeakMap<Database, PreparedStatement>();
const embeddingCache = new WeakMap<
    Database,
    {
        revisionStatement: PreparedStatement;
        revision: string;
        entries: Map<string, Map<string, Float32Array>>;
    }
>();

function getSearchEmbeddings(
    db: Database,
    projectPath: string,
    modelId: string,
): Map<string, Float32Array> {
    if (!isKnownAutocommit(db)) {
        // A rollback leaves every revision counter unchanged, so a vector read
        // inside a transaction must never be cached or served from the cache.
        embeddingCache.delete(db);
        return loadProjectCommitEmbeddings(db, projectPath, modelId);
    }
    let cache = embeddingCache.get(db);
    if (!cache) {
        cache = {
            revisionStatement: db.prepare(`SELECT total_changes() AS writes,
                (SELECT data_version FROM pragma_data_version) AS dataVersion,
                (SELECT schema_version FROM pragma_schema_version) AS schemaVersion`),
            revision: "",
            entries: new Map(),
        };
        embeddingCache.set(db, cache);
    }
    // total_changes sees writes on this connection; data_version sees commits
    // from other connections; schema_version also covers table rebuilds. No TTL
    // can serve vectors stale after a dashboard edit, sync or model-space change.
    const revision = JSON.stringify(cache.revisionStatement.get());
    if (revision !== cache.revision) {
        cache.entries.clear();
        cache.revision = revision;
    }
    const key = JSON.stringify([projectPath, modelId]);
    const cached = cache.entries.get(key);
    if (cached) {
        cache.entries.delete(key);
        cache.entries.set(key, cached);
        return cached;
    }
    const vectors = loadProjectCommitEmbeddings(db, projectPath, modelId);
    const size = (entries: Map<string, Float32Array>) =>
        [...entries.values()].reduce((sum, vector) => sum + vector.byteLength, 0);
    if (size(vectors) <= 32 * 1024 * 1024) cache.entries.set(key, vectors);
    while (
        cache.entries.size > 16 ||
        [...cache.entries.values()].reduce((sum, entry) => sum + size(entry), 0) > 32 * 1024 * 1024
    ) {
        const oldest = cache.entries.keys().next().value;
        if (oldest === undefined) break;
        cache.entries.delete(oldest);
    }
    return vectors;
}

interface CommitRow {
    sha: string;
    project_path: string;
    short_sha: string;
    message: string;
    author: string | null;
    committed_at: number;
    indexed_at: number;
}

function rowToCommit(row: CommitRow): StoredGitCommit {
    return {
        sha: row.sha,
        shortSha: row.short_sha,
        projectPath: row.project_path,
        message: row.message,
        author: row.author,
        committedAtMs: row.committed_at,
        indexedAtMs: row.indexed_at,
    };
}

function getFtsStatement(db: Database, dated = false): PreparedStatement {
    const statements = dated ? datedFtsStatements : ftsStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.sha AS sha, c.project_path AS project_path, c.short_sha AS short_sha,
                    c.message AS message, c.author AS author,
                    c.committed_at AS committed_at, c.indexed_at AS indexed_at
             FROM git_commits_fts
             INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
             WHERE c.project_path = ?
               ${dated ? "AND c.committed_at BETWEEN ? AND ?" : ""}
               AND git_commits_fts MATCH ?
             ORDER BY bm25(git_commits_fts) LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

/** Escape LIKE wildcards so the fallback matches the query as a literal substring. */
function escapeLikePattern(text: string): string {
    return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function getLikeFallbackStatement(db: Database, dated = false): PreparedStatement {
    const statements = dated ? datedFtsPlainStatements : ftsPlainStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
             FROM git_commits
             WHERE project_path = ?
               ${dated ? "AND committed_at BETWEEN ? AND ?" : ""}
               AND lower(message) LIKE '%' || lower(?) || '%' ESCAPE '\\'
             ORDER BY committed_at DESC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

function getBySHAsStatement(db: Database, dated = false): PreparedStatement {
    const statements = dated ? datedGetBySHAsStatements : getBySHAsStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
               FROM git_commits
               WHERE project_path = ?
                 ${dated ? "AND committed_at BETWEEN ? AND ?" : ""}
                 AND sha IN (SELECT value FROM json_each(?))`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

export interface GitCommitSearchHit {
    commit: StoredGitCommit;
    /** 0..1 combined score. */
    score: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface SearchGitCommitsOptions {
    limit: number;
    /** Raw semantic score weight. Default 0.7. */
    semanticWeight?: number;
    /** Raw FTS score weight. Default 0.3. */
    ftsWeight?: number;
    /** When semantic OR FTS has only one signal, scale the score by this
     *  penalty to favor hybrid matches. Default 0.8. */
    singleSourcePenalty?: number;
    /** Pre-computed query embedding. When omitted, we skip the semantic pass. */
    queryEmbedding?: Float32Array | null;
    /** ID of the model that generated queryEmbedding; commit vectors are read only from the same model space. */
    queryModelId?: string | null;
    from?: number;
    to?: number;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/**
 * Return top-K commits matching `query` for `projectPath`, combining FTS
 * and semantic ranks. Falls back to LIKE when FTS fails (e.g. short queries).
 */
export function searchGitCommitsSync(
    db: Database,
    projectPath: string,
    query: string,
    options: SearchGitCommitsOptions,
): GitCommitSearchHit[] {
    const trimmed = query.trim();
    if (trimmed.length === 0 || options.limit <= 0) return [];

    const semanticWeight = options.semanticWeight ?? 0.7;
    const ftsWeight = options.ftsWeight ?? 0.3;
    const singleSourcePenalty = options.singleSourcePenalty ?? 0.8;
    const fetchLimit = Math.max(options.limit * 3, 30);
    const dated = options.from !== undefined || options.to !== undefined;
    const from = options.from ?? Number.MIN_SAFE_INTEGER;
    const to = options.to ?? Number.MAX_SAFE_INTEGER;

    // ---- FTS pass -------------------------------------------------------
    const ftsCandidates: StoredGitCommit[] = [];
    const sanitized = sanitizeFtsQuery(trimmed);
    if (sanitized.length > 0) {
        try {
            for (const row of getFtsStatement(db, dated).all(
                projectPath,
                ...(dated ? [from, to] : []),
                sanitized,
                fetchLimit,
            ) as CommitRow[]) {
                ftsCandidates.push(rowToCommit(row));
            }
        } catch (error) {
            log(
                `[git-commits] FTS query failed for "${trimmed}": ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // LIKE fallback when FTS returned nothing (short tokens, exact-substring queries)
    if (ftsCandidates.length === 0) {
        for (const row of getLikeFallbackStatement(db, dated).all(
            projectPath,
            ...(dated ? [from, to] : []),
            escapeLikePattern(trimmed),
            fetchLimit,
        ) as CommitRow[]) {
            ftsCandidates.push(rowToCommit(row));
        }
    }

    const ftsScores = new Map<string, number>();
    ftsCandidates.forEach((commit, rank) => {
        ftsScores.set(commit.sha, 1 / (rank + 1));
    });

    // ---- Semantic pass --------------------------------------------------
    const semanticScores = new Map<string, number>();
    if (options.queryEmbedding && options.queryModelId && options.queryModelId !== "off") {
        const embeddings = getSearchEmbeddings(db, projectPath, options.queryModelId);
        for (const [sha, embedding] of embeddings.entries()) {
            const similarity = clamp01(cosineSimilarity(options.queryEmbedding, embedding));
            if (similarity > 0) {
                semanticScores.set(sha, similarity);
            }
        }
    }

    // ---- Merge + rank ---------------------------------------------------
    const bySha = new Map<string, StoredGitCommit>();
    for (const commit of ftsCandidates) bySha.set(commit.sha, commit);

    // Pull all semantic-only commit metadata in one statement. JSON avoids
    // SQLite's positional-parameter limit for large semantic pools.
    const semanticOnlyShas = [...semanticScores.keys()].filter((sha) => !bySha.has(sha));
    if (semanticOnlyShas.length > 0) {
        const rows = getBySHAsStatement(db, dated).all(
            projectPath,
            ...(dated ? [from, to] : []),
            JSON.stringify(semanticOnlyShas),
        ) as CommitRow[];
        for (const row of rows) bySha.set(row.sha, rowToCommit(row));
    }

    const results: GitCommitSearchHit[] = [];
    for (const [sha, commit] of bySha.entries()) {
        const sem = semanticScores.get(sha);
        const fts = ftsScores.get(sha);
        let score = 0;
        let matchType: GitCommitSearchHit["matchType"] = "fts";

        if (sem !== undefined && fts !== undefined) {
            score = semanticWeight * sem + ftsWeight * fts;
            matchType = "hybrid";
        } else if (sem !== undefined) {
            score = sem * singleSourcePenalty;
            matchType = "semantic";
        } else if (fts !== undefined) {
            score = fts * singleSourcePenalty;
            matchType = "fts";
        }

        if (score <= 0) continue;
        results.push({ commit, score, matchType });
    }

    results.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        // Newer commits win ties
        return right.commit.committedAtMs - left.commit.committedAtMs;
    });

    return results.slice(0, options.limit);
}
