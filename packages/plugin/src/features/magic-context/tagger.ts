import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    adoptNullOwnerToolTag,
    backfillTagTokenCounts,
    getAssignableTagNumberByMessageId,
    getMaxTagNumberBySession,
    getNullOwnerToolTag,
    getToolTagNumberByOwner,
    insertTag,
    type TagTokenCounts,
    tagTokenCountIsNull,
} from "./storage-tags";
import type { TagEntry } from "./types";

/**
 * Composite key separator for tool tags in the in-memory assignments map.
 * `\x00` (NUL) cannot appear in a callId or message id (both are
 * UUID-shaped or finite character sets) so concatenation is unambiguous.
 *
 * v3.3.1 Layer C: tool tags carry a composite identity of
 * `(sessionId, callId, ownerMsgId)`. The bare callId is no longer a
 * unique key — two assistant turns reusing the same callId (collision
 * pattern observed in real OC sessions) must produce distinct tags.
 *
 * Message and file tags continue to use bare `messageId` keys (no
 * collision risk; `messageId` is `${msgId}:p${ord}` or `${msgId}:fileN`
 * which is globally unique within a session).
 */
const TOOL_COMPOSITE_KEY_SEP = "\x00";

export function makeToolCompositeKey(ownerMsgId: string, callId: string): string {
    return `${ownerMsgId}${TOOL_COMPOSITE_KEY_SEP}${callId}`;
}

/**
 * Narrowed type for non-tool tag operations. The compile-time exclusion
 * of `"tool"` here is the v3.3.1 Layer C contract: every tool path MUST
 * use `assignToolTag`/`getToolTag` so composite identity propagates.
 *
 * Any caller passing `"tool"` to `assignTag` or `getTag` triggers a TS
 * compile error at the call site. Defense-in-depth: the runtime body
 * also throws if it ever sees a "tool" type at runtime (caught by
 * `as any` casts in legacy code).
 */
type NonToolTagType = Exclude<TagEntry["type"], "tool">;

export interface ToolTagAccounting {
    byteSize: number;
    tokenCount: number | null;
    inputByteSize: number;
    inputTokenCount: number | null;
}

export interface TaggerHeapStats {
    sessionCount: number;
    assignmentEntries: number;
    toolAccountingEntries: number;
    loadSignatureEntries: number;
    sessions: Array<{
        sessionId: string;
        assignments: number;
        toolAccounting: number;
    }>;
}

export interface Tagger {
    /**
     * Assign a tag for a non-tool entity (message text or file part).
     *
     * Tool tags MUST use {@link assignToolTag}; the `type` parameter
     * here is narrowed at compile time to forbid `"tool"`.
     */
    assignTag(
        sessionId: string,
        messageId: string,
        type: NonToolTagType,
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
        /**
         * Pi-only: fingerprint of the raw message this tag is created for,
         * persisted on the tag row so a later pass can adopt a fallback-id tag
         * onto the real SessionEntry id. OpenCode passes undefined → column
         * stays NULL → no behavior change.
         */
        entryFingerprint?: string | null,
        /**
         * Lazy per-tag token computation, invoked by the tagger ONLY on the
         * fresh-insert branch (never when an existing tag is rebound). This is
         * what keeps tokenization "compute once, ever" — steady-state passes
         * pay nothing. Returns the real-tokenizer counts for this tag's content.
         */
        tokenThunk?: () => TagTokenCounts,
    ): number;
    /**
     * Look up the tag number for a non-tool entity.
     *
     * The `type` parameter is required (and narrowed to non-tool) so a
     * future tool-tag lookup can't accidentally fall through here. Use
     * {@link getToolTag} for tool lookups.
     */
    getTag(sessionId: string, messageId: string, type: NonToolTagType): number | undefined;
    /**
     * Assign a tag for a tool invocation. Composite identity
     * `(sessionId, callId, ownerMsgId)` is mandatory — pre-v3.3.1 the
     * tagger keyed tool tags by bare callId, and two assistant turns
     * reusing the same callId would silently bind to the same tag,
     * inheriting the older tag's drop status.
     *
     * `ownerMsgId` is the assistant message id that hosts the tool
     * invocation. For Pi parallel-tool-calls without `part.id`, callers
     * pass a synthetic locator equal to the contentId (owner == callId)
     * to satisfy the contract while preserving the legacy "each part
     * gets its own tag" behavior.
     */
    assignToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
        /** Lazy token computation — invoked only on fresh insert (see assignTag). */
        tokenThunk?: () => TagTokenCounts,
    ): number;
    /**
     * Look up the tag number for a tool invocation by composite
     * identity.
     */
    getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined;
    /** Persisted accounting loaded in the same scan as tool-tag identities. */
    getToolTagAccounting(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
    ): ToolTagAccounting | undefined;
    /** Keep the loaded accounting mirror synchronized with same-connection writes. */
    setToolTagAccounting(sessionId: string, tagNumber: number, accounting: ToolTagAccounting): void;
    bindTag(sessionId: string, messageId: string, tagNumber: number): void;
    /**
     * Remove a stale in-memory assignment key. Used by Pi fallback-tag
     * adoption after a tag's message_id is migrated from the pi-msg-*
     * fallback to the real id: the old fallback key must be dropped so it
     * doesn't linger as an alias to the same tag number.
     */
    unbindTag(sessionId: string, messageId: string): void;
    /**
     * Bind a tool tag by composite key. The in-memory map keys this as
     * `${ownerMsgId}\x00${callId}`.
     */
    bindToolTag(sessionId: string, callId: string, ownerMsgId: string, tagNumber: number): void;
    /**
     * Remove a stale tool composite assignment. Used by Pi fallback-owner
     * adoption when a tool tag moves from a synthetic pi-msg-* owner to the
     * real SessionEntry id (or when a duplicate real-owner row is folded away).
     */
    unbindToolTag(sessionId: string, ownerMsgId: string, callId: string): void;
    getAssignments(sessionId: string): ReadonlyMap<string, number>;
    resetCounter(sessionId: string, db: Database): void;
    getCounter(sessionId: string): number;
    initFromDb(sessionId: string, db: Database, floor?: number): void;
    /** Returns the database tag version recorded when this session's map was last loaded. */
    getLoadedTagsVersion?(sessionId: string, db: Database): number | undefined;
    cleanup(sessionId: string): void;
    /** Present on the production tagger; optional keeps lightweight test doubles source-compatible. */
    getHeapStats?(): TaggerHeapStats;
}

const GET_COUNTER_SQL = `SELECT counter FROM session_meta WHERE session_id = ?`;
const GET_TAGS_VERSION_SQL = `SELECT tags_version FROM session_meta WHERE session_id = ?`;
// Layer C: pull tool_owner_message_id and type so we can compose the
// in-memory key correctly. NULL-owner tool rows are intentionally NOT
// placed in the in-memory map; the lazy-adoption DB path discovers them
// at the next lookup.
const GET_ASSIGNMENTS_SQL =
    "SELECT message_id, tag_number, type, tool_owner_message_id, byte_size, token_count, input_byte_size, input_token_count FROM tags WHERE session_id = ? ORDER BY tag_number ASC";
// Scoped variant: load only tags at/above the live-wire floor (tag_number is
// monotonic with message order, so everything below the first wire message's
// tag is compacted-away history not in the wire). floor=0 callers use the
// unscoped SQL above and get today's full-session load unchanged.
const GET_ASSIGNMENTS_SCOPED_SQL =
    "SELECT message_id, tag_number, type, tool_owner_message_id, byte_size, token_count, input_byte_size, input_token_count FROM tags WHERE session_id = ? AND tag_number >= ? ORDER BY tag_number ASC";

/**
 * Session-local change signal for the `initFromDb` cache. Triggers advance it
 * only when a tag identity changes, so writes for the other active sessions in
 * a shared database cannot evict this session's in-memory assignment map.
 */
const probeTagsVersionStatements = new WeakMap<Database, PreparedStatement>();

function getProbeTagsVersionStatement(db: Database): PreparedStatement {
    let stmt = probeTagsVersionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(GET_TAGS_VERSION_SQL);
        probeTagsVersionStatements.set(db, stmt);
    }
    return stmt;
}

interface AssignmentRow {
    message_id: string;
    tag_number: number;
    type: TagEntry["type"];
    tool_owner_message_id: string | null;
    byte_size: number;
    token_count: number | null;
    input_byte_size: number;
    input_token_count: number | null;
}

/**
 * Per-session signature recorded at the last successful `initFromDb` reload.
 * Keyed by sessionId; tied to a specific `Database` object so we never
 * cache-hit across different connections (e.g. test fixtures, dashboard
 * hot reload, harness swap).
 */
interface LoadSignature {
    db: Database;
    tagsVersion: number;
    /**
     * Live-wire load-scoping floor in effect for the cached map. A floor change
     * (compaction boundary advanced, or a revert lowered it) must force exactly
     * one reload into the new range, so it is part of the cache identity.
     */
    floor: number;
}

function isAssignmentRow(row: unknown): row is AssignmentRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    const candidate = row as Record<string, unknown>;
    if (typeof candidate.message_id !== "string") return false;
    if (typeof candidate.tag_number !== "number") return false;
    if (candidate.type !== "message" && candidate.type !== "tool" && candidate.type !== "file")
        return false;
    if (
        candidate.tool_owner_message_id !== null &&
        typeof candidate.tool_owner_message_id !== "string"
    )
        return false;
    if (typeof candidate.byte_size !== "number") return false;
    if (candidate.token_count !== null && typeof candidate.token_count !== "number") return false;
    if (typeof candidate.input_byte_size !== "number") return false;
    if (candidate.input_token_count !== null && typeof candidate.input_token_count !== "number")
        return false;
    return true;
}

/**
 * Counter upsert is monotonic: ON CONFLICT we keep MAX(existing, new) so
 * concurrent writers (or a stale process catching up) cannot accidentally
 * roll the counter backwards. Combined with the DB-authoritative allocation
 * in assignTag(), this prevents a stale in-memory counter from re-issuing
 * tag numbers that another writer already claimed.
 *
 * `harness` is written on first INSERT only. On conflict we don't update it —
 * a session is created by exactly one harness (OpenCode or Pi) and that origin
 * doesn't change for the lifetime of the row.
 */
const UPSERT_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)
`;

const upsertCounterStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertCounterStatement(db: Database): PreparedStatement {
    let stmt = upsertCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(UPSERT_COUNTER_SQL);
        upsertCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Force-reset to 0. Distinct from the monotonic upsert above because callers
 * like /ctx-recomp need to roll the counter back to rebuild a session from
 * scratch. Includes harness on first INSERT for the same reason as the
 * monotonic upsert.
 */
const RESET_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, 0, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = 0
`;

const resetCounterStatements = new WeakMap<Database, PreparedStatement>();

function getResetCounterStatement(db: Database): PreparedStatement {
    let stmt = resetCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(RESET_COUNTER_SQL);
        resetCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Maximum retries when a tag_number INSERT collides with an existing row
 * for a different message_id (i.e. our counter is behind the DB max). Each
 * retry re-reads the DB max and tries the next slot. In practice 1-2 retries
 * are enough; the cap protects against pathological state divergence.
 */
const MAX_TAG_ALLOC_RETRIES = 5;

class MagicContextTaggerHeapHolder {
    readonly counters = new Map<string, number>();
    readonly assignments = new Map<string, Map<string, number>>();
    readonly toolAccountingBySession = new Map<string, Map<number, ToolTagAccounting>>();
    readonly loadSignatures = new Map<string, LoadSignature>();
}

export function createTagger(): Tagger {
    // Keep durable caches under one named owner because JSC snapshots expose
    // constructor names but no module/source paths.
    const heapHolder = new MagicContextTaggerHeapHolder();
    // per-session load signatures: tracks the DB state at the last
    // successful initFromDb() reload. A subsequent initFromDb() call can
    // skip the full DB scan when (a) the signature exists for this session,
    // (b) the recorded `db` object is identical to the current one, and
    // (c) the session-local tags version still matches. A different Database
    // object or a mapping write for this session falls through to a reload.
    // Same-connection tagger writes update this map directly and do not
    // invalidate the signature.
    //
    // Absence of a signature entry means "first load" (or post-cleanup /
    // post-resetCounter) so the next initFromDb is always a full reload.

    function getSessionAssignments(sessionId: string): Map<string, number> {
        let map = heapHolder.assignments.get(sessionId);
        if (!map) {
            map = new Map();
            heapHolder.assignments.set(sessionId, map);
        }
        return map;
    }

    function getSessionToolAccounting(sessionId: string): Map<number, ToolTagAccounting> {
        let map = heapHolder.toolAccountingBySession.get(sessionId);
        if (!map) {
            map = new Map();
            heapHolder.toolAccountingBySession.set(sessionId, map);
        }
        return map;
    }

    function isUniqueConstraintError(error: unknown): boolean {
        return (
            error instanceof Error &&
            "code" in error &&
            (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
        );
    }

    /**
     * Persist a counter value at least as large as `value`, both in memory
     * and in the session_meta table. The DB upsert is monotonic (MAX-based)
     * so this never moves the counter backwards, even under concurrent
     * writers from another process touching the same session.
     */
    function syncCounterAtLeast(sessionId: string, db: Database, value: number): void {
        if (value <= 0) return;
        const next = Math.max(heapHolder.counters.get(sessionId) ?? 0, value);
        heapHolder.counters.set(sessionId, next);
        getUpsertCounterStatement(db).run(sessionId, next, getHarness());
    }

    /**
     * Core allocation loop shared by both non-tool and tool tag paths.
     *
     * `mapKey` is the in-memory assignments key (bare messageId for
     * message/file, composite `<owner>\x00<callId>` for tool).
     * `toolOwnerMessageId` is null for non-tool tags and required for
     * tool tags. `dbExistingLookup` returns the persisted tag number
     * for this entity if one already exists (different lookup paths
     * for the bare-key vs composite-key cases).
     */
    function allocateTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize: number,
        toolName: string | null,
        inputByteSize: number,
        toolOwnerMessageId: string | null,
        mapKey: string,
        dbExistingLookup: () => number | null,
        entryFingerprint: string | null = null,
        tokenThunk?: () => TagTokenCounts,
    ): number {
        const sessionAssignments = getSessionAssignments(sessionId);

        const existing = sessionAssignments.get(mapKey);
        if (existing !== undefined) {
            return existing;
        }

        // Fast path: this entity already has a row in DB from a previous
        // pass. Bind the existing tag back into memory and bump the counter
        // to at least that value. This handles the case where the in-memory
        // assignments map was lost (cleanup/restart) but the DB still has
        // the row.
        const dbExisting = dbExistingLookup();
        if (dbExisting !== null) {
            sessionAssignments.set(mapKey, dbExisting);
            syncCounterAtLeast(sessionId, db, dbExisting);
            // One-time token backfill for legacy rows (written before the token
            // columns existed). Only fires when the row's token_count is still
            // NULL, so a populated row never re-tokenizes — this is the single
            // convergence point that lets both the sidebar and protected-tail
            // consumers SUM stored counts after at most one cold pass per tag.
            if (tokenThunk && tagTokenCountIsNull(db, sessionId, dbExisting)) {
                try {
                    backfillTagTokenCounts(db, sessionId, dbExisting, tokenThunk());
                } catch {
                    // Best-effort: a transient BUSY just defers backfill to the
                    // next observation. Consumers fall back to live tokenization
                    // for any message that still has a NULL tag this pass.
                }
            }
            return dbExisting;
        }

        // Only past both fast-paths do we have a genuinely new tag — invoke the
        // token thunk exactly once here so an existing tag never re-tokenizes.
        const tokenCounts = tokenThunk?.() ?? null;

        // Allocation loop (see assignTag pre-Layer-C comment for rationale).
        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const memCounter = heapHolder.counters.get(sessionId) ?? 0;
            const dbMax = getMaxTagNumberBySession(db, sessionId);
            const next = Math.max(memCounter, dbMax) + 1;

            try {
                db.transaction(() => {
                    // Ensure session_meta exists before the tags INSERT fires the
                    // per-session tags_version trigger. The transaction rolls both
                    // writes back if tag allocation fails.
                    getUpsertCounterStatement(db).run(sessionId, next, getHarness());
                    insertTag(
                        db,
                        sessionId,
                        messageId,
                        type,
                        byteSize,
                        next,
                        reasoningByteSize,
                        toolName,
                        inputByteSize,
                        toolOwnerMessageId,
                        entryFingerprint,
                        tokenCounts,
                    );
                }).immediate();
            } catch (error: unknown) {
                if (!isUniqueConstraintError(error)) {
                    throw error;
                }

                // UNIQUE collision. Two possible causes:
                //   (a) Another writer just claimed `next` for a DIFFERENT
                //       entity — recovery: advance counter and retry.
                //   (b) This entity was raced and now has its own row —
                //       recovery: bind the existing tag and return it.
                const racedRow = dbExistingLookup();
                if (racedRow !== null) {
                    sessionAssignments.set(mapKey, racedRow);
                    syncCounterAtLeast(sessionId, db, racedRow);
                    return racedRow;
                }

                const advancedDbMax = getMaxTagNumberBySession(db, sessionId);
                heapHolder.counters.set(sessionId, Math.max(memCounter, advancedDbMax));
                continue;
            }

            heapHolder.counters.set(sessionId, next);
            sessionAssignments.set(mapKey, next);
            const signature = heapHolder.loadSignatures.get(sessionId);
            if (signature?.db === db) {
                // The INSERT trigger advanced exactly once. Mirror our own write
                // so same-connection allocations retain the hot cache path.
                signature.tagsVersion += 1;
            }
            if (type === "tool") {
                getSessionToolAccounting(sessionId).set(next, {
                    byteSize,
                    tokenCount: tokenCounts?.tokenCount ?? null,
                    inputByteSize,
                    inputTokenCount: tokenCounts?.inputTokenCount ?? null,
                });
            }
            return next;
        }

        // Give up after retries — surface the failure so the transform
        // catch can log it and continue with reduced functionality.
        throw new Error(
            `tagger.allocateTag: failed to allocate tag for session=${sessionId} key=${mapKey} after ${MAX_TAG_ALLOC_RETRIES} retries`,
        );
    }

    function assignTag(
        sessionId: string,
        messageId: string,
        type: NonToolTagType,
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
        entryFingerprint: string | null = null,
        tokenThunk?: () => TagTokenCounts,
    ): number {
        // Defense-in-depth: TS narrowing already excludes "tool", but a
        // caller routing through `as any` could still hit this body.
        // Throw to surface the misuse loudly.
        if ((type as string) === "tool") {
            throw new Error(
                "tagger.assignTag: type='tool' is forbidden — use assignToolTag(sessionId, callId, ownerMsgId, ...)",
            );
        }
        return allocateTag(
            sessionId,
            messageId,
            type,
            byteSize,
            db,
            reasoningByteSize,
            toolName,
            inputByteSize,
            null,
            messageId,
            () => getAssignableTagNumberByMessageId(db, sessionId, messageId),
            entryFingerprint,
            tokenThunk,
        );
    }

    /**
     * One-time token backfill on the tool existing-row paths (DB hit, lazy
     * adoption, adoption-race recheck). Without this, pre-token-column tool
     * rows stay NULL forever — the non-tool path backfills in allocateTag,
     * but the tool fast paths return before reaching it, so legacy sessions
     * never converge and nullCount keeps the cheap trigger gate disabled.
     */
    function backfillToolTokensIfNull(
        db: Database,
        sessionId: string,
        tagNumber: number,
        tokenThunk?: () => TagTokenCounts,
    ): void {
        if (!tokenThunk) return;
        try {
            if (tagTokenCountIsNull(db, sessionId, tagNumber)) {
                backfillTagTokenCounts(db, sessionId, tagNumber, tokenThunk());
            }
        } catch {
            // Best-effort: a transient BUSY defers backfill to the next
            // observation; consumers fall back to live tokenization meanwhile.
        }
    }

    function assignToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
        tokenThunk?: () => TagTokenCounts,
    ): number {
        const compositeKey = makeToolCompositeKey(ownerMsgId, callId);
        const sessionAssignments = getSessionAssignments(sessionId);

        // Composite-key fast path
        const existing = sessionAssignments.get(compositeKey);
        if (existing !== undefined) {
            return existing;
        }

        // DB fast path: composite-keyed lookup. If the row already exists
        // for this exact (callId, ownerMsgId), bind and return.
        const dbHit = getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId);
        if (dbHit !== null) {
            sessionAssignments.set(compositeKey, dbHit);
            syncCounterAtLeast(sessionId, db, dbHit);
            backfillToolTokensIfNull(db, sessionId, dbHit, tokenThunk);
            return dbHit;
        }

        // Lazy adoption: legacy NULL-owner row exists for this callId and
        // is up for grabs. Try to atomically claim it.
        //
        // Loop: backfill (Layer B) may finish writing an owner between
        // our SELECT and UPDATE. The NULL-guarded UPDATE catches that
        // race; if the UPDATE matches zero rows we re-check the composite
        // fast path (which may now hit) and on miss try the next NULL row.
        // Bounded by MAX_TAG_ALLOC_RETRIES so we never loop unboundedly
        // even under pathological concurrent-writer interleavings.
        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const orphan = getNullOwnerToolTag(db, sessionId, callId);
            if (orphan === null) break;

            const claimed = adoptNullOwnerToolTag(db, orphan.id, ownerMsgId);
            if (claimed) {
                sessionAssignments.set(compositeKey, orphan.tagNumber);
                syncCounterAtLeast(sessionId, db, orphan.tagNumber);
                backfillToolTokensIfNull(db, sessionId, orphan.tagNumber, tokenThunk);
                return orphan.tagNumber;
            }

            // Race lost: re-check composite fast path before allocating
            // fresh — another writer may have just claimed the same row
            // for the same owner.
            const recheck = getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId);
            if (recheck !== null) {
                sessionAssignments.set(compositeKey, recheck);
                syncCounterAtLeast(sessionId, db, recheck);
                backfillToolTokensIfNull(db, sessionId, recheck, tokenThunk);
                return recheck;
            }
            // Otherwise loop: there may be more NULL-owner rows for this
            // callId (collision deviation: when legacy data has multiple
            // NULL-owner rows for the same callId, partial UNIQUE forced
            // only the lowest tag_number row to be adopted by backfill;
            // remaining rows stay NULL and we get to adopt one here).
        }

        // Fresh allocation
        return allocateTag(
            sessionId,
            callId,
            "tool",
            byteSize,
            db,
            reasoningByteSize,
            toolName,
            inputByteSize,
            ownerMsgId,
            compositeKey,
            () => getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId),
            null,
            tokenThunk,
        );
    }

    function getTag(
        sessionId: string,
        messageId: string,
        _type: NonToolTagType,
    ): number | undefined {
        // _type is unused at runtime — the parameter exists for compile-
        // time enforcement of the non-tool contract. Any caller passing
        // "tool" gets a TS error before this body runs.
        return heapHolder.assignments.get(sessionId)?.get(messageId);
    }

    function getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined {
        return heapHolder.assignments.get(sessionId)?.get(makeToolCompositeKey(ownerMsgId, callId));
    }

    function getToolTagAccounting(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
    ): ToolTagAccounting | undefined {
        const tagNumber = getToolTag(sessionId, callId, ownerMsgId);
        return tagNumber === undefined
            ? undefined
            : heapHolder.toolAccountingBySession.get(sessionId)?.get(tagNumber);
    }

    function setToolTagAccounting(
        sessionId: string,
        tagNumber: number,
        accounting: ToolTagAccounting,
    ): void {
        getSessionToolAccounting(sessionId).set(tagNumber, accounting);
    }

    function bindTag(sessionId: string, messageId: string, tagNumber: number): void {
        getSessionAssignments(sessionId).set(messageId, tagNumber);
    }

    function unbindTag(sessionId: string, messageId: string): void {
        getSessionAssignments(sessionId).delete(messageId);
    }

    function bindToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        tagNumber: number,
    ): void {
        getSessionAssignments(sessionId).set(makeToolCompositeKey(ownerMsgId, callId), tagNumber);
    }

    function unbindToolTag(sessionId: string, ownerMsgId: string, callId: string): void {
        getSessionAssignments(sessionId).delete(makeToolCompositeKey(ownerMsgId, callId));
    }

    function getAssignments(sessionId: string): ReadonlyMap<string, number> {
        return getSessionAssignments(sessionId);
    }

    function resetCounter(sessionId: string, db: Database): void {
        // Force-reset uses a non-monotonic UPDATE so callers can rebuild a
        // session from scratch (e.g. /ctx-recomp full rebuild). Bypass the
        // monotonic upsert by using a dedicated statement.
        heapHolder.counters.set(sessionId, 0);
        heapHolder.assignments.delete(sessionId);
        heapHolder.toolAccountingBySession.delete(sessionId);
        // Drop the load signature so the next initFromDb forces a full
        // reload rather than cache-hitting against pre-reset state.
        heapHolder.loadSignatures.delete(sessionId);
        getResetCounterStatement(db).run(sessionId, getHarness());
    }

    function getCounter(sessionId: string): number {
        return heapHolder.counters.get(sessionId) ?? 0;
    }

    /** Read the current mapping version for one session. */
    function probeSignature(sessionId: string, db: Database): { tagsVersion: number } {
        const row = getProbeTagsVersionStatement(db).get(sessionId) as
            | { tags_version: number }
            | null
            | undefined;
        return {
            tagsVersion: row?.tags_version ?? 0,
        };
    }

    /**
     * Load (or refresh) per-session tagger state from the DB.
     *
     * Cache-hit fast path: if this session's last successful full reload used
     * the same `Database` object and the current session-local tags version
     * still matches, trust the in-memory map/counter and skip the full
     * assignments scan.
     *
     * Cache-miss slow path: re-read assignments + counter from disk to pick
     * up writes made by sibling connections/processes. Same-connection tagger
     * writes deliberately do NOT invalidate this cache: `assignTag`,
     * `assignToolTag`, fallback adoption, and unbind/bind paths mutate
     * `sessionAssignments`/`counters` in memory as they persist the mapping.
     * Non-mapping same-connection writes (`status`, `drop_mode`, byte/token
     * counts, source content, pending ops, etc.) do not affect what this loader
     * reads, so forcing a reload for them only burns hot-path latency.
     *
     * The previous `if (heapHolder.counters.has(sessionId)) return` short-circuit had a
     * subtle bug: once the in-memory counter drifted behind the DB max
     * (stale process or concurrent writer), it could never self-heal — every
     * `assignTag` would keep proposing already-claimed tag numbers and either
     * bounce through the collision-recovery path or fail outright. The
     * session-local version keeps cross-connection refresh correctness without
     * unrelated sessions forcing a per-pass rescan.
     *
     * Record the cached signature only after a successful full reload so a
     * thrown query never leaves fresh signature metadata pointing at stale
     * in-memory state.
     */
    function initFromDb(sessionId: string, db: Database, floor = 0): void {
        const probe = probeSignature(sessionId, db);
        const cached = heapHolder.loadSignatures.get(sessionId);
        if (
            cached !== undefined &&
            cached.db === db &&
            cached.tagsVersion === probe.tagsVersion &&
            cached.floor === floor
        ) {
            return;
        }

        const row = db.prepare(GET_COUNTER_SQL).get(sessionId) as
            | { counter: number }
            | null
            | undefined;
        // floor > 0: load only the live-wire range (tag_number >= floor). floor=0
        // (Pi, and the OpenCode fallback when no floor could be derived) keeps the
        // full-session load unchanged. Self-heal (dbExistingLookup in allocateTag)
        // rebinds any below-floor in-wire tag to its exact persisted number, so a
        // scoped load is byte-identical on the wire — it only changes how many
        // point lookups happen this pass.
        const assignmentRows = (
            floor > 0
                ? db.prepare(GET_ASSIGNMENTS_SCOPED_SQL).all(sessionId, floor)
                : db.prepare(GET_ASSIGNMENTS_SQL).all(sessionId)
        ).filter(isAssignmentRow);
        const sessionAssignments = getSessionAssignments(sessionId);
        sessionAssignments.clear();
        const sessionToolAccounting = getSessionToolAccounting(sessionId);
        sessionToolAccounting.clear();

        let maxTagNumber = 0;
        for (const assignment of assignmentRows) {
            // v3.3.1 Layer C: tool tags with non-NULL owner enter the
            // map under their composite key so getToolTag/assignToolTag
            // can hit. NULL-owner tool rows are intentionally NOT
            // placed in the in-memory map — they're discoverable via
            // the lazy-adoption DB query (getNullOwnerToolTag) the
            // next time their callId is observed in a transform pass.
            // This guarantees only "fully identified" rows live in
            // memory; NULL-owner orphans get adopted on first touch
            // rather than racing against fresh allocations.
            if (assignment.type === "tool") {
                if (assignment.tool_owner_message_id !== null) {
                    sessionAssignments.set(
                        makeToolCompositeKey(
                            assignment.tool_owner_message_id,
                            assignment.message_id,
                        ),
                        assignment.tag_number,
                    );
                    sessionToolAccounting.set(assignment.tag_number, {
                        byteSize: assignment.byte_size,
                        tokenCount: assignment.token_count,
                        inputByteSize: assignment.input_byte_size,
                        inputTokenCount: assignment.input_token_count,
                    });
                }
                // else: NULL-owner — skip the in-memory binding.
            } else {
                sessionAssignments.set(assignment.message_id, assignment.tag_number);
            }
            if (assignment.tag_number > maxTagNumber) {
                maxTagNumber = assignment.tag_number;
            }
        }

        // Counter is the largest of three signals: persisted counter (what
        // we last wrote), DB max from the assignments table (what's actually
        // claimed), and current in-memory counter (what we already allocated
        // in this process). Taking the max of all three guarantees we never
        // hand out a number some other writer has already taken.
        const counter = Math.max(
            row?.counter ?? 0,
            maxTagNumber,
            heapHolder.counters.get(sessionId) ?? 0,
        );
        heapHolder.counters.set(sessionId, counter);

        // Record the signature AFTER the full reload completes successfully
        // so a thrown query never leaves us with a fresh signature pointing
        // at stale in-memory state.
        heapHolder.loadSignatures.set(sessionId, {
            db,
            tagsVersion: probe.tagsVersion,
            floor,
        });
    }

    function getLoadedTagsVersion(sessionId: string, db: Database): number | undefined {
        const signature = heapHolder.loadSignatures.get(sessionId);
        return signature?.db === db ? signature.tagsVersion : undefined;
    }

    function cleanup(sessionId: string): void {
        heapHolder.counters.delete(sessionId);
        heapHolder.assignments.delete(sessionId);
        heapHolder.toolAccountingBySession.delete(sessionId);
        // Drop the load signature so the next initFromDb forces a full
        // reload rather than cache-hitting against pre-cleanup state.
        heapHolder.loadSignatures.delete(sessionId);
    }

    function getHeapStats(): TaggerHeapStats {
        const sessionIds = new Set([
            ...heapHolder.counters.keys(),
            ...heapHolder.assignments.keys(),
            ...heapHolder.toolAccountingBySession.keys(),
            ...heapHolder.loadSignatures.keys(),
        ]);
        const sessions = [...sessionIds].map((sessionId) => ({
            sessionId,
            assignments: heapHolder.assignments.get(sessionId)?.size ?? 0,
            toolAccounting: heapHolder.toolAccountingBySession.get(sessionId)?.size ?? 0,
        }));
        return {
            sessionCount: sessionIds.size,
            assignmentEntries: sessions.reduce((sum, session) => sum + session.assignments, 0),
            toolAccountingEntries: sessions.reduce(
                (sum, session) => sum + session.toolAccounting,
                0,
            ),
            loadSignatureEntries: heapHolder.loadSignatures.size,
            sessions,
        };
    }

    return {
        assignTag,
        assignToolTag,
        getTag,
        getToolTag,
        getToolTagAccounting,
        setToolTagAccounting,
        bindTag,
        unbindTag,
        bindToolTag,
        unbindToolTag,
        getAssignments,
        resetCounter,
        getCounter,
        initFromDb,
        getLoadedTagsVersion,
        cleanup,
        getHeapStats,
    };
}
