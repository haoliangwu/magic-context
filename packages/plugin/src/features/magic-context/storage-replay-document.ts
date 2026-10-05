import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";

const CAS_RETRY_LIMIT = 5;
const MISSING_REPLAY_DOCUMENT_COLUMN = Symbol("missing replay document column");

export type PersistedTrailingBlankDecision = "keep" | `keep:${number}` | "strip";

export interface ReplayDocument {
    version: 1 | 2;
    trailingBlank: Record<string, PersistedTrailingBlankDecision>;
    piNative?: unknown;
    [key: string]: unknown;
}

export function isPersistedTrailingBlankDecision(
    value: unknown,
): value is PersistedTrailingBlankDecision {
    if (value === "keep" || value === "strip") return true;
    if (typeof value !== "string" || !value.startsWith("keep:")) return false;
    const countText = value.slice("keep:".length);
    if (!/^[1-9]\d*$/.test(countText)) return false;
    const count = Number(countText);
    return Number.isSafeInteger(count) && count > 1 && count <= 10_000;
}

export class ReplayDocumentError extends Error {
    constructor(reason: string) {
        super(`invalid persisted replay document: ${reason}`);
        this.name = "ReplayDocumentError";
    }
}

function invalidReplayDocument(reason: string): ReplayDocumentError {
    return new ReplayDocumentError(reason);
}

type BlankParseMode = "strict" | "read";

function parseTrailingBlank(
    value: unknown,
    mode: BlankParseMode,
): Record<string, PersistedTrailingBlankDecision> {
    if (!isRecord(value)) {
        throw invalidReplayDocument("trailingBlank must be an object");
    }

    const entries: Array<[string, PersistedTrailingBlankDecision]> = [];
    for (const [id, decision] of Object.entries(value)) {
        if (id.length === 0 || !isPersistedTrailingBlankDecision(decision)) {
            if (mode === "read") continue;
            throw invalidReplayDocument("trailingBlank contains an invalid decision");
        }
        entries.push([id, decision]);
    }
    return Object.fromEntries(entries);
}

function parseV2ReplayDocument(
    parsed: Record<string, unknown>,
    mode: BlankParseMode,
): ReplayDocument {
    if (parsed.version !== 2) {
        throw invalidReplayDocument("unknown envelope version");
    }
    if (!Object.hasOwn(parsed, "trailingBlank")) {
        throw invalidReplayDocument("version 2 is missing trailingBlank");
    }

    return {
        ...parsed,
        version: 2,
        trailingBlank: parseTrailingBlank(parsed.trailingBlank, mode),
    };
}

/**
 * Decode the shared replay document. The historical v1 storage format is the
 * flat trailing-blank map itself; v2 is the namespaced envelope. Parsing is
 * deliberately strict so writers cannot turn an unrecognized document into a
 * new, lossy format.
 */
export function parseReplayDocument(
    raw: string | null | undefined,
    mode: BlankParseMode = "strict",
): ReplayDocument {
    if (raw === null || raw === undefined || raw === "") {
        return { version: 1, trailingBlank: {} };
    }
    if (typeof raw !== "string") {
        throw invalidReplayDocument("stored value is not text");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw invalidReplayDocument("stored value is not JSON");
    }
    if (!isRecord(parsed)) {
        throw invalidReplayDocument("stored value is not an object");
    }

    // A legacy assistant may itself be named "version".
    if (Object.hasOwn(parsed, "version") && !isPersistedTrailingBlankDecision(parsed.version))
        return parseV2ReplayDocument(parsed, mode);

    return {
        version: 1,
        trailingBlank: parseTrailingBlank(parsed, mode),
    };
}

/** Serialize v1 as its historical flat map and v2 as its namespaced envelope. */
export function serializeReplayDocument(doc: ReplayDocument): string {
    const trailingBlank = parseTrailingBlank(doc.trailingBlank, "strict");
    if (doc.version === 1) return JSON.stringify(trailingBlank);
    if (doc.version !== 2) {
        throw invalidReplayDocument("unknown document version");
    }

    return JSON.stringify({
        ...doc,
        version: 2,
        trailingBlank,
    });
}

function isMissingReplayDocumentColumn(error: unknown): boolean {
    return (
        error instanceof Error && /no such column: trailing_blank_decisions/i.test(error.message)
    );
}

/*
 * Where the document lives. `session_meta.trailing_blank_decisions` holds the
 * envelope: the version and every namespace other than the trailing-blank map
 * (`piNative`, `cacheTtlPolicy`). Since migration 94 each trailing-blank decision
 * is its own row in `session_replay_decisions`. The map grows by one entry per
 * assistant message, and SQLite rewrites a whole record whenever its length
 * changes, so keeping the map in the column made every new decision rewrite the
 * session's entire `session_meta` record.
 *
 * The column may still carry trailing-blank entries: migration 94 leaves a
 * document it cannot parse strictly where it is, so that session keeps today's
 * behaviour (lenient reads see its valid entries, strict writers refuse it).
 * Readers therefore overlay the rows on whatever map the column holds; a row
 * wins over a column entry for the same assistant.
 *
 * A database without the decision table (a schema built by hand, or one that
 * predates migration 94) keeps the whole map in the column, as before.
 */
const decisionTablePresent = new WeakMap<Database, true>();

function hasReplayDecisionTable(db: Database): boolean {
    if (decisionTablePresent.has(db)) return true;
    const row = db
        .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session_replay_decisions'",
        )
        .get() as { present?: number } | undefined;
    if (row?.present !== 1) return false;
    decisionTablePresent.set(db, true);
    return true;
}

/** Stored decision rows for the given assistants, or for the whole session when `messageIds` is omitted. */
function readDecisionRows(
    db: Database,
    sessionId: string,
    messageIds?: readonly string[],
): Array<{ message_id: string; decision: unknown }> {
    if (messageIds === undefined) {
        return db
            .prepare(
                "SELECT message_id, decision FROM session_replay_decisions WHERE session_id = ?",
            )
            .all(sessionId) as Array<{ message_id: string; decision: unknown }>;
    }
    if (messageIds.length === 0) return [];
    // One statement for any number of ids: the list is bound as a JSON array
    // rather than expanded into placeholders.
    return db
        .prepare(
            `SELECT message_id, decision FROM session_replay_decisions
             WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
        )
        .all(sessionId, JSON.stringify(messageIds)) as Array<{
        message_id: string;
        decision: unknown;
    }>;
}

function readRawReplayDocument(
    db: Database,
    sessionId: string,
): string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN {
    try {
        const row = db
            .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { trailing_blank_decisions?: unknown } | undefined;
        const raw = row?.trailing_blank_decisions;
        if (raw === null || raw === undefined || typeof raw === "string") return raw;
        throw invalidReplayDocument("stored value is not text");
    } catch (error) {
        if (isMissingReplayDocumentColumn(error)) return MISSING_REPLAY_DOCUMENT_COLUMN;
        throw error;
    }
}

// Cache only validated trailing-blank dictionaries, never mutable replay documents.
// The raw column is re-read on every access, so writes from another connection,
// a rollback, or a value changed and later restored cannot leave a stale interpretation.
const trailingBlankReadCache = new WeakMap<
    Database,
    Map<
        string,
        {
            raw: string | null | undefined;
            decisions: Readonly<Record<string, PersistedTrailingBlankDecision>>;
        }
    >
>();
const TRAILING_BLANK_CACHE_MAX_SESSIONS = 4;
const TRAILING_BLANK_CACHE_MAX_CHARS = 4 * 1024 * 1024;

/** Read only visible assistants' choices without re-enumerating archived history. */
export function readReplayTrailingBlankSubset(
    db: Database,
    sessionId: string,
    messageIds: Iterable<string>,
): Map<string, PersistedTrailingBlankDecision> {
    const raw = readRawReplayDocument(db, sessionId);
    if (raw === MISSING_REPLAY_DOCUMENT_COLUMN) return new Map();
    let cache = trailingBlankReadCache.get(db);
    if (!cache) {
        cache = new Map();
        trailingBlankReadCache.set(db, cache);
    }
    let entry = cache.get(sessionId);
    if (!entry || entry.raw !== raw) {
        cache.delete(sessionId);
        entry = { raw, decisions: parseReplayDocument(raw, "read").trailingBlank };
        // Bound retained source text per connection as well as session cardinality.
        // Oversized documents are still readable, but must not pin unbounded history.
        if ((raw?.length ?? 0) <= TRAILING_BLANK_CACHE_MAX_CHARS) {
            let retainedChars = raw?.length ?? 0;
            for (const value of cache.values()) retainedChars += value.raw?.length ?? 0;
            while (
                cache.size >= TRAILING_BLANK_CACHE_MAX_SESSIONS ||
                retainedChars > TRAILING_BLANK_CACHE_MAX_CHARS
            ) {
                const oldest = cache.keys().next().value;
                if (oldest === undefined) break;
                retainedChars -= cache.get(oldest)?.raw?.length ?? 0;
                cache.delete(oldest);
            }
            cache.set(sessionId, entry);
        }
    } else {
        cache.delete(sessionId);
        cache.set(sessionId, entry);
    }
    const wanted = [...new Set(messageIds)];
    const rowDecisions = new Map<string, PersistedTrailingBlankDecision>();
    if (hasReplayDecisionTable(db)) {
        for (const row of readDecisionRows(db, sessionId, wanted)) {
            // Lenient like the column read: an unreadable row is skipped.
            if (isPersistedTrailingBlankDecision(row.decision)) {
                rowDecisions.set(row.message_id, row.decision);
            }
        }
    }
    const selected = new Map<string, PersistedTrailingBlankDecision>();
    for (const id of wanted) {
        const fromRow = rowDecisions.get(id);
        if (fromRow !== undefined) selected.set(id, fromRow);
        else if (Object.hasOwn(entry.decisions, id)) selected.set(id, entry.decisions[id]);
    }
    return selected;
}

/**
 * Read the envelope stored in `session_meta` without creating session metadata:
 * every namespace, but only the trailing-blank entries the column itself still
 * carries. Readers of other namespaces use this so they never load the
 * session's decision rows.
 */
export function readReplayEnvelope(
    db: Database,
    sessionId: string,
    mode: BlankParseMode = "strict",
): ReplayDocument {
    const raw = readRawReplayDocument(db, sessionId);
    if (raw === MISSING_REPLAY_DOCUMENT_COLUMN) {
        return { version: 1, trailingBlank: {} };
    }
    return parseReplayDocument(raw, mode);
}

/**
 * Read the complete document without creating session metadata: the envelope
 * with every trailing-blank decision, rows overlaid on any column entries.
 */
export function readReplayDocument(
    db: Database,
    sessionId: string,
    mode: BlankParseMode = "strict",
): ReplayDocument {
    const doc = readReplayEnvelope(db, sessionId, mode);
    if (!hasReplayDecisionTable(db)) return doc;
    const rows = readDecisionRows(db, sessionId);
    if (rows.length === 0) return doc;
    const merged = new Map(Object.entries(doc.trailingBlank));
    for (const row of rows) {
        if (!isPersistedTrailingBlankDecision(row.decision)) {
            if (mode === "read") continue;
            throw invalidReplayDocument("trailingBlank contains an invalid decision");
        }
        merged.set(row.message_id, row.decision);
    }
    return { ...doc, trailingBlank: Object.fromEntries(merged) };
}

/**
 * Every trailing-blank decision of a session, for a caller that already read the
 * `session_meta.trailing_blank_decisions` column as part of a larger row. Lenient
 * like `readReplayDocument(..., "read")`; a column that cannot be read even
 * leniently yields no decisions at all.
 */
export function readAllTrailingBlankDecisions(
    db: Database,
    sessionId: string,
    rawColumn: string | null | undefined,
): Map<string, PersistedTrailingBlankDecision> {
    let decisions: Map<string, PersistedTrailingBlankDecision>;
    try {
        decisions = new Map(Object.entries(parseReplayDocument(rawColumn, "read").trailingBlank));
    } catch (error) {
        if (error instanceof ReplayDocumentError) return new Map();
        throw error;
    }
    if (!hasReplayDecisionTable(db)) return decisions;
    for (const row of readDecisionRows(db, sessionId)) {
        if (isPersistedTrailingBlankDecision(row.decision))
            decisions.set(row.message_id, row.decision);
    }
    return decisions;
}

/**
 * Mutate the envelope with a bounded whole-column CAS. The mutator sees the
 * column's own content (see readReplayEnvelope); trailing-blank decisions are
 * changed through updateTrailingBlankDecisions. A false result means either that
 * the stored document was unreadable/unsupported, the column is unavailable on
 * an old schema, or all compare-and-swap attempts lost. A mutator returning
 * false is a successful byte-preserving no-op.
 */
export function updateReplayDocument(
    db: Database,
    sessionId: string,
    mutate: (doc: ReplayDocument) => boolean,
): boolean {
    let initial: string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN;
    try {
        initial = readRawReplayDocument(db, sessionId);
    } catch (error) {
        if (error instanceof ReplayDocumentError) return false;
        throw error;
    }
    if (initial === MISSING_REPLAY_DOCUMENT_COLUMN) return false;

    ensureSessionMetaRow(db, sessionId);
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        let raw: string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN;
        try {
            raw = readRawReplayDocument(db, sessionId);
        } catch (error) {
            if (error instanceof ReplayDocumentError) return false;
            throw error;
        }
        if (raw === MISSING_REPLAY_DOCUMENT_COLUMN) return false;

        let doc: ReplayDocument;
        try {
            doc = parseReplayDocument(raw);
        } catch (error) {
            if (error instanceof ReplayDocumentError) return false;
            throw error;
        }
        if (!mutate(doc)) return true;

        const next = serializeReplayDocument(doc);
        if (next === raw) return true;
        const result = db
            .prepare(
                "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?",
            )
            .run(next, sessionId, raw);
        if (result.changes > 0) return true;
    }

    sessionLog(sessionId, `trailing_blank_decisions CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

const DECISION_CONFLICT = Symbol("replay decision changed concurrently");

/**
 * Change trailing-blank decisions for the given assistants. `decide` receives
 * the current decision of each requested assistant that has one and returns the
 * decisions to store (unchanged entries are ignored). Each stored row is
 * compared against the value `decide` saw, so a concurrent writer's change is
 * never overwritten: the whole batch rolls back and is decided again, up to the
 * same retry bound as the document CAS. Returns false when the stored document
 * is unreadable, the schema has no replay column, a requested row holds an
 * invalid decision, or every attempt lost.
 */
export function updateTrailingBlankDecisions(
    db: Database,
    sessionId: string,
    messageIds: Iterable<string>,
    decide: (
        current: ReadonlyMap<string, PersistedTrailingBlankDecision>,
    ) => ReadonlyMap<string, PersistedTrailingBlankDecision>,
): boolean {
    const ids = [...new Set(messageIds)].filter((id) => id.length > 0);
    if (!hasReplayDecisionTable(db)) {
        return updateReplayDocument(db, sessionId, (doc) => {
            const current = new Map<string, PersistedTrailingBlankDecision>();
            for (const id of ids) {
                if (Object.hasOwn(doc.trailingBlank, id)) current.set(id, doc.trailingBlank[id]);
            }
            let changed = false;
            for (const [id, decision] of decide(current)) {
                if (current.get(id) === decision) continue;
                Object.defineProperty(doc.trailingBlank, id, {
                    value: decision,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
                changed = true;
            }
            return changed;
        });
    }

    let initial: string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN;
    try {
        initial = readRawReplayDocument(db, sessionId);
    } catch (error) {
        if (error instanceof ReplayDocumentError) return false;
        throw error;
    }
    if (initial === MISSING_REPLAY_DOCUMENT_COLUMN) return false;

    ensureSessionMetaRow(db, sessionId);
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        let columnDecisions: Record<string, PersistedTrailingBlankDecision>;
        try {
            const raw = readRawReplayDocument(db, sessionId);
            if (raw === MISSING_REPLAY_DOCUMENT_COLUMN) return false;
            // Strict, like the document CAS: an unreadable document refuses writes.
            columnDecisions = parseReplayDocument(raw).trailingBlank;
        } catch (error) {
            if (error instanceof ReplayDocumentError) return false;
            throw error;
        }
        const stored = new Map<string, string>();
        for (const row of readDecisionRows(db, sessionId, ids)) {
            if (!isPersistedTrailingBlankDecision(row.decision)) return false;
            stored.set(row.message_id, row.decision);
        }
        const current = new Map<string, PersistedTrailingBlankDecision>();
        for (const id of ids) {
            const fromRow = stored.get(id);
            if (fromRow !== undefined) current.set(id, fromRow as PersistedTrailingBlankDecision);
            else if (Object.hasOwn(columnDecisions, id)) current.set(id, columnDecisions[id]);
        }
        const changes = [...decide(current)].filter(
            ([id, decision]) => current.get(id) !== decision,
        );
        for (const [id, decision] of changes) {
            if (id.length === 0 || !isPersistedTrailingBlankDecision(decision)) {
                throw invalidReplayDocument("trailingBlank contains an invalid decision");
            }
        }
        if (changes.length === 0) return true;

        try {
            db.transaction(() => {
                const insert = db.prepare(
                    `INSERT INTO session_replay_decisions (session_id, message_id, decision)
                     VALUES (?, ?, ?) ON CONFLICT(session_id, message_id) DO NOTHING`,
                );
                const update = db.prepare(
                    `UPDATE session_replay_decisions SET decision = ?
                     WHERE session_id = ? AND message_id = ? AND decision IS ?`,
                );
                for (const [id, decision] of changes) {
                    const expected = stored.get(id);
                    const result =
                        expected === undefined
                            ? insert.run(sessionId, id, decision)
                            : update.run(decision, sessionId, id, expected);
                    if (Number(result.changes) !== 1) throw DECISION_CONFLICT;
                }
            }).immediate();
            return true;
        } catch (error) {
            if (error === DECISION_CONFLICT) continue;
            throw error;
        }
    }

    sessionLog(sessionId, `session_replay_decisions CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

/**
 * Replace a session's whole stored document: the envelope in `session_meta`
 * and, when the decision table exists, every decision row. Used when a session
 * is cloned, so the destination starts with exactly the filtered source
 * document. The caller owns the surrounding transaction.
 */
export function writeReplayDocument(db: Database, sessionId: string, doc: ReplayDocument): void {
    if (!hasReplayDecisionTable(db)) {
        db.prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?").run(
            serializeReplayDocument(doc),
            sessionId,
        );
        return;
    }
    const decisions = parseTrailingBlank(doc.trailingBlank, "strict");
    db.prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?").run(
        doc.version === 1 ? "" : serializeReplayDocument({ ...doc, trailingBlank: {} }),
        sessionId,
    );
    db.prepare("DELETE FROM session_replay_decisions WHERE session_id = ?").run(sessionId);
    const insert = db.prepare(
        "INSERT INTO session_replay_decisions (session_id, message_id, decision) VALUES (?, ?, ?)",
    );
    for (const [id, decision] of Object.entries(decisions)) insert.run(sessionId, id, decision);
}
