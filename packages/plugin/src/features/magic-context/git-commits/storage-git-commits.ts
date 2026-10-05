/**
 * SQLite storage layer for indexed git commits.
 *
 * Separate from the memory embedding table because:
 *   - Identity is the SHA, not a memory row id
 *   - Lifecycle is managed by git, not by Dreamer review flow
 *   - FTS is also separate so commit queries never pollute memory BM25 ranks
 *
 * Eviction: when `max_commits` is exceeded for a project, we delete the oldest
 * commits by `committed_at ASC` (not by indexed_at — indexed_at can reorder
 * when we catch up after a long absence). ON DELETE CASCADE removes matching
 * embedding rows and FTS triggers remove matching FTS rows, so a single DELETE
 * cleans all three tables.
 */

import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import type { GitCommit } from "./git-log-reader";

export interface StoredGitCommit extends GitCommit {
    projectPath: string;
    indexedAtMs: number;
}

const insertStatements = new WeakMap<Database, PreparedStatement>();
const existingShasStatements = new WeakMap<Database, PreparedStatement>();
const projectCountStatements = new WeakMap<Database, PreparedStatement>();
const evictOverflowStatements = new WeakMap<Database, PreparedStatement>();
const latestCommitTimeStatements = new WeakMap<Database, PreparedStatement>();
const latestCommitShaStatements = new WeakMap<Database, PreparedStatement>();

function getInsertStatement(db: Database): PreparedStatement {
    let stmt = insertStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha) DO UPDATE SET
                 project_path = excluded.project_path,
                 short_sha = excluded.short_sha,
                 message = excluded.message,
                 author = excluded.author,
                 committed_at = excluded.committed_at,
                 indexed_at = excluded.indexed_at
             WHERE git_commits.message != excluded.message`,
        );
        insertStatements.set(db, stmt);
    }
    return stmt;
}

function getExistingShasStatement(db: Database): PreparedStatement {
    let stmt = existingShasStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT sha FROM git_commits WHERE project_path = ?");
        existingShasStatements.set(db, stmt);
    }
    return stmt;
}

function getProjectCountStatement(db: Database): PreparedStatement {
    let stmt = projectCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT COUNT(*) AS count FROM git_commits WHERE project_path = ?");
        projectCountStatements.set(db, stmt);
    }
    return stmt;
}

function getLatestCommitTimeStatement(db: Database): PreparedStatement {
    let stmt = latestCommitTimeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT MAX(committed_at) AS latest FROM git_commits WHERE project_path = ?",
        );
        latestCommitTimeStatements.set(db, stmt);
    }
    return stmt;
}

function getLatestCommitShaStatement(db: Database): PreparedStatement {
    let stmt = latestCommitShaStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT sha FROM git_commits WHERE project_path = ? ORDER BY committed_at DESC, sha DESC LIMIT 1",
        );
        latestCommitShaStatements.set(db, stmt);
    }
    return stmt;
}

function getEvictOverflowStatement(db: Database): PreparedStatement {
    let stmt = evictOverflowStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM git_commits
             WHERE rowid IN (
                 SELECT rowid FROM git_commits
                 WHERE project_path = ?
                 ORDER BY committed_at DESC, sha DESC
                 LIMIT -1 OFFSET ?
             )`,
        );
        evictOverflowStatements.set(db, stmt);
    }
    return stmt;
}

/** Batch upsert in a single transaction. Returns the count actually inserted
 *  or updated (skipped unchanged rows don't count). */
export function upsertCommits(
    db: Database,
    projectPath: string,
    commits: GitCommit[],
): { inserted: number; updated: number } {
    if (commits.length === 0) return { inserted: 0, updated: 0 };

    const existing = new Set<string>();
    for (const row of getExistingShasStatement(db).all(projectPath) as { sha: string }[]) {
        existing.add(row.sha);
    }

    let inserted = 0;
    let updated = 0;
    const now = Date.now();
    const insertStmt = getInsertStatement(db);

    db.transaction(() => {
        for (const commit of commits) {
            const result = insertStmt.run(
                commit.sha,
                projectPath,
                commit.shortSha,
                commit.message,
                commit.author,
                commit.committedAtMs,
                now,
            );
            // changes > 0 means row was inserted or updated (not skipped by WHERE clause)
            if (result.changes > 0) {
                if (existing.has(commit.sha)) {
                    updated++;
                } else {
                    inserted++;
                    existing.add(commit.sha);
                }
            }
        }
    }).immediate();

    return { inserted, updated };
}

/** Return the total count of indexed commits for a project. */
export function getCommitCount(db: Database, projectPath: string): number {
    const row = getProjectCountStatement(db).get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
}

/** Return the most recent committed_at (ms) for this project, or null. */
export function getLatestIndexedCommitTimeMs(db: Database, projectPath: string): number | null {
    const row = getLatestCommitTimeStatement(db).get(projectPath) as
        | { latest: number | null }
        | undefined;
    return row?.latest ?? null;
}

/** SHA of this project's most recently committed indexed commit, or null. */
export function getLatestIndexedCommitSha(db: Database, projectPath: string): string | null {
    const row = getLatestCommitShaStatement(db).get(projectPath) as { sha: string } | undefined;
    return row?.sha ?? null;
}

/** Keep at most `maxCommits` rows for this project, evicting oldest overflow.
 *  Returns number of rows evicted. */
export function enforceProjectCap(db: Database, projectPath: string, maxCommits: number): number {
    if (maxCommits <= 0) return 0;
    const count = getCommitCount(db, projectPath);
    if (count <= maxCommits) return 0;

    // Decide the overflow inside the DELETE statement from the current committed
    // table state. This avoids a stale count-derived `excess` deleting the next
    // oldest page if another process already enforced the same cap.
    getEvictOverflowStatement(db).run(projectPath, maxCommits);
    const after = getCommitCount(db, projectPath);
    const evicted = Math.max(0, count - after);
    if (evicted > 0) {
        log(
            `[git-commits] evicted ${evicted} oldest commits for project ${projectPath} (cap=${maxCommits}, was=${count})`,
        );
    }
    return evicted;
}
