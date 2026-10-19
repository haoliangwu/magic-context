import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { repairMissingHistoryBoundary } from "@magic-context/core/hooks/magic-context/history-boundary-repair";
import { clearPiMuralProcessCache } from "./inject-compartments-pi";
import {
	queuePiHistoryRetirement,
	readPiHistoryRetirement,
} from "./pi-history-retirement";
import {
	convertEntriesToRawMessages,
	SYNTH_USER_ID_PREFIX,
} from "./read-session-pi";

interface CleanCheck {
	db: ContextDatabase;
	leafId: string | null;
	entryCount: number;
	revision: string;
}

const lastCleanBySession = new Map<string, CleanCheck>();

export function clearPiHistoryBoundaryRepairSession(sessionId: string): void {
	lastCleanBySession.delete(sessionId);
}

function compartmentRevision(
	db: ContextDatabase,
	sessionId: string,
): string | null {
	try {
		const row = db
			.prepare(
				"SELECT generation, version FROM compartment_history_versions WHERE session_id = ?",
			)
			.get(sessionId) as { generation: string; version: number } | undefined;
		// The existing persistent triggers advance this row for inserts, deletes
		// and updates, including summary rewrites with unchanged sequences and count.
		if (!row) return "empty";
		return typeof row.generation === "string" &&
			row.generation.length > 0 &&
			Number.isSafeInteger(row.version) &&
			row.version >= 0
			? `${row.generation}:${row.version}`
			: null;
	} catch {
		// A store without an authoritative revision must be checked, not cached.
		return null;
	}
}

function realId(id: string): string {
	return id.startsWith(SYNTH_USER_ID_PREFIX)
		? id.slice(SYNTH_USER_ID_PREFIX.length)
		: id;
}

/**
 * Pi keeps abandoned entries in its JSONL store. Only a complete parent chain
 * from the active leaf to the root proves that an entry is off that branch.
 * getBranch() includes pre-compaction entries, unlike the provider request.
 * A broken chain (for example a skipped JSONL line) proves nothing: leave the
 * summaries alone and let ordinal alignment keep the historian paused.
 */
export function repairPiHistoryBoundary(
	db: ContextDatabase,
	sessionId: string,
	ctx: unknown,
	branchEntries?: readonly unknown[] | null,
): void {
	const sm = (
		ctx as {
			sessionManager?: {
				getBranch?: () => unknown;
				getLeafId?: () => unknown;
				getEntry?: (id: string) => unknown;
			};
		}
	)?.sessionManager;
	if (typeof sm?.getBranch !== "function" || typeof sm.getLeafId !== "function")
		return;
	let entries: unknown;
	let leaf: unknown;
	try {
		entries = branchEntries ?? sm.getBranch();
		leaf = sm.getLeafId();
	} catch {
		return;
	}
	if (!Array.isArray(entries)) return;
	if (leaf !== null && typeof leaf !== "string") return;
	if (
		(entries.at(-1) as { id?: unknown } | undefined)?.id !== (leaf ?? undefined)
	)
		return;
	const revision = compartmentRevision(db, sessionId);
	const previous = lastCleanBySession.get(sessionId);
	if (
		revision !== null &&
		previous?.db === db &&
		previous.revision === revision &&
		entries.length >= previous.entryCount &&
		(previous.entryCount === 0 ||
			(entries[previous.entryCount - 1] as { id?: unknown })?.id ===
				previous.leafId)
	) {
		// Pi and OMP append entries or move the active leaf, never reparent old
		// entries. The checked leaf at its old position therefore proves an
		// appended tail without revisiting older entries or compartment boundaries.
		lastCleanBySession.set(sessionId, {
			db,
			leafId: leaf,
			entryCount: entries.length,
			revision,
		});
		return;
	}
	lastCleanBySession.delete(sessionId);
	const ids = new Set<string>();
	let parent: string | null = null;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") return;
		const row = entry as { id?: unknown; parentId?: unknown };
		if (
			typeof row.id !== "string" ||
			!row.id ||
			row.parentId !== parent ||
			ids.has(row.id)
		)
			return;
		ids.add(row.id);
		parent = row.id;
	}
	if (leaf !== parent) return;
	const targetOnBranch = (endIds: readonly string[]): string | null => {
		const raw = convertEntriesToRawMessages(entries);
		const ordinalByEntry = new Map(
			raw.map((message, index) => [realId(message.id), index]),
		);
		let targetIndex = -1;
		for (let id of endIds) {
			const seen = new Set<string>();
			id = realId(id);
			while (id && !seen.has(id)) {
				seen.add(id);
				const index = ordinalByEntry.get(id);
				if (index !== undefined) {
					targetIndex = Math.max(targetIndex, index);
					break;
				}
				const entry = sm.getEntry?.(id) as { parentId?: unknown } | undefined;
				if (!entry || typeof entry.parentId !== "string") break;
				id = entry.parentId;
			}
		}
		return raw[targetIndex]?.id ?? null;
	};
	const pending = readPiHistoryRetirement(db, sessionId);
	// A second tree jump can make the pending recovery's last message unreachable
	// before a summary covers it. Recover only through its shared ancestor on the
	// active branch, rather than waiting forever for an off-branch message.
	if (pending && !ids.has(realId(pending))) {
		const target = targetOnBranch([pending]);
		if (target)
			db.transaction(() =>
				queuePiHistoryRetirement(db, sessionId, target),
			).immediate();
	}
	const result = repairMissingHistoryBoundary({
		db,
		sessionId,
		scope: "active-branch",
		isInHostStore: (id) => ids.has(realId(id)),
		onRetire: (retired, anchor) => {
			const target = targetOnBranch([
				...retired.map((compartment) => compartment.endMessageId),
				...(pending ? [pending] : []),
			]);
			if (target && (!anchor || realId(target) !== realId(anchor.endMessageId)))
				queuePiHistoryRetirement(db, sessionId, target);
		},
	});
	if (result.kind === "repaired" || result.kind === "baseline-reset")
		clearPiMuralProcessCache(sessionId);
	if (result.kind === "intact" || result.kind === "repaired") {
		const checkedRevision =
			result.kind === "repaired"
				? compartmentRevision(db, sessionId)
				: revision;
		if (checkedRevision !== null)
			lastCleanBySession.set(sessionId, {
				db,
				leafId: leaf,
				entryCount: entries.length,
				revision: checkedRevision,
			});
	}
}
