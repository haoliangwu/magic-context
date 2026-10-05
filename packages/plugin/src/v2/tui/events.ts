/**
 * OpenCode 2 events carry their session id in several different shapes
 * depending on the event family (`sessionID`/`sessionId`/`id`, sometimes nested
 * under `data` or `info`), so one extractor serves every v2 TUI listener.
 */
export function eventSessionID(event: unknown): string | undefined {
    if (typeof event !== "object" || event === null) return undefined;
    const record = event as Record<string, unknown>;
    const data =
        typeof record.data === "object" && record.data !== null
            ? (record.data as Record<string, unknown>)
            : record;
    for (const key of ["sessionID", "sessionId", "id"]) {
        if (typeof data[key] === "string") return data[key];
    }
    const info = data.info;
    if (typeof info === "object" && info !== null) {
        const nested = info as Record<string, unknown>;
        if (typeof nested.sessionID === "string") return nested.sessionID;
        if (typeof nested.id === "string") return nested.id;
    }
    return undefined;
}
