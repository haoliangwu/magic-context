import {
	inRootAsyncContext,
	withSqliteTurnDeadline,
} from "@magic-context/core/shared/sqlite";

const foregroundWaits = new Map<string, () => number>();

/** Detached historians retain their normal timeout except while a turn awaits them. */
export function inPiHistorianRootContext<T>(
	sessionId: string,
	operation: () => T,
): T {
	return inRootAsyncContext(() =>
		withSqliteTurnDeadline(
			() => foregroundWaits.get(sessionId)?.() ?? Infinity,
			operation,
		),
	);
}

/** While a turn awaits the historian, cap its root SQLite busy waits by that turn's remaining budget. */
export async function waitForPiHistorianInTurn<T>(
	sessionId: string,
	remainingMs: () => number,
	wait: () => Promise<T>,
): Promise<T> {
	foregroundWaits.set(sessionId, remainingMs);
	try {
		return await wait();
	} finally {
		// An older, superseded waiter cannot remove a newer turn's allowance.
		if (foregroundWaits.get(sessionId) === remainingMs)
			foregroundWaits.delete(sessionId);
	}
}
