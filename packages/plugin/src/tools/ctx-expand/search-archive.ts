import { withMessageFtsSessionFilter } from "../../features/magic-context/message-fts-session-filter";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { readRawSessionMessageIdOrdinalsForRange } from "../../hooks/magic-context/read-session-chunk";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";

interface ArchiveRow {
    ordinal: number;
    id: string;
    role: string;
    content: string;
}

/** Recover indexed text when the host no longer holds the cited messages. */
export function renderSearchArchive(
    db: ContextDatabase,
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
    archiveOnly = false,
): string | null {
    return withMessageFtsSessionFilter(db, sessionId, (sessionFirst) => {
        let rawIds: Map<string, number> | undefined;
        // The sidecar bounds modern stores to this session and ordinal range. A
        // legacy store can still have unmapped FTS rows, so retain a direct read.
        const rows = db.prepare(
            sessionFirst
                ? `SELECT f.message_ordinal AS ordinal, f.message_id AS id, f.role, f.content
                   FROM message_fts_rowid_map AS m
                   JOIN message_history_fts AS f ON f.rowid = m.fts_rowid
                   WHERE m.session_id = ?1 AND m.message_ordinal BETWEEN ?2 AND ?3
                     AND f.session_id = ?1 AND f.message_ordinal BETWEEN ?2 AND ?3
                   ORDER BY m.message_ordinal`
                : `SELECT message_ordinal AS ordinal, message_id AS id, role, content
                   FROM message_history_fts
                   WHERE session_id = ?1 AND message_ordinal BETWEEN ?2 AND ?3
                   ORDER BY CAST(message_ordinal AS INTEGER)`,
        );
        const blocks: string[] = [];
        let tokens = 0;
        let lastOrdinal = start - 1;
        let truncated = false;
        for (const row of rows.iterate(sessionId, start, end) as Iterable<ArchiveRow>) {
            if (!row.content) continue;
            if (!archiveOnly) {
                rawIds ??= readRawSessionMessageIdOrdinalsForRange(sessionId, start, end);
                if (rawIds.get(row.id) === row.ordinal) continue;
            }
            const block = `[${row.ordinal}] ${row.role === "user" ? "U" : "A"}: ${row.content}`;
            const cost = estimateTokens(block);
            if (blocks.length > 0 && tokens + cost > tokenBudget) {
                truncated = true;
                break;
            }
            blocks.push(block);
            tokens += cost;
            lastOrdinal = row.ordinal;
        }
        if (blocks.length === 0) return null;
        const text = [
            "From the search archive: indexed text only; no surrounding messages or tool output.",
            "",
            ...blocks,
        ];
        if (truncated) {
            text.push(
                "",
                `Truncated at message ${lastOrdinal} (budget: ~${tokenBudget} tokens). Call ctx_expand(start=${lastOrdinal + 1}, end=${end}) for more archived text.`,
            );
        }
        return text.join("\n");
    });
}
