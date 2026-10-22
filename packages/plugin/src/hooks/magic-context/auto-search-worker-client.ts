import { Worker } from "node:worker_threads";
import {
    embedBatchForProject,
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import type { EmbeddingPurpose } from "../../features/magic-context/memory/embedding-provider";
import type {
    CapturedQueryEmbedding,
    MessageHistorySearchOutcome,
    MessageHistorySearchRequest,
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import {
    type AutoSearchHintDecision,
    appendAutoSearchHintDecision,
} from "../../features/magic-context/storage-meta-persisted";
import {
    forgetUnpublishedAutoSearchNoHint,
    getUnpublishedAutoSearchNoHint,
    registerAutoSearchWork,
    rememberUnpublishedAutoSearchNoHint,
} from "../../shared/auto-search-lifecycle";
import { isEmbeddingHostBusy } from "../../shared/embedding-activity";
import { getHarness, type HarnessId } from "../../shared/harness";
import { log } from "../../shared/logger";
import {
    assertTransformWrite,
    type Database,
    getSqliteDatabasePath,
    isTransientSqliteError,
} from "../../shared/sqlite";
import {
    AUTO_SEARCH_TIMEOUT_MS,
    AUTO_SEARCH_VECTOR_TIMEOUT_MS,
    autoSearchDeadlineUnixMs,
} from "./auto-search-deadline";

const pendingRegistrations = new WeakMap<Database, Set<string>>();
const pendingTurns = new WeakMap<
    Database,
    Map<string, Map<string, { promise: Promise<unknown>; signal: AbortSignal }>>
>();

/** Same-turn passes join one search, then replay the owner's served decision. */
export async function coalesceAutoSearchTurn<T>(
    db: Database,
    sessionId: string,
    messageId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    replay: () => void,
): Promise<T> {
    let sessions = pendingTurns.get(db);
    if (!sessions) {
        sessions = new Map();
        pendingTurns.set(db, sessions);
    }
    let turns = sessions.get(sessionId);
    if (!turns) {
        turns = new Map();
        sessions.set(sessionId, turns);
    }
    const pending = turns.get(messageId);
    if (pending && !pending.signal.aborted) {
        const result = await pending.promise;
        if (!pending.signal.aborted) replay();
        return result as T;
    }
    const lifecycle = registerAutoSearchWork(sessionId);
    const work = Promise.resolve().then(() => operation(lifecycle.signal));
    const turn = { promise: work, signal: lifecycle.signal };
    turns.set(messageId, turn);
    try {
        return await work;
    } finally {
        lifecycle.done();
        if (turns.get(messageId) === turn) turns.delete(messageId);
        if (turns.size === 0) sessions.delete(sessionId);
    }
}

/** Cold optional hints skip immediately. Registration starts after the served
 * stage, and is deduplicated until it settles; warm hints never load config or
 * drain embedding-identity maintenance. Startup/tools own configuration refresh. */
export function queueAutoSearchRegistration(
    db: Database,
    projectPath: string,
    register?: () => Promise<void>,
): void {
    if (!register) return;
    let pending = pendingRegistrations.get(db);
    if (!pending) {
        pending = new Set();
        pendingRegistrations.set(db, pending);
    }
    if (pending.has(projectPath)) return;
    pending.add(projectPath);
    const timer = setTimeout(() => {
        if (getProjectEmbeddingSnapshot(projectPath)) {
            pending.delete(projectPath);
            return;
        }
        void Promise.resolve()
            .then(register)
            .catch((error) =>
                log(
                    `[auto-search] background registration failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            )
            .finally(() => pending.delete(projectPath));
    }, 0);
    timer.unref?.();
}

/** Only the owner publishes a decision. Once master's synchronous append succeeds,
 * serve it: never reject a committed hint because of a later IPC acknowledgement. */
export function persistAutoSearchDecision(
    db: Database,
    sessionId: string,
    decision: AutoSearchHintDecision,
    startedAt: number,
): ReturnType<typeof appendAutoSearchHintDecision> | null {
    if (performance.now() - startedAt >= AUTO_SEARCH_TIMEOUT_MS) return null;
    let outcome: ReturnType<typeof appendAutoSearchHintDecision>;
    try {
        outcome = appendAutoSearchHintDecision(db, sessionId, decision);
    } catch (error) {
        assertTransformWrite();
        rememberUnpublishedAutoSearchNoHint(
            sessionId,
            decision.messageId,
            decision.decision === "no-hint" ? decision.reason : "error",
        );
        // A locked store must not refuse the turn over this bookkeeping write.
        // The message is now remembered as served without a hint, so this pass
        // serves it plain and a later pass retries the save before any search
        // could add a hint to bytes the provider has already cached.
        if (!isTransientSqliteError(error)) throw error;
        log(
            `[auto-search] decision save hit a busy store for session ${sessionId}; serving without a hint and retrying the save on a later pass: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ok: false, kind: "storage-busy" };
    }
    if (!outcome.ok) {
        assertTransformWrite();
        rememberUnpublishedAutoSearchNoHint(
            sessionId,
            decision.messageId,
            decision.decision === "no-hint" ? decision.reason : "error",
        );
    } else if (outcome.decision.decision === "no-hint") {
        forgetUnpublishedAutoSearchNoHint(sessionId, decision.messageId);
    }
    return outcome;
}

/** Retry saving a served no-hint decision before a recovered search can change its bytes. */
export function retryUnpublishedAutoSearchNoHint(
    db: Database,
    sessionId: string,
    messageId: string,
    startedAt: number,
): boolean {
    const reason = getUnpublishedAutoSearchNoHint(sessionId, messageId);
    if (reason === undefined) return false;
    try {
        persistAutoSearchDecision(
            db,
            sessionId,
            { messageId, decision: "no-hint", reason },
            startedAt,
        );
    } catch (error) {
        assertTransformWrite();
        log(
            `[auto-search] frozen omission save still failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return true;
}

export interface AutoSearchWorkerInput {
    persistent?: boolean;
    job?: "search" | "backfill" | "messages";
    path: string;
    harness: HarnessId;
    sessionId: string;
    projectPath: string;
    query: string;
    options: Omit<
        UnifiedSearchOptions,
        | "embedQuery"
        | "isEmbeddingRuntimeEnabled"
        | "signal"
        | "readMessages"
        | "searchMessageHistory"
    >;
    embeddingRuntimeEnabled: boolean;
    embeddingHostBusy: boolean;
    snapshot: ReturnType<typeof getProjectEmbeddingSnapshot>;
    deadlineUnixMs?: number;
    /** The message-history lane to run, for the "messages" job. */
    messageRequest?: MessageHistorySearchRequest;
}
export type AutoSearchWorkerReply =
    | { kind: "result"; results: UnifiedSearchResult[] }
    | { kind: "messages"; outcome: MessageHistorySearchOutcome }
    /** Sent by a "messages" job as soon as its thread runs, before loading search code. */
    | { kind: "accepted" }
    | { kind: "error"; error: string }
    | { kind: "query"; id: number; text: string }
    | { kind: "batch"; id: number; texts: string[]; purpose: EmbeddingPurpose };
export type AutoSearchEmbeddingReply = {
    id: number;
    embeddingHostBusy?: boolean;
    result?: CapturedQueryEmbedding | Float32Array | null;
    passage?: {
        vectors: (Float32Array | null)[];
        modelId: string;
        generation: number;
        providerIdentity: string;
        runtimeFingerprint: string;
        dimensions: number | null;
    } | null;
    error?: string;
};

/**
 * Keep every search SELECT and vector scan off the prompt thread.
 * Workers are cached by database, harness, project, job and entry URL so matching
 * searches reuse their SQLite connection and incremental decoded-vector pool.
 * On abort, discard the worker without awaiting termination. Only the owner
 * appends hint decisions; search workers return results on read-only connections.
 * All provider calls stay with the owner and share the caller's abort signal.
 */
export async function searchAutoHint(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions,
    entry = new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./auto-search-worker.ts"
            : "./auto-search-worker.js",
        import.meta.url,
    ),
): Promise<UnifiedSearchResult[]> {
    return executeAutoSearchWorker(db, sessionId, projectPath, query, options, entry, "search");
}

const pendingBackfills = new WeakMap<Database, Map<string, Promise<void>>>();

interface SearchWorkerSlot {
    worker: Worker;
    busy?: Promise<void>;
    release?: () => void;
    idleTimer?: ReturnType<typeof setTimeout>;
    dispose(): void;
}
const searchWorkers = new WeakMap<Database, Map<string, SearchWorkerSlot>>();
const liveSearchWorkers = new Set<SearchWorkerSlot>();
const MAX_IDLE_SEARCH_WORKERS = 4;
const SEARCH_WORKER_IDLE_MS = 5 * 60_000;
let workersCreated = 0;
let workersReused = 0;

export function getAutoSearchWorkerStats(): { created: number; reused: number } {
    return { created: workersCreated, reused: workersReused };
}

export function disposeIdleAutoSearchWorkers(): void {
    for (const slot of liveSearchWorkers) if (!slot.busy) slot.dispose();
}

async function acquireSearchWorker(
    db: Database,
    key: string,
    entry: URL,
    input: AutoSearchWorkerInput,
    signal: AbortSignal,
): Promise<{ slot: SearchWorkerSlot; fresh: boolean } | null> {
    const pool = searchWorkers.get(db) ?? new Map<string, SearchWorkerSlot>();
    searchWorkers.set(db, pool);
    while (!signal.aborted) {
        let slot = pool.get(key);
        if (slot?.busy) {
            const current = slot;
            await new Promise<void>((resolve) => {
                const done = () => {
                    signal.removeEventListener("abort", done);
                    resolve();
                };
                signal.addEventListener("abort", done, { once: true });
                void current.busy?.then(done);
                if (signal.aborted) done();
            });
            continue;
        }
        const fresh = !slot;
        if (!slot) {
            const worker = inRootAsyncContext(
                () => new Worker(entry, { workerData: { ...input, persistent: true } }),
            );
            slot = {
                worker,
                dispose() {
                    clearTimeout(this.idleTimer);
                    if (pool.get(key) === this) pool.delete(key);
                    liveSearchWorkers.delete(this);
                    void worker.terminate();
                    worker.unref();
                },
            };
            workersCreated++;
            pool.set(key, slot);
            liveSearchWorkers.add(slot);
            const current = slot;
            worker.on("error", () => current.dispose());
            worker.on("exit", () => current.dispose());
        } else workersReused++;
        clearTimeout(slot.idleTimer);
        const current = slot;
        current.busy = new Promise<void>((resolve) => {
            current.release = resolve;
        });
        current.worker.ref();
        return { slot: current, fresh };
    }
    return null;
}

/** Called only after the owner has decided the hint. No background result can
 * change that decision, and cleanup cancels both queued and active jobs. */
export function queueAutoSearchBackfill(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
): Promise<void> {
    if (isEmbeddingHostBusy()) return Promise.resolve();
    const key = `${sessionId}\0${projectPath}`;
    const pending = pendingBackfills.get(db) ?? new Map<string, Promise<void>>();
    pendingBackfills.set(db, pending);
    const prior = pending.get(key);
    if (prior) return prior;
    const lifecycle = registerAutoSearchWork(sessionId);
    const work = new Promise<void>((resolve) => {
        const done = () => {
            lifecycle.done();
            pending.delete(key);
            resolve();
        };
        const queued = inRootAsyncContext(() =>
            setTimeout(() => {
                lifecycle.signal.removeEventListener("abort", cancel);
                if (lifecycle.signal.aborted) return done();
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10_000);
                timeout.unref?.();
                void executeAutoSearchWorker(
                    db,
                    sessionId,
                    projectPath,
                    query,
                    { signal: AbortSignal.any([controller.signal, lifecycle.signal]) },
                    new URL(
                        new URL(import.meta.url).pathname.endsWith(".ts")
                            ? "./auto-search-worker.ts"
                            : "./auto-search-worker.js",
                        import.meta.url,
                    ),
                    "backfill",
                )
                    .catch((error) => log("[auto-search] background backfill failed:", error))
                    .finally(() => {
                        clearTimeout(timeout);
                        done();
                    });
            }, 0),
        );
        const cancel = () => {
            clearTimeout(queued);
            done();
        };
        lifecycle.signal.addEventListener("abort", cancel, { once: true });
        queued.unref?.();
    });
    pending.set(key, work);
    return work;
}

async function executeAutoSearchWorker(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions,
    entry: URL,
    job: "search" | "backfill",
): Promise<UnifiedSearchResult[]> {
    if (options.signal?.aborted) return [];
    const path = getSqliteDatabasePath(db);
    if (!path) throw new Error("auto-search requires a file-backed database for off-thread search");
    const {
        embedQuery,
        isEmbeddingRuntimeEnabled,
        signal: deadlineSignal,
        readMessages: _readMessages,
        searchMessageHistory: _searchMessageHistory,
        ...serializable
    } = options;
    const lifecycle = registerAutoSearchWork(sessionId);
    const signal = deadlineSignal
        ? AbortSignal.any([deadlineSignal, lifecycle.signal])
        : lifecycle.signal;
    const snapshot = getProjectEmbeddingSnapshot(projectPath);
    const input: AutoSearchWorkerInput = {
        job,
        path,
        harness: getHarness(),
        sessionId,
        projectPath,
        query,
        options: {
            ...serializable,
            autoHint: true,
            backfillMemoryEmbeddings: false,
            countRetrievals: false,
            measurementDisabled: true,
        },
        embeddingRuntimeEnabled: isEmbeddingRuntimeEnabled?.() ?? false,
        embeddingHostBusy: isEmbeddingHostBusy(),
        snapshot,
        deadlineUnixMs: autoSearchDeadlineUnixMs(deadlineSignal),
    };
    let lease: Awaited<ReturnType<typeof acquireSearchWorker>>;
    try {
        lease = await acquireSearchWorker(
            db,
            `${input.harness}\0${projectPath}\0${job}\0${entry.href}`,
            entry,
            input,
            signal,
        );
    } catch (error) {
        lifecycle.done();
        throw error;
    }
    if (!lease) {
        lifecycle.done();
        return [];
    }
    const { slot, fresh } = lease;
    const worker = slot.worker;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (results: UnifiedSearchResult[], error?: Error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            lifecycle.signal.removeEventListener("abort", abort);
            lifecycle.done();
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
            if (error || signal.aborted || entry.href !== defaultAutoSearchWorkerEntry().href)
                slot.dispose();
            else {
                slot.idleTimer = setTimeout(() => slot.dispose(), SEARCH_WORKER_IDLE_MS);
                slot.idleTimer.unref?.();
            }
            const release = slot.release;
            slot.busy = undefined;
            slot.release = undefined;
            release?.();
            const reusable = liveSearchWorkers.delete(slot);
            if (reusable) liveSearchWorkers.add(slot);
            const idle = [...liveSearchWorkers].filter((candidate) => !candidate.busy);
            for (const prior of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_SEARCH_WORKERS)))
                prior.dispose();
            worker.unref();
            if (error) reject(error);
            else resolve(results);
        };
        const abort = () => finish([]);
        signal?.addEventListener("abort", abort, { once: true });
        lifecycle.signal.addEventListener("abort", abort, { once: true });
        const onError = (error: Error) => finish([], error);
        const onExit = (code: number) =>
            finish([], new Error(`auto-search worker exited (${code})`));
        const onMessage = async (reply: AutoSearchWorkerReply) => {
            if (settled) return;
            if (reply.kind === "result") {
                // A registration can change while the worker is ranking. Never serve
                // vectors from a generation that the owner has since replaced.
                if (
                    snapshot &&
                    getProjectEmbeddingSnapshot(projectPath)?.generation !== snapshot.generation
                )
                    finish([]);
                else finish(reply.results);
                return;
            }
            if (reply.kind === "error") {
                finish([], new Error(reply.error));
                return;
            }
            // Only the "messages" job answers with these.
            if (reply.kind === "messages" || reply.kind === "accepted") return;
            const response: AutoSearchEmbeddingReply = { id: reply.id };
            try {
                if (reply.kind === "query")
                    response.result =
                        (await (job === "backfill"
                            ? embedTextForProject(projectPath, reply.text, signal, "query")
                            : boundedHintEmbedding(embedQuery, reply.text, signal))) ?? null;
                else {
                    const passage = await embedBatchForProject(
                        projectPath,
                        reply.texts,
                        signal,
                        reply.purpose,
                    );
                    const current = getProjectEmbeddingSnapshot(projectPath);
                    response.passage =
                        passage && current
                            ? {
                                  ...passage,
                                  providerIdentity: current.providerIdentity,
                                  runtimeFingerprint: current.runtimeFingerprint,
                                  dimensions:
                                      passage.vectors.find((vector) => vector !== null)?.length ??
                                      null,
                              }
                            : null;
                }
            } catch (error) {
                response.error = error instanceof Error ? error.message : String(error);
            }
            response.embeddingHostBusy = isEmbeddingHostBusy();
            // Providers that ignore abort can complete late. Never send their
            // continuation into a dead worker or a subsequent turn's request.
            if (!settled && !signal?.aborted) {
                try {
                    worker.postMessage(response);
                } catch (error) {
                    finish([], error instanceof Error ? error : new Error(String(error)));
                }
            }
        };
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.on("message", onMessage);
        if (signal?.aborted) abort();
        else if (!fresh) {
            try {
                worker.postMessage({ kind: "run", input });
            } catch (error) {
                finish([], error instanceof Error ? error : new Error(String(error)));
            }
        }
    });
}

async function boundedHintEmbedding(
    embed: UnifiedSearchOptions["embedQuery"],
    text: string,
    signal: AbortSignal,
): Promise<CapturedQueryEmbedding | Float32Array | null> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(() => embed?.(text, combined) ?? null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    resolve(null);
                    controller.abort();
                }, AUTO_SEARCH_VECTOR_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function defaultAutoSearchWorkerEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./auto-search-worker.ts"
            : "./auto-search-worker.js",
        import.meta.url,
    );
}

/**
 * How long a message-search worker may take to report that its thread is
 * running. It does so before loading any search code, so this covers only
 * thread start.
 */
const MESSAGE_WORKER_ACCEPT_TIMEOUT_MS = 400;
/** How long an accepted message-search worker may take to answer. */
const MESSAGE_WORKER_RESULT_TIMEOUT_MS = 30_000;

export type MessageSearchWorkerFallbackReason =
    | "no-file"
    | "start-failed"
    | "not-accepted"
    | "no-result"
    | "worker-error"
    | "exited";

const messageSearchWorkerFallbacks = new Map<MessageSearchWorkerFallbackReason, number>();

/** How often each reason sent a message search back to the calling thread. */
export function getMessageSearchWorkerFallbacks(): ReadonlyMap<
    MessageSearchWorkerFallbackReason,
    number
> {
    return messageSearchWorkerFallbacks;
}

/**
 * Run the message-history lane of a search on a worker with its own read-only
 * connection, so its FTS statements (the per-probe match counts of an explicit
 * `ctx_search` in particular) never run on the serving thread. The worker calls
 * the same `searchMessageHistory`, so results and ranking are unchanged.
 *
 * Resolves null when the store has no file a worker can open, the worker fails
 * or exits, does not report that it is running within
 * MESSAGE_WORKER_ACCEPT_TIMEOUT_MS, or does not answer within
 * MESSAGE_WORKER_RESULT_TIMEOUT_MS after that. The caller then runs the lane
 * in process as before. Each fallback is logged and counted by reason (see
 * {@link getMessageSearchWorkerFallbacks}).
 */
export function searchMessageHistoryOffThread(
    db: Database,
    request: MessageHistorySearchRequest,
    entry: URL = defaultAutoSearchWorkerEntry(),
    deadlines: { acceptMs?: number; resultMs?: number } = {},
): Promise<MessageHistorySearchOutcome | null> {
    const fallback = (reason: MessageSearchWorkerFallbackReason, detail?: unknown) => {
        messageSearchWorkerFallbacks.set(
            reason,
            (messageSearchWorkerFallbacks.get(reason) ?? 0) + 1,
        );
        log(
            `[search] message search runs in process (${reason})${
                detail === undefined
                    ? ""
                    : `: ${detail instanceof Error ? detail.message : String(detail)}`
            }`,
        );
    };
    const path = getSqliteDatabasePath(db);
    if (!path) {
        fallback("no-file");
        return Promise.resolve(null);
    }
    const input: AutoSearchWorkerInput = {
        job: "messages",
        path,
        harness: getHarness(),
        sessionId: request.sessionId,
        projectPath: "",
        query: request.query,
        options: {},
        embeddingRuntimeEnabled: false,
        embeddingHostBusy: false,
        snapshot: null,
        messageRequest: request,
    };
    return new Promise((resolve) => {
        let settled = false;
        let worker: Worker | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (
            outcome: MessageHistorySearchOutcome | null,
            reason?: MessageSearchWorkerFallbackReason,
            detail?: unknown,
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (reason) fallback(reason, detail);
            void worker?.terminate();
            worker?.unref();
            resolve(outcome);
        };
        const arm = (reason: MessageSearchWorkerFallbackReason, ms: number) => {
            clearTimeout(deadline);
            deadline = setTimeout(() => finish(null, reason, `no reply within ${ms} ms`), ms);
            deadline.unref?.();
        };
        try {
            worker = inRootAsyncContext(() => new Worker(entry, { workerData: input }));
        } catch (error) {
            finish(null, "start-failed", error);
            return;
        }
        arm("not-accepted", deadlines.acceptMs ?? MESSAGE_WORKER_ACCEPT_TIMEOUT_MS);
        worker.on("message", (reply: AutoSearchWorkerReply) => {
            if (reply.kind === "accepted")
                arm("no-result", deadlines.resultMs ?? MESSAGE_WORKER_RESULT_TIMEOUT_MS);
            else if (reply.kind === "messages") finish(reply.outcome);
            else if (reply.kind === "error") finish(null, "worker-error", reply.error);
        });
        worker.on("error", (error) => finish(null, "worker-error", error));
        worker.on("exit", (code) => finish(null, "exited", `exit code ${code}`));
    });
}

import { inRootAsyncContext } from "../../shared/sqlite";
