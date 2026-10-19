import { ensureSessionMetaRow } from "@magic-context/core/features/magic-context/storage-meta-shared";
import type { Database } from "@magic-context/core/shared/sqlite";

const KEY = "piHistorianRetirement";

function readState(db: Database, sessionId: string): Record<string, unknown> {
	const row = db
		.prepare(
			"SELECT deferred_execute_state AS state FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId) as { state: string | null } | undefined;
	const state: unknown = row?.state ? JSON.parse(row.state) : {};
	if (!state || typeof state !== "object" || Array.isArray(state))
		throw new Error("Invalid session metadata JSON");
	return state as Record<string, unknown>;
}

export function readPiHistoryRetirement(
	db: Database,
	sessionId: string,
): string | null {
	const target = readState(db, sessionId)[KEY];
	return typeof target === "string" && target.length > 0 ? target : null;
}

/** Call within the transaction deleting stale summaries; preserve other metadata namespaces. */
export function queuePiHistoryRetirement(
	db: Database,
	sessionId: string,
	throughMessageId: string,
): void {
	ensureSessionMetaRow(db, sessionId);
	const state = readState(db, sessionId);
	state[KEY] = throughMessageId;
	db.prepare(
		"UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?",
	).run(JSON.stringify(state), sessionId);
}

/** Only a committed publication covering the reachable target completes recovery. */
export function acknowledgePiHistoryRetirement(
	db: Database,
	sessionId: string,
	publishedEnd: number,
	ordinalOf: (messageId: string) => number | undefined,
): void {
	const state = readState(db, sessionId);
	const target = state[KEY];
	if (typeof target !== "string") return;
	const ordinal = ordinalOf(target);
	if (ordinal === undefined || ordinal > publishedEnd) return;
	delete state[KEY];
	db.prepare(
		"UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?",
	).run(JSON.stringify(state), sessionId);
}
