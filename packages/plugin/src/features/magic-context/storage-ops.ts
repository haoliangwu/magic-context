import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import type { PendingOp, TagEntry } from "./types";

const queuePendingOpStatements = new WeakMap<Database, PreparedStatement>();
const queueUnchangedDropStatements = new WeakMap<Database, PreparedStatement>();
const getPendingOpsStatements = new WeakMap<Database, PreparedStatement>();
const getPendingOpsCountStatements = new WeakMap<Database, PreparedStatement>();
const hasPendingDropOpsStatements = new WeakMap<Database, PreparedStatement>();
const clearPendingOpsStatements = new WeakMap<Database, PreparedStatement>();
const removePendingOpStatements = new WeakMap<Database, PreparedStatement>();

function getQueuePendingOpStatement(db: Database): PreparedStatement {
    let stmt = queuePendingOpStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness)
             SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
                 SELECT 1 FROM pending_ops WHERE session_id = ? AND tag_id = ? AND operation = ?
             )`,
        );
        queuePendingOpStatements.set(db, stmt);
    }
    return stmt;
}

function getPendingOpsStatement(db: Database): PreparedStatement {
    let stmt = getPendingOpsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT id, session_id, tag_id, operation, queued_at FROM pending_ops WHERE session_id = ? ORDER BY queued_at ASC, id ASC",
        );
        getPendingOpsStatements.set(db, stmt);
    }
    return stmt;
}

function getClearPendingOpsStatement(db: Database): PreparedStatement {
    let stmt = clearPendingOpsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM pending_ops WHERE session_id = ?");
        clearPendingOpsStatements.set(db, stmt);
    }
    return stmt;
}

function getRemovePendingOpStatement(db: Database): PreparedStatement {
    let stmt = removePendingOpStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?");
        removePendingOpStatements.set(db, stmt);
    }
    return stmt;
}

interface PendingOpRow {
    id: number;
    session_id: string;
    tag_id: number;
    operation: string;
    queued_at: number;
}

function isPendingOpRow(row: unknown): row is PendingOpRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_id === "number" &&
        typeof r.operation === "string" &&
        typeof r.queued_at === "number"
    );
}

function toPendingOp(row: PendingOpRow): PendingOp | null {
    if (row.operation !== "drop") {
        sessionLog(row.session_id, `unknown pending operation "${row.operation}"; ignoring`);
        return null;
    }

    return {
        id: row.id,
        sessionId: row.session_id,
        tagId: row.tag_id,
        operation: row.operation,
        queuedAt: row.queued_at,
    };
}

export function queuePendingOp(
    db: Database,
    sessionId: string,
    tagId: number,
    operation: PendingOp["operation"],
    queuedAt: number = Date.now(),
): void {
    // One statement makes retry/overlap idempotent even across SQLite writers,
    // preserving the first row's identity, timestamp and queue order.
    getQueuePendingOpStatement(db).run(
        sessionId,
        tagId,
        operation,
        queuedAt,
        getHarness(),
        sessionId,
        tagId,
        operation,
    );
}

/** Revalidate a preselected row by primary key, never by scanning the session.
 * A consumed, retargeted, owner-adopted, or deleted/reinserted tag must not inherit
 * a stale selection. Size/depth changes do not change its source identity.
 */
export function queuePendingDropForUnchangedTag(
    db: Database,
    sessionId: string,
    tag: TagEntry,
): boolean {
    let statement = queueUnchangedDropStatements.get(db);
    if (!statement) {
        statement =
            db.prepare(`INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness)
            SELECT session_id, tag_number, 'drop', ?, ? FROM tags
            WHERE id = ? AND session_id = ? AND tag_number = ? AND message_id = ?
                AND type = ? AND tool_owner_message_id IS ? AND status = 'active'
                AND NOT EXISTS (
                    SELECT 1 FROM pending_ops WHERE session_id = tags.session_id
                        AND tag_id = tags.tag_number AND operation = 'drop'
                )`);
        queueUnchangedDropStatements.set(db, statement);
    }
    return (
        statement.run(
            Date.now(),
            getHarness(),
            tag.id ?? null,
            sessionId,
            tag.tagNumber,
            tag.messageId,
            tag.type,
            tag.toolOwnerMessageId,
        ).changes > 0
    );
}

export function getPendingOps(db: Database, sessionId: string): PendingOp[] {
    const rows = getPendingOpsStatement(db).all(sessionId).filter(isPendingOpRow);

    return rows.map(toPendingOp).filter((op): op is PendingOp => op !== null);
}

/** Test the same valid drop rows as getPendingOps without materializing the queue. */
export function hasPendingDropOps(db: Database, sessionId: string): boolean {
    let statement = hasPendingDropOpsStatements.get(db);
    if (!statement) {
        // Keep malformed/unsupported rows out of the permission-probe signal,
        // just as the row validator in getPendingOps does. Number fields can
        // be either SQLite integers or reals, but never text or NULL.
        statement = db.prepare(`SELECT EXISTS (
            SELECT 1 FROM pending_ops WHERE session_id = ? AND operation = 'drop'
                AND typeof(id) IN ('integer', 'real')
                AND typeof(session_id) = 'text'
                AND typeof(tag_id) IN ('integer', 'real')
                AND typeof(queued_at) IN ('integer', 'real')
        ) AS present`);
        hasPendingDropOpsStatements.set(db, statement);
    }
    return (statement.get(sessionId) as { present: number }).present === 1;
}

/** Read durable queue depth without loading rows on a deferred pass. */
export function getPendingOpsCount(db: Database, sessionId: string): number | null {
    try {
        let statement = getPendingOpsCountStatements.get(db);
        if (!statement) {
            statement = db.prepare(
                "SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?",
            );
            getPendingOpsCountStatements.set(db, statement);
        }
        const row = statement.get(sessionId) as { count?: number } | null;
        return typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : null;
    } catch {
        // A diagnostic read must never turn a fail-open transform into a failure.
        return null;
    }
}

export function clearPendingOps(db: Database, sessionId: string): void {
    getClearPendingOpsStatement(db).run(sessionId);
}

export function removePendingOp(db: Database, sessionId: string, tagId: number): void {
    getRemovePendingOpStatement(db).run(sessionId, tagId);
}
