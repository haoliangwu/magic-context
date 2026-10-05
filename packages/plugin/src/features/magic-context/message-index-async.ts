import type {
    RawMessage,
    RawMessageOrdinalAnchor,
} from "../../hooks/magic-context/read-session-raw";
import { scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { log, sessionLog } from "../../shared/logger";
import { type Database, withSqliteBackgroundWriter } from "../../shared/sqlite";
import {
    clearIndexedMessages,
    getLastIndexedOrdinal,
    getMessageIndexReconciliationStartOrdinal,
    getMessageIndexSourceIdentity,
    indexMessagesAfterOrdinal,
    indexSingleMessage,
    isMessageIndexReconciledThrough,
    isMessageIndexSourceCurrent,
} from "./message-index";

/**
 * Detect SQLite "database is locked" errors so the async indexer can
 * downgrade them to a one-line warning instead of a stack trace.
 *
 * Why we tolerate them: incremental indexing is best-effort. Any BUSY
 * conflict is fully recoverable by the next reconciliation pass (which
 * re-reads `last_indexed_ordinal` and indexes everything missed). A
 * single SQLITE_BUSY here just means another writer (concurrent
 * transform on a different session, dreamer task, second OpenCode
 * instance) held the WAL writer lock past our 5s `busy_timeout`.
 * Throwing turns a normal busy-window into a stack trace in user logs
 * without changing the eventual indexing outcome — reconciliation fills
 * in any missed rows automatically the next time
 * `scheduleReconciliation` runs.
 */
function isDatabaseLockedError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as { code?: unknown; message?: unknown };
    if (typeof e.code === "string") {
        if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED") return true;
    }
    if (typeof e.message === "string") {
        if (/database is locked/i.test(e.message)) return true;
        if (/sqlite_(busy|locked)/i.test(e.message)) return true;
    }
    return false;
}

/**
 * Event-driven message-history FTS indexing.
 *
 * v0.17 removes indexing from the `searchMessages()` hot path. Search now only
 * runs an FTS5 SELECT; writes happen through three asynchronous triggers:
 *
 * 1. Live incremental indexing: terminal `message.updated` events schedule a
 *    single-message read and `indexSingleMessage()` insert/replace. Events are
 *    debounced per message for 100ms and completed revisions are keyed by the
 *    source version plus normalized-content hash.
 * 2. Per-session lazy reconciliation: the first transform/hook touch schedules
 *    one catch-up pass. It reads raw messages, resumes from
 *    `message_history_index.last_indexed_ordinal`, rewinds from any recorded
 *    dirty floor left by a failed incremental write, inserts missing rows, and
 *    advances the watermark to `messages.length`.
 * 3. Revert/delete handling: `message.removed` clears all FTS rows + the
 *    watermark and then re-runs reconciliation. Searches during that rebuild
 *    window correctly see no message hits.
 *
 * Concurrency: all writes for one session go through a module-scope async lock
 * (`sessionLocks`). Work for different sessions can run in parallel; work for
 * the same session chains behind the prior Promise, so reconciliation, live
 * inserts, and clear+rebuild cannot double-insert or race the watermark.
 *
 * Watermark semantics: `last_indexed_ordinal` means every message with ordinal
 * <= watermark has been processed (inserted when indexable, skipped otherwise).
 */

const INCREMENTAL_DEBOUNCE_MS = 100;
const RECONCILIATION_BATCH_SIZE = 100;

class MagicContextMessageIndexHeapHolder {
    readonly reconciledSessions = new Set<string>();
    readonly reconciliationScheduledSessions = new Set<string>();
    readonly clearAndReindexScheduledSessions = new Map<
        string,
        { source: MessageReconciliationSource }
    >();
    readonly sessionLocks = new Map<string, Promise<void>>();
    readonly incrementalTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly pendingIncrementalKeys = new Set<string>();
    readonly completedIncrementalKeys = new Set<string>();
    readonly activeReconcilerBuffers = new Map<string, readonly RawMessage[]>();
}

const heapHolder = new MagicContextMessageIndexHeapHolder();

function clearCompletedIncrementalKeys(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of heapHolder.completedIncrementalKeys) {
        if (key.startsWith(prefix)) heapHolder.completedIncrementalKeys.delete(key);
    }
}

type FullReadMessages = ((sessionId: string) => RawMessage[]) & {
    readPage?: (
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
        after?: RawMessageOrdinalAnchor,
    ) => RawMessage[];
    getCount?: (sessionId: string) => number;
};

export interface BoundedMessageReconciliationSource {
    readPage(
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
        after?: RawMessageOrdinalAnchor,
    ): RawMessage[];
    getCount(sessionId: string): number;
}

export type MessageReconciliationSource = FullReadMessages | BoundedMessageReconciliationSource;
type ReadSingleMessage = (sessionId: string, messageId: string) => RawMessage | null;
type IncrementalMessageSource = ReadSingleMessage | RawMessage;

function defer(fn: () => void): void {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
        .setImmediate;
    if (typeof immediate === "function") {
        immediate(fn);
        return;
    }
    setTimeout(fn, 0);
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => defer(resolve));
}

function runWithSessionLock(
    sessionId: string,
    operation: () => Promise<void> | void,
): Promise<void> {
    const previous = heapHolder.sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(async () => {
            await operation();
        });

    heapHolder.sessionLocks.set(sessionId, run);
    run.finally(() => {
        if (heapHolder.sessionLocks.get(sessionId) === run) {
            heapHolder.sessionLocks.delete(sessionId);
        }
    }).catch(() => undefined);

    return run;
}

function logIndexingError(sessionId: string, action: string, error: unknown): void {
    if (isDatabaseLockedError(error)) {
        // Concise warning, no stack trace. Reconciliation catches up later.
        sessionLog(
            sessionId,
            `message FTS async ${action} skipped (database busy; will retry on next reconciliation)`,
        );
        return;
    }
    sessionLog(
        sessionId,
        `message FTS async ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    log(`[message-index-async] ${action} failed for ${sessionId}:`, error);
}

function serializedMessageBytes(messages: readonly RawMessage[]): number {
    try {
        return Buffer.byteLength(JSON.stringify(messages));
    } catch {
        return 0;
    }
}

async function reconcileSessionIndex(
    db: Database,
    sessionId: string,
    readMessages: MessageReconciliationSource,
): Promise<void> {
    await runWithSessionLock(sessionId, async () => {
        if (heapHolder.reconciledSessions.has(sessionId)) return;

        let fallbackSnapshot: RawMessage[] | null = null;
        try {
            const fullReader = typeof readMessages === "function" ? readMessages : null;
            const finalWatermark = readMessages.getCount
                ? readMessages.getCount(sessionId)
                : (fallbackSnapshot = fullReader?.(sessionId) ?? []).length;
            let cursor = getMessageIndexReconciliationStartOrdinal(db, sessionId);
            let after: RawMessageOrdinalAnchor | undefined;

            while (cursor < finalWatermark) {
                const pageEnd = Math.min(finalWatermark, cursor + RECONCILIATION_BATCH_SIZE);
                const messages = readMessages.readPage
                    ? readMessages.readPage(
                          sessionId,
                          cursor,
                          RECONCILIATION_BATCH_SIZE,
                          finalWatermark,
                          after,
                      )
                    : (fallbackSnapshot ?? []).filter(
                          (message) => message.ordinal > cursor && message.ordinal <= pageEnd,
                      );
                const retainedMessages = fallbackSnapshot ?? messages;
                heapHolder.activeReconcilerBuffers.set(sessionId, retainedMessages);

                withSqliteBackgroundWriter(() =>
                    indexMessagesAfterOrdinal(db, sessionId, messages, cursor, pageEnd),
                );
                const nextCursor = getMessageIndexReconciliationStartOrdinal(db, sessionId);
                if (nextCursor <= cursor) break;
                cursor = nextCursor;
                const last = messages.at(-1);
                // Only seek from a row whose ordinal matches the durable progress.
                // Empty/filtered pages may advance farther than the last hydrated row.
                after =
                    last?.ordinal === cursor && typeof last.createdAt === "number"
                        ? { timeCreated: last.createdAt, id: last.id }
                        : undefined;

                if (cursor < finalWatermark) {
                    // One bounded page is the maximum synchronous work per event-loop
                    // turn. The timer-backed await lets host I/O run before the next
                    // source read and writer transaction.
                    await yieldToEventLoop();
                }
            }

            if (isMessageIndexReconciledThrough(db, sessionId, finalWatermark)) {
                heapHolder.reconciledSessions.add(sessionId);
            }
        } finally {
            heapHolder.activeReconcilerBuffers.delete(sessionId);
        }
    });
}

export function scheduleReconciliation(
    db: Database,
    sessionId: string,
    readMessages: MessageReconciliationSource,
): void {
    if (
        heapHolder.reconciledSessions.has(sessionId) ||
        heapHolder.reconciliationScheduledSessions.has(sessionId)
    ) {
        return;
    }
    heapHolder.reconciliationScheduledSessions.add(sessionId);

    scheduleAfterBootQuiet(() => {
        defer(() => {
            void reconcileSessionIndex(db, sessionId, readMessages)
                .catch((error) => {
                    logIndexingError(sessionId, "reconciliation", error);
                    if (isDatabaseLockedError(error))
                        setTimeout(
                            () => scheduleReconciliation(db, sessionId, readMessages),
                            1000,
                        ).unref();
                })
                .finally(() => {
                    heapHolder.reconciliationScheduledSessions.delete(sessionId);
                });
        });
    });
}

export function scheduleIncrementalIndex(
    db: Database,
    sessionId: string,
    messageId: string,
    messageSource: IncrementalMessageSource,
): void {
    const schedulingKey = `${sessionId}\u0000${messageId}`;
    if (heapHolder.pendingIncrementalKeys.has(schedulingKey)) return;

    const activeTimer = heapHolder.incrementalTimers.get(schedulingKey);
    if (activeTimer) clearTimeout(activeTimer);

    // Restart the settle window for every update. OpenCode can repeat a terminal
    // message.updated event as its final parts land; a trailing debounce reads the
    // authoritative message once after that burst instead of once per timer window.
    const timer = setTimeout(() => {
        heapHolder.incrementalTimers.delete(schedulingKey);
        heapHolder.pendingIncrementalKeys.add(schedulingKey);
        void runWithSessionLock(sessionId, () => {
            const message =
                typeof messageSource === "function"
                    ? messageSource(sessionId, messageId)
                    : messageSource;
            if (!message) return;

            const revisionKey = `${schedulingKey}\u0000${getMessageIndexSourceIdentity(message)}`;
            if (heapHolder.completedIncrementalKeys.has(revisionKey)) return;

            const currentWatermark = getLastIndexedOrdinal(db, sessionId);
            if (
                message.ordinal <= currentWatermark &&
                isMessageIndexSourceCurrent(db, sessionId, message)
            ) {
                heapHolder.completedIncrementalKeys.add(revisionKey);
                return;
            }

            const wasReconciled = heapHolder.reconciledSessions.delete(sessionId);
            withSqliteBackgroundWriter(() => indexSingleMessage(db, sessionId, message));
            const finalWatermark = getLastIndexedOrdinal(db, sessionId);
            if (wasReconciled && isMessageIndexReconciledThrough(db, sessionId, finalWatermark)) {
                heapHolder.reconciledSessions.add(sessionId);
            }
            heapHolder.completedIncrementalKeys.add(revisionKey);
        })
            .catch((error) => {
                heapHolder.reconciledSessions.delete(sessionId);
                logIndexingError(sessionId, `incremental index for ${messageId}`, error);
                if (isDatabaseLockedError(error))
                    setTimeout(
                        () => scheduleIncrementalIndex(db, sessionId, messageId, messageSource),
                        1000,
                    ).unref();
            })
            .finally(() => {
                heapHolder.pendingIncrementalKeys.delete(schedulingKey);
            });
    }, INCREMENTAL_DEBOUNCE_MS);

    heapHolder.incrementalTimers.set(schedulingKey, timer);
}

export function scheduleClearAndReindex(
    db: Database,
    sessionId: string,
    readMessages: MessageReconciliationSource,
): void {
    heapHolder.reconciledSessions.delete(sessionId);
    heapHolder.reconciliationScheduledSessions.delete(sessionId);
    clearCompletedIncrementalKeys(sessionId);

    const existing = heapHolder.clearAndReindexScheduledSessions.get(sessionId);
    if (existing) {
        existing.source = readMessages;
        return;
    }
    const pending = { source: readMessages };
    heapHolder.clearAndReindexScheduledSessions.set(sessionId, pending);

    scheduleAfterBootQuiet(() => {
        defer(() => {
            let cleared = false;
            void runWithSessionLock(sessionId, () => {
                if (heapHolder.clearAndReindexScheduledSessions.get(sessionId) !== pending) return;
                // Coalesce removals only until the clear starts. A removal during
                // paged reconciliation must schedule another authoritative rebuild.
                heapHolder.clearAndReindexScheduledSessions.delete(sessionId);
                // An older boot-quiet reconciliation can finish after this clear was
                // scheduled, so invalidate process state under the same session lock
                // that clears the durable index.
                heapHolder.reconciledSessions.delete(sessionId);
                clearCompletedIncrementalKeys(sessionId);
                clearIndexedMessages(db, sessionId);
                cleared = true;
            })
                .then(() =>
                    cleared ? reconcileSessionIndex(db, sessionId, pending.source) : undefined,
                )
                .catch((error) => {
                    heapHolder.reconciledSessions.delete(sessionId);
                    if (heapHolder.clearAndReindexScheduledSessions.get(sessionId) === pending)
                        heapHolder.clearAndReindexScheduledSessions.delete(sessionId);
                    logIndexingError(sessionId, "clear and reindex", error);
                });
        });
    });
}

export interface MessageIndexQueueHeapStats {
    queueLength: number;
    reconciliationScheduled: number;
    incrementalTimers: number;
    pendingIncremental: number;
    activeSessionLocks: number;
    completedIncrementalKeys: number;
    activeBufferMessages: number;
    activeBufferBytes: number;
}

/** Live async-index holder counts used by the opt-in heap diagnostic RPC. */
export function getMessageIndexQueueHeapStats(): MessageIndexQueueHeapStats {
    return {
        queueLength:
            heapHolder.reconciliationScheduledSessions.size +
            heapHolder.incrementalTimers.size +
            heapHolder.pendingIncrementalKeys.size,
        reconciliationScheduled: heapHolder.reconciliationScheduledSessions.size,
        incrementalTimers: heapHolder.incrementalTimers.size,
        pendingIncremental: heapHolder.pendingIncrementalKeys.size,
        activeSessionLocks: heapHolder.sessionLocks.size,
        completedIncrementalKeys: heapHolder.completedIncrementalKeys.size,
        activeBufferMessages: [...heapHolder.activeReconcilerBuffers.values()].reduce(
            (sum, messages) => sum + messages.length,
            0,
        ),
        activeBufferBytes: [...heapHolder.activeReconcilerBuffers.values()].reduce(
            (sum, messages) => sum + serializedMessageBytes(messages),
            0,
        ),
    };
}

export function isSessionReconciled(sessionId: string): boolean {
    return heapHolder.reconciledSessions.has(sessionId);
}

export function clearSessionTracking(sessionId: string): void {
    heapHolder.clearAndReindexScheduledSessions.delete(sessionId);
    heapHolder.reconciledSessions.delete(sessionId);
    heapHolder.reconciliationScheduledSessions.delete(sessionId);
    heapHolder.sessionLocks.delete(sessionId);
    heapHolder.activeReconcilerBuffers.delete(sessionId);

    const prefix = `${sessionId}\u0000`;
    for (const [key, timer] of heapHolder.incrementalTimers) {
        if (key.startsWith(prefix)) {
            clearTimeout(timer);
            heapHolder.incrementalTimers.delete(key);
        }
    }

    for (const key of heapHolder.pendingIncrementalKeys) {
        if (key.startsWith(prefix)) {
            heapHolder.pendingIncrementalKeys.delete(key);
        }
    }
    for (const key of heapHolder.completedIncrementalKeys) {
        if (key.startsWith(prefix)) heapHolder.completedIncrementalKeys.delete(key);
    }
}

export function __resetMessageIndexAsyncForTests(): void {
    heapHolder.clearAndReindexScheduledSessions.clear();
    for (const timer of heapHolder.incrementalTimers.values()) {
        clearTimeout(timer);
    }
    heapHolder.reconciledSessions.clear();
    heapHolder.reconciliationScheduledSessions.clear();
    heapHolder.sessionLocks.clear();
    heapHolder.incrementalTimers.clear();
    heapHolder.pendingIncrementalKeys.clear();
    heapHolder.completedIncrementalKeys.clear();
    heapHolder.activeReconcilerBuffers.clear();
}
