/**
 * Exact ordinal-to-message-id reads for historian boundary validation, run on a
 * worker thread.
 *
 * An exact read of the message at ordinal N evaluates the JSON of every message
 * before it (see `readRawSessionMessageIdOrdinalsForRangeFromDb`). On a session
 * of 175k messages in a large, cold OpenCode store that took seconds per call
 * and froze the whole server, every session with it. This module runs the same
 * reads on a worker with its own read-only connection, so the serving thread
 * only waits asynchronously.
 *
 * Exactness rules:
 * - Every request starts a fresh read. A finished answer goes only to the
 *   callers that were waiting for it; it is never cached for a later caller,
 *   because an interior edit can change ordinals without any cheap signal.
 * - Concurrent callers asking for the same ordinals of the same session share
 *   the outstanding read. At most one read per session runs at a time.
 * - A caller that cannot get an answer gets "not-ready", which means: skip this
 *   historian start and let a later pass try again. It is not a failure.
 *
 * Waiting is bounded in transform passes: every pass of the session counts
 * against the outstanding read, and after {@link EXACT_ORDINAL_READ_DEFER_PASS_CAP}
 * passes its waiters are released with "not-ready". The released read keeps
 * running until it finishes, so the next attempt cannot start a second scan of
 * the same session; that attempt reads afresh once the first one has finished.
 *
 * Only sessions read straight from the OpenCode 1 store file use the worker.
 * Sessions served by a registered provider (OpenCode 2, Pi, in-memory test
 * stores) return null so the caller keeps its synchronous read: another
 * connection cannot see those stores, and their range reads do not parse each
 * preceding message.
 */
import { sessionLog } from "../../shared/logger";
import { getSqliteDatabasePath } from "../../shared/sqlite";
import {
    type BoundarySnapshotValidationResult,
    boundarySnapshotIdChecks,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";
import { type RawOrdinalWarmupOptions, runSessionWarmupWorker } from "./raw-ordinal-warmup";
import { hasRawMessageProvider } from "./read-session-chunk";
import { openCodeDbExists, withReadOnlySessionDb } from "./read-session-db";

/**
 * How many transform passes of a session may go by while a historian run waits
 * for its exact read before the run gives up and leaves the start to a later
 * pass. A pass is one request the transform prepares for the session.
 */
export const EXACT_ORDINAL_READ_DEFER_PASS_CAP = 6;

/** A worker that has not answered by then is treated as unavailable for this attempt. */
const EXACT_ORDINAL_READ_RESULT_MS = 2 * 60_000;

export type ExactOrdinalReadNotReadyReason =
    /** The session's passes reached the cap while the read was outstanding. */
    | "pass-cap"
    /**
     * A read for this session is still running: either one whose waiters the
     * pass cap already released, or one for a different set of ordinals.
     */
    | "read-outstanding"
    /** The worker could not start or did not answer. */
    | "worker-failed";

export type ExactOrdinalIdsAnswer =
    | { kind: "ready"; ids: ReadonlyMap<number, string | null> }
    | { kind: "not-ready"; reason: ExactOrdinalReadNotReadyReason };

interface OutstandingRead {
    sessionId: string;
    ordinalsKey: string;
    passes: number;
    released: boolean;
    answer: Promise<ExactOrdinalIdsAnswer>;
    release: () => void;
}

/** Keyed by store path and session id: one running read per session and store. */
const outstanding = new Map<string, OutstandingRead>();
const capLoggedSessions = new Set<string>();
let readsStarted = 0;
let workerOptionsForTest: RawOrdinalWarmupOptions | null = null;

function readStorePath(sessionId: string): string | null {
    if (hasRawMessageProvider(sessionId) || !openCodeDbExists()) return null;
    return withReadOnlySessionDb(getSqliteDatabasePath);
}

/**
 * Read the message id at each ordinal on a worker, exactly as a synchronous
 * single-ordinal read would. Returns null when the session is not read from an
 * OpenCode 1 store file; the caller then reads synchronously as before.
 */
export function readExactRawMessageIdsOffThread(
    sessionId: string,
    ordinals: readonly number[],
    options: RawOrdinalWarmupOptions = {},
): Promise<ExactOrdinalIdsAnswer> | null {
    const path = readStorePath(sessionId);
    if (!path) return null;
    const wanted = [...new Set(ordinals)].sort((left, right) => left - right);
    const ordinalsKey = wanted.join(",");
    const key = `${path}\0${sessionId}`;
    const running = outstanding.get(key);
    if (running) {
        if (!running.released && running.ordinalsKey === ordinalsKey) return running.answer;
        return Promise.resolve({ kind: "not-ready", reason: "read-outstanding" });
    }

    let settle: (answer: ExactOrdinalIdsAnswer) => void = () => {};
    const answer = new Promise<ExactOrdinalIdsAnswer>((resolve) => {
        settle = resolve;
    });
    const read: OutstandingRead = {
        sessionId,
        ordinalsKey,
        passes: 0,
        released: false,
        answer,
        release: () => {
            read.released = true;
            settle({ kind: "not-ready", reason: "pass-cap" });
        },
    };
    outstanding.set(key, read);
    readsStarted += 1;
    const forget = () => {
        if (outstanding.get(key) === read) outstanding.delete(key);
    };
    void runSessionWarmupWorker(
        { path, sessionId, exactOrdinalIds: wanted },
        {
            ...workerOptionsForTest,
            ...options,
            resultMs:
                options.resultMs ?? workerOptionsForTest?.resultMs ?? EXACT_ORDINAL_READ_RESULT_MS,
        },
    )
        .then((result) => {
            // Forget the read before answering, so no caller that runs after the
            // answer can join a read that has already finished.
            forget();
            if ("exactOrdinalIds" in result) {
                settle({ kind: "ready", ids: new Map(result.exactOrdinalIds) });
                return;
            }
            const detail = "failure" in result ? `${result.failure}: ${result.detail}` : "";
            sessionLog(
                sessionId,
                `exact ordinal read unavailable (${detail}); the historian start waits for a later pass`,
            );
            settle({ kind: "not-ready", reason: "worker-failed" });
        })
        .catch((error: unknown) => {
            forget();
            sessionLog(sessionId, "exact ordinal read failed; the historian start waits:", error);
            settle({ kind: "not-ready", reason: "worker-failed" });
        });
    return answer;
}

/**
 * Count one transform pass of the session against its outstanding exact read.
 * At the cap the read's waiters get "not-ready"; the first time a session
 * reaches it in this process is logged.
 */
export function noteTransformPassForExactOrdinalReads(sessionId: string): void {
    for (const read of outstanding.values()) {
        if (read.sessionId !== sessionId || read.released) continue;
        read.passes += 1;
        if (read.passes < EXACT_ORDINAL_READ_DEFER_PASS_CAP) continue;
        if (!capLoggedSessions.has(sessionId)) {
            capLoggedSessions.add(sessionId);
            sessionLog(
                sessionId,
                `historian start released after ${EXACT_ORDINAL_READ_DEFER_PASS_CAP} passes waiting for an exact ordinal read; a later pass starts it again once that read finishes`,
            );
        }
        read.release();
    }
}

export type OffThreadBoundaryValidation =
    | { kind: "validated"; result: BoundarySnapshotValidationResult }
    | { kind: "not-ready"; reason: ExactOrdinalReadNotReadyReason };

/**
 * {@link validateBoundarySnapshot} with its exact id reads done on a worker.
 * The count, fingerprint and offset checks still run on this thread after the
 * ids arrive; they use bounded reads. Sessions without an OpenCode 1 store file
 * validate synchronously, exactly as before.
 */
export async function validateBoundarySnapshotOffThread(
    args: Parameters<typeof validateBoundarySnapshot>[0],
    options: RawOrdinalWarmupOptions = {},
): Promise<OffThreadBoundaryValidation> {
    const { snapshot } = args;
    // A changed context limit fails validation before any id is read.
    if (args.currentContextLimit && args.currentContextLimit !== snapshot.contextLimit)
        return { kind: "validated", result: validateBoundarySnapshot(args) };
    const request = readExactRawMessageIdsOffThread(
        snapshot.sessionId,
        boundarySnapshotIdChecks(snapshot).map(([ordinal]) => ordinal),
        options,
    );
    if (!request) return { kind: "validated", result: validateBoundarySnapshot(args) };
    const answer = await request;
    if (answer.kind === "not-ready") return answer;
    return {
        kind: "validated",
        result: validateBoundarySnapshot({ ...args, exactIds: answer.ids }),
    };
}

/** @internal Worker reads started in this process. */
export function getExactOrdinalReadsStartedForTest(): number {
    return readsStarted;
}

/** @internal Worker options for reads started without explicit options, e.g. a silent test worker. */
export function setExactOrdinalReadWorkerOptionsForTest(
    options: RawOrdinalWarmupOptions | null,
): void {
    workerOptionsForTest = options;
}

/** @internal */
export function resetExactOrdinalReadsForTest(): void {
    for (const read of outstanding.values()) read.release();
    outstanding.clear();
    capLoggedSessions.clear();
    readsStarted = 0;
    workerOptionsForTest = null;
}
