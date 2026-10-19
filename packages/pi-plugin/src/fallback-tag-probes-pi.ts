import {
	hasPiFallbackMessageTags as readMessageTags,
	hasPiFallbackToolOwnerTags as readToolOwnerTags,
} from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";
import { readPiFallbackTagRows } from "./tag-snapshot-pi";

/**
 * Answer a `pi-msg-*` existence probe from the session's cached fallback rows
 * (see readPiFallbackTagRows) instead of a LIKE query over the tags table. The
 * tag snapshot re-reads those rows only for tag numbers that changed, so a
 * context pass that just appends tags avoids a full LIKE rescan. Inside a
 * transaction the cache returns null and the probe queries the table.
 */
function probe(
	db: Database,
	sessionId: string,
	kind: "message" | "tool",
): boolean {
	const rows = readPiFallbackTagRows(db, sessionId);
	if (!rows)
		return kind === "message"
			? readMessageTags(db, sessionId)
			: readToolOwnerTags(db, sessionId);
	return rows.some((row) => row.type === kind);
}

export function hasPiFallbackMessageTags(
	db: Database,
	sessionId: string,
): boolean {
	return probe(db, sessionId, "message");
}

export function hasPiFallbackToolOwnerTags(
	db: Database,
	sessionId: string,
): boolean {
	return probe(db, sessionId, "tool");
}
