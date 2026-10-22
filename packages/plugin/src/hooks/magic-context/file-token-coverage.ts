import type { ContextDatabase } from "../../features/magic-context/storage";
import { isFilePart } from "./tag-part-guards";

/**
 * A text tag is not a complete message total when an attachment has no tag.
 * Fall back to the live estimator for those messages, but preserve the stored
 * totals of historical messages whose file rows already cover every attachment.
 */
export function omitIncompleteFileTokenTotals<T>(
    db: ContextDatabase,
    sessionId: string,
    messages: readonly { id: string; parts: readonly unknown[] }[],
    totals: Map<string, T>,
): Map<string, T> {
    const filesByMessage = new Map<string, number>();
    for (const message of messages) {
        const count = message.parts.filter(isFilePart).length;
        if (count > 0 && totals.has(message.id)) filesByMessage.set(message.id, count);
    }
    if (filesByMessage.size === 0) return totals;
    const rows = db
        .prepare(`
        SELECT o.value AS owner, COUNT(t.id) AS count
        FROM json_each(?) o LEFT JOIN tags t
          ON t.session_id = ? AND t.type = 'file'
          AND t.message_id >= o.value || ':file'
          AND t.message_id < o.value || ':file;'
        GROUP BY o.value
    `)
        .all(JSON.stringify([...filesByMessage.keys()]), sessionId) as {
        owner: string;
        count: number;
    }[];
    for (const row of rows) {
        if (row.count < (filesByMessage.get(row.owner) ?? 0)) totals.delete(row.owner);
    }
    return totals;
}
