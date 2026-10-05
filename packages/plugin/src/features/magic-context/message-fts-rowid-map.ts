import { createHash } from "node:crypto";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { withoutSqliteTransformPass, withSqliteBackgroundWriter } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";

export const MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE = 100;

const BACKFILL_STATE_ID = 1;
const EMPTY_INDEX_CONTENT_HASH = createHash("sha256").update("").digest("hex");

interface BackfillStateRow {
    watermarkRowid?: number;
    completed?: number;
}

interface BackfillFtsRow {
    ftsRowid?: number;
    sessionId?: string;
    messageOrdinal?: number | string;
}

export interface MessageFtsRowidMapBackfillProgress {
    processed: number;
    watermarkRowid: number;
    completed: boolean;
}

const upsertMapStatements = new WeakMap<Database, PreparedStatement>();
const rangeReadyStatements = new WeakMap<Database, PreparedStatement>();
const updateTimeStatements = new WeakMap<Database, PreparedStatement>();
const activeBackfills = new WeakMap<Database, Promise<void>>();

function getUpsertMapStatement(db: Database): PreparedStatement {
    let statement = upsertMapStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `INSERT INTO message_fts_rowid_map
                 (session_id, message_ordinal, fts_rowid, message_time_ms)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, message_ordinal) DO UPDATE SET
                 fts_rowid = excluded.fts_rowid,
                 message_time_ms = COALESCE(
                     excluded.message_time_ms,
                     message_fts_rowid_map.message_time_ms
                 )`,
        );
        upsertMapStatements.set(db, statement);
    }
    return statement;
}

function getBackfillState(db: Database): MessageFtsRowidMapBackfillProgress {
    const row = db
        .prepare(
            `SELECT watermark_rowid AS watermarkRowid, completed
             FROM message_fts_rowid_map_backfill_state
             WHERE id = ?`,
        )
        .get(BACKFILL_STATE_ID) as BackfillStateRow | undefined;
    return {
        processed: 0,
        watermarkRowid:
            typeof row?.watermarkRowid === "number" && Number.isSafeInteger(row.watermarkRowid)
                ? row.watermarkRowid
                : 0,
        completed: row?.completed === 1,
    };
}

/** Record the FTS row identity in the caller's message-index transaction. */
export function recordMessageFtsRowid(
    db: Database,
    sessionId: string,
    messageOrdinal: number,
    ftsRowid: number | bigint,
    messageTimeMs: number | null = null,
): void {
    const numericRowid = Number(ftsRowid);
    if (!Number.isSafeInteger(numericRowid) || numericRowid <= 0) {
        throw new Error(`invalid message FTS rowid: ${String(ftsRowid)}`);
    }
    const normalizedTime =
        typeof messageTimeMs === "number" &&
        Number.isSafeInteger(messageTimeMs) &&
        messageTimeMs >= 0
            ? messageTimeMs
            : null;
    getUpsertMapStatement(db).run(sessionId, messageOrdinal, numericRowid, normalizedTime);
}

/** Fill a missing indexed timestamp without changing the FTS row identity. */
export function recordIndexedMessageTime(
    db: Database,
    sessionId: string,
    messageOrdinal: number,
    messageTimeMs: number | null | undefined,
): void {
    if (
        typeof messageTimeMs !== "number" ||
        !Number.isSafeInteger(messageTimeMs) ||
        messageTimeMs < 0
    ) {
        return;
    }
    let statement = updateTimeStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `UPDATE message_fts_rowid_map
                SET message_time_ms = ?
              WHERE session_id = ? AND message_ordinal = ?
                AND message_time_ms IS NULL`,
        );
        updateTimeStatements.set(db, statement);
    }
    statement.run(messageTimeMs, sessionId, messageOrdinal);
}

/**
 * Map one bounded rowid-ascending FTS window and persist its watermark atomically.
 * The rowid constraint is an FTS5 point/range access; it never filters an
 * UNINDEXED identity column.
 */
export function backfillMessageFtsRowidMapBatch(
    db: Database,
    batchSize = MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE,
): MessageFtsRowidMapBackfillProgress {
    const boundedBatchSize = Number.isFinite(batchSize)
        ? Math.min(MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE, Math.max(1, Math.floor(batchSize)))
        : MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE;
    let progress: MessageFtsRowidMapBackfillProgress = {
        processed: 0,
        watermarkRowid: 0,
        completed: false,
    };

    let transactionStartedAt = 0;
    db.transaction(() => {
        transactionStartedAt = performance.now();
        db.prepare(`INSERT OR IGNORE INTO message_fts_rowid_map_backfill_state
            (id, watermark_rowid, completed) VALUES (?, 0, 0)`).run(BACKFILL_STATE_ID);
        const state = getBackfillState(db);
        if (state.completed) {
            progress = state;
            return;
        }
        // Keep the bounded read and mapping atomic: a concurrent FTS delete/insert
        // could recycle a rowid between discovery and recording its owner.
        const rows = db
            .prepare(`SELECT rowid AS ftsRowid,
            session_id AS sessionId, message_ordinal AS messageOrdinal
            FROM message_history_fts WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`)
            .all(state.watermarkRowid, boundedBatchSize) as BackfillFtsRow[];
        let watermarkRowid = state.watermarkRowid;
        for (const row of rows) {
            const ftsRowid = Number(row.ftsRowid);
            const messageOrdinal = Number(row.messageOrdinal);
            if (Number.isSafeInteger(ftsRowid) && ftsRowid > watermarkRowid) {
                watermarkRowid = ftsRowid;
            }
            if (
                typeof row.sessionId === "string" &&
                Number.isSafeInteger(messageOrdinal) &&
                messageOrdinal >= 0 &&
                Number.isSafeInteger(ftsRowid) &&
                ftsRowid > 0
            ) {
                recordMessageFtsRowid(db, row.sessionId, messageOrdinal, ftsRowid);
            }
        }

        const completed = rows.length < boundedBatchSize;
        db.prepare(
            `UPDATE message_fts_rowid_map_backfill_state
             SET watermark_rowid = ?, completed = ?, updated_at = ?
             WHERE id = ?`,
        ).run(watermarkRowid, completed ? 1 : 0, Date.now(), BACKFILL_STATE_ID);
        progress = {
            processed: rows.length,
            watermarkRowid,
            completed,
        };
    }).immediate();
    logSlowWriteTransaction("message_fts_rowid_backfill", transactionStartedAt);

    return progress;
}

/** Drain legacy FTS rows in bounded turns so SQLite never owns the host loop. */
export async function runMessageFtsRowidMapBackfill(db: Database): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (;;) {
        const progress = backfillMessageFtsRowidMapBatch(db);
        if (progress.completed) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

/** Coalesce OpenCode and Pi startup attempts sharing one in-process DB handle. */
export function startMessageFtsRowidMapBackfill(db: Database): Promise<void> {
    const active = activeBackfills.get(db);
    if (active) return active;
    const run = withoutSqliteTransformPass(() =>
        withSqliteBackgroundWriter(() => runMessageFtsRowidMapBackfill(db)),
    ).finally(() => {
        activeBackfills.delete(db);
    });
    activeBackfills.set(db, run);
    return run;
}

/**
 * A partially backfilled span is readable only when the ordinary source table
 * proves every ordinal is known and every indexable source row already has a
 * map entry. Legacy spans without complete source metadata wait for the global
 * rowid backfill to finish.
 */
export function messageFtsOrdinalRangeIsMapped(
    db: Database,
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
): boolean {
    if (endOrdinal < startOrdinal) return true;
    if (getBackfillState(db).completed) return true;

    let statement = rangeReadyStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT COUNT(DISTINCT source.message_ordinal) AS sourceOrdinalCount,
                    COUNT(DISTINCT CASE
                        WHEN source.role IN ('user', 'assistant')
                         AND source.normalized_content_hash != ?
                        THEN source.message_ordinal
                    END) AS expectedMapCount,
                    COUNT(DISTINCT CASE
                        WHEN source.role IN ('user', 'assistant')
                         AND source.normalized_content_hash != ?
                         AND map.fts_rowid IS NOT NULL
                        THEN source.message_ordinal
                    END) AS mappedCount
             FROM message_history_source AS source
             LEFT JOIN message_fts_rowid_map AS map
               ON map.session_id = source.session_id
              AND map.message_ordinal = source.message_ordinal
             WHERE source.session_id = ?
               AND source.message_ordinal BETWEEN ? AND ?`,
        );
        rangeReadyStatements.set(db, statement);
    }
    const row = statement.get(
        EMPTY_INDEX_CONTENT_HASH,
        EMPTY_INDEX_CONTENT_HASH,
        sessionId,
        startOrdinal,
        endOrdinal,
    ) as
        | { sourceOrdinalCount?: number; expectedMapCount?: number; mappedCount?: number }
        | undefined;
    const ordinalCount = endOrdinal - startOrdinal + 1;
    return row?.sourceOrdinalCount === ordinalCount && row.expectedMapCount === row.mappedCount;
}

export function getMessageFtsRowidMapBackfillProgress(
    db: Database,
): MessageFtsRowidMapBackfillProgress {
    return getBackfillState(db);
}

/**
 * Delete the FTS rows of whole sessions that the rowid map cannot reach yet.
 *
 * Whole-session clears delete FTS rows through `message_fts_rowid_map`. Rows
 * written before the map existed get their map entry only when the bounded
 * backfill reaches them, and the backfill walks rowids in ascending order, so
 * every such unmapped row sits above its watermark. Until the backfill
 * completes, a clear also sweeps that rowid range for the sessions; otherwise
 * the rows outlive the clear, get mapped later, and surface in search as stale
 * duplicates forever, even after the session is deleted. The rowid bound keeps
 * the sweep to the part of the table the backfill has not reached.
 */
export function deleteUnmappedMessageFtsRows(db: Database, sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    const state = getBackfillState(db);
    if (state.completed) return;
    const placeholders = sessionIds.map(() => "?").join(", ");
    db.prepare(
        `DELETE FROM message_history_fts
         WHERE rowid > ? AND session_id IN (${placeholders})`,
    ).run(state.watermarkRowid, ...sessionIds);
}
