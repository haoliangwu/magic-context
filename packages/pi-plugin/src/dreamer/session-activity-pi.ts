import {
	backfillSessionActivity,
	observeSessionActivity,
} from "@magic-context/core/features/magic-context/session-activity";
import type { Database } from "@magic-context/core/shared/sqlite";
import { sessionEntries } from "./bounded-session-reader";

export function observePiMessageActivity(
	db: Database,
	sessionId: string,
	timestamp?: number,
): void {
	observeSessionActivity(db, sessionId, timestamp);
}

export function latestPiMessageTime(path: string): number | undefined {
	let latest = 0;
	for (const entry of sessionEntries(path)) {
		const row = entry as { type?: unknown; message?: { timestamp?: unknown } };
		if (row.type === "message" && typeof row.message?.timestamp === "number")
			latest = Math.max(latest, row.message.timestamp);
	}
	return latest || undefined;
}

export async function backfillPiSessionActivity(
	db: Database,
	harness: string,
	paths: Map<string, string>,
): Promise<void> {
	await backfillSessionActivity(db, harness, (sessionId) => {
		const path = paths.get(sessionId);
		if (!path) return undefined;
		try {
			return latestPiMessageTime(path);
		} catch {
			// A deleted or unreadable session file has no recoverable entries.
			return undefined;
		}
	});
}
