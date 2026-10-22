import { expect, it } from "bun:test";
import { createCompactionHandler } from "@magic-context/core/features/magic-context/compaction";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { copySessionStateForClone } from "@magic-context/core/features/magic-context/storage-clone";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { clearSession } from "@magic-context/core/features/magic-context/storage-meta-session";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { deleteSessionScopedRows } from "@magic-context/core/features/magic-context/storage-session-tables";
import { tagRevisionKey } from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import * as tags from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyPendingOperations } from "@magic-context/core/hooks/magic-context/apply-operations";
import { Database } from "@magic-context/core/shared/sqlite";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { createPiTranscript } from "./transcript-pi";

function stamp(db: Database, session = "s") {
	return db
		.prepare(`SELECT
		COALESCE((SELECT value FROM schema_migrations_meta WHERE key = ?), '0') AS revision,
		COALESCE((SELECT tags_version FROM session_meta WHERE session_id = ?), 0) AS durable`)
		.get(tagRevisionKey(session), session);
}

type Writer = [string, (db: Database) => void, ((db: Database) => void)?];
const writers: Writer[] = [
	[
		"TypeScript tagger",
		(db) => {
			const tagger = createTagger();
			tagger.initFromDb("s", db);
			tagger.assignTag("s", "new:p0", "message", 20, db);
			tagger.cleanup("s");
		},
	],
	[
		"Pi transcript tagger",
		(db) => {
			const tagger = createTagger();
			tagger.initFromDb("s", db);
			tagTranscript(
				"s",
				createPiTranscript(
					[{ role: "user", content: "new text", timestamp: 1 }],
					"s",
				),
				tagger,
				db,
			);
			tagger.cleanup("s");
		},
	],
	["status", (db) => tags.updateTagStatus(db, "s", 1, "dropped")],
	["drop", (db) => tags.markTagDropped(db, "s", 1, "full")],
	[
		"drop mode only",
		(db) => tags.updateTagDropMode(db, "s", 1, "skeleton_real"),
	],
	["byte size only", (db) => tags.updateTagByteSize(db, "s", 1, 999)],
	[
		"input byte size only",
		(db) => tags.updateTagInputByteSize(db, "s", 1, 999),
	],
	["token count only", (db) => tags.updateTagTokenCount(db, "s", 1, 999)],
	[
		"input token count only",
		(db) => tags.updateTagInputTokenCount(db, "s", 1, 999),
	],
	[
		"token backfill",
		(db) =>
			tags.backfillTagTokenCounts(db, "s", 1, {
				tokenCount: 99,
				inputTokenCount: 2,
				reasoningTokenCount: 3,
			}),
	],
	["caveman depth", (db) => tags.updateCavemanDepth(db, "s", 1, 2)],
	["message identity", (db) => tags.updateTagMessageId(db, "s", 1, "new:p0")],
	[
		"whitespace retirement",
		(db) => tags.markWhitespaceAssistantTagInert(db, "s", 1, "old:p0"),
	],
	[
		"Pi message adoption",
		(db) => {
			tags.adoptPiFallbackMessageTag(db, "s", 1, "old:p0", "new:p0");
		},
	],
	[
		"Pi tool adoption",
		(db) => {
			tags.adoptPiFallbackToolOwnerTag(
				db,
				"s",
				3,
				"call-owned",
				"owned",
				"new-owner",
			);
		},
	],
	[
		"Pi duplicate message fold",
		(db) => {
			tags.adoptPiFallbackMessageTag(
				db,
				"s",
				1,
				"old:p0",
				"new:p0",
				new Set([1]),
			);
		},
		(db) => {
			db.exec(
				"INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size) VALUES ('s', 5, 'new:p0', 'message', 'dropped', 20)",
			);
		},
	],
	[
		"Pi duplicate tool fold",
		(db) => {
			tags.adoptPiFallbackToolOwnerTag(
				db,
				"s",
				3,
				"call-owned",
				"owned",
				"new-owner",
				new Set([3]),
			);
		},
		(db) => {
			db.exec(
				"INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size, tool_owner_message_id) VALUES ('s', 5, 'call-owned', 'tool', 'dropped', 20, 'new-owner')",
			);
		},
	],
	[
		"shrunk message part fold",
		(db) => {
			tags.foldShrunkPartTags(db, "s", [{ messageId: "old", partCount: 1 }]);
		},
		(db) => {
			tags.insertTag(db, "s", "old:p1", "message", 20, 5);
		},
	],
	[
		"fallback identity",
		(db) => {
			tags.adoptFallbackTagMessageId(db, "s", 1, "old:p0", "new:p0");
		},
	],
	[
		"tool owner adoption",
		(db) => {
			tags.adoptNullOwnerToolTag(db, 2, "owner");
		},
	],
	[
		"message deletion",
		(db) => {
			tags.deleteTagsByMessageId(db, "s", "old");
		},
	],
	[
		"tool deletion",
		(db) => {
			tags.deleteToolTagsByOwner(db, "s", "owned");
		},
	],
	["compaction", (db) => createCompactionHandler().onCompacted("s", db)],
	[
		"compartment trim",
		(db) => {
			tags.markTagsCompactedByMessageIds(db, "s", ["old"]);
		},
	],
	["session reset", (db) => clearSession(db, "s")],
	["permanent deletion", (db) => clearSession(db, "s", false, true)],
	[
		"orphan sweep deletion",
		(db) => {
			deleteSessionScopedRows(db, ["s"], "pi");
		},
	],
	[
		"clone",
		(db) => {
			clearSession(db, "s");
			copySessionStateForClone(db, "source", "s", {
				resolveBoundaryOrdinal: () => 1,
				includeTag: () => true,
				includeMessageId: () => true,
				selectPendingPiMarker: () => null,
			});
		},
	],
	[
		"pending-op drain",
		(db) => {
			const tagger = createTagger();
			tagger.initFromDb("s", db);
			const transcript = createPiTranscript(
				[{ role: "user", content: "pending target", timestamp: 2 }],
				"s",
			);
			const { targets } = tagTranscript("s", transcript, tagger, db);
			const number = [...targets.keys()][0];
			if (number === undefined) throw new Error("missing pending drop target");
			queuePendingOp(db, "s", number, "drop", 1);
			const before = stamp(db);
			applyPendingOperations("s", db, targets, new Set());
			expect(
				tags.getTagsBySession(db, "s").find((tag) => tag.tagNumber === number)
					?.status,
			).toBe("dropped");
			expect(stamp(db)).not.toEqual(before);
			tagger.cleanup("s");
		},
	],
];

for (const [name, write, setup] of writers) {
	it(`session stamp covers ${name} writer`, () => {
		const db = new Database(":memory:");
		try {
			initializeDatabase(db);
			runMigrations(db);
			db.exec(`INSERT INTO tags(id, session_id, tag_number, message_id, type, status, byte_size, harness, tool_owner_message_id)
				VALUES (1, 's', 1, 'old:p0', 'message', 'active', 10, 'pi', NULL),
				(2, 's', 2, 'call', 'tool', 'active', 10, 'pi', NULL),
				(3, 's', 3, 'call-owned', 'tool', 'active', 10, 'pi', 'owned'),
				(4, 'source', 1, 'source:p0', 'message', 'active', 10, 'pi', NULL)`);
			setup?.(db);
			const before = stamp(db);
			const other = stamp(db, "source");
			const rows = db
				.prepare("SELECT * FROM tags WHERE session_id = 's'")
				.all();
			write(db);
			expect(
				db.prepare("SELECT * FROM tags WHERE session_id = 's'").all(),
			).not.toEqual(rows);
			expect(stamp(db)).not.toEqual(before);
			expect(stamp(db, "source")).toEqual(other);
		} finally {
			db.close();
		}
	});
}

it("full-row TEMP triggers cover every mutable tag column and session moves", () => {
	const db = new Database(":memory:");
	try {
		initializeDatabase(db);
		runMigrations(db);
		tags.insertTag(db, "s", "old:p0", "message", 10, 1);
		for (const assignment of [
			"id = 99",
			"tag_number = 2",
			"message_id = 'new:p0'",
			"type = 'tool'",
			"status = 'dropped'",
			"drop_mode = 'skeleton_real'",
			"byte_size = 11",
			"reasoning_byte_size = 2",
			"input_byte_size = 3",
			"token_count = 4",
			"input_token_count = 5",
			"reasoning_token_count = 6",
			"caveman_depth = 1",
			"tool_name = 'read'",
			"tool_owner_message_id = 'owner'",
			"entry_fingerprint = 'new'",
			"harness = 'omp'",
		]) {
			const before = stamp(db);
			db.exec(`UPDATE tags SET ${assignment} WHERE session_id = 's'`);
			expect(stamp(db)).not.toEqual(before);
		}
		const before = stamp(db);
		db.exec(
			"UPDATE tags SET session_id = 'destination' WHERE session_id = 's'",
		);
		expect(stamp(db)).not.toEqual(before);
		expect(stamp(db, "destination")).not.toEqual({ revision: "0", durable: 0 });
	} finally {
		db.close();
	}
});
