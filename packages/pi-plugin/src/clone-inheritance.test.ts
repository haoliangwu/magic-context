/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodePiContentDecision,
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
	PI_CONTENT_DECISION_LIMIT,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	type CloneSessionStateFilter,
	clearSession,
	copySessionStateForClone,
	getOrCreateSessionMeta,
	getSourceContents,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage";
import {
	addTrailingBlankDecisions,
	getTrailingBlankDecisions,
	thinkingBindingRecoveryFrozenId,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	addNativeReasoningIds,
	getNativeReasoningIds,
	getNativeToolInputs,
	saveNativeToolInputs,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	handlePiCloneSessionStart,
	readPiSessionIdFromFile,
} from "./clone-inheritance";
import { mustMaterializePi } from "./inject-compartments-pi";
import { createTestDb } from "./test-utils.test";

const openDatabases: Database[] = [];
const temporaryDirectories: string[] = [];

function db(): Database {
	const value = createTestDb();
	openDatabases.push(value);
	return value;
}

afterEach(async () => {
	for (const database of openDatabases.splice(0)) database.close();
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

function user(id: string): unknown {
	return {
		type: "message",
		id,
		message: { role: "user", content: id, timestamp: 1 },
	};
}

function assistant(id: string): unknown {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			provider: "test",
			model: "test",
			timestamp: 2,
		},
	};
}

function toolResult(id: string, callId = "call-1"): unknown {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: id }],
			timestamp: 2,
		},
	};
}

function compaction(id: string, firstKeptEntryId: string): unknown {
	return { type: "compaction", id, firstKeptEntryId, summary: "summary" };
}

function seedCompartment(
	database: Database,
	args: {
		sessionId?: string;
		sequence: number;
		startId: string;
		endId: string;
		start?: number;
		end?: number;
	},
): void {
	database
		.prepare(
			`INSERT INTO compartments
			 (session_id, sequence, start_message, end_message, start_message_id,
			  end_message_id, title, content, p1, p2, p3, p4, importance,
			  episode_type, legacy, created_at, harness)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			args.sessionId ?? "source",
			args.sequence,
			args.start ?? 1,
			args.end ?? 2,
			args.startId,
			args.endId,
			`title-${args.sequence}`,
			`content-${args.sequence}`,
			`p1-${args.sequence}`,
			`p2-${args.sequence}`,
			null,
			null,
			73,
			"feature",
			0,
			1000 + args.sequence,
			"pi",
		);
}

function seedTag(
	database: Database,
	args: {
		tagNumber: number;
		messageId: string;
		type?: "message" | "tool" | "file";
		ownerId?: string | null;
		status?: "active" | "dropped" | "compacted";
		cavemanDepth?: number;
	},
): void {
	database
		.prepare(
			`INSERT INTO tags
			 (session_id, message_id, type, status, byte_size, tag_number, harness,
			  entry_fingerprint, token_count, input_token_count, reasoning_token_count,
			  reasoning_byte_size, drop_mode, tool_name, input_byte_size,
			  caveman_depth, tool_owner_message_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			"source",
			args.messageId,
			args.type ?? "message",
			args.status ?? "active",
			100 + args.tagNumber,
			args.tagNumber,
			"pi",
			`fingerprint-${args.tagNumber}`,
			20,
			3,
			2,
			11,
			"truncated",
			args.type === "tool" ? "read" : null,
			9,
			args.cavemanDepth ?? 0,
			args.ownerId ?? null,
		);
}

function count(database: Database, table: string, sessionId = "clone"): number {
	return (
		database
			.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
			.get(sessionId) as { count: number }
	).count;
}

function copyWithEntries(database: Database, entries: unknown[]) {
	return copySessionStateForClone(
		database,
		"source",
		"clone",
		__test.createCloneFilter(entries),
	);
}

function seedMeta(database: Database, values: Record<string, unknown>): void {
	const columns = Object.keys(values);
	const placeholders = columns.map(() => "?").join(", ");
	// Upsert rather than insert: seeded tags fire migration v86's tags trigger, which
	// creates the session's metadata row before this helper runs. Production never
	// plain-inserts here either — every writer goes through the shared upsert helpers.
	const assignments = columns
		.map((column) => `${column} = excluded.${column}`)
		.join(", ");
	database
		.prepare(
			`INSERT INTO session_meta (session_id, harness, ${columns.join(", ")}) VALUES (?, ?, ${placeholders})
			 ON CONFLICT(session_id) DO UPDATE SET harness = excluded.harness, ${assignments}`,
		)
		.run("source", "pi", ...Object.values(values));
}

function pending(
	firstKeptEntryId: string,
	endMessageId: string,
	ordinal: number,
): string {
	return JSON.stringify({
		firstKeptEntryId,
		endMessageId,
		ordinal,
		tokensBefore: 123,
		summary: "marker summary",
		publishedAt: 456,
	});
}

describe("Pi clone state inheritance", () => {
	it("does not inherit Rust reasoning decisions across fork or branch filters", () => {
		for (const branch of [
			[user("kept")],
			[user("kept"), assistant("branch-new")],
		]) {
			const database = db();
			seedTag(database, { tagNumber: 1, messageId: "kept" });
			seedTag(database, { tagNumber: 2, messageId: "removed" });
			// Rust state normally lives in a separate store. Even if both stores are
			// colocated, the Pi clone's explicit table list must not copy its units.
			database.exec(
				"CREATE TABLE mc_cache_state (session_id TEXT PRIMARY KEY, core_state TEXT, meta TEXT)",
			);
			database.prepare("INSERT INTO mc_cache_state VALUES (?, ?, ?)").run(
				"source",
				JSON.stringify({
					frozen_units: [
						{ key: "strip:reasoning_clear:kept", frozen_payload: "" },
					],
				}),
				JSON.stringify({
					reasoning_replay_evidence: { source_hash: "source-only" },
				}),
			);
			const result = copyWithEntries(database, branch);
			expect(result.kind).toBe("migrated");
			expect(
				getTagsBySession(database, "clone").map((tag) => tag.messageId),
			).toEqual(["kept"]);
			expect(count(database, "mc_cache_state", "source")).toBe(1);
			expect(count(database, "mc_cache_state", "clone")).toBe(0);
		}
	});
	it("filters prefix clones, including compartments that span the fork point", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedCompartment(database, { sequence: 2, startId: "u3", endId: "a3" });
		seedCompartment(database, { sequence: 3, startId: "u2", endId: "a3" });
		seedTag(database, { tagNumber: 1, messageId: "a1:p0", status: "dropped" });
		seedTag(database, { tagNumber: 2, messageId: "a3:p0" });
		seedTag(database, {
			tagNumber: 3,
			messageId: "call-3",
			type: "tool",
			ownerId: "a3",
		});

		const result = copyWithEntries(database, [
			user("u1"),
			assistant("a1"),
			user("u2"),
		]);

		expect(result).toMatchObject({ compartmentsCopied: 1, tagsCopied: 1 });
		const compartments = database
			.prepare(
				"SELECT sequence, start_message, end_message FROM compartments WHERE session_id = ?",
			)
			.all("clone");
		expect(compartments).toEqual([
			{ sequence: 1, start_message: 1, end_message: 2 },
		]);
		const copiedTag = database
			.prepare(
				"SELECT tag_number, status, drop_mode, token_count FROM tags WHERE session_id = ?",
			)
			.get("clone");
		expect(copiedTag).toEqual({
			tag_number: 1,
			status: "dropped",
			drop_mode: "truncated",
			token_count: 20,
		});
	});

	it("migrates a compartment whose boundary is a synthetic folded-tool user", () => {
		const database = db();
		seedCompartment(database, {
			sequence: 1,
			startId: "synth-user-tool-1",
			endId: "a1",
		});

		const result = copyWithEntries(database, [
			toolResult("tool-1"),
			assistant("a1"),
		]);

		expect(result.compartmentsCopied).toBe(1);
		expect(
			database
				.prepare(
					"SELECT start_message, end_message FROM compartments WHERE session_id = ?",
				)
				.get("clone"),
		).toEqual({ start_message: 1, end_message: 2 });
	});

	it("inherits session notes and facts with fork-prefix anchors remapped", () => {
		const database = db();
		database
			.prepare(
				`INSERT INTO notes
				 (type, status, content, session_id, created_at, updated_at, harness,
				  anchor_ordinal, anchor_block_id)
				 VALUES ('session', 'active', ?, ?, ?, ?, 'pi', ?, ?)`,
			)
			.run("kept note", "source", 10, 10, 2, "a1#0");
		database
			.prepare(
				`INSERT INTO notes
				 (type, status, content, session_id, created_at, updated_at, harness,
				  anchor_ordinal, anchor_block_id)
				 VALUES ('session', 'active', ?, ?, ?, ?, 'pi', ?, ?)`,
			)
			.run("future note", "source", 11, 11, 3, "u3#0");
		database
			.prepare(
				"INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("source", "decision", "keep the invariant", 12, 12, "pi");
		const sourceNoteId = (
			database
				.prepare(
					"SELECT id FROM notes WHERE session_id = ? ORDER BY id LIMIT 1",
				)
				.get("source") as { id: number }
		).id;
		const sourceFactId = (
			database
				.prepare("SELECT id FROM session_facts WHERE session_id = ?")
				.get("source") as { id: number }
		).id;

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result).toMatchObject({ notesCopied: 1, factsCopied: 1 });
		const note = database
			.prepare(
				"SELECT id, content, anchor_ordinal, anchor_block_id FROM notes WHERE session_id = ?",
			)
			.get("clone") as {
			id: number;
			content: string;
			anchor_ordinal: number;
			anchor_block_id: string;
		};
		expect(note).toEqual({
			id: expect.any(Number),
			content: "kept note",
			anchor_ordinal: 2,
			anchor_block_id: "a1#0",
		});
		expect(note.id).not.toBe(sourceNoteId);
		const fact = database
			.prepare(
				"SELECT id, category, content FROM session_facts WHERE session_id = ?",
			)
			.get("clone") as { id: number; category: string; content: string };
		expect(fact).toMatchObject({
			category: "decision",
			content: "keep the invariant",
		});
		expect(fact.id).not.toBe(sourceFactId);
	});

	it("does not migrate a pending marker already represented by the copied compaction", () => {
		const database = db();
		seedCompartment(database, {
			sequence: 1,
			startId: "u1",
			endId: "a2",
			end: 4,
		});
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u1", "a2", 4),
		});

		const result = copyWithEntries(database, [
			user("u1"),
			assistant("a1"),
			compaction("c1", "u2"),
			user("u2"),
			assistant("a2"),
		]);

		expect(result.pendingMarkerMigrated).toBe(false);
		expect(getOrCreateSessionMeta(database, "clone")).toBeDefined();
		expect(
			(
				database
					.prepare(
						"SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?",
					)
					.get("clone") as { marker: string | null }
			).marker,
		).toBeNull();
	});

	it("migrates a newer pending marker beyond a copied compaction cut", () => {
		const database = db();
		seedCompartment(database, {
			sequence: 1,
			startId: "u1",
			endId: "a2",
			end: 4,
		});
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u2", "a2", 99),
		});

		const result = copyWithEntries(database, [
			user("u1"),
			assistant("a1"),
			compaction("c1", "u1"),
			user("u2"),
			assistant("a2"),
		]);

		expect(result.pendingMarkerMigrated).toBe(true);
		const marker = JSON.parse(
			(
				database
					.prepare(
						"SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?",
					)
					.get("clone") as { marker: string }
			).marker,
		);
		expect(marker).toMatchObject({
			firstKeptEntryId: "u2",
			endMessageId: "a2",
			ordinal: 4,
		});
	});

	it("migrates an applicable pending marker when the clone has no compaction entry", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u1", "a1", 2),
		});

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result.pendingMarkerMigrated).toBe(true);
	});

	it("drops a pending marker that references outside the copied prefix", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u3", "a3", 6),
		});

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result.pendingMarkerMigrated).toBe(false);
	});

	it("skips atomically when the destination already has compartments or tags", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedTag(database, { tagNumber: 1, messageId: "a1:p0" });
		seedCompartment(database, {
			sessionId: "clone",
			sequence: 99,
			startId: "existing-u",
			endId: "existing-a",
		});

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result.kind).toBe("destination-not-empty");
		expect(count(database, "compartments")).toBe(1);
		expect(count(database, "tags")).toBe(0);
		expect(count(database, "session_meta")).toBe(0);
	});

	it("rolls back every copied row when a filter fails mid-copy", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedTag(database, { tagNumber: 1, messageId: "u1:p0" });
		seedTag(database, { tagNumber: 2, messageId: "a1:p0" });
		let visits = 0;
		const filter: CloneSessionStateFilter = {
			resolveBoundaryOrdinal: (id) =>
				id === "u1" ? 1 : id === "a1" ? 2 : undefined,
			includeMessageId: () => true,
			includeTag: () => {
				visits += 1;
				if (visits === 2) throw new Error("injected copy failure");
				return true;
			},
			selectPendingPiMarker: () => null,
		};

		expect(() =>
			copySessionStateForClone(database, "source", "clone", filter),
		).toThrow("injected copy failure");
		for (const table of [
			"compartments",
			"tags",
			"source_contents",
			"pending_ops",
			"session_meta",
		]) {
			expect(count(database, table)).toBe(0);
		}
	});

	it("copies pending operations only for copied tags", () => {
		const database = db();
		seedTag(database, { tagNumber: 1, messageId: "u1:p0" });
		seedTag(database, { tagNumber: 2, messageId: "u3:p0" });
		database
			.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
			)
			.run("source", 1, "drop", 100, "pi");
		database
			.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
			)
			.run("source", 2, "drop", 200, "pi");

		const result = copyWithEntries(database, [user("u1")]);

		expect(result.pendingOpsCopied).toBe(1);
		expect(
			database
				.prepare(
					"SELECT tag_id, operation, queued_at FROM pending_ops WHERE session_id = ?",
				)
				.all("clone"),
		).toEqual([{ tag_id: 1, operation: "drop", queued_at: 100 }]);
	});

	it("migrates all todo fields together when the anchor is on the clone path", () => {
		const database = db();
		seedMeta(database, {
			last_todo_state: '[{"content":"carry"}]',
			todo_synthetic_call_id: "todo-call",
			todo_synthetic_anchor_message_id: "a1",
			todo_synthetic_state_json: '[{"content":"carry"}]',
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(
			database
				.prepare(
					`SELECT last_todo_state, todo_synthetic_call_id,
					        todo_synthetic_anchor_message_id, todo_synthetic_state_json
					   FROM session_meta WHERE session_id = ?`,
				)
				.get("clone"),
		).toEqual({
			last_todo_state: '[{"content":"carry"}]',
			todo_synthetic_call_id: "todo-call",
			todo_synthetic_anchor_message_id: "a1",
			todo_synthetic_state_json: '[{"content":"carry"}]',
		});
	});

	it("migrates no todo fields when the synthetic anchor is beyond the fork", () => {
		const database = db();
		seedMeta(database, {
			last_todo_state: '[{"content":"newer"}]',
			todo_synthetic_call_id: "todo-call",
			todo_synthetic_anchor_message_id: "a3",
			todo_synthetic_state_json: '[{"content":"newer"}]',
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		const row = database
			.prepare(
				`SELECT last_todo_state, todo_synthetic_call_id,
				        todo_synthetic_anchor_message_id, todo_synthetic_state_json
				   FROM session_meta WHERE session_id = ?`,
			)
			.get("clone");
		expect(row).toEqual({
			last_todo_state: "",
			todo_synthetic_call_id: "",
			todo_synthetic_anchor_message_id: "",
			todo_synthetic_state_json: "",
		});
	});

	it("copies source contents so caveman replay works on a migrated tag", () => {
		const database = db();
		const original =
			"I just really basically wanted to clearly explain ".repeat(20);

		seedTag(database, {
			tagNumber: 7,
			messageId: "u1:p0",
			cavemanDepth: 3,
		});
		database
			.prepare(
				"INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, ?, ?)",
			)
			.run(7, "source", original, 100, "pi");

		copyWithEntries(database, [user("u1")]);

		expect(getSourceContents(database, "clone", [7]).get(7)).toBe(original);
		let rendered = original;
		const targets = new Map<number, TagTarget>([
			[
				7,
				{
					getContent: () => rendered,
					setContent: (content) => {
						const changed = rendered !== content;
						rendered = content;
						return changed;
					},
				},
			],
		]);
		expect(
			replayCavemanCompression(
				"clone",
				database,
				targets,
				getTagsBySession(database, "clone"),
			),
		).toBe(1);
		expect(rendered).not.toBe(original);
	});

	it("sets the clone counter and watermarks from the maximum copied tag", () => {
		const database = db();
		seedTag(database, { tagNumber: 4, messageId: "u1:p0" });
		seedTag(database, { tagNumber: 12, messageId: "u3:p0" });
		seedMeta(database, {
			counter: 99,
			cleared_reasoning_through_tag: 20,
			tool_reclaim_watermark: 10,
		});

		copyWithEntries(database, [user("u1")]);

		const meta = database
			.prepare(
				"SELECT counter, cleared_reasoning_through_tag, tool_reclaim_watermark FROM session_meta WHERE session_id = ?",
			)
			.get("clone");
		expect(meta).toEqual({
			counter: 4,
			cleared_reasoning_through_tag: 4,
			tool_reclaim_watermark: 4,
		});
	});

	it("copies only retained Pi content decisions into a clone", () => {
		const database = db();
		seedMeta(database, {
			merged_reasoning_stripped_ids: JSON.stringify([
				encodePiContentDecision("reminder-strip", "u1:p0"),
				encodePiContentDecision("seam-temporal-strip", "u1"),
				encodePiContentDecision("reminder-strip", "u3:p0"),
			]),
		});
		copyWithEntries(database, [user("u1")]);
		expect([...getPiContentDecisions(database, "clone")]).toEqual([
			encodePiContentDecision("reminder-strip", "u1:p0"),
			encodePiContentDecision("seam-temporal-strip", "u1"),
		]);
	});

	it("retains nonzero text parts during pruning and remaps their message roots on clone", () => {
		const database = db();
		seedTag(database, { tagNumber: 1, messageId: "u1:p1" });
		seedMeta(database, {
			merged_reasoning_stripped_ids: JSON.stringify([
				encodePiContentDecision("seam-temporal-strip", "u1"),
			]),
		});
		expect(
			freezePiContentDecision(database, "source", "reminder-strip", "u1:p1"),
		).toBe(true);
		expect(getPiContentDecisions(database, "source").size).toBe(2);
		copySessionStateForClone(database, "source", "clone", {
			...__test.createCloneFilter([user("u1")]),
			mapMessageId: (id) => `mapped-${id}`,
		});
		expect([...getPiContentDecisions(database, "clone")]).toEqual([
			encodePiContentDecision("seam-temporal-strip", "mapped-u1"),
			encodePiContentDecision("reminder-strip", "mapped-u1:p1"),
		]);
	});

	it("preserves legacy replay entries while bounding content decisions and pruning deleted messages", () => {
		const database = db();
		const legacy = [
			"bare-id",
			thinkingBindingRecoveryFrozenId("entry"),
			'__merged_reasoning_parts_v1__:["assistant",["part-id",2]]',
		];
		const entries = [...legacy];
		for (let i = 0; i < PI_CONTENT_DECISION_LIMIT; i++) {
			seedTag(database, { tagNumber: i + 1, messageId: `u${i}:p0` });
			entries.push(encodePiContentDecision("reminder-strip", `u${i}:p0`));
		}
		seedMeta(database, {
			merged_reasoning_stripped_ids: JSON.stringify(entries),
		});
		expect(legacy.map(decodePiContentDecision)).toEqual([null, null, null]);
		expect(
			freezePiContentDecision(database, "source", "reminder-strip", "new:p0"),
		).toBe(false);
		database
			.prepare("DELETE FROM tags WHERE session_id = ? AND message_id = ?")
			.run("source", "u0:p0");
		expect(
			freezePiContentDecision(database, "source", "reminder-strip", "new:p0"),
		).toBe(true);
		const row = database
			.prepare(
				"SELECT merged_reasoning_stripped_ids AS value FROM session_meta WHERE session_id = ?",
			)
			.get("source") as { value: string };
		expect(JSON.parse(row.value).slice(0, 3)).toEqual(legacy);
		expect(getPiContentDecisions(database, "source").size).toBe(
			PI_CONTENT_DECISION_LIMIT,
		);
		expect(
			getPiContentDecisions(database, "source").has(
				encodePiContentDecision("reminder-strip", "u0:p0"),
			),
		).toBe(false);
	});

	it("clears Pi content decisions with session deletion", () => {
		const database = db();
		seedMeta(database, {
			merged_reasoning_stripped_ids: JSON.stringify([
				encodePiContentDecision("reminder-strip", "u:p0"),
			]),
		});
		clearSession(database, "source");
		expect(getPiContentDecisions(database, "source").size).toBe(0);
	});

	it("inherits frozen ids that remain on the clone path", () => {
		const database = db();
		seedMeta(database, {
			stripped_placeholder_ids: JSON.stringify(["a1", "a3"]),
			processed_image_stripped_ids: JSON.stringify(["u1", "u3"]),
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		const row = database
			.prepare(
				`SELECT stripped_placeholder_ids AS placeholders,
				        processed_image_stripped_ids AS images
				   FROM session_meta WHERE session_id = ?`,
			)
			.get("clone") as { placeholders: string; images: string };
		expect(JSON.parse(row.placeholders)).toEqual(["a1"]);
		expect(JSON.parse(row.images)).toEqual(["u1"]);
	});

	it("carries only retained native tool and reasoning decisions into a remapped clone", () => {
		const database = db();
		const retainedInput =
			'{"path":"src/retained.ts","range":{"start":10,"end":40},"marker":"[truncated]"}';
		seedTag(database, {
			tagNumber: 1,
			messageId: "call-retained",
			type: "tool",
			ownerId: "assistant-retained",
		});
		seedTag(database, {
			tagNumber: 2,
			messageId: "call-outside",
			type: "tool",
			ownerId: "assistant-outside",
		});
		addTrailingBlankDecisions(database, "source", [
			["assistant-retained", "strip"],
			["assistant-outside", "keep:2"],
		]);
		saveNativeToolInputs(
			database,
			"source",
			new Map([
				["call-retained", retainedInput],
				["call-outside", '{"path":"src/outside.ts"}'],
			]),
		);
		addNativeReasoningIds(database, "source", [
			"assistant-retained",
			"assistant-outside",
		]);

		const filter: CloneSessionStateFilter = {
			resolveBoundaryOrdinal: () => undefined,
			includeTag: (tag) =>
				tag.type === "tool" && tag.toolOwnerMessageId === "assistant-retained",
			includeMessageId: (id) => id === "assistant-retained",
			mapMessageId: (id) =>
				id === "assistant-retained"
					? "clone-assistant-retained"
					: id === "call-retained"
						? "clone-call-retained"
						: id,
			selectPendingPiMarker: () => null,
		};

		const result = copySessionStateForClone(
			database,
			"source",
			"clone",
			filter,
		);

		expect(result.tagsCopied).toBe(1);
		expect(getNativeToolInputs(database, "clone")).toEqual(
			new Map([["clone-call-retained", retainedInput]]),
		);
		expect(getNativeReasoningIds(database, "clone")).toEqual(
			new Set(["clone-assistant-retained"]),
		);
		expect(getTrailingBlankDecisions(database, "clone")).toEqual(
			new Map([["clone-assistant-retained", "strip"]]),
		);
	});

	it("filters and remaps legacy flat trailing decisions without adding native state", () => {
		const database = db();
		addTrailingBlankDecisions(database, "source", [
			["assistant-retained", "strip"],
			["assistant-outside", "keep:2"],
		]);
		copySessionStateForClone(database, "source", "clone", {
			...__test.createCloneFilter([assistant("assistant-retained")]),
			mapMessageId: (id) => `clone-${id}`,
		});
		expect(getTrailingBlankDecisions(database, "clone")).toEqual(
			new Map([["clone-assistant-retained", "strip"]]),
		);
		expect(getTrailingBlankDecisions(database, "source")).toEqual(
			new Map([
				["assistant-retained", "strip"],
				["assistant-outside", "keep:2"],
			]),
		);
		expect(getNativeToolInputs(database, "clone")).toEqual(new Map());
		expect(getNativeReasoningIds(database, "clone")).toEqual(new Set());
	});

	it("fails closed and rolls back a clone with malformed native replay", () => {
		const database = db();
		seedTag(database, {
			tagNumber: 1,
			messageId: "call-retained",
			type: "tool",
			ownerId: "assistant-retained",
		});
		const malformedReplayDocument = JSON.stringify({
			version: 2,
			trailingBlank: {},
			piNative: "not-a-native-state",
		});
		seedMeta(database, {
			trailing_blank_decisions: malformedReplayDocument,
		});

		expect(() =>
			copyWithEntries(database, [assistant("assistant-retained")]),
		).toThrow();
		expect(count(database, "tags")).toBe(0);
		expect(count(database, "session_meta")).toBe(0);
		const sourceMeta = database
			.prepare(
				"SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?",
			)
			.get("source") as { trailing_blank_decisions: string };
		expect(sourceMeta.trailing_blank_decisions).toBe(malformedReplayDocument);
	});

	it("leaves every m0/m1 cache field fresh so the first pass hard-materializes", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			cached_m0_bytes: Buffer.from("source-m0"),
			cached_m1_bytes: Buffer.from("source-m1"),
			memory_block_cache: "source-memory-cache",
			memory_block_ids: "[1,2]",
			cached_m0_max_compartment_seq: 1,
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		const decision = mustMaterializePi(
			{
				sessionId: "clone",
				projectIdentity: "project",
				projectDirectory: "/project",
			},
			database,
		);
		expect(decision).toEqual({ value: true, reason: "first_render" });
		const cacheRow = database
			.prepare(
				`SELECT cached_m0_bytes, cached_m1_bytes, memory_block_cache,
				        memory_block_ids, cached_m0_max_compartment_seq
				   FROM session_meta WHERE session_id = ?`,
			)
			.get("clone");
		expect(cacheRow).toEqual({
			cached_m0_bytes: null,
			cached_m1_bytes: null,
			memory_block_cache: "",
			memory_block_ids: "",
			cached_m0_max_compartment_seq: null,
		});
	});

	it("reads the source id from the previous JSONL header", async () => {
		const directory = await createTestTempDirFromPath(
			join(tmpdir(), "mc-clone-header-"),
		);
		temporaryDirectories.push(directory);
		const file = join(directory, "source.jsonl");
		await writeFile(
			file,
			'{"type":"session","id":"source-id"}\n{"type":"message"}\n',
		);
		expect(await readPiSessionIdFromFile(file)).toBe("source-id");
	});

	it("signals a migrated pending marker only after the transaction commits", async () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u1", "a1", 2),
		});
		const directory = await createTestTempDirFromPath(
			join(tmpdir(), "mc-clone-signal-"),
		);
		temporaryDirectories.push(directory);
		const file = join(directory, "source.jsonl");
		await writeFile(file, '{"type":"session","id":"source"}\n');
		let markerVisibleAtSignal = false;

		const result = await handlePiCloneSessionStart(
			{ reason: "fork", previousSessionFile: file },
			{
				sessionManager: {
					getSessionId: () => "clone",
					getBranch: () => [user("u1"), assistant("a1")],
				},
			},
			{
				db: database,
				signalPendingMarker: () => {
					markerVisibleAtSignal =
						(
							database
								.prepare(
									"SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?",
								)
								.get("clone") as { marker: string | null }
						).marker !== null;
				},
				writeLog: () => undefined,
			},
		);

		expect(result?.pendingMarkerMigrated).toBe(true);
		expect(markerVisibleAtSignal).toBe(true);
	});

	it("fails open with one actionable structured log line", async () => {
		const database = db();
		const messages: string[] = [];

		const result = await handlePiCloneSessionStart(
			{ reason: "fork", previousSessionFile: "/missing/source.jsonl" },
			{ sessionManager: { getSessionId: () => "clone" } },
			{
				db: database,
				signalPendingMarker: () => undefined,
				writeLog: (message) => messages.push(message),
			},
		);

		expect(result).toBeNull();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"source=unknown dest=clone stage=read-source-header",
		);
		expect(messages[0]).toContain("run /ctx-wrapup to rebuild, or re-clone");
	});
});
