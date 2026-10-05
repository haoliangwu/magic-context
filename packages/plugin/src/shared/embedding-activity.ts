/** Track busy status only for sessions observed by this process; untracked sessions are not assumed busy. */
const busySessions = new Set<string>();

export function setEmbeddingSessionBusy(sessionId: string, busy: boolean): void {
    if (busy) busySessions.add(sessionId);
    else busySessions.delete(sessionId);
}

export function observeEmbeddingActivity(event: { type: string; properties?: unknown }): void {
    const props = event.properties as
        | { sessionID?: string; status?: { type?: string } }
        | undefined;
    if (!props || typeof props.sessionID !== "string") return;
    if (
        event.type === "session.idle" ||
        event.type === "session.deleted" ||
        (event.type === "session.status" && props.status?.type === "idle")
    ) {
        setEmbeddingSessionBusy(props.sessionID, false);
    } else if (event.type === "session.status" && props.status?.type) {
        setEmbeddingSessionBusy(props.sessionID, true);
    }
}

export function isEmbeddingHostBusy(): boolean {
    return busySessions.size > 0;
}

/**
 * Forget every busy session (tests only). A test that starts an agent turn and
 * never ends it would otherwise leave the whole process busy, and background
 * embedding in later tests of the same process would stop at once.
 */
export function resetEmbeddingActivityForTests(): void {
    busySessions.clear();
}
