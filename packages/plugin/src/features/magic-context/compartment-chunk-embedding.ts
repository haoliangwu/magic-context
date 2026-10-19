import { createHash } from "node:crypto";

import {
    estimateTokens,
    getTokenEstimatorFingerprint,
} from "../../hooks/magic-context/read-session-formatting";
import { getHarness } from "../../shared/harness";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { isSynapseEmbeddingTruncated } from "./memory/embedding-synapse";
import { messageFtsOrdinalRangeIsMapped } from "./message-fts-rowid-map";
import { recursiveCharacterSplit } from "./recursive-text-splitter";

export const DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS = 512;

/**
 * Fraction of the configured `max_input_tokens` we actually fill per window.
 *
 * `max_input_tokens` is the provider's HARD context ceiling, but we window using
 * our own `estimateTokens` heuristic, which drifts from the provider's real
 * tokenizer (observed ~1% on Qwen3 — a chunk we sized at 8192 counted 8261 on
 * the server and was silently truncated). Targeting 90% of the ceiling absorbs
 * that cross-tokenizer drift so a window never exceeds the provider limit.
 */
export const CHUNK_WINDOW_SAFETY_RATIO = 0.9;

interface FtsChunkRow {
    messageOrdinal: number | string;
    role: string;
    content: string;
}

interface ExistingChunkHashRow {
    windowIndex: number;
    chunkHash: string;
}

interface SearchChunkRow {
    rowId: number;
    startTime: number | null;
    endTime: number | null;
    compartmentId: number;
    sessionId: string;
    title: string;
    compartmentStart: number;
    compartmentEnd: number;
    windowIndex: number;
    windowStart: number;
    windowEnd: number;
    chunkHash: string;
    modelId: string;
    dims: number;
    vector: Uint8Array | ArrayBuffer;
}

interface SearchPoolProbeRow {
    rowCount: number;
    maxRowId: number;
    rowIdSum: number;
    metadata: Map<number, SearchScopeMetadataRow>;
    ids: readonly number[];
}

interface SearchScopeMetadataRow {
    readonly [column: string]: number | string | null;
    readonly rowId: number;
}

const SEARCH_SCOPE_METADATA_FIELDS = [
    "rowId",
    "compartmentId",
    "sessionId",
    "projectPath",
    "harness",
    "windowIndex",
    "windowStart",
    "windowEnd",
    "chunkHash",
    "modelId",
    "dims",
    "createdAt",
    "vectorBytes",
    "compartmentSessionId",
    "title",
    "compartmentStart",
    "compartmentEnd",
    "startTime",
    "endTime",
] as const;

interface DecodedSearchPoolEntry {
    pool: Map<string, DecodedSearchPoolEntry>;
    key: string;
    rowCount: number;
    maxRowId: number;
    rowIdSum: number;
    metadata: Map<number, SearchScopeMetadataRow>;
    ids: readonly number[];
    rows: StoredCompartmentChunkEmbedding[];
    byteSize: number;
}

interface BackfillCandidateRow {
    id: number;
    sessionId: string;
    startMessage: number;
    endMessage: number;
    title: string;
}

export interface CompartmentChunkBackfillCandidate {
    id: number;
    sessionId: string;
    startMessage: number;
    endMessage: number;
    title: string;
}

export interface CompartmentChunkWindow {
    windowIndex: number;
    startOrdinal: number;
    endOrdinal: number;
    text: string;
    chunkHash: string;
}

export interface StoredCompartmentChunkEmbedding {
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    windowIndex: number;
    windowStartOrdinal: number;
    windowEndOrdinal: number;
    chunkHash: string;
    modelId: string;
    dims: number;
    vector: Float32Array;
}

export interface SaveCompartmentChunkEmbeddingInput {
    compartmentId: number;
    sessionId: string;
    projectPath: string;
    window: CompartmentChunkWindow;
    modelId: string;
    vector: Float32Array;
    createdAt?: number;
}

export const MESSAGE_FTS_CHUNK_LOAD_SQL = `SELECT map.message_ordinal AS messageOrdinal, fts.role, fts.content
 FROM message_fts_rowid_map AS map
 CROSS JOIN message_history_fts AS fts
   ON fts.rowid = map.fts_rowid
 WHERE map.session_id = ?
   AND map.message_ordinal BETWEEN ? AND ?
   AND fts.role IN ('user', 'assistant')
 ORDER BY map.message_ordinal ASC`;

const loadFtsRowsStatements = new WeakMap<Database, PreparedStatement>();
const searchPoolDates = new WeakMap<
    StoredCompartmentChunkEmbedding,
    {
        startTime: number | null;
        endTime: number | null;
    }
>();
const existingHashStatements = new WeakMap<Database, PreparedStatement>();
const existingHashByProjectStatements = new WeakMap<Database, PreparedStatement>();
const deleteByCompartmentStatements = new WeakMap<Database, PreparedStatement>();
const insertEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const renumberEmbeddingWindowStatements = new WeakMap<Database, PreparedStatement>();
const searchRowsStatements = new WeakMap<Database, PreparedStatement>();
const searchRowsByModelStatements = new WeakMap<Database, PreparedStatement>();
const searchPoolProbeStatements = new WeakMap<Database, PreparedStatement>();
const pendingSearchPools = new WeakMap<Database, Map<string, Promise<void>>>();
const backfillCandidateStatements = new WeakMap<Database, PreparedStatement>();
const shadowBackfillCandidateStatements = new WeakMap<Database, PreparedStatement>();

const DECODED_SEARCH_POOL_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const decodedSearchPools = new WeakMap<Database, Map<string, DecodedSearchPoolEntry>>();
const decodedSearchPoolLru = new Map<DecodedSearchPoolEntry, true>();
let decodedSearchPoolBytes = 0;
const searchPoolStats = { fullRebuilds: 0, appends: 0, probes: 0, probeMs: 0, probePages: 0 };

export function _getCompartmentChunkSearchCacheStatsForTests(): typeof searchPoolStats & {
    bytes: number;
} {
    return { ...searchPoolStats, bytes: decodedSearchPoolBytes };
}

function getLoadFtsRowsStatement(db: Database): PreparedStatement {
    let stmt = loadFtsRowsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(MESSAGE_FTS_CHUNK_LOAD_SQL);
        loadFtsRowsStatements.set(db, stmt);
    }
    return stmt;
}

function getExistingHashStatement(db: Database, scopedToProject: boolean): PreparedStatement {
    const map = scopedToProject ? existingHashByProjectStatements : existingHashStatements;
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT window_index AS windowIndex, chunk_hash AS chunkHash
             FROM compartment_chunk_embeddings
             WHERE compartment_id = ?
               AND model_id = ?
               ${scopedToProject ? "AND project_path = ?" : ""}
             ORDER BY window_index ASC`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function getDeleteByCompartmentStatement(db: Database): PreparedStatement {
    let stmt = deleteByCompartmentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM compartment_chunk_embeddings WHERE compartment_id = ? AND model_id = ?",
        );
        deleteByCompartmentStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertEmbeddingStatement(db: Database): PreparedStatement {
    let stmt = insertEmbeddingStatements.get(db);
    if (!stmt) {
        // Vectors/dims are immutable at a rowid: refresh by deleting and inserting
        // new rows. In-place window_index/project_path/harness repairs are
        // observed by the search scope probe. The writer guard enforces this rule.
        stmt = db.prepare(
            `INSERT INTO compartment_chunk_embeddings (
                compartment_id, session_id, project_path, harness, window_index,
                start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insertEmbeddingStatements.set(db, stmt);
    }
    return stmt;
}

function getRenumberEmbeddingWindowStatement(db: Database): PreparedStatement {
    let stmt = renumberEmbeddingWindowStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `UPDATE compartment_chunk_embeddings
             SET window_index = ?
             WHERE compartment_id = ?
               AND model_id = ?
               AND project_path = ?
               AND window_index = ?`,
        );
        renumberEmbeddingWindowStatements.set(db, stmt);
    }
    return stmt;
}

function getSearchPoolProbeStatement(db: Database): PreparedStatement {
    let stmt = searchPoolProbeStatements.get(db);
    if (!stmt) {
        // Existing session and project/model indexes bound the scan; neither
        // covers all scope fields and metadata. length(BLOB) skips overflow payload.
        stmt = db.prepare(
            `SELECT e.id AS rowId, e.compartment_id AS compartmentId,
                    e.session_id AS sessionId, e.project_path AS projectPath, e.harness AS harness,
                    e.window_index AS windowIndex, e.start_ordinal AS windowStart,
                    e.end_ordinal AS windowEnd, e.chunk_hash AS chunkHash,
                    e.model_id AS modelId, e.dims AS dims, e.created_at AS createdAt,
                    length(e.vector) AS vectorBytes,
                    c.session_id AS compartmentSessionId, c.title AS title,
                    c.start_message AS compartmentStart, c.end_message AS compartmentEnd,
                    start_map.message_time_ms AS startTime, end_map.message_time_ms AS endTime
             FROM compartment_chunk_embeddings e
             LEFT JOIN compartments c ON c.id = e.compartment_id
             LEFT JOIN message_fts_rowid_map start_map
               ON start_map.session_id = c.session_id AND start_map.message_ordinal = c.start_message
             LEFT JOIN message_fts_rowid_map end_map
               ON end_map.session_id = c.session_id AND end_map.message_ordinal = c.end_message
             WHERE e.session_id = ? AND e.project_path = ? AND e.model_id = ? AND e.id > ?
             ORDER BY e.id ASC LIMIT 512`,
        );
        searchPoolProbeStatements.set(db, stmt);
    }
    return stmt;
}

function sameScopeMetadata(left: SearchScopeMetadataRow, right: SearchScopeMetadataRow): boolean {
    for (let index = 0; index < SEARCH_SCOPE_METADATA_FIELDS.length; index++) {
        const key = SEARCH_SCOPE_METADATA_FIELDS[index];
        if (left[key] !== right[key]) return false;
    }
    return true;
}

async function probeSearchScope(
    db: Database,
    sessionId: string,
    projectPath: string,
    modelId: string,
    previous?: SearchPoolProbeRow,
): Promise<SearchPoolProbeRow> {
    const started = performance.now();
    searchPoolStats.probes++;
    const probe: SearchPoolProbeRow = {
        rowCount: 0,
        maxRowId: 0,
        rowIdSum: 0,
        metadata: previous?.metadata ?? new Map(),
        ids: previous?.ids ?? [],
    };
    let copied = previous === undefined;
    let oldIndex = 0;
    // Reuse unchanged records and the map itself. A warm probe must not allocate
    // another full metadata pool and force a large main-thread garbage collection.
    const writable = () => {
        if (!copied) {
            probe.metadata = new Map(probe.metadata);
            copied = true;
        }
        return probe.metadata;
    };
    await yieldSearchPool();
    for (;;) {
        const rows = getSearchPoolProbeStatement(db).all(
            sessionId,
            projectPath,
            modelId,
            probe.maxRowId,
        ) as SearchScopeMetadataRow[];
        searchPoolStats.probePages++;
        if (rows.length === 0) {
            if (previous) {
                while (oldIndex < previous.ids.length) writable().delete(previous.ids[oldIndex++]);
            }
            if (copied) probe.ids = [...probe.metadata.keys()].sort((a, b) => a - b);
            searchPoolStats.probeMs += performance.now() - started;
            return probe;
        }
        for (const row of rows) {
            probe.rowCount++;
            probe.maxRowId = row.rowId;
            probe.rowIdSum += row.rowId;
            if (previous) {
                while (oldIndex < previous.ids.length && previous.ids[oldIndex] < row.rowId) {
                    writable().delete(previous.ids[oldIndex++]);
                }
            }
            if (previous && previous.ids[oldIndex] === row.rowId) {
                const old = previous.metadata.get(row.rowId);
                if (!old || !sameScopeMetadata(old, row)) {
                    writable().set(row.rowId, row);
                }
                oldIndex++;
            } else writable().set(row.rowId, row);
        }
        await yieldSearchPool();
    }
}

function sameSearchScope(left: SearchPoolProbeRow, right: SearchPoolProbeRow): boolean {
    return (
        left.rowCount === right.rowCount &&
        left.maxRowId === right.maxRowId &&
        left.rowIdSum === right.rowIdSum &&
        (left.metadata === right.metadata ||
            [...left.metadata].every(([id, value]) => right.metadata.get(id) === value))
    );
}

function scopeOnlyAppended(cached: SearchPoolProbeRow, probe: SearchPoolProbeRow): boolean {
    if (probe.rowCount <= cached.rowCount) return false;
    let addedCount = 0;
    let addedSum = 0;
    for (const [id, fingerprint] of probe.metadata) {
        if (id > cached.maxRowId) {
            addedCount++;
            addedSum += id;
        } else if (cached.metadata.get(id) !== fingerprint) return false;
    }
    return (
        addedCount === probe.rowCount - cached.rowCount &&
        cached.rowIdSum + addedSum === probe.rowIdSum
    );
}

/** Missing endpoint mappings and SQL NULL times cannot satisfy an inclusive overlap. */
function filterSearchPoolDates(
    rows: StoredCompartmentChunkEmbedding[],
    dateRange: { from: number; to: number } | null,
): StoredCompartmentChunkEmbedding[] {
    if (dateRange === null) return rows;
    return rows.filter((row) => {
        const compartment = searchPoolDates.get(row);
        return (
            compartment !== undefined &&
            compartment.startTime !== null &&
            compartment.endTime !== null &&
            compartment.startTime <= dateRange.to &&
            compartment.endTime >= dateRange.from
        );
    });
}

function getSearchRowsStatement(db: Database, withModel: boolean): PreparedStatement {
    const map = withModel ? searchRowsByModelStatements : searchRowsStatements;
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT e.id AS rowId, e.compartment_id AS compartmentId,
                    start_map.message_time_ms AS startTime, end_map.message_time_ms AS endTime,
                    e.session_id AS sessionId,
                    c.title AS title,
                    c.start_message AS compartmentStart,
                    c.end_message AS compartmentEnd,
                    e.window_index AS windowIndex,
                    e.start_ordinal AS windowStart,
                    e.end_ordinal AS windowEnd,
                    e.chunk_hash AS chunkHash,
                    e.model_id AS modelId,
                    e.dims AS dims,
                    e.vector AS vector
             FROM compartment_chunk_embeddings e
              JOIN compartments c ON c.id = e.compartment_id
              LEFT JOIN message_fts_rowid_map start_map
                ON start_map.session_id = c.session_id AND start_map.message_ordinal = c.start_message
              LEFT JOIN message_fts_rowid_map end_map
                ON end_map.session_id = c.session_id AND end_map.message_ordinal = c.end_message
             WHERE e.session_id = ?
               AND e.project_path = ?
                ${withModel ? "AND e.model_id = ?" : ""}
                AND e.id > ? AND e.id <= ?
              ORDER BY e.id ASC LIMIT 16`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function getBackfillCandidateStatement(db: Database): PreparedStatement {
    let stmt = backfillCandidateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.id AS id,
                    c.session_id AS sessionId,
                    c.start_message AS startMessage,
                    c.end_message AS endMessage,
                    c.title AS title
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
             ORDER BY c.created_at DESC, c.id DESC`,
        );
        backfillCandidateStatements.set(db, stmt);
    }
    return stmt;
}

function getShadowBackfillCandidateStatement(db: Database): PreparedStatement {
    let stmt = shadowBackfillCandidateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.id AS id,
                    c.session_id AS sessionId,
                    c.start_message AS startMessage,
                    c.end_message AS endMessage,
                    c.title AS title
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
               AND EXISTS (
                   SELECT 1
                   FROM compartment_chunk_embeddings primary_chunks
                   WHERE primary_chunks.compartment_id = c.id
                     AND primary_chunks.project_path = ?
                     AND primary_chunks.model_id = ?
               )
             ORDER BY c.created_at DESC, c.id DESC`,
        );
        shadowBackfillCandidateStatements.set(db, stmt);
    }
    return stmt;
}

function searchPoolKey(sessionId: string, projectPath: string, modelId: string): string {
    return JSON.stringify([sessionId, projectPath, modelId]);
}

function getDecodedSearchPool(db: Database): Map<string, DecodedSearchPoolEntry> {
    let pool = decodedSearchPools.get(db);
    if (!pool) {
        pool = new Map();
        decodedSearchPools.set(db, pool);
    }
    return pool;
}

function removeDecodedSearchPoolEntry(entry: DecodedSearchPoolEntry): void {
    if (entry.pool.get(entry.key) === entry) {
        entry.pool.delete(entry.key);
    }
    if (decodedSearchPoolLru.delete(entry)) {
        decodedSearchPoolBytes -= entry.byteSize;
    }
}

function touchDecodedSearchPoolEntry(entry: DecodedSearchPoolEntry): void {
    decodedSearchPoolLru.delete(entry);
    decodedSearchPoolLru.set(entry, true);
}

function estimateDecodedSearchPoolBytes(rows: readonly StoredCompartmentChunkEmbedding[]): number {
    let bytes = 0;
    for (const row of rows) {
        // Include row/vector wrappers, endpoint timestamp metadata and UTF-16
        // strings as well as payload bytes in the process-wide memory budget.
        bytes +=
            row.vector.byteLength +
            384 +
            2 *
                (row.sessionId.length +
                    row.title.length +
                    row.chunkHash.length +
                    row.modelId.length);
    }
    return bytes;
}

function cacheDecodedSearchPool(
    pool: Map<string, DecodedSearchPoolEntry>,
    key: string,
    probe: SearchPoolProbeRow,
    rows: StoredCompartmentChunkEmbedding[],
): void {
    const existing = pool.get(key);
    if (existing) removeDecodedSearchPoolEntry(existing);

    const entry: DecodedSearchPoolEntry = {
        pool,
        key,
        ...probe,
        rows,
        byteSize: estimateDecodedSearchPoolBytes(rows),
    };
    entry.byteSize += probe.ids.length * 8;
    for (const metadata of probe.metadata.values()) {
        entry.byteSize += 320;
        for (const key of SEARCH_SCOPE_METADATA_FIELDS) {
            const value = metadata[key];
            if (typeof value === "string") entry.byteSize += 2 * value.length;
        }
    }
    pool.set(key, entry);
    decodedSearchPoolLru.set(entry, true);
    decodedSearchPoolBytes += entry.byteSize;

    while (decodedSearchPoolBytes > DECODED_SEARCH_POOL_CACHE_MAX_BYTES) {
        const oldest = decodedSearchPoolLru.keys().next().value as
            | DecodedSearchPoolEntry
            | undefined;
        if (!oldest) break;
        removeDecodedSearchPoolEntry(oldest);
    }
}

/** Clear process-level decoded vectors between isolated test cases. */
export function _resetCompartmentChunkSearchCacheForTests(): void {
    for (const entry of [...decodedSearchPoolLru.keys()]) {
        removeDecodedSearchPoolEntry(entry);
    }
    decodedSearchPoolLru.clear();
    decodedSearchPoolBytes = 0;
    Object.assign(searchPoolStats, {
        fullRebuilds: 0,
        appends: 0,
        probes: 0,
        probeMs: 0,
        probePages: 0,
    });
}

function isFinitePositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeCompartmentChunkMaxInputTokens(value: unknown): number {
    if (!isFinitePositiveInteger(value)) {
        return DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS;
    }
    return Math.max(1, Math.floor(value));
}

function normalizeContent(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function formatOrdinalRange(start: number, end: number): string {
    return start === end ? `[${start}]` : `[${start}-${end}]`;
}

function rolePrefix(role: string): "U" | "A" | null {
    if (role === "user") return "U";
    if (role === "assistant") return "A";
    return null;
}

function parseOrdinal(value: number | string | undefined): number | null {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCanonicalLineRange(line: string): { start: number; end: number } | null {
    const match = /^\[(\d+)(?:-(\d+))?\]\s+[UA]:/.exec(line.trim());
    if (!match) return null;
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end };
}

function assertOrdinalRangeWithinCompartment(
    rangeStart: number,
    rangeEnd: number,
    compartmentStart: number,
    compartmentEnd: number,
): void {
    if (rangeStart < compartmentStart || rangeEnd > compartmentEnd || rangeEnd < rangeStart) {
        throw new RangeError(
            `Canonical chunk range ${rangeStart}-${rangeEnd} lies outside compartment ${compartmentStart}-${compartmentEnd}`,
        );
    }
}

function hashChunkText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function vectorBlob(vector: Float32Array): Uint8Array {
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function toFloat32Array(blob: Uint8Array | ArrayBuffer): Float32Array {
    if (blob instanceof Uint8Array) {
        const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        return new Float32Array(buffer);
    }
    return new Float32Array(blob.slice(0));
}

export function buildCanonicalChunkTextFromFts(
    db: Database,
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
): string | null {
    if (endOrdinal < startOrdinal) return "";
    if (!messageFtsOrdinalRangeIsMapped(db, sessionId, startOrdinal, endOrdinal)) return null;
    const rows = getLoadFtsRowsStatement(db)
        .all(sessionId, startOrdinal, endOrdinal)
        .map((row) => row as FtsChunkRow);
    const lines: string[] = [];
    let current: {
        role: "U" | "A";
        start: number;
        end: number;
        parts: string[];
    } | null = null;

    const flush = (): void => {
        if (!current || current.parts.length === 0) return;
        lines.push(
            `${formatOrdinalRange(current.start, current.end)} ${current.role}: ${current.parts.join(
                " / ",
            )}`,
        );
        current = null;
    };

    for (const row of rows) {
        const ordinal = parseOrdinal(row.messageOrdinal);
        const prefix = rolePrefix(row.role);
        const content = typeof row.content === "string" ? normalizeContent(row.content) : "";
        if (ordinal === null || prefix === null || content.length === 0) continue;

        if (current && current.role === prefix) {
            current.end = ordinal;
            current.parts.push(content);
            continue;
        }

        flush();
        current = { role: prefix, start: ordinal, end: ordinal, parts: [content] };
    }
    flush();
    return lines.join("\n");
}

/**
 * Fallback embeddable text for a compartment whose RAW span has NO indexable
 * content. A thin one-beat compartment — e.g. a host-injected
 * `<system-reminder>` notification (stripped to empty by the indexer) plus an
 * assistant tool-call (no text) — leaves `buildCanonicalChunkTextFromFts`
 * returning "". Such a compartment would never acquire an embedding row, so it
 * stays counted as "remaining" forever and the auto-embed drain re-fires its
 * start/finish notification on every restart (the desktop "Embedding 1 /
 * Embedded 0" loop).
 *
 * The compartment still carries a real summary (title + p1 paraphrase) — the
 * ONLY signal it has — so we embed that instead. This is NOT the redundancy that
 * retired `p1_embedding` (which embedded the summary ALONGSIDE the raw chunk):
 * here there is no raw chunk to embed, so the summary is the sole content.
 * Returns "" only when the compartment has neither a title nor p1/content.
 */
export function buildCompartmentSummaryFallbackText(db: Database, compartmentId: number): string {
    const row = db
        .prepare("SELECT title, p1, content FROM compartments WHERE id = ?")
        .get(compartmentId) as
        | { title?: string | null; p1?: string | null; content?: string | null }
        | undefined;
    if (!row) return "";
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const p1 = typeof row.p1 === "string" ? row.p1.trim() : "";
    // v2 rows mirror p1 into `content`; legacy rows only have `content`.
    const body = p1.length > 0 ? p1 : typeof row.content === "string" ? row.content.trim() : "";
    return [title, body].filter((s) => s.length > 0).join("\n");
}

/**
 * Convert historian input text into the same embeddable subset used by the FTS
 * backfill producer: only U:/A: conversational lines remain, and TC: tool-call
 * summaries are removed because they are better served by exact FTS probes.
 */
export function canonicalizeInMemoryChunkTextForEmbedding(
    chunkText: string,
    startOrdinal?: number,
    endOrdinal?: number,
): string {
    const lines: string[] = [];
    for (const rawLine of chunkText.split(/\r?\n/)) {
        const line = rawLine.trim();
        const match = /^(\[(\d+)(?:-(\d+))?\]\s+[UA]:)\s*(.*)$/.exec(line);
        if (!match) continue;
        const lineStart = Number.parseInt(match[2], 10);
        const lineEnd = match[3] ? Number.parseInt(match[3], 10) : lineStart;
        if (startOrdinal != null && lineEnd < startOrdinal) continue;
        if (endOrdinal != null && lineStart > endOrdinal) continue;

        const rawParts = match[4]
            .split(" / ")
            .map((part) => normalizeContent(part))
            .filter((part) => part.length > 0);
        const ordinalSpan = lineEnd - lineStart + 1;
        const roleLabel = match[1].slice(match[1].indexOf("]") + 2);

        if (ordinalSpan === rawParts.length) {
            const retained = rawParts
                .map((part, index) => ({ ordinal: lineStart + index, part }))
                .filter(({ ordinal, part }) => {
                    if (part.startsWith("TC:")) return false;
                    if (startOrdinal != null && ordinal < startOrdinal) return false;
                    if (endOrdinal != null && ordinal > endOrdinal) return false;
                    return true;
                });
            if (retained.length === 0) continue;
            const retainedStart = retained[0].ordinal;
            const retainedEnd = retained[retained.length - 1].ordinal;
            lines.push(
                `${formatOrdinalRange(retainedStart, retainedEnd)} ${roleLabel} ${retained
                    .map(({ part }) => part)
                    .join(" / ")}`,
            );
            continue;
        }

        const clipsRequestedRange =
            (startOrdinal != null && lineStart < startOrdinal) ||
            (endOrdinal != null && lineEnd > endOrdinal);
        if (clipsRequestedRange) {
            // Merged historian blocks can include filtered ordinals, while a single
            // message can itself contain " / ". Without one part per ordinal there
            // is no faithful way to clip the text. Reject the in-memory chunk so the
            // publish path reconstructs this compartment's exact span from FTS.
            return "";
        }

        const parts = rawParts.filter((part) => !part.startsWith("TC:"));
        if (parts.length === 0) continue;
        lines.push(`${match[1]} ${parts.join(" / ")}`);
    }
    return lines.join("\n");
}

export function chunkCanonicalText(
    canonicalText: string,
    startOrdinal: number,
    endOrdinal: number,
    maxInputTokens: number,
): CompartmentChunkWindow[] {
    const lines = canonicalText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0 || endOrdinal < startOrdinal) return [];

    for (const line of lines) {
        const range = parseCanonicalLineRange(line);
        if (range) {
            assertOrdinalRangeWithinCompartment(range.start, range.end, startOrdinal, endOrdinal);
        }
    }

    const normalizedMax = normalizeCompartmentChunkMaxInputTokens(maxInputTokens);
    // Window against a safety-margined budget, not the raw ceiling, so estimator
    // drift can't push a window past the provider's real token limit.
    const effectiveMax = Math.max(1, Math.floor(normalizedMax * CHUNK_WINDOW_SAFETY_RATIO));
    const fullText = lines.join("\n");
    if (estimateTokens(fullText) <= effectiveMax) {
        return [
            {
                windowIndex: 0,
                startOrdinal,
                endOrdinal,
                text: fullText,
                chunkHash: hashChunkText(fullText),
            },
        ];
    }

    const windows: CompartmentChunkWindow[] = [];
    let currentLines: string[] = [];
    let currentStart: number | null = null;
    let currentEnd: number | null = null;
    let currentTokens = 0;

    const flush = (): void => {
        if (currentLines.length === 0 || currentStart === null || currentEnd === null) return;
        const text = currentLines.join("\n");
        assertOrdinalRangeWithinCompartment(currentStart, currentEnd, startOrdinal, endOrdinal);
        windows.push({
            windowIndex: windows.length,
            startOrdinal: currentStart,
            endOrdinal: currentEnd,
            text,
            chunkHash: hashChunkText(text),
        });
        currentLines = [];
        currentStart = null;
        currentEnd = null;
        currentTokens = 0;
    };

    for (const line of lines) {
        const range = parseCanonicalLineRange(line);
        const lineStart = range?.start ?? startOrdinal;
        const lineEnd = range?.end ?? lineStart;
        const lineTokens = estimateTokens(line);

        // A single canonical line (one U:/A: span) can itself exceed the per-window
        // budget — e.g. a span containing a large file dump or paste rendered into
        // one line. Packing only flushes BETWEEN lines, so such a line would be
        // emitted as one oversized window and blow past the provider's hard context
        // window (#206: jina returned 400 exceed_context_size for a 51774-token
        // window against an 8192 ceiling). Split the line down to budget first, and
        // emit each sub-slice as its own window carrying this line's ordinal range.
        if (lineTokens > effectiveMax) {
            flush();
            for (const slice of splitOversizedLine(line, effectiveMax)) {
                assertOrdinalRangeWithinCompartment(lineStart, lineEnd, startOrdinal, endOrdinal);
                windows.push({
                    windowIndex: windows.length,
                    startOrdinal: lineStart,
                    endOrdinal: lineEnd,
                    text: slice,
                    chunkHash: hashChunkText(slice),
                });
            }
            continue;
        }

        if (currentLines.length > 0 && currentTokens + lineTokens > effectiveMax) {
            flush();
        }
        if (currentLines.length === 0) {
            currentStart = lineStart;
        }
        currentLines.push(line);
        currentEnd = lineEnd;
        currentTokens += lineTokens;
    }
    flush();

    return windows;
}

/**
 * Split a single oversized canonical line into sub-slices each within
 * `effectiveMax` tokens, using a recursive character splitter (best-in-class
 * boundary hierarchy: paragraph → line → sentence → word → char). The
 * `lengthFunction` is our real tokenizer (`estimateTokens`), so slicing is
 * token-accurate against the same heuristic the windower uses — deterministic,
 * no provider call, cache-stable. A hard char-level safety cap guarantees
 * termination even if a single token-dense fragment resists separator splitting.
 */
function splitOversizedLine(line: string, effectiveMax: number): string[] {
    // Recursive split on the best-in-class separator hierarchy (paragraph → line
    // → word → char), measured with our real tokenizer. Fall back to a
    // deterministic char-budget split if the splitter throws or yields nothing
    // (never leave an oversized line un-split).
    let slices: string[] = [];
    try {
        slices = recursiveCharacterSplit(line, {
            chunkSize: effectiveMax,
            lengthFunction: estimateTokens,
        });
    } catch (error) {
        // Surface the regression instead of degrading silently: if the splitter
        // consistently fails for some input shape the char-budget fallback still
        // embeds, but we want a signal.
        log("[magic-context] recursiveCharacterSplit failed; using char-budget fallback:", error);
        slices = [];
    }
    if (slices.length === 0) {
        slices = charBudgetSplit(line, effectiveMax);
    }
    // Final guard: any slice still over budget (token-dense, no separators) is
    // hard-split by character budget. charBudgetSplit is the TERMINAL splitter —
    // it shrinks to a single character, the smallest indivisible unit — so its
    // output is budget-compliant by construction EXCEPT for the degenerate case
    // of a lone character that alone exceeds the budget (only reachable with a
    // tiny effectiveMax; never with real provider budgets). We assert that
    // contract in dev/test rather than re-splitting (which cannot reduce a
    // 1-char slice further and would loop): any escapee is a genuine bug, not
    // something to silently paper over.
    const safe: string[] = [];
    const pushChecked = (slice: string): void => {
        if (estimateTokens(slice) > effectiveMax && slice.length > 1) {
            // Not terminal yet — split further. (Defensive: charBudgetSplit
            // should already guarantee this; only triggers if its contract
            // regresses.)
            safe.push(...charBudgetSplit(slice, effectiveMax));
            return;
        }
        safe.push(slice);
    };
    for (const slice of slices) {
        if (estimateTokens(slice) <= effectiveMax) {
            safe.push(slice);
        } else {
            for (const sub of charBudgetSplit(slice, effectiveMax)) pushChecked(sub);
        }
    }
    return safe.filter((s) => s.length > 0);
}

/**
 * Deterministic character-budget fallback split. Estimates a chars-per-token
 * ratio from the input and slices on that, then trims each slice down until it
 * fits the token budget. Always terminates.
 *
 * Budget guarantee: every emitted slice is within `effectiveMax` tokens EXCEPT
 * the degenerate case where a single character already exceeds the budget (only
 * reachable when `effectiveMax` is tiny — e.g. 1 — and one char tokenizes to
 * multiple tokens). In that case the slice is a single character: it cannot be
 * split further, so emitting it is the only progress-making choice. With real
 * provider budgets (thousands of tokens) this case never arises.
 */
function charBudgetSplit(text: string, effectiveMax: number): string[] {
    const totalTokens = Math.max(1, estimateTokens(text));
    const charsPerToken = Math.max(1, Math.floor(text.length / totalTokens));
    const sliceChars = Math.max(1, effectiveMax * charsPerToken);
    const out: string[] = [];
    let pos = 0;
    while (pos < text.length) {
        let end = Math.min(text.length, pos + sliceChars);
        let slice = text.slice(pos, end);
        // Shrink until the slice fits the token budget (handles dense regions).
        // Floor at one character: a single char is the smallest indivisible unit,
        // so we stop there even if it alone exceeds the budget (degenerate tiny
        // budget) — otherwise the loop could not make progress.
        while (slice.length > 1 && estimateTokens(slice) > effectiveMax) {
            end = pos + Math.max(1, Math.floor((end - pos) / 2));
            slice = text.slice(pos, end);
        }
        out.push(slice);
        pos = end;
    }
    return out;
}

export function getExistingChunkHashes(
    db: Database,
    compartmentId: number,
    modelId: string,
    projectPath?: string,
): Map<number, string> {
    const scoped = typeof projectPath === "string" && projectPath.length > 0;
    const rows = (
        scoped
            ? getExistingHashStatement(db, true).all(compartmentId, modelId, projectPath)
            : getExistingHashStatement(db, false).all(compartmentId, modelId)
    ) as ExistingChunkHashRow[];
    return new Map(
        rows
            .filter(
                (row) => typeof row.windowIndex === "number" && typeof row.chunkHash === "string",
            )
            .map((row) => [row.windowIndex, row.chunkHash]),
    );
}

export function chunkEmbeddingWindowsAreCurrent(
    db: Database,
    compartmentId: number,
    modelId: string,
    windows: readonly CompartmentChunkWindow[],
    projectPath?: string,
): boolean {
    const existing = getExistingChunkHashes(db, compartmentId, modelId, projectPath);
    if (existing.size !== windows.length) return false;
    return windows.every((window) => existing.get(window.windowIndex) === window.chunkHash);
}

/**
 * Replace one compartment's windows for one model. Pass `windowSourceKey` (from
 * {@link chunkWindowSourceKey}, computed right after chunking) when every row's
 * window came from one `chunkCanonicalText` call. The key is then recorded with
 * the rows in the same transaction, so a later coverage check of unchanged text
 * can confirm the rows without chunking it again.
 */
export function replaceCompartmentChunkEmbeddings(
    db: Database,
    rows: readonly SaveCompartmentChunkEmbeddingInput[],
    windowSourceKey?: string,
): void {
    if (rows.length === 0 || rows.some((row) => isSynapseEmbeddingTruncated(row.vector))) return;
    const compartmentId = rows[0].compartmentId;
    const modelId = rows[0].modelId;
    const now = Date.now();
    db.transaction(() => {
        getDeleteByCompartmentStatement(db).run(compartmentId, modelId);
        const insert = getInsertEmbeddingStatement(db);
        for (const row of rows) {
            insert.run(
                row.compartmentId,
                row.sessionId,
                row.projectPath,
                getHarness(),
                row.window.windowIndex,
                row.window.startOrdinal,
                row.window.endOrdinal,
                row.window.chunkHash,
                row.modelId,
                row.vector.length,
                vectorBlob(row.vector),
                row.createdAt ?? now,
            );
        }
        if (windowSourceKey) {
            recordChunkWindowSource(
                db,
                compartmentId,
                windowSourceKey,
                rows.map((row) => [row.window.windowIndex, row.window.chunkHash]),
            );
        }
    }).immediate();
}

const yieldSearchPool = () => new Promise<void>((resolve) => setImmediate(resolve));

function searchPoolInTransaction(db: Database): boolean {
    const connection = db as unknown as { inTransaction?: boolean; isTransaction?: boolean };
    return connection.inTransaction === true || connection.isTransaction === true;
}

async function refreshDecodedSearchPool(
    db: Database,
    sessionId: string,
    projectPath: string,
    modelId: string,
): Promise<StoredCompartmentChunkEmbedding[]> {
    const key = searchPoolKey(sessionId, projectPath, modelId);
    const pool = getDecodedSearchPool(db);
    for (;;) {
        const inTransaction = searchPoolInTransaction(db);
        const previous = pool.get(key);
        const probe = await probeSearchScope(db, sessionId, projectPath, modelId, previous);
        const rowCount = probe.rowCount;
        const maxRowId = probe.maxRowId;
        // Another scope may evict the snapshot while the probe yields. Re-read
        // the retained entry before touching the LRU or reusing cached vectors.
        const cached = pool.get(key);
        if (!inTransaction && cached && sameSearchScope(cached, probe)) {
            touchDecodedSearchPoolEntry(cached);
            return cached.rows;
        }

        // Vectors/dims are immutable at a rowid: refreshes delete/insert new rows.
        // In-place writers change window_index/project_path/harness, all covered
        // by the exact metadata probe (and protected by the writer guard test).
        // No database-wide commit/change counter participates in certification.
        const append = !inTransaction && cached && scopeOnlyAppended(cached, probe);
        if (append) searchPoolStats.appends++;
        else searchPoolStats.fullRebuilds++;
        let afterId = append ? cached.maxRowId : 0;
        const added: StoredCompartmentChunkEmbedding[] = [];
        let appendedCount = 0;
        // Yield before the first read as well: callers must never pay a cold
        // synchronous full-pool allocation before receiving their Promise.
        await yieldSearchPool();
        for (;;) {
            const rows = getSearchRowsStatement(db, true).all(
                sessionId,
                projectPath,
                modelId,
                afterId,
                maxRowId,
            ) as SearchChunkRow[];
            if (rows.length === 0) break;
            afterId = rows[rows.length - 1].rowId;
            appendedCount += rows.length;
            for (const row of rows) {
                if (
                    typeof row.compartmentId !== "number" ||
                    typeof row.sessionId !== "string" ||
                    typeof row.title !== "string" ||
                    typeof row.compartmentStart !== "number" ||
                    typeof row.compartmentEnd !== "number" ||
                    typeof row.windowIndex !== "number" ||
                    typeof row.windowStart !== "number" ||
                    typeof row.windowEnd !== "number" ||
                    typeof row.chunkHash !== "string" ||
                    typeof row.modelId !== "string" ||
                    typeof row.dims !== "number" ||
                    !(row.vector instanceof Uint8Array || row.vector instanceof ArrayBuffer)
                )
                    continue;
                added.push({
                    compartmentId: row.compartmentId,
                    sessionId: row.sessionId,
                    title: row.title,
                    startOrdinal: row.compartmentStart,
                    endOrdinal: row.compartmentEnd,
                    windowIndex: row.windowIndex,
                    windowStartOrdinal: row.windowStart,
                    windowEndOrdinal: row.windowEnd,
                    chunkHash: row.chunkHash,
                    modelId: row.modelId,
                    dims: row.dims,
                    vector: toFloat32Array(row.vector),
                });
                searchPoolDates.set(added[added.length - 1], {
                    startTime: row.startTime,
                    endTime: row.endTime,
                });
            }
            await yieldSearchPool();
        }
        const endProbe = await probeSearchScope(db, sessionId, projectPath, modelId, probe);
        if (!sameSearchScope(probe, endProbe) || searchPoolInTransaction(db) !== inTransaction) {
            // No transaction spans a yield on this shared connection. Discard a
            // raced read and retry rather than publishing a mixed/partial pool.
            continue;
        }
        if (append && appendedCount !== rowCount - cached.rowCount) {
            // Explicit low-id inserts are not an append, even if the total row
            // count grew. Rebuild to include them in the original SQL order.
            removeDecodedSearchPoolEntry(cached);
            continue;
        }
        const decoded = append ? cached.rows.concat(added) : added;
        decoded.sort((a, b) => a.compartmentId - b.compartmentId || a.windowIndex - b.windowIndex);
        // A transaction-local snapshot must not become a reusable cache entry
        // after its transaction ends or rolls back.
        if (!inTransaction) cacheDecodedSearchPool(pool, key, probe, decoded);
        return decoded;
    }
}

export async function loadCompartmentChunkEmbeddingsForSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    modelId: string,
    dateRange: { from: number; to: number } | null = null,
): Promise<StoredCompartmentChunkEmbedding[]> {
    if (!modelId) {
        throw new Error("loadCompartmentChunkEmbeddingsForSearch requires a current model id");
    }
    const key = searchPoolKey(sessionId, projectPath, modelId);
    let pending = pendingSearchPools.get(db);
    if (!pending) {
        pending = new Map();
        pendingSearchPools.set(db, pending);
    }
    for (;;) {
        while (pending.has(key)) await pending.get(key);
        const operation = refreshDecodedSearchPool(db, sessionId, projectPath, modelId);
        const completion = operation.then(() => {});
        pending.set(key, completion);
        try {
            const rows = await operation;
            return filterSearchPoolDates(rows, dateRange);
        } finally {
            pending.delete(key);
            // The result promise carries errors to the caller; the coordination
            // promise must also be handled when there are no concurrent waiters.
            void completion.catch(() => {});
        }
    }
}

export function loadUnembeddedCompartmentChunkCandidates(
    db: Database,
    projectPath: string,
    modelId: string,
    limit: number,
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
): CompartmentChunkBackfillCandidate[] {
    const rows = getBackfillCandidateStatement(db).all(projectPath) as unknown[];
    return selectHashIncompleteChunkCandidates(
        db,
        projectPath,
        modelId,
        mapBackfillCandidateRows(rows),
        Math.max(1, limit),
        maxInputTokens,
    );
}

/**
 * Select hash-incomplete rows under the shadow window contract, restricted to
 * compartments already represented in the primary cohort. Primary and shadow
 * providers may use different token ceilings, so primary window keys and hashes
 * cannot be used as the shadow completeness predicate.
 */
export function loadUnembeddedShadowChunkCandidates(
    db: Database,
    projectPath: string,
    primaryModelId: string,
    shadowModelId: string,
    limit: number,
    shadowMaxInputTokens: number,
): CompartmentChunkBackfillCandidate[] {
    const rows = getShadowBackfillCandidateStatement(db).all(
        projectPath,
        projectPath,
        primaryModelId,
    ) as unknown[];
    return selectHashIncompleteChunkCandidates(
        db,
        projectPath,
        shadowModelId,
        mapBackfillCandidateRows(rows),
        Math.max(1, limit),
        shadowMaxInputTokens,
    );
}

/**
 * Auto-drain selector that gives the host a turn after every mapped span read.
 * `leaseHeldRenumber` is reserved for callers holding the project's write lease;
 * it enables the repairs in applyLeaseHeldCoverageRepair.
 */
export async function loadUnembeddedCompartmentChunkCandidatesPolite(
    db: Database,
    projectPath: string,
    modelId: string,
    limit: number,
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
    leaseHeldRenumber = false,
): Promise<CompartmentChunkBackfillCandidate[]> {
    const rows = getBackfillCandidateStatement(db).all(projectPath) as unknown[];
    const candidates = mapBackfillCandidateRows(rows);
    const missing: CompartmentChunkBackfillCandidate[] = [];
    const stale: CompartmentChunkBackfillCandidate[] = [];
    let sliceStarted = performance.now();
    for (const candidate of candidates) {
        const classification = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (classification.defect === "missing") missing.push(candidate);
        else if (classification.defect === "stale") stale.push(candidate);
        else if (leaseHeldRenumber) {
            applyLeaseHeldCoverageRepair(db, candidate, projectPath, modelId, classification);
        }
        sliceStarted = await yieldCoverageSlice(sliceStarted);
    }
    return [...missing, ...stale].slice(0, Math.max(1, limit));
}

function mapBackfillCandidateRows(rows: unknown[]): CompartmentChunkBackfillCandidate[] {
    return rows
        .filter((row): row is BackfillCandidateRow => {
            if (row === null || typeof row !== "object") return false;
            const candidate = row as Record<string, unknown>;
            return (
                typeof candidate.id === "number" &&
                typeof candidate.sessionId === "string" &&
                typeof candidate.startMessage === "number" &&
                typeof candidate.endMessage === "number" &&
                typeof candidate.title === "string"
            );
        })
        .map((row) => ({
            id: row.id,
            sessionId: row.sessionId,
            startMessage: row.startMessage,
            endMessage: row.endMessage,
            title: row.title,
        }));
}

type ChunkCoverageDefect = "missing" | "stale" | "renumber" | "deferred" | null;

// The window memo below keys on canonical transcript text, token budget and
// embedding model. If indexed message text or the summary changes, old window
// hashes cannot be reused. Its size limit prevents unbounded transcript retention.
// CHUNKER_VERSION is also part of every persisted window source key: bump it
// whenever chunkCanonicalText can return different windows for the same input,
// so windows recorded by an older build are re-checked by chunking.
const CHUNKER_VERSION = 1;
const BACKOFF_PREFIX = "chunk_embed_backoff:";

function backoffKey(compartmentId: number): string {
    return `${BACKOFF_PREFIX}${compartmentId}`;
}

/** Also removes the compartments' recorded window sources (see recordChunkWindowSource). */
export function deleteChunkEmbedBackoffForCompartments(db: Database, ids: readonly number[]): void {
    if (ids.length === 0) return;
    db.prepare(
        `DELETE FROM schema_migrations_meta WHERE key IN (${ids.map(() => "?, ?").join(",")})`,
    ).run(...ids.flatMap((id) => [`${BACKOFF_PREFIX}${id}`, windowSourceMetaKey(id)]));
}

/** Also removes the session's recorded window sources (see recordChunkWindowSource). */
export function deleteChunkEmbedBackoffForSession(db: Database, sessionId: string): void {
    db.prepare(`DELETE FROM schema_migrations_meta WHERE key IN (
        SELECT ? || id FROM compartments WHERE session_id = ?
        UNION ALL
        SELECT ? || id FROM compartments WHERE session_id = ?
    )`).run(BACKOFF_PREFIX, sessionId, WINDOW_SOURCE_PREFIX, sessionId);
}

export function recordChunkEmbedBackoff(
    db: Database,
    candidate: CompartmentChunkBackfillCandidate,
    projectPath: string,
    modelId: string,
): void {
    const mapped = buildCanonicalChunkTextFromFts(
        db,
        candidate.sessionId,
        candidate.startMessage,
        candidate.endMessage,
    );
    if (mapped === null) return;
    const text = mapped || buildCompartmentSummaryFallbackText(db, candidate.id);
    const hash = createHash("sha256").update(text).digest("hex");
    const key = backoffKey(candidate.id);
    const prior = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    let retries = 0;
    try {
        const value = JSON.parse(prior?.value ?? "null") as {
            hash?: string;
            project?: string;
            model?: string;
            retries?: number;
        } | null;
        if (value?.hash === hash && value.project === projectPath && value.model === modelId) {
            retries = Math.max(0, Math.min(12, value.retries ?? 0));
        }
    } catch {
        /* Invalid old metadata is replaced. */
    }
    db.prepare(`INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        key,
        JSON.stringify({
            hash,
            project: projectPath,
            model: modelId,
            retries: retries + 1,
            retryAt: Date.now() + Math.min(86_400_000, 60_000 * 2 ** retries),
        }),
    );
}

function chunkEmbedBackoffActive(
    db: Database,
    candidate: CompartmentChunkBackfillCandidate,
    projectPath: string,
    modelId: string,
    text: string,
): boolean {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(backoffKey(candidate.id)) as { value: string } | undefined;
    if (!row) return false;
    try {
        const value = JSON.parse(row.value) as {
            hash: string;
            project: string;
            model: string;
            retryAt: number;
        };
        return (
            value.project === projectPath &&
            value.model === modelId &&
            value.hash === createHash("sha256").update(text).digest("hex") &&
            value.retryAt > Date.now()
        );
    } catch {
        return false;
    }
}
// Window sources: a persisted record of which windows `chunkCanonicalText`
// produced for a given input, so the coverage check after a process restart can
// confirm stored rows without tokenizing the transcript again.
//
// Chunking is a pure function of the canonical text, the compartment's ordinal
// range, the token budget, the chunker code and the token estimator. The source
// key hashes all five. Each record pairs a source key with a digest of the
// (window index, chunk hash) set chunking produced for it. A record therefore
// stays true whatever later happens to the embedding rows: coverage trusts it
// only when the current input has the same source key AND the rows stored now
// for the model have exactly that digest, which is the same verdict re-chunking
// would reach. Records live in the existing `schema_migrations_meta` key-value
// table, one key per compartment, next to the chunk_embed_backoff keys.
const WINDOW_SOURCE_PREFIX = "chunk_embed_windows:";
// Primary and shadow providers can window the same compartment under different
// token budgets; a few records cover both plus a recent budget change.
const WINDOW_SOURCE_RECORD_LIMIT = 4;

interface ChunkWindowSourceRecord {
    source: string;
    windows: string;
}

const windowSourceReadStatements = new WeakMap<Database, PreparedStatement>();
const windowSourceWriteStatements = new WeakMap<Database, PreparedStatement>();

function windowSourceMetaKey(compartmentId: number): string {
    return `${WINDOW_SOURCE_PREFIX}${compartmentId}`;
}

function windowSourceKeyFromTextHash(
    textHash: string,
    startOrdinal: number,
    endOrdinal: number,
    maxInputTokens: number,
): string {
    return hashChunkText(
        JSON.stringify([
            CHUNKER_VERSION,
            getTokenEstimatorFingerprint(),
            normalizeCompartmentChunkMaxInputTokens(maxInputTokens),
            startOrdinal,
            endOrdinal,
            textHash,
        ]),
    );
}

/**
 * Identity of one `chunkCanonicalText(canonicalText, startOrdinal, endOrdinal,
 * maxInputTokens)` call in this process. Compute it right after chunking and
 * pass it to {@link replaceCompartmentChunkEmbeddings}.
 */
export function chunkWindowSourceKey(
    canonicalText: string,
    startOrdinal: number,
    endOrdinal: number,
    maxInputTokens: number,
): string {
    return windowSourceKeyFromTextHash(
        hashChunkText(canonicalText),
        startOrdinal,
        endOrdinal,
        maxInputTokens,
    );
}

function windowSetDigest(windows: Iterable<readonly [number, string]>): string {
    const sorted = [...windows].sort((a, b) => a[0] - b[0]);
    return hashChunkText(sorted.map(([index, hash]) => `${index}:${hash}`).join("\n"));
}

function readChunkWindowSources(db: Database, compartmentId: number): ChunkWindowSourceRecord[] {
    let stmt = windowSourceReadStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?");
        windowSourceReadStatements.set(db, stmt);
    }
    const row = stmt.get(windowSourceMetaKey(compartmentId)) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return [];
    try {
        const parsed = JSON.parse(row.value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (entry): entry is ChunkWindowSourceRecord =>
                entry !== null &&
                typeof entry === "object" &&
                typeof (entry as ChunkWindowSourceRecord).source === "string" &&
                typeof (entry as ChunkWindowSourceRecord).windows === "string",
        );
    } catch {
        // An unreadable value only means coverage re-chunks; the next record replaces it.
        return [];
    }
}

/** Record which windows a source key produced. Callers hold a write transaction. */
function recordChunkWindowSource(
    db: Database,
    compartmentId: number,
    sourceKey: string,
    windows: Iterable<readonly [number, string]>,
): void {
    const record: ChunkWindowSourceRecord = {
        source: sourceKey,
        windows: windowSetDigest(windows),
    };
    const kept = readChunkWindowSources(db, compartmentId).filter(
        (entry) => entry.source !== sourceKey,
    );
    let stmt = windowSourceWriteStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(`INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
        windowSourceWriteStatements.set(db, stmt);
    }
    stmt.run(
        windowSourceMetaKey(compartmentId),
        JSON.stringify([record, ...kept].slice(0, WINDOW_SOURCE_RECORD_LIMIT)),
    );
}

function storedWindowsMatchRecordedSource(
    db: Database,
    compartmentId: number,
    sourceKey: string,
    existing: ReadonlyMap<number, string>,
): boolean {
    const record = readChunkWindowSources(db, compartmentId).find(
        (entry) => entry.source === sourceKey,
    );
    return record !== undefined && record.windows === windowSetDigest(existing);
}

const COVERAGE_MEMO_LIMIT = 2048;
const cachedCoverageWindows = new Map<string, CompartmentChunkWindow[]>();

/** Forget memoized coverage windows, as a process restart does. */
export function _resetCompartmentChunkCoverageMemoForTests(): void {
    cachedCoverageWindows.clear();
}

function memoizedCoverageWindows(
    candidate: CompartmentChunkBackfillCandidate,
    canonicalText: string,
    sourceKey: string,
    modelId: string,
    maxInputTokens: number,
): CompartmentChunkWindow[] {
    // The source key covers the text, range, budget, chunker and estimator.
    const key = JSON.stringify([candidate.id, sourceKey, modelId]);
    const cached = cachedCoverageWindows.get(key);
    if (cached) {
        cachedCoverageWindows.delete(key);
        cachedCoverageWindows.set(key, cached);
        return cached;
    }
    const windows = chunkCanonicalText(
        canonicalText,
        candidate.startMessage,
        candidate.endMessage,
        maxInputTokens,
    );
    cachedCoverageWindows.set(key, windows);
    if (cachedCoverageWindows.size > COVERAGE_MEMO_LIMIT) {
        const oldest = cachedCoverageWindows.keys().next().value;
        if (oldest !== undefined) cachedCoverageWindows.delete(oldest);
    }
    return windows;
}

// Do not let a long catch-up monopolize the host between HTTP requests.
async function yieldCoverageSlice(started: number): Promise<number> {
    if (performance.now() - started < 35) return started;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return performance.now();
}

interface ChunkCoverageClassification {
    defect: ChunkCoverageDefect;
    /** Current windows; empty when deferred or when a recorded window source confirmed coverage. */
    windows: CompartmentChunkWindow[];
    /** Source key of the current input; absent when deferred. */
    sourceKey?: string;
    /** True when a recorded window source confirmed the rows without chunking. */
    confirmedByRecord?: boolean;
}

function renumberOneBasedChunkWindows(
    db: Database,
    candidate: CompartmentChunkBackfillCandidate,
    projectPath: string,
    modelId: string,
    windows: readonly CompartmentChunkWindow[],
    sourceKey: string | undefined,
): void {
    const update = getRenumberEmbeddingWindowStatement(db);
    db.transaction(() => {
        // Move lowest to highest so each old key is vacant before the next row
        // moves into it, preserving the unique compartment/model/window key.
        for (const window of windows) {
            const result = update.run(
                window.windowIndex,
                candidate.id,
                modelId,
                projectPath,
                window.windowIndex + 1,
            );
            if (result.changes !== 1) {
                throw new Error(
                    `Failed to renumber compartment ${candidate.id} window ${window.windowIndex + 1}`,
                );
            }
        }
        // The rows now equal the current windows; record them as a confirmed source.
        if (sourceKey) {
            recordChunkWindowSource(
                db,
                candidate.id,
                sourceKey,
                windows.map((window) => [window.windowIndex, window.chunkHash]),
            );
        }
    }).immediate();
}

/** Classify one compartment against the transcript bytes the current model would embed. */
function classifyChunkCoverageDefect(
    db: Database,
    projectPath: string,
    modelId: string,
    candidate: CompartmentChunkBackfillCandidate,
    maxInputTokens: number,
): ChunkCoverageClassification {
    const mappedText = buildCanonicalChunkTextFromFts(
        db,
        candidate.sessionId,
        candidate.startMessage,
        candidate.endMessage,
    );
    if (mappedText === null) return { defect: "deferred", windows: [] };
    const canonicalText = mappedText || buildCompartmentSummaryFallbackText(db, candidate.id);
    if (
        !canonicalText ||
        chunkEmbedBackoffActive(db, candidate, projectPath, modelId, canonicalText)
    ) {
        return { defect: "deferred", windows: [] };
    }
    const sourceKey = chunkWindowSourceKey(
        canonicalText,
        candidate.startMessage,
        candidate.endMessage,
        maxInputTokens,
    );
    const existing = getExistingChunkHashes(db, candidate.id, modelId, projectPath);
    // Same verdict as re-chunking below, without tokenizing (see recordChunkWindowSource).
    if (storedWindowsMatchRecordedSource(db, candidate.id, sourceKey, existing)) {
        return { defect: null, windows: [], sourceKey, confirmedByRecord: true };
    }
    const windows = memoizedCoverageWindows(
        candidate,
        canonicalText,
        sourceKey,
        modelId,
        maxInputTokens,
    );

    const isMatchingOneBasedSet =
        windows.length > 0 &&
        existing.size === windows.length &&
        windows.every((window) => existing.get(window.windowIndex + 1) === window.chunkHash);
    if (isMatchingOneBasedSet) return { defect: "renumber", windows, sourceKey };

    const expectedWindowIndexes = new Set(windows.map((window) => window.windowIndex));
    if ([...existing.keys()].some((windowIndex) => !expectedWindowIndexes.has(windowIndex))) {
        return { defect: "stale", windows, sourceKey };
    }
    if (windows.some((window) => !existing.has(window.windowIndex))) {
        return { defect: "missing", windows, sourceKey };
    }
    if (
        existing.size !== windows.length ||
        windows.some((window) => existing.get(window.windowIndex) !== window.chunkHash)
    ) {
        return { defect: "stale", windows, sourceKey };
    }
    return { defect: null, windows, sourceKey };
}

/**
 * Lease-held scans repair what coverage found: renumber matching one-based rows,
 * and record the window source of rows confirmed by chunking, so the next
 * process confirms them without tokenizing. Plain coverage counts stay read-only.
 */
function applyLeaseHeldCoverageRepair(
    db: Database,
    candidate: CompartmentChunkBackfillCandidate,
    projectPath: string,
    modelId: string,
    classification: ChunkCoverageClassification,
): void {
    const { defect, windows, sourceKey, confirmedByRecord } = classification;
    if (defect === "renumber") {
        renumberOneBasedChunkWindows(db, candidate, projectPath, modelId, windows, sourceKey);
    } else if (defect === null && !confirmedByRecord && sourceKey) {
        db.transaction(() => {
            recordChunkWindowSource(
                db,
                candidate.id,
                sourceKey,
                windows.map((window) => [window.windowIndex, window.chunkHash]),
            );
        }).immediate();
    }
}

/**
 * Return only key/hash-incomplete compartments. Missing expected window keys are
 * ordered ahead of stale-hash replacements so a bounded sweep fills holes before
 * spending provider capacity refreshing rows that remain searchable.
 */
function selectHashIncompleteChunkCandidates(
    db: Database,
    projectPath: string,
    modelId: string,
    candidates: readonly CompartmentChunkBackfillCandidate[],
    limit: number,
    maxInputTokens: number,
    leaseHeldRenumber = false,
): CompartmentChunkBackfillCandidate[] {
    const missing: CompartmentChunkBackfillCandidate[] = [];
    const stale: CompartmentChunkBackfillCandidate[] = [];
    for (const candidate of candidates) {
        const classification = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (classification.defect === "missing") missing.push(candidate);
        else if (classification.defect === "stale") stale.push(candidate);
        else if (leaseHeldRenumber) {
            applyLeaseHeldCoverageRepair(db, candidate, projectPath, modelId, classification);
        }
    }
    return [...missing, ...stale].slice(0, limit);
}

const sessionBackfillCandidateStatements = new WeakMap<Database, PreparedStatement>();

/** Session-scoped variant of {@link loadUnembeddedCompartmentChunkCandidates}.
 *  Used by the on-demand `/ctx-embed-history` command, which backfills ONE
 *  session at a time. Missing expected windows precede stale-hash replacements;
 *  each defect class remains oldest-first so progress is deterministic.
 *
 *  `excludeIds` lets the drain loop advance past compartments that produced no
 *  embeddable work or provider failures this run. `leaseHeldRenumber` (which enables
 *  the repairs in applyLeaseHeldCoverageRepair) is reserved
 *  for callers holding the project's write lease. */
export function loadUnembeddedSessionChunkCandidates(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    limit: number,
    excludeIds?: readonly number[],
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
    leaseHeldRenumber = false,
): CompartmentChunkBackfillCandidate[] {
    const exclusions = excludeIds && excludeIds.length > 0 ? excludeIds : [];
    const exclusionSql =
        exclusions.length > 0 ? `AND c.id NOT IN (${exclusions.map(() => "?").join(", ")})` : "";
    const stmt =
        exclusions.length > 0
            ? db.prepare(
                  `SELECT c.id AS id,
                          c.session_id AS sessionId,
                          c.start_message AS startMessage,
                          c.end_message AS endMessage,
                          c.title AS title
                   FROM compartments c
                   JOIN session_projects sp
                     ON sp.session_id = c.session_id
                    AND sp.harness = c.harness
                    AND sp.project_path = ?
                   WHERE c.session_id = ?
                     AND c.start_message IS NOT NULL
                     AND c.end_message IS NOT NULL
                     ${exclusionSql}
                   ORDER BY c.start_message ASC, c.id ASC`,
              )
            : (() => {
                  let cached = sessionBackfillCandidateStatements.get(db);
                  if (!cached) {
                      cached = db.prepare(
                          `SELECT c.id AS id,
                                  c.session_id AS sessionId,
                                  c.start_message AS startMessage,
                                  c.end_message AS endMessage,
                                  c.title AS title
                           FROM compartments c
                           JOIN session_projects sp
                             ON sp.session_id = c.session_id
                            AND sp.harness = c.harness
                            AND sp.project_path = ?
                           WHERE c.session_id = ?
                             AND c.start_message IS NOT NULL
                             AND c.end_message IS NOT NULL
                           ORDER BY c.start_message ASC, c.id ASC`,
                      );
                      sessionBackfillCandidateStatements.set(db, cached);
                  }
                  return cached;
              })();
    const rows = stmt.all(projectPath, sessionId, ...exclusions) as unknown[];
    return selectHashIncompleteChunkCandidates(
        db,
        projectPath,
        modelId,
        mapBackfillCandidateRows(rows),
        Math.max(1, limit),
        maxInputTokens,
        leaseHeldRenumber,
    );
}

/** Yielding selector for automatic catch-up; never scans the whole session in one turn. */
export async function loadUnembeddedSessionChunkCandidatesPolite(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    limit: number,
    excludeIds: readonly number[] = [],
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
    leaseHeldRenumber = false,
): Promise<CompartmentChunkBackfillCandidate[]> {
    const excluded = new Set(excludeIds);
    const missing: CompartmentChunkBackfillCandidate[] = [];
    const stale: CompartmentChunkBackfillCandidate[] = [];
    let started = performance.now();
    for (const candidate of getSessionBackfillRows(db, projectPath, sessionId)) {
        if (excluded.has(candidate.id)) continue;
        const classification = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (classification.defect === "missing") missing.push(candidate);
        else if (classification.defect === "stale") stale.push(candidate);
        else if (leaseHeldRenumber) {
            applyLeaseHeldCoverageRepair(db, candidate, projectPath, modelId, classification);
        }
        started = await yieldCoverageSlice(started);
    }
    return [...missing, ...stale].slice(0, Math.max(1, limit));
}

/** Count session compartments whose current transcript windows are missing or stale. */
export function countUnembeddedSessionCompartments(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
): number {
    const rows = getSessionBackfillRows(db, projectPath, sessionId);
    let count = 0;
    for (const candidate of rows) {
        const { defect } = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (defect === "missing" || defect === "stale") count++;
    }
    return count;
}

/**
 * Count total embeddable compartments and key/hash-complete compartments for
 * `/ctx-embed`. A row's mere existence never contributes to `embedded`.
 */
export function countSessionCompartmentEmbedCoverage(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
): { embedded: number; total: number } {
    const candidates = getSessionBackfillRows(db, projectPath, sessionId);
    let embedded = 0;
    for (const candidate of candidates) {
        const { defect } = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (defect === null || defect === "renumber") embedded += 1;
    }
    return { embedded, total: candidates.length };
}

function getSessionBackfillRows(
    db: Database,
    projectPath: string,
    sessionId: string,
): CompartmentChunkBackfillCandidate[] {
    const rows = db
        .prepare(
            `SELECT c.id AS id,
                    c.session_id AS sessionId,
                    c.start_message AS startMessage,
                    c.end_message AS endMessage,
                    c.title AS title
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.session_id = ?
               AND c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
             ORDER BY c.start_message ASC, c.id ASC`,
        )
        .all(projectPath, sessionId) as unknown[];
    return mapBackfillCandidateRows(rows);
}

/** Count session history for background embedding, yielding between groups of compartments so HTTP requests can run. */
export async function countSessionCompartmentEmbedCoveragePolite(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
): Promise<{ embedded: number; total: number }> {
    const candidates = getSessionBackfillRows(db, projectPath, sessionId);
    let embedded = 0;
    let started = performance.now();
    for (const candidate of candidates) {
        const { defect } = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (defect === null || defect === "renumber") embedded++;
        started = await yieldCoverageSlice(started);
    }
    return { embedded, total: candidates.length };
}

/** Count without allocating a candidate backlog, yielding between tokenization slices. */
export async function countUnembeddedSessionCompartmentsPolite(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    maxInputTokens = DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS,
): Promise<number> {
    const candidates = getSessionBackfillRows(db, projectPath, sessionId);
    let count = 0;
    let started = performance.now();
    for (const candidate of candidates) {
        const { defect } = classifyChunkCoverageDefect(
            db,
            projectPath,
            modelId,
            candidate,
            maxInputTokens,
        );
        if (defect === "missing" || defect === "stale") count++;
        started = await yieldCoverageSlice(started);
    }
    return count;
}
