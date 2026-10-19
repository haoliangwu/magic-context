/**
 * Identical user messages stamped in the same millisecond share one entry
 * fingerprint. Fallback adoption pairs their newest `pi-msg-*` rows with the
 * real ids by position; these tests cover pairs where that pairing meets the
 * served-number rules: a real id that already holds a served row, and a
 * newest pair the model never saw.
 */
import { describe, expect, it } from "bun:test";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { __test } from "./context-handler";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import { createTestDb } from "./test-utils.test";

type Messages = Parameters<typeof __test.buildEntryFingerprintMap>[0];

interface PairState {
	/** Status of the newest fallback pair (tags 10 and 11). */
	newestStatus: string;
	/** Existing real-id row for the first twin, as tag 20, if any. */
	firstRealRow?: string;
	/** Numbers recorded as served before adoption runs. */
	served: number[];
}

// Older fallback rows (7, 8) from before a compaction shifted the indexes,
// newer ones (10, 11) from after it, as an older build left them.
function setUp(sessionId: string, state: PairState) {
	const db = createTestDb();
	const message = { role: "user", content: "continue", timestamp: 5_000 };
	const messages = [
		{ role: "user", content: "Start.", timestamp: 4_000 },
		structuredClone(message),
		structuredClone(message),
	] as Messages;
	const ids = ["real-start", "real-first", "real-second"];
	const resolveStableId = (_message: unknown, index: number) => ids[index];
	const fingerprints = __test.buildEntryFingerprintMap(
		messages,
		resolveStableId,
	);
	const fingerprint = fingerprints.get("real-first") as string;
	const insert = db.prepare(
		`INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, entry_fingerprint)
		 VALUES (?, ?, 'message', ?, 8, ?, ?)`,
	);
	insert.run(sessionId, "pi-msg-9-5000-user:p0", "active", 7, fingerprint);
	insert.run(sessionId, "pi-msg-10-5000-user:p0", "active", 8, fingerprint);
	insert.run(
		sessionId,
		"pi-msg-1-5000-user:p0",
		state.newestStatus,
		10,
		fingerprint,
	);
	insert.run(
		sessionId,
		"pi-msg-2-5000-user:p0",
		state.newestStatus,
		11,
		fingerprint,
	);
	if (state.firstRealRow)
		insert.run(sessionId, "real-first:p0", state.firstRealRow, 20, fingerprint);
	capturePiServedArray(sessionId, [], { servedTagNumbers: state.served });
	const tagger = createTagger();
	const adopt = () =>
		__test.adoptPiFallbackTags(db, sessionId, tagger, fingerprints, {
			messages,
			resolveStableId,
		});
	const rows = () =>
		db
			.prepare(
				"SELECT message_id, tag_number, status FROM tags WHERE session_id = ? ORDER BY tag_number",
			)
			.all(sessionId);
	const guard = () =>
		__test.guardPiMessageAllocations(db, sessionId, fingerprints);
	return { db, tagger, adopt, rows, guard };
}

describe("issue 650: identical same-millisecond pair adoption", () => {
	it("keeps the first twin's served real-id number active and queues the dropped fallback's drop", () => {
		const sessionId = "identical-pair-served-real-row";
		const { db, tagger, adopt, rows, guard } = setUp(sessionId, {
			newestStatus: "dropped",
			firstRealRow: "active",
			// 10 never reached the model; the first twin was last served as 20.
			served: [7, 8, 11, 20],
		});
		try {
			adopt();
			expect(rows()).toEqual([
				{
					message_id: "pi-msg-9-5000-user:p0",
					tag_number: 7,
					status: "active",
				},
				{
					message_id: "pi-msg-10-5000-user:p0",
					tag_number: 8,
					status: "active",
				},
				{ message_id: "real-second:p0", tag_number: 11, status: "dropped" },
				// The dropped fallback did not overwrite the served active row;
				// its drop waits in the queue for a pass allowed to apply it.
				{ message_id: "real-first:p0", tag_number: 20, status: "active" },
			]);
			expect(
				getPendingOps(db, sessionId).map((op) => [op.tagId, op.operation]),
			).toEqual([[20, "drop"]]);
			expect(tagger.getTag(sessionId, "real-first:p0", "message")).toBe(20);
			expect(tagger.getTag(sessionId, "real-second:p0", "message")).toBe(11);
			expect(guard()).toEqual([]);
		} finally {
			clearPiServedArraySession(sessionId);
			db.close();
		}
	});

	it("moves the newest pair when the ledger shows it was served", () => {
		const sessionId = "identical-pair-served-newest";
		const { db, adopt, rows } = setUp(sessionId, {
			newestStatus: "active",
			served: [7, 8, 10, 11],
		});
		try {
			adopt();
			expect(rows()).toEqual([
				{
					message_id: "pi-msg-9-5000-user:p0",
					tag_number: 7,
					status: "active",
				},
				{
					message_id: "pi-msg-10-5000-user:p0",
					tag_number: 8,
					status: "active",
				},
				{ message_id: "real-first:p0", tag_number: 10, status: "active" },
				{ message_id: "real-second:p0", tag_number: 11, status: "active" },
			]);
		} finally {
			clearPiServedArraySession(sessionId);
			db.close();
		}
	});

	// This test first asserted that the allocation guard refuses the pass. No
	// identity conflict may refuse more than one turn, so the guard now reports
	// both real ids as unresolved and tagging allocates for them (one logged
	// cache change); the unserved newest pair is still not moved.
	it("reports rather than move a newest pair the model never saw", () => {
		const sessionId = "identical-pair-unserved-newest";
		const { db, adopt, rows, guard } = setUp(sessionId, {
			newestStatus: "active",
			// Only the older pair reached the model; 10 and 11 came from a pass
			// that never served, so moving them would renumber both messages.
			served: [7, 8],
		});
		try {
			const before = rows();
			adopt();
			expect(rows()).toEqual(before);
			expect(getPendingOps(db, sessionId)).toEqual([]);
			expect(guard()).toEqual([
				{ kind: "message", id: "real-first" },
				{ kind: "message", id: "real-second" },
			]);
		} finally {
			clearPiServedArraySession(sessionId);
			db.close();
		}
	});
});
