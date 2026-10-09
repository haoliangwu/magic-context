import type { Database } from "../../shared/sqlite";

// Decode prerelease blob entries only during migration; runtime reads indexed rows.
const PREFIX = "temporal-message-v1:";

export function encodeTemporalDecision(messageId: string, marker: string): string {
    return PREFIX + JSON.stringify([messageId, marker]);
}

export function decodeTemporalDecision(entry: string): [string, string] | null {
    if (!entry.startsWith(PREFIX)) return null;
    try {
        const pair: unknown = JSON.parse(entry.slice(PREFIX.length));
        if (
            Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === "string" &&
            pair[0] &&
            typeof pair[1] === "string"
        )
            return [pair[0], pair[1]];
    } catch {
        /* Invalid entries are not rendering instructions. */
    }
    return null;
}

type TemporalRow = { message_id: string; marker: string | null };

function readRows(db: Database, sessionId: string, messageIds?: Iterable<string>): TemporalRow[] {
    if (!messageIds)
        return db
            .prepare("SELECT message_id,marker FROM temporal_decisions WHERE session_id=?")
            .all(sessionId) as TemporalRow[];
    const ids = [...messageIds];
    const result: TemporalRow[] = [];
    for (let offset = 0; offset < ids.length; offset += 400) {
        const chunk = ids.slice(offset, offset + 400);
        result.push(
            ...(db
                .prepare(
                    `SELECT message_id,marker FROM temporal_decisions WHERE session_id=? AND message_id IN (${chunk.map(() => "?").join(",")})`,
                )
                .all(sessionId, ...chunk) as TemporalRow[]),
        );
    }
    return result;
}

export function getTemporalDecisions(
    db: Database,
    sessionId: string,
    messageIds?: Iterable<string>,
): Map<string, string> {
    return new Map(
        readRows(db, sessionId, messageIds).flatMap((row) =>
            row.marker === null ? [] : [[row.message_id, row.marker] as const],
        ),
    );
}

/** Adopt legacy served bytes before tagging can make a new identity look historical. */
export function observeTemporalDecisions(
    db: Database,
    sessionId: string,
    candidates: ReadonlyMap<string, string>,
    previouslyServed?: (messageIds: Iterable<string>) => ReadonlyMap<string, string>,
    messageIds?: Iterable<string>,
): Map<string, string> {
    // Eligibility decides new choices only. A message that has been edited to
    // transport-shaped text still replays its existing identity-owned choice.
    const ids = new Set([...candidates.keys(), ...(messageIds ?? [])]);
    const rows = readRows(db, sessionId, ids);
    const known = new Set(rows.map((row) => row.message_id));
    const missing = [...candidates].filter(([id]) => !known.has(id));
    if (!missing.length)
        return new Map(
            rows.flatMap((row) =>
                row.marker === null ? [] : [[row.message_id, row.marker] as const],
            ),
        );
    const transient = new Map<string, string>();
    db.transaction(() => {
        const insert = db.prepare(
            "INSERT OR IGNORE INTO temporal_decisions(session_id,message_id,marker) VALUES (?,?,?)",
        );
        const servedTag = db.prepare(
            "SELECT 1 FROM tags WHERE session_id=? AND message_id=? UNION ALL SELECT 1 FROM tags WHERE session_id=? AND message_id>=? AND message_id<? LIMIT 1",
        );
        let served: ReadonlyMap<string, string> | undefined;
        for (const [id, candidate] of missing) {
            const historical = servedTag.get(sessionId, id, sessionId, `${id}:p`, `${id}:q`);
            if (historical) {
                served ??= previouslyServed?.(missing.map(([missingId]) => missingId)) ?? new Map();
                const previous = served.get(id);
                if (previous === undefined) {
                    // A tag proves identity, not previously served bytes. Keep
                    // this legacy choice undecided (no row) until a rebuild.
                    // Its transient display follows the old renderer; NULL
                    // rows remain reserved for newly observed unmarked text.
                    transient.set(id, candidate);
                    continue;
                }
                // A newly discoverable gap is not adoption when the exact last
                // served projection proves that this message had no marker.
                insert.run(sessionId, id, previous === "" && candidate !== "" ? null : previous);
            } else {
                // Remember that this was a new, unmarked message, rather than
                // mistaking its newly minted tag for old-code served evidence.
                insert.run(sessionId, id, null);
            }
        }
    }).immediate();
    return new Map([...transient, ...getTemporalDecisions(db, sessionId, ids)]);
}

/** First writer wins by message identity. Never change served bytes before commit. */
export function freezeTemporalDecisions(
    db: Database,
    sessionId: string,
    candidates: ReadonlyMap<string, string>,
): Map<string, string> {
    if (candidates.size === 0) return new Map();
    return db
        .transaction(() => {
            const insert = db.prepare(
                "INSERT INTO temporal_decisions(session_id,message_id,marker) VALUES (?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET marker=excluded.marker WHERE temporal_decisions.marker IS NULL",
            );
            for (const [id, marker] of candidates) {
                insert.run(sessionId, id, marker);
            }
            return getTemporalDecisions(db, sessionId, candidates.keys());
        })
        .immediate();
}

export function deleteTemporalDecision(db: Database, sessionId: string, messageId: string): void {
    db.prepare("DELETE FROM temporal_decisions WHERE session_id=? AND message_id=?").run(
        sessionId,
        messageId,
    );
}
