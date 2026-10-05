import type { Database } from "../../shared/sqlite";
import { layoutLkgPrefix } from "./lkg-prefix-chunks";

/**
 * Migration 94: stop rewriting two multi-megabyte records on every pass.
 *
 * SQLite rewrites a whole record whenever its length changes. The LKG slot's
 * `json_prefix` and the replay document in `session_meta.trailing_blank_decisions`
 * both grow a little on every new message, so each pass rewrote megabytes of
 * `context.db` (the LKG row and the whole `session_meta` record that carries the
 * document). This migration moves the growing parts into rows that change
 * independently:
 *
 * - the LKG prefix into fixed-position slices in `lkg_slot_chunks`, with the
 *   slice count, length and hash kept on the (now small) `lkg_slots` row;
 * - each trailing-blank decision into its own `session_replay_decisions` row,
 *   leaving only the envelope (version and other namespaces) in the column.
 */

/**
 * Slices of each LKG prefix, in order; see lkg-prefix-chunks.ts. `hash` is the
 * slice's SHA-256, which a save compares to decide whether the slice changed.
 * It precedes `body` so reading it never walks the body's overflow pages.
 */
export const LKG_SLOT_CHUNKS_DDL = `
    CREATE TABLE IF NOT EXISTS lkg_slot_chunks (
        session_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        hash TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (session_id, chunk)
    );
`;

/** One trailing-blank replay decision per assistant message. */
export const SESSION_REPLAY_DECISIONS_DDL = `
    CREATE TABLE IF NOT EXISTS session_replay_decisions (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
    ) WITHOUT ROWID;
`;

function lkgSlotsDdl(table: string): string {
    return `
        CREATE TABLE IF NOT EXISTS ${table} (
            session_id TEXT PRIMARY KEY,
            json_prefix_chars INTEGER NOT NULL,
            json_prefix_chunks INTEGER NOT NULL,
            json_prefix_hash TEXT NOT NULL,
            input_id_seq TEXT NOT NULL,
            input_content_digests TEXT NOT NULL,
            input_content_signatures TEXT,
            last_input_message_id TEXT NOT NULL,
            model_key TEXT,
            provider_key TEXT,
            captured_at INTEGER NOT NULL,
            row_version INTEGER,
            capture_sequence INTEGER
        );
    `;
}

/** The `lkg_slots` layout from migration 94 on, without the prefix itself. */
export const LKG_SLOTS_DDL = lkgSlotsDdl("lkg_slots");

/** Slots captured longer ago than this are dropped rather than moved; see splitLkgSlotPrefixes. */
const LKG_MOVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function tableExists(db: Database, name: string): boolean {
    return Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name),
    );
}

function columnExists(db: Database, table: string, column: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === column);
}

/**
 * Rebuild `lkg_slots` without `json_prefix`, moving each prefix into slices.
 *
 * The LKG is a recovery cache: the next applied pass of a session recaptures
 * its slot. It matters most right after this migration, because the restart
 * that applies it also restarts the Rust module, and while the module reopens
 * its own store the LKG slot is what a session replays. So slots captured in the
 * last day, the sessions that can send a pass in that window, are moved, and
 * older ones are dropped. Moving every slot would rewrite the whole cache (about
 * 700 MB on a large store, 34 to 73 seconds under load) while holding the write
 * lock every other process needs to start.
 *
 * The prefix is sliced in JavaScript, not with SQL substr, because the slice
 * boundaries and the hash a load verifies must be computed exactly as
 * saveLkgSlotToDb computes them.
 */
export function splitLkgSlotPrefixes(db: Database, now = Date.now()): void {
    db.exec(LKG_SLOT_CHUNKS_DDL);
    if (!tableExists(db, "lkg_slots")) {
        db.exec(LKG_SLOTS_DDL);
        return;
    }
    if (!columnExists(db, "lkg_slots", "json_prefix")) return;

    db.prepare("DELETE FROM lkg_slots WHERE NOT (captured_at >= ?)").run(now - LKG_MOVE_WINDOW_MS);

    db.exec("DROP TABLE IF EXISTS lkg_slots_v94");
    db.exec(lkgSlotsDdl("lkg_slots_v94"));
    const sessionIds = (
        db.prepare("SELECT session_id FROM lkg_slots").all() as Array<{ session_id: unknown }>
    ).map((row) => row.session_id);
    const readPrefix = db.prepare("SELECT json_prefix FROM lkg_slots WHERE session_id IS ?");
    // OR IGNORE skips a row whose metadata breaks a NOT NULL constraint; such a
    // row could never have loaded, so it is not carried over.
    const insertSlot = db.prepare(
        `INSERT OR IGNORE INTO lkg_slots_v94 (
            session_id, json_prefix_chars, json_prefix_chunks, json_prefix_hash,
            input_id_seq, input_content_digests, input_content_signatures,
            last_input_message_id, model_key, provider_key,
            captured_at, row_version, capture_sequence
        )
        SELECT session_id, ?, ?, ?,
            input_id_seq, input_content_digests, input_content_signatures,
            last_input_message_id, model_key, provider_key,
            captured_at, row_version, capture_sequence
        FROM lkg_slots WHERE session_id IS ?`,
    );
    const insertChunk = db.prepare(
        "INSERT INTO lkg_slot_chunks (session_id, chunk, hash, body) VALUES (?, ?, ?, ?)",
    );
    db.prepare("DELETE FROM lkg_slot_chunks").run();
    // One slot at a time, so at most one prefix (up to several megabytes) is in memory.
    for (const sessionId of sessionIds) {
        if (typeof sessionId !== "string") continue;
        const row = readPrefix.get(sessionId) as { json_prefix?: unknown } | undefined;
        if (typeof row?.json_prefix !== "string") continue;
        const layout = layoutLkgPrefix(row.json_prefix);
        const inserted = insertSlot.run(layout.chars, layout.chunks.length, layout.hash, sessionId);
        if (Number(inserted.changes) !== 1) continue;
        for (let index = 0; index < layout.chunks.length; index += 1) {
            insertChunk.run(sessionId, index, layout.chunkHashes[index], layout.chunks[index]);
        }
    }
    db.exec("DROP TABLE lkg_slots");
    db.exec("ALTER TABLE lkg_slots_v94 RENAME TO lkg_slots");
}

/**
 * SQL test for `isPersistedTrailingBlankDecision` (storage-replay-document.ts)
 * over a json_each/json_type pair: "keep", "strip", or "keep:N" with N written
 * without a leading zero and 2 <= N <= 10000.
 */
function validDecisionSql(type: string, value: string): string {
    return `(${type} = 'text' AND (
        ${value} IN ('keep', 'strip') OR (
            ${value} GLOB 'keep:[1-9]*'
            AND substr(${value}, 6) NOT GLOB '*[^0-9]*'
            AND length(${value}) <= 10
            AND CAST(substr(${value}, 6) AS INTEGER) BETWEEN 2 AND 10000
        )
    ))`;
}

/**
 * Move every trailing-blank decision out of the replay document into
 * `session_replay_decisions`.
 *
 * The version test replicates `parseReplayDocument`: a document is the v2
 * envelope when it has a `version` key whose value is not itself a valid
 * decision. A v1 document is the flat map, which may contain an assistant whose
 * id is literally "version". Only documents that parse strictly are moved. A
 * document that does not (malformed JSON, an invalid decision, an unknown
 * envelope version) stays in the column untouched, so that session keeps exactly
 * today's behaviour: lenient readers still see its valid entries and strict
 * writers still refuse it.
 *
 * Afterwards a v2 column holds the envelope with an empty `trailingBlank`, and
 * its other namespaces (`piNative`, `cacheTtlPolicy`) are unchanged. A v1
 * column, which has no other namespaces, is emptied.
 */
export function splitReplayDecisions(db: Database): void {
    db.exec(SESSION_REPLAY_DECISIONS_DDL);
    if (!tableExists(db, "session_meta")) return;
    if (!columnExists(db, "session_meta", "trailing_blank_decisions")) return;

    const doc = "sm.trailing_blank_decisions";
    const hasVersionKey = `json_type(${doc}, '$.version') IS NOT NULL`;
    const versionIsDecision = validDecisionSql(
        `json_type(${doc}, '$.version')`,
        `json_extract(${doc}, '$.version')`,
    );
    const isV2 = `(${hasVersionKey} AND NOT ${versionIsDecision})`;
    const v2Valid = `(
        json_type(${doc}, '$.version') IN ('integer', 'real')
        AND json_extract(${doc}, '$.version') = 2
        AND json_type(${doc}, '$.trailingBlank') = 'object'
        AND NOT EXISTS (
            SELECT 1 FROM json_each(${doc}, '$.trailingBlank') AS entry
            WHERE entry.key = '' OR NOT ${validDecisionSql("entry.type", "entry.value")}
        )
    )`;
    const v1Valid = `NOT EXISTS (
        SELECT 1 FROM json_each(${doc}) AS entry
        WHERE entry.key = '' OR NOT ${validDecisionSql("entry.type", "entry.value")}
    )`;

    db.exec("DROP TABLE IF EXISTS temp.v94_replay_documents");
    db.exec(`
        CREATE TEMP TABLE v94_replay_documents AS
        SELECT session_id, version FROM (
            SELECT sm.session_id AS session_id, CASE WHEN ${isV2} THEN 2 ELSE 1 END AS version,
                CASE WHEN ${isV2} THEN ${v2Valid} ELSE ${v1Valid} END AS strictly_valid
            FROM session_meta AS sm
            WHERE typeof(${doc}) = 'text' AND ${doc} <> ''
                AND json_valid(${doc}) AND json_type(${doc}) = 'object'
        ) WHERE strictly_valid;
    `);
    // json_each yields entries in document order; for a repeated key the later
    // entry wins, as it does in JSON.parse.
    db.exec(`
        INSERT INTO session_replay_decisions (session_id, message_id, decision)
        SELECT sm.session_id, entry.key, entry.value
        FROM v94_replay_documents AS moved
        JOIN session_meta AS sm ON sm.session_id = moved.session_id
        JOIN json_each(
            ${doc}, CASE moved.version WHEN 2 THEN '$.trailingBlank' ELSE '$' END
        ) AS entry
        WHERE true
        ON CONFLICT(session_id, message_id) DO UPDATE SET decision = excluded.decision;
    `);
    db.exec(`
        UPDATE session_meta SET trailing_blank_decisions = (
            SELECT CASE moved.version
                WHEN 2 THEN json_set(session_meta.trailing_blank_decisions, '$.trailingBlank', json('{}'))
                ELSE ''
            END
            FROM v94_replay_documents AS moved WHERE moved.session_id = session_meta.session_id
        )
        WHERE session_id IN (SELECT session_id FROM v94_replay_documents);
    `);
    db.exec("DROP TABLE temp.v94_replay_documents");
}
