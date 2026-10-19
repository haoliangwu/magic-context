import {
	decodePiContentDecision,
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

export const PI_TAG_IDENTITY_REPAIR_ONCE_GUARD = "pi-tag-identity-repair-once";
export const PI_TAG_IDENTITY_REPAIR_REASON = "tag_identity_repair";
export interface PiIdentityRebuild {
	key: string;
	kept: number;
	removed: number[];
	kind: "tool" | "message";
}

/**
 * Outcome of asking for the one unproven repair an identity may receive.
 * - `claimed`: this identity had no repair yet; the caller may keep the newest
 *   number and declare one `tag_identity_repair` rebuild.
 * - `recurring`: the identity was already repaired once (under `key` or one of
 *   `legacyKeys`). The caller must not repair it again and must not refuse
 *   the turn either: it leaves the rows unmerged and serves the identity the
 *   way tagging would without any repair.
 * - `unpersisted`: the guard could not be read or written (a full or damaged
 *   decision ledger, a rejected write). Without a durable guard a repair could repeat on every pass, so
 *   the caller treats it like `recurring`.
 */
export type PiIdentityRepairClaim = "claimed" | "recurring" | "unpersisted";

const unreadableLedgerLogged = new Set<string>();

/**
 * The session's Pi content-decision ledger for identity decisions, or null
 * when the stored field cannot be read (not JSON, not an array, a non-string
 * member). An unreadable ledger is logged once per session and treated as "no
 * identity decision can be read or written": callers serve duplicates
 * unmerged and never write the field, so the damaged value, which may still
 * hold other kinds of decisions, is left exactly as it is. The reminder-strip
 * and seam replays read through this too, so a damaged field degrades those
 * replays instead of refusing every turn.
 */
export function readPiIdentityDecisions(
	db: Database,
	sessionId: string,
): Set<string> | null {
	try {
		return getPiContentDecisions(db, sessionId);
	} catch (error) {
		if (!unreadableLedgerLogged.has(sessionId)) {
			if (unreadableLedgerLogged.size > 10_000) unreadableLedgerLogged.clear();
			unreadableLedgerLogged.add(sessionId);
			sessionLog(
				sessionId,
				`Pi content-decision ledger unreadable: tag identity duplicates are served unmerged and no stored decision is replayed or written; the stored field is left untouched: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return null;
	}
}

/**
 * Write one identity decision. Any failure (a busy store, a damaged field, a
 * rejected write) returns false instead of throwing: the caller then leaves
 * the duplicate unmerged, which serves the turn.
 */
function freezeIdentityDecision(
	db: Database,
	sessionId: string,
	kind:
		| "tag-identity-repair-once"
		| "tag-identity-repair-pending"
		| "tag-identity-rebuild-failed"
		| "tag-identity-recurring",
	value: string,
): boolean {
	if (readPiIdentityDecisions(db, sessionId) === null) return false;
	try {
		return freezePiContentDecision(db, sessionId, kind, value);
	} catch (error) {
		sessionLog(
			sessionId,
			`tag identity decision ${kind} could not be written; serving duplicates unmerged: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/** Caller holds the duplicate-fold writer transaction; persist that this identity has been repaired. */
export function claimPiIdentityRepair(
	db: Database,
	sessionId: string,
	key: string,
	legacyKeys: readonly string[] = [],
): PiIdentityRepairClaim {
	const decisions = readPiIdentityDecisions(db, sessionId);
	if (decisions === null) return "unpersisted";
	if (
		[key, ...legacyKeys].some((candidate) =>
			decisions.has(
				encodePiContentDecision("tag-identity-repair-once", candidate),
			),
		)
	)
		return "recurring";
	return freezeIdentityDecision(db, sessionId, "tag-identity-repair-once", key)
		? "claimed"
		: "unpersisted";
}

const unrecordedRecurrenceLogged = new Set<string>();

/**
 * Record, once per identity, that a duplicate was served unmerged because its
 * one repair was spent or could not be recorded. Returns whether the caller
 * should log the event: true when this call wrote the record, or when the
 * record cannot be written and this process has not logged that identity for
 * the session yet (so a full ledger logs once, not on every turn). Never
 * throws.
 */
export function recordPiIdentityRecurrence(
	db: Database,
	sessionId: string,
	key: string,
): boolean {
	const entry = encodePiContentDecision("tag-identity-recurring", key);
	if (readPiIdentityDecisions(db, sessionId)?.has(entry)) return false;
	if (freezeIdentityDecision(db, sessionId, "tag-identity-recurring", key))
		return true;
	const logKey = `${sessionId}\0${key}`;
	if (unrecordedRecurrenceLogged.has(logKey)) return false;
	if (unrecordedRecurrenceLogged.size > 10_000)
		unrecordedRecurrenceLogged.clear();
	unrecordedRecurrenceLogged.add(logKey);
	return true;
}

export function readPiIdentityRecurrences(
	db: Database,
	sessionId: string,
): string[] {
	return [...(readPiIdentityDecisions(db, sessionId) ?? [])].flatMap(
		(entry) => {
			const decoded = decodePiContentDecision(entry);
			return decoded?.[0] === "tag-identity-recurring" ? [decoded[1]] : [];
		},
	);
}

/** Returns false when the rebuild could not be recorded; the caller then skips the repair. Never throws. */
export function queuePiIdentityRebuild(
	db: Database,
	sessionId: string,
	repair: PiIdentityRebuild,
): boolean {
	return freezeIdentityDecision(
		db,
		sessionId,
		"tag-identity-repair-pending",
		JSON.stringify(repair),
	);
}

/** Refuse only the first durable failure to clear m[0]/m[1] for a tag-identity rebuild; later sends retain the pending repair. */
export function claimPiIdentityRebuildFailure(
	db: Database,
	sessionId: string,
): "first" | "again" | "unpersisted" {
	const decisions = readPiIdentityDecisions(db, sessionId);
	if (!decisions) return "unpersisted";
	const key = encodePiContentDecision(
		"tag-identity-rebuild-failed",
		"m0-m1-clear",
	);
	if (decisions.has(key)) return "again";
	return freezeIdentityDecision(
		db,
		sessionId,
		"tag-identity-rebuild-failed",
		"m0-m1-clear",
	)
		? "first"
		: "unpersisted";
}

export function readPiIdentityRebuilds(
	db: Database,
	sessionId: string,
): PiIdentityRebuild[] {
	const repairs = [...(readPiIdentityDecisions(db, sessionId) ?? [])].flatMap(
		(entry) => {
			const decoded = decodePiContentDecision(entry);
			if (decoded?.[0] !== "tag-identity-repair-pending") return [];
			// A damaged record cannot name a number to protect. Ignoring it costs at
			// most the protection of one already-folded survivor for one pass; it
			// must not refuse the session's turns.
			let repair: PiIdentityRebuild;
			try {
				repair = JSON.parse(decoded[1]) as PiIdentityRebuild;
			} catch {
				return [];
			}
			if (
				typeof repair?.key !== "string" ||
				!Number.isSafeInteger(repair.kept) ||
				!Array.isArray(repair.removed) ||
				!repair.removed.every(Number.isSafeInteger) ||
				!["tool", "message"].includes(repair.kind)
			)
				return [];
			return [repair];
		},
	);
	const byKey = new Map<string, PiIdentityRebuild>();
	for (const repair of repairs) {
		const previous = byKey.get(repair.key);
		byKey.set(repair.key, {
			...repair,
			removed: [...new Set([...(previous?.removed ?? []), ...repair.removed])],
		});
	}
	return [...byKey.values()];
}

/**
 * Clear the pending rebuild records once a repaired array was served. Leaves
 * the field untouched when it holds no pending record or cannot be read (a
 * damaged field may still hold other decisions), and never throws: failing
 * to clear only means the next pass declares the same rebuild once more.
 */
export function acknowledgePiIdentityRebuilds(
	db: Database,
	sessionId: string,
): void {
	try {
		db.transaction(() => {
			const row = db
				.prepare(
					"SELECT merged_reasoning_stripped_ids AS entries FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { entries: string | null } | undefined;
			if (!row?.entries) return;
			const entries: unknown = JSON.parse(row.entries);
			if (
				!Array.isArray(entries) ||
				!entries.every((entry) => typeof entry === "string")
			)
				return;
			const kept = entries.filter(
				(entry) =>
					decodePiContentDecision(entry)?.[0] !== "tag-identity-repair-pending",
			);
			if (kept.length === entries.length) return;
			db.prepare(
				"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ? AND merged_reasoning_stripped_ids IS ?",
			).run(JSON.stringify(kept), sessionId, row.entries);
		}).immediate();
	} catch (error) {
		sessionLog(
			sessionId,
			`tag identity rebuild acknowledgement failed; the next pass repeats it: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
