/**
 * Whether a messages transform ran for this session since the system hook last
 * looked, or since a newer assistant reply completed.
 *
 * OpenCode 1 builds every provider request in the same order: the prompt loop runs
 * `experimental.chat.messages.transform`, converts the messages, re-reads AGENTS.md
 * and configured instruction files, and only then runs
 * `experimental.chat.system.transform` inside the LLM request builder. So when the
 * system hook sees a changed system prompt, the messages of that same request are
 * already final, and the new system text is already going to the provider. That
 * request rewrites the provider's prompt cache from the system block onward.
 * Scheduling a Magic Context rebuild for the following request would make the
 * provider rewrite its cache a second time one request later.
 *
 * Valid only where the messages transform runs before the system hook for every
 * main request, as on stock OpenCode 1. There each messages pass sets the marker
 * and its own system hook consumes it, so no completion event is needed to tell
 * which request the marker belongs to.
 *
 * The marker is keyed by session only. It carries no request identity, so it means
 * "a messages pass ran since the last consumption or newer completion", NOT "the
 * messages pass of this request ran". On a host that runs the system hook first, an
 * earlier request that ends without a completed-assistant event, or whose event has
 * not arrived yet, leaves its marker behind. The next request's system hook then
 * reads true before that request's messages transform has run. The request-hook-order
 * unit test that pins this limitation names the failing sequence. Do not wire this
 * helper into a system-first host without a seam that ties the system hook and the
 * messages transform to the same request. OpenCode 2 (its context hook runs the
 * system stage before the transform) and Pi (`processSystemPromptForCache` in
 * `before_agent_start`) deliberately do not use it.
 *
 * A completion clears the marker only for a reply newer than every assistant
 * message the messages pass saw, so a late event for an earlier reply cannot clear
 * a fresh marker.
 */
export interface RequestHookOrder {
    /** The messages transform is preparing a provider request for this session. */
    messagesPrepared(
        sessionId: string,
        messages: readonly { info?: { id?: unknown; role?: unknown } }[],
    ): void;
    /** An assistant message finished (served, failed or aborted). */
    assistantCompleted(sessionId: string, messageId: string | undefined): void;
    /**
     * Called by the system hook. True when a messages pass ran since the last
     * consumption or newer completion. On a messages-first host (stock OpenCode 1)
     * that pass belongs to this request, so its messages can no longer change.
     * Consumes the marker.
     */
    consumeMessagesPrepared(sessionId: string): boolean;
    clearSession(sessionId: string): void;
}

export function createRequestHookOrder(): RequestHookOrder {
    // Value: the newest assistant message id the messages pass saw ("" when none).
    const prepared = new Map<string, string>();
    return {
        messagesPrepared(sessionId, messages) {
            let newestAssistant = "";
            for (const message of messages) {
                const id = message.info?.id;
                if (message.info?.role !== "assistant" || typeof id !== "string") continue;
                if (id > newestAssistant) newestAssistant = id;
            }
            prepared.set(sessionId, newestAssistant);
        },
        assistantCompleted(sessionId, messageId) {
            const newestSeen = prepared.get(sessionId);
            if (newestSeen === undefined) return;
            // OpenCode message ids sort by creation time. An id we cannot compare is
            // treated as a newer reply: the fallback is the system-first path.
            if (messageId === undefined || messageId > newestSeen) prepared.delete(sessionId);
        },
        consumeMessagesPrepared(sessionId) {
            const had = prepared.has(sessionId);
            prepared.delete(sessionId);
            return had;
        },
        clearSession(sessionId) {
            prepared.delete(sessionId);
        },
    };
}
