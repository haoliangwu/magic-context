import { createHash, randomUUID } from "node:crypto";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getEmergencyRecoveryArmedAt } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import type { PiLkgPassSnapshot } from "./pi-lkg";
import { piFitMessageBytes } from "./tokenize-pi-messages";

interface UpperReclaimCursor {
	sessionId: string;
	modelKey: string | null;
	contextWindow: number | null;
	head: string | null;
	recoveryArmedAt: number | null;
}
interface UpperReclaimClaim extends UpperReclaimCursor {
	reservation?: string;
}
const pendingInput = new Set<string>();
const KEY = "piUpperEstimateReclaim";

/** Recheck capacity when recovery, missing usage, growing input or cache changes make it uncertain. */
export function piFitOverflowPossible(args: {
	hasUI: boolean;
	inputTokens: number;
	recoveryArmed: boolean;
	forceMaterialization: boolean;
	imported: boolean;
	coldInjection: boolean;
	cacheBusting: boolean;
	sessionId: string;
	appendedMessages?: readonly unknown[];
	contextLimit?: number;
	forcePercentage?: number;
}): boolean {
	if (
		(!args.hasUI && args.inputTokens <= 0) ||
		args.recoveryArmed ||
		args.forceMaterialization ||
		args.imported ||
		args.coldInjection ||
		args.cacheBusting ||
		pendingInput.has(args.sessionId)
	)
		return true;
	if (!args.contextLimit || !Number.isFinite(args.contextLimit)) return false;
	const headroom =
		args.contextLimit * ((args.forcePercentage ?? 85) / 100) - args.inputTokens;
	let appendedBytes = 0;
	try {
		// Last-known-good replay already detached messages added after its saved
		// input. Inspect that tail, not the entire previously served prefix.
		for (const message of args.appendedMessages ?? []) {
			appendedBytes += piFitMessageBytes(message);
			if (2 * appendedBytes >= headroom) return true;
		}
	} catch {
		return true;
	}
	return false;
}

export function clearPiUpperReclaimSession(sessionId: string): void {
	pendingInput.delete(sessionId);
}
export function requestPiFitReclaimInput(sessionId: string): void {
	pendingInput.add(sessionId);
}
export function clearPiFitReclaimInput(sessionId: string): void {
	pendingInput.delete(sessionId);
}

/** Only a rebuilt head, changed capacity or provider overflow starts a new reclaim cycle. */
export function piUpperReclaimCursor(args: {
	sessionId: string;
	modelKey: string | null;
	contextWindow?: number;
	head?: {
		cachedM0Bytes?: Uint8Array | null;
		cachedM1Bytes?: Uint8Array | null;
		cachedM0MuralDataUrl?: string | null;
	};
	messageCount: number;
	snapshot?: PiLkgPassSnapshot;
	input: readonly unknown[];
}): UpperReclaimCursor | undefined {
	const head = args.head;
	return {
		sessionId: args.sessionId,
		modelKey: args.modelKey,
		contextWindow: args.contextWindow ?? null,
		// Length-delimited fields distinguish different prefix layouts. Tail
		// appends and byte-identical fold attempts never change this fingerprint.
		head: head
			? createHash("sha256")
					.update(
						JSON.stringify([
							Buffer.from(head.cachedM0Bytes ?? []).toString("base64"),
							Buffer.from(head.cachedM1Bytes ?? []).toString("base64"),
							head.cachedM0MuralDataUrl ?? null,
						]),
					)
					.digest("hex")
			: null,
		recoveryArmedAt: getEmergencyRecoveryArmedAt(args.sessionId),
	};
}

function claimFrom(
	value: unknown,
	sessionId: string,
): UpperReclaimClaim | null {
	const claim = value as Partial<UpperReclaimClaim> | undefined;
	return claim?.sessionId === sessionId &&
		(typeof claim.modelKey === "string" || claim.modelKey === null)
		? (claim as UpperReclaimClaim)
		: null;
}

function canReclaim(
	previous: UpperReclaimClaim | null,
	cursor: UpperReclaimCursor,
): boolean {
	return (
		!previous ||
		previous.modelKey !== cursor.modelKey ||
		(previous.contextWindow ?? null) !== cursor.contextWindow ||
		(previous.head ?? null) !== cursor.head ||
		(cursor.recoveryArmedAt !== null &&
			cursor.recoveryArmedAt !== previous.recoveryArmedAt)
	);
}

export function shouldReclaimPiUpperEstimate(
	db: ContextDatabase,
	cursor: UpperReclaimCursor | undefined,
): boolean {
	if (!cursor) return false;
	// Never cache an absent claim: another process can reserve it immediately.
	return canReclaim(
		claimFrom(readReplayEnvelope(db, cursor.sessionId)[KEY], cursor.sessionId),
		cursor,
	);
}

/** Reserve before any asynchronous reclaim work; the outcome must name this owner. */
export function reservePiUpperEstimateReclaim(
	db: ContextDatabase,
	cursor: UpperReclaimCursor,
): string | undefined {
	const reservation = randomUUID();
	return db
		.transaction(() => {
			let claimed = false;
			if (
				!updateReplayDocument(db, cursor.sessionId, (doc) => {
					claimed = canReclaim(claimFrom(doc[KEY], cursor.sessionId), cursor);
					if (!claimed) return false;
					doc.version = 2;
					doc[KEY] = { ...cursor, reservation };
					return true;
				})
			)
				throw new Error("Could not reserve upper-estimate reclaim");
			return claimed ? reservation : undefined;
		})
		.immediate();
}

export function recordPiUpperEstimateReclaim(
	db: ContextDatabase,
	cursor: UpperReclaimCursor,
	reservation?: string,
): void {
	const owner = reservation ?? reservePiUpperEstimateReclaim(db, cursor);
	if (!owner) return;
	// Forks copy extra fields from the replay JSON. A session id prevents the
	// parent's "already reclaimed" decision from suppressing its child's first
	// attempt, without adding a database column.
	if (
		!updateReplayDocument(db, cursor.sessionId, (doc) => {
			if (claimFrom(doc[KEY], cursor.sessionId)?.reservation !== owner)
				return false;
			doc.version = 2;
			doc[KEY] = cursor;
			return true;
		})
	)
		throw new Error("Could not persist upper-estimate reclaim cursor");
	pendingInput.delete(cursor.sessionId);
}

/** A failed attempt releases only its own reservation, never a newer process's claim. */
export function releasePiUpperEstimateReclaim(
	db: ContextDatabase,
	cursor: UpperReclaimCursor,
	reservation: string,
): void {
	if (
		!updateReplayDocument(db, cursor.sessionId, (doc) => {
			if (claimFrom(doc[KEY], cursor.sessionId)?.reservation !== reservation)
				return false;
			delete doc[KEY];
			return true;
		})
	)
		throw new Error("Could not release upper-estimate reclaim");
}

export function resetPiUpperEstimateReclaim(
	db: ContextDatabase,
	sessionId: string,
): void {
	if (!claimFrom(readReplayEnvelope(db, sessionId)[KEY], sessionId)) return;
	if (
		!updateReplayDocument(db, sessionId, (doc) => {
			delete doc[KEY];
			return true;
		})
	)
		throw new Error("Could not clear upper-estimate reclaim cursor");
}
