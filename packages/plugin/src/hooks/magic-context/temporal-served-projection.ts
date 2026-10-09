import type { Database } from "../../shared/sqlite";
import { loadPersistedLkgSlot } from "./lkg-persist";
import { getInMemorySlot } from "./lkg-slot";
import { peelLeadingMcTagNotation } from "./tag-content-primitives";
import { TEMPORAL_MARKER_REPLAY_PATTERN } from "./temporal-awareness";

function readLkgTemporalDecisions(
    db: Database,
    sessionId: string,
    runtime: "pi" | "opencode",
): Map<string, string> {
    const slot = getInMemorySlot(sessionId) ?? loadPersistedLkgSlot(db, sessionId);
    if (!slot) return new Map();
    let messages: unknown;
    try {
        messages = JSON.parse(slot.jsonPrefix);
    } catch {
        return new Map();
    }
    if (!Array.isArray(messages)) return new Map();
    const result = new Map<string, string>();
    const tagOwner = db.prepare("SELECT message_id FROM tags WHERE session_id=? AND tag_number=?");
    for (let index = 0; index < messages.length; index++) {
        const raw = messages[index];
        if (!raw || typeof raw !== "object") continue;
        const message = raw as {
            role?: string;
            info?: { id?: string; role?: string };
            content?: unknown;
            parts?: Array<{ type?: string; text?: string; ignored?: boolean }>;
        };
        const role = runtime === "pi" ? message.role : message.info?.role;
        if (role !== "user") continue;
        const parts = runtime === "pi" ? message.content : message.parts;
        const text =
            typeof parts === "string"
                ? parts
                : Array.isArray(parts)
                  ? parts.find((part) => part?.type === "text" && part.ignored !== true)?.text
                  : undefined;
        if (typeof text !== "string") continue;
        let id = runtime === "pi" ? slot.piOutputEntryIds?.[index] : message.info?.id;
        if (!id && runtime === "pi") {
            // Older Pi snapshots lacked an output-ownership vector. Their §N§
            // prefix still names an unambiguous persisted tag in this session.
            const tag = /^§(\d+)§/.exec(text);
            const owner = tag
                ? (tagOwner.get(sessionId, Number(tag[1])) as { message_id: string } | undefined)
                : undefined;
            id = owner?.message_id.replace(/:p\d+$/, "");
        }
        if (!id) continue;
        const marker = peelLeadingMcTagNotation(text).body.match(
            TEMPORAL_MARKER_REPLAY_PATTERN,
        )?.[0];
        result.set(id, marker ? `${marker.trimEnd()}\n` : "");
    }
    return result;
}

/** Exact LKG bytes win; only missing identities consult their first persisted text. */
export function readServedTemporalDecisions(
    db: Database,
    sessionId: string,
    runtime: "pi" | "opencode",
    messageIds?: Iterable<string>,
): Map<string, string> {
    const result = readLkgTemporalDecisions(db, sessionId, runtime);
    if (!messageIds) return result;
    const select = (predicate: string, order: string) =>
        db.prepare(`
        SELECT s.content FROM tags AS t
        LEFT JOIN source_contents AS s ON s.session_id=t.session_id AND s.tag_id=t.tag_number
        WHERE t.session_id=? AND t.type='message' AND ${predicate}
        ORDER BY ${order}, t.tag_number LIMIT 1`);
    const whole = select("t.message_id=?", "t.tag_number");
    const part = select(
        "t.message_id>=? AND t.message_id<?",
        "CAST(SUBSTR(t.message_id, ?) AS INTEGER)",
    );
    for (const id of messageIds) {
        if (result.has(id)) continue;
        // Select the first text tag even when its source is missing; a later
        // text part's empty marker is not evidence about the first part.
        const row = (whole.get(sessionId, id) ??
            part.get(sessionId, `${id}:p`, `${id}:q`, id.length + 3)) as
            | { content: string | null }
            | undefined;
        if (typeof row?.content !== "string") continue;
        const marker = peelLeadingMcTagNotation(row.content).body.match(
            TEMPORAL_MARKER_REPLAY_PATTERN,
        )?.[0];
        result.set(id, marker ? `${marker.trimEnd()}\n` : "");
    }
    return result;
}
