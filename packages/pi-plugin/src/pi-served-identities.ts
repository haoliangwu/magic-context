import {
	ReplayDocumentError,
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import { BoundedSessionMap } from "@magic-context/core/shared/bounded-session-map";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { recordPiTransformTiming } from "./context-perf-hooks";

export class PiServedEnvelopeUnavailable extends Error {}

const loggedReasons = new BoundedSessionMap<Set<string>>(1000);

/** Count each number-only/failed publication outcome; suppress repeated warning lines for the same session/reason. */
export function notePiPublicationIssue(
	sessionId: string,
	reason: string,
	status: "numbers_only" | "skipped" | "commit_failed" | "mirror_failed",
): void {
	try {
		recordPiTransformTiming({
			sessionId,
			stage: "lkgPublication",
			elapsedMs: 0,
			publication: { status, reason, count: 1 },
		});
	} catch {
		// Diagnostic observers must not turn an optional publication into a refusal.
	}
	const reasons = loggedReasons.get(sessionId) ?? new Set<string>();
	if (reasons.has(reason)) return;
	reasons.add(reason);
	loggedReasons.set(sessionId, reasons);
	sessionLog(
		sessionId,
		`Pi publication ${status} reason=${reason}; serving managed context`,
	);
}

function parseNumbers(value: unknown): number[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		!value.every((number) => Number.isSafeInteger(number) && number > 0)
	) {
		throw new PiServedEnvelopeUnavailable(
			"Invalid committed Pi served identities; refusing adoption",
		);
	}
	return value;
}

/** Committed served numbers remain authoritative after replay invalidation or history removal. */
export function readPiCommittedServedNumbers(
	db: Database,
	sessionId: string,
): readonly number[] {
	try {
		return parseNumbers(readReplayEnvelope(db, sessionId).piServedTagNumbers);
	} catch (error) {
		if (error instanceof ReplayDocumentError) {
			throw new PiServedEnvelopeUnavailable(
				"Pi served-number envelope is unreadable",
				{ cause: error },
			);
		}
		throw error;
	}
}

/** Runs inside the last-good request transaction; failure rolls back the request and served numbers. */
export function publishPiServedNumbers(
	db: Database,
	sessionId: string,
	numbers: Iterable<number>,
): void {
	const delta = [...numbers];
	parseNumbers(delta);
	const updated = updateReplayDocument(db, sessionId, (doc) => {
		const previous = parseNumbers(doc.piServedTagNumbers);
		const union = new Set(previous);
		for (const number of delta) union.add(number);
		if (union.size === previous.length) return false;
		doc.version = 2;
		doc.piServedTagNumbers = [...union];
		return true;
	});
	if (!updated) throw new Error("Pi served-identity publication failed");
}
