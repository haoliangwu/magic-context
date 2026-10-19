import type { AutoSearchHintNoHintReason } from "../features/magic-context/storage-meta-persisted";

const pending = new Map<string, Set<AbortController>>();
const unpublishedNoHints = new Map<string, Map<string, AutoSearchHintNoHintReason>>();

/**
 * A failed save can still send the user message without a search hint. Remember
 * that no-hint decision until a later pass saves it to SQLite, including across
 * closing and reopening the database handle. Switching or shutting down a session
 * does not prove deletion and must not discard it. If all compare-and-swap (CAS)
 * save retries fail and the process restarts before repair, this unsaved record
 * is lost: that compound failure is the remaining durability gap.
 */
export function rememberUnpublishedAutoSearchNoHint(
    sessionId: string,
    messageId: string,
    reason: AutoSearchHintNoHintReason,
): void {
    let messages = unpublishedNoHints.get(sessionId);
    if (!messages) {
        messages = new Map();
        unpublishedNoHints.set(sessionId, messages);
    }
    if (!messages.has(messageId)) messages.set(messageId, reason);
}

export function getUnpublishedAutoSearchNoHint(
    sessionId: string,
    messageId: string,
): AutoSearchHintNoHintReason | undefined {
    return unpublishedNoHints.get(sessionId)?.get(messageId);
}

export function forgetUnpublishedAutoSearchNoHint(sessionId: string, messageId: string): void {
    const messages = unpublishedNoHints.get(sessionId);
    messages?.delete(messageId);
    if (messages?.size === 0) unpublishedNoHints.delete(sessionId);
}

/** Deleting a session releases its unsaved no-hint records; switching away does not. */
export function clearUnpublishedAutoSearchNoHints(sessionId?: string): void {
    if (sessionId === undefined) unpublishedNoHints.clear();
    else unpublishedNoHints.delete(sessionId);
}

/** Cleanup cancels optional searches and backfill, not durable served decisions. */
export function registerAutoSearchWork(sessionId: string): {
    signal: AbortSignal;
    done: () => void;
} {
    const controller = new AbortController();
    const work = pending.get(sessionId) ?? new Set<AbortController>();
    pending.set(sessionId, work);
    work.add(controller);
    return {
        signal: controller.signal,
        done: () => {
            work.delete(controller);
            if (pending.get(sessionId) === work && work.size === 0) pending.delete(sessionId);
        },
    };
}

export function cancelAutoSearchWork(sessionId?: string): void {
    for (const [id, work] of pending) {
        if (sessionId !== undefined && id !== sessionId) continue;
        pending.delete(id);
        for (const controller of work) controller.abort();
    }
}
