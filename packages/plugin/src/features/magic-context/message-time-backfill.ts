import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { Database } from "../../shared/sqlite";
import { withoutSqliteTransformPass, withSqliteBackgroundWriter } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";

export const MESSAGE_TIME_BACKFILL_BATCH_SIZE = 500;

const BACKFILL_STATE_ID = 1;

interface MessageTimeBackfillRow {
    sessionId: string;
    messageOrdinal: number | string;
    messageId: string;
}

interface MessageTimeBackfillStateRow {
    cursorSessionId?: string;
    cursorOrdinal?: number;
    completed?: number;
}

export interface MessageTimeBackfillProgress {
    processed: number;
    cursorSessionId: string;
    cursorOrdinal: number;
    completed: boolean;
}

export type MessageTimeBackfillReader = ((sessionId: string) => RawMessage[]) & {
    readPage?: (
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ) => RawMessage[];
};

const activeBackfills = new WeakMap<Database, Promise<void>>();

function normalizedMessageTime(value: RawMessage["createdAt"]): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function getBackfillState(db: Database): MessageTimeBackfillProgress {
    const row = db
        .prepare(
            `SELECT cursor_session_id AS cursorSessionId,
                    cursor_ordinal AS cursorOrdinal,
                    completed
               FROM message_time_backfill_state
              WHERE id = ?`,
        )
        .get(BACKFILL_STATE_ID) as MessageTimeBackfillStateRow | undefined;
    return {
        processed: 0,
        cursorSessionId: typeof row?.cursorSessionId === "string" ? row.cursorSessionId : "",
        cursorOrdinal:
            typeof row?.cursorOrdinal === "number" && Number.isSafeInteger(row.cursorOrdinal)
                ? row.cursorOrdinal
                : 0,
        completed: row?.completed === 1,
    };
}

function readMessageTimes(
    reader: MessageTimeBackfillReader,
    rows: readonly MessageTimeBackfillRow[],
): Map<string, number> {
    const times = new Map<string, number>();
    const bySession = new Map<string, MessageTimeBackfillRow[]>();
    for (const row of rows) {
        const list = bySession.get(row.sessionId) ?? [];
        list.push(row);
        bySession.set(row.sessionId, list);
    }

    for (const [sessionId, sessionRows] of bySession) {
        const ordinals = sessionRows.map((row) => Number(row.messageOrdinal));
        const firstOrdinal = Math.min(...ordinals);
        const lastOrdinal = Math.max(...ordinals);
        const messages = reader.readPage
            ? reader.readPage(
                  sessionId,
                  Math.max(0, firstOrdinal - 1),
                  Math.max(1, lastOrdinal - firstOrdinal + 1),
                  lastOrdinal,
              )
            : reader(sessionId).filter(
                  (message) => message.ordinal >= firstOrdinal && message.ordinal <= lastOrdinal,
              );
        const wantedIds = new Set(sessionRows.map((row) => row.messageId));
        for (const message of messages) {
            const time = normalizedMessageTime(message.createdAt);
            if (time !== null && wantedIds.has(message.id)) times.set(message.id, time);
        }
    }
    return times;
}

/** Fill one durable cursor window. Host reads happen before the atomic update/cursor commit. */
export function backfillMessageTimesBatch(
    db: Database,
    reader: MessageTimeBackfillReader,
    batchSize = MESSAGE_TIME_BACKFILL_BATCH_SIZE,
): MessageTimeBackfillProgress {
    const state = getBackfillState(db);
    if (state.completed) return state;
    const boundedBatchSize = Math.max(1, Math.floor(batchSize));
    const rows = db
        .prepare(
            `SELECT map.session_id AS sessionId,
                    map.message_ordinal AS messageOrdinal,
                    fts.message_id AS messageId
               FROM message_fts_rowid_map AS map
               JOIN message_history_fts AS fts ON fts.rowid = map.fts_rowid
              WHERE map.message_time_ms IS NULL
                AND (map.session_id > ?
                     OR (map.session_id = ? AND map.message_ordinal > ?))
              ORDER BY map.session_id ASC, map.message_ordinal ASC
              LIMIT ?`,
        )
        .all(
            state.cursorSessionId,
            state.cursorSessionId,
            state.cursorOrdinal,
            boundedBatchSize,
        ) as MessageTimeBackfillRow[];
    const times = readMessageTimes(reader, rows);
    const last = rows.at(-1);
    const completed = rows.length < boundedBatchSize;
    const cursorSessionId = last?.sessionId ?? state.cursorSessionId;
    const cursorOrdinal = last ? Number(last.messageOrdinal) : state.cursorOrdinal;

    let transactionStartedAt = 0;
    db.transaction(() => {
        transactionStartedAt = performance.now();
        db.prepare(`INSERT OR IGNORE INTO message_time_backfill_state
            (id, cursor_session_id, cursor_ordinal, completed) VALUES (?, '', 0, 0)`).run(
            BACKFILL_STATE_ID,
        );
        const update = db.prepare(
            `UPDATE message_fts_rowid_map
                SET message_time_ms = ?
              WHERE session_id = ? AND message_ordinal = ? AND message_time_ms IS NULL`,
        );
        for (const row of rows) {
            const time = times.get(row.messageId);
            if (time !== undefined) update.run(time, row.sessionId, Number(row.messageOrdinal));
        }
        db.prepare(
            `UPDATE message_time_backfill_state
                SET cursor_session_id = ?, cursor_ordinal = ?, completed = ?, updated_at = ?
              WHERE id = ?`,
        ).run(cursorSessionId, cursorOrdinal, completed ? 1 : 0, Date.now(), BACKFILL_STATE_ID);
    }).immediate();
    logSlowWriteTransaction("message_time_backfill", transactionStartedAt);

    return {
        processed: rows.length,
        cursorSessionId,
        cursorOrdinal,
        completed,
    };
}

/** Drain durable legacy rows in bounded turns, yielding between SQLite write windows. */
export async function runMessageTimeBackfill(
    db: Database,
    reader: MessageTimeBackfillReader,
): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (;;) {
        const progress = backfillMessageTimesBatch(db, reader);
        if (progress.completed) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

export function startMessageTimeBackfill(
    db: Database,
    reader: MessageTimeBackfillReader,
): Promise<void> {
    const active = activeBackfills.get(db);
    if (active) return active;
    const run = withoutSqliteTransformPass(() =>
        withSqliteBackgroundWriter(() => runMessageTimeBackfill(db, reader)),
    ).finally(() => activeBackfills.delete(db));
    activeBackfills.set(db, run);
    return run;
}

export function getMessageTimeBackfillProgress(db: Database): MessageTimeBackfillProgress {
    return getBackfillState(db);
}
