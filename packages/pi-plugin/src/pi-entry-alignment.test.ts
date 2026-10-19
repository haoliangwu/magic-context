import { describe, expect, it, spyOn } from "bun:test";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import * as logger from "@magic-context/core/shared/logger";
// Pi 0.87.1 applies `context_edit` omissions when it builds the context.
import { buildSessionContext } from "pi-coding-agent-087";
import { __test, clearContextHandlerSession } from "./context-handler";
import { createTestDb } from "./test-utils.test";

// The positional entry-id lane trusts that Pi built the event from the branch
// projection. An extension earlier in Pi's context chain may replace or
// reorder messages while keeping the count; each position is therefore
// checked against its projected entry before the lane is used.

const ctx = {} as ExtensionContext;

function entry(
	id: string,
	parentId: string | null,
	message: Record<string, unknown>,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp as number).toISOString(),
		message,
	} as unknown as SessionEntry;
}

function buildEntries(sameTimestampPair = false): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	const push = (id: string, message: Record<string, unknown>) => {
		entries.push(entry(id, parentId, message));
		parentId = id;
	};
	push("system-entry", {
		role: "system",
		content: "You are a coding agent.",
		timestamp: 1_000,
	});
	for (let index = 0; index < 10; index += 1) {
		// Entries 4 and 5 can share a millisecond, as two messages appended in
		// one tick do; then only their content tells them apart.
		const timestamp =
			sameTimestampPair && index === 5 ? 2_000 + 4 : 2_000 + index;
		push(`entry-${index}`, {
			role:
				index % 2 === 0 || (sameTimestampPair && index === 5)
					? "user"
					: "assistant",
			content:
				index % 2 === 0 || (sameTimestampPair && index === 5)
					? `Message ${index}`
					: [{ type: "text", text: `Answer ${index}` }],
			timestamp,
		});
	}
	return entries;
}

/** The array Pi 0.87 hands `context` handlers: a clone without system messages. */
function eventMessages(entries: SessionEntry[]): unknown[] {
	const byId = new Map(entries.map((row) => [row.id, row]));
	return structuredClone(
		buildSessionContext(
			entries as never,
			entries.at(-1)?.id ?? null,
			byId as never,
		).messages as unknown[],
	).filter((message) => (message as { role?: unknown }).role !== "system");
}

const expectedIds = Array.from({ length: 10 }, (_, index) => `entry-${index}`);

function resolve(
	sessionId: string,
	entries: SessionEntry[],
	messages: unknown[],
) {
	return __test.resolvePiEventEntryIds(
		ctx,
		messages as Parameters<typeof __test.resolvePiEventEntryIds>[1],
		sessionId,
		entries,
	);
}

describe("Pi positional entry-id alignment", () => {
	it("uses the positional lane without hashing when every position matches", () => {
		const entries = buildEntries();
		resolve("alignment-clean", entries, eventMessages(entries));
		const before = __test.readPiEntryFingerprintCount();
		const ids = resolve("alignment-clean", entries, eventMessages(entries));
		expect(__test.readPiEntryFingerprintCount() - before).toBe(0);
		expect([...(ids ?? [])]).toEqual(expectedIds);
		clearContextHandlerSession("alignment-clean");
	});

	it("falls back to content matching when an earlier extension swaps two messages", () => {
		const entries = buildEntries();
		const messages = eventMessages(entries);
		[messages[3], messages[6]] = [messages[6], messages[3]];
		const log = spyOn(logger, "sessionLog");
		try {
			const ids = resolve("alignment-swap", entries, messages);
			const swapped = [...expectedIds];
			[swapped[3], swapped[6]] = [swapped[6], swapped[3]];
			expect([...(ids ?? [])]).toEqual(swapped);
			resolve("alignment-swap", entries, messages);
			// One line per session, naming the first position that did not match.
			expect(
				log.mock.calls
					.map((call) => call[1])
					.filter((line) => line.startsWith("pi entry alignment:")),
			).toEqual([
				"pi entry alignment: message 3 of 10 does not match its projected entry; resolving ids by content fingerprint (logged once per session)",
			]);
		} finally {
			log.mockRestore();
			clearContextHandlerSession("alignment-swap");
		}
	});

	it("falls back to content matching when an earlier extension replaces a message", () => {
		const entries = buildEntries();
		const messages = eventMessages(entries);
		messages[4] = {
			role: "user",
			content: "Injected by another extension",
			timestamp: 9_999,
		};
		const ids = resolve("alignment-replace", entries, messages);
		const replaced: (string | undefined)[] = [...expectedIds];
		replaced[4] = undefined;
		expect([...(ids ?? [])]).toEqual(replaced);
		clearContextHandlerSession("alignment-replace");
	});

	it("checks content where two entries share every header field", () => {
		const entries = buildEntries(true);
		const messages = eventMessages(entries);
		[messages[4], messages[5]] = [messages[5], messages[4]];
		const ids = resolve("alignment-same-header", entries, messages);
		const swapped = [...expectedIds];
		[swapped[4], swapped[5]] = [swapped[5], swapped[4]];
		expect([...(ids ?? [])]).toEqual(swapped);
		clearContextHandlerSession("alignment-same-header");
	});
});

describe("Pi fallback adoption of identical same-millisecond messages", () => {
	// Builds the state an older build left behind for two identical user
	// messages it could only resolve by fingerprint: index-based `pi-msg-*`
	// rows, tagged once before a compaction shifted the indexes (tags 7, 8) and
	// again after it (tags 10, 11, the pair last served). Returns the rows after
	// one adoption with the given real ids resolved.
	function adoptPair(realIds: readonly string[], newestStatus: string) {
		const db = createTestDb();
		const sessionId = "alignment-identical-adoption";
		const message = { role: "user", content: "continue", timestamp: 5_000 };
		const messages = [
			{ role: "user", content: "Start.", timestamp: 4_000 },
			structuredClone(message),
			structuredClone(message),
		];
		const ids = ["real-start", ...realIds];
		const resolveStableId = (_message: unknown, index: number) => ids[index];
		const fingerprints = __test.buildEntryFingerprintMap(
			messages as Parameters<typeof __test.buildEntryFingerprintMap>[0],
			resolveStableId,
		);
		const fingerprint = fingerprints.get(realIds[0] as string) as string;
		const insert = db.prepare(
			`INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, entry_fingerprint)
			 VALUES (?, ?, 'message', ?, 8, ?, ?)`,
		);
		insert.run(sessionId, "pi-msg-9-5000-user:p0", "active", 7, fingerprint);
		insert.run(sessionId, "pi-msg-10-5000-user:p0", "active", 8, fingerprint);
		insert.run(
			sessionId,
			"pi-msg-1-5000-user:p0",
			newestStatus,
			10,
			fingerprint,
		);
		insert.run(
			sessionId,
			"pi-msg-2-5000-user:p0",
			newestStatus,
			11,
			fingerprint,
		);
		try {
			__test.adoptPiFallbackTags(db, sessionId, createTagger(), fingerprints, {
				messages: messages as Parameters<
					typeof __test.buildEntryFingerprintMap
				>[0],
				resolveStableId,
			});
			return db
				.prepare(
					"SELECT message_id, tag_number, status FROM tags WHERE session_id = ? ORDER BY tag_number",
				)
				.all(sessionId);
		} finally {
			db.close();
		}
	}

	it("moves the newest fallback pair, dropped status included, onto the real ids in order", () => {
		expect(adoptPair(["real-first", "real-second"], "dropped")).toEqual([
			{ message_id: "pi-msg-9-5000-user:p0", tag_number: 7, status: "active" },
			{ message_id: "pi-msg-10-5000-user:p0", tag_number: 8, status: "active" },
			{ message_id: "real-first:p0", tag_number: 10, status: "dropped" },
			{ message_id: "real-second:p0", tag_number: 11, status: "dropped" },
		]);
	});

	it("leaves the rows alone when a single real id cannot be told apart from its twin", () => {
		// One resolved real id cannot be paired by order with several fallbacks.
		const rows = adoptPair(["real-first", "real-first"], "dropped");
		expect(
			rows.map((row) => (row as { message_id: string }).message_id),
		).toEqual([
			"pi-msg-9-5000-user:p0",
			"pi-msg-10-5000-user:p0",
			"pi-msg-1-5000-user:p0",
			"pi-msg-2-5000-user:p0",
		]);
	});
});

describe("Pi header-anchored entry ids", () => {
	// System entry, a user/assistant exchange, two identical user messages
	// stamped in one millisecond, then a closing assistant.
	function identicalPairEntries(): SessionEntry[] {
		const rows: [string, Record<string, unknown>][] = [
			[
				"system-entry",
				{
					role: "system",
					content: "You are a coding agent.",
					timestamp: 1_000,
				},
			],
			["u0", { role: "user", content: "Read the loader.", timestamp: 2_000 }],
			[
				"a0",
				{
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
					responseId: "r0",
					timestamp: 3_000,
				},
			],
			["u1", { role: "user", content: "continue", timestamp: 4_000 }],
			["u2", { role: "user", content: "continue", timestamp: 4_000 }],
			[
				"a1",
				{
					role: "assistant",
					content: [{ type: "text", text: "Continuing." }],
					responseId: "r1",
					timestamp: 5_000,
				},
			],
		];
		let parentId: string | null = null;
		return rows.map(([id, message]) => {
			const row = entry(id, parentId, message);
			parentId = id;
			return row;
		});
	}
	const extra = {
		role: "custom",
		customType: "reminder",
		content: [{ type: "text", text: "Remember the style guide." }],
		display: false,
		timestamp: 9_000,
	};

	it("keeps the real ids of an identical pair between anchors when another extension appends a message", () => {
		const entries = identicalPairEntries();
		const messages = [...eventMessages(entries), extra];
		const before = __test.readPiEntryAlignmentLaneCounts();
		const ids = resolve("anchored-append", entries, messages);
		expect([...(ids ?? [])]).toEqual(["u0", "a0", "u1", "u2", "a1", undefined]);
		expect(__test.readPiEntryAlignmentLaneCounts().anchored).toBe(
			before.anchored + 1,
		);
		clearContextHandlerSession("anchored-append");
	});

	it("leaves an identical pair unresolved when a message lands inside its run", () => {
		// The run between the anchors a0 and a1 is now one longer than the
		// projected run, so no position can be trusted and the pair's equal
		// fingerprints cannot tell them apart either.
		const entries = identicalPairEntries();
		const messages = eventMessages(entries);
		messages.splice(3, 0, extra);
		const ids = resolve("anchored-inside-run", entries, messages);
		expect([...(ids ?? [])]).toEqual([
			"u0",
			"a0",
			undefined,
			undefined,
			undefined,
			"a1",
		]);
		clearContextHandlerSession("anchored-inside-run");
	});

	it("matches every message by fingerprint when anchors appear out of order", () => {
		const entries = identicalPairEntries();
		const messages = [...eventMessages(entries), extra];
		[messages[0], messages[1]] = [messages[1], messages[0]];
		const before = __test.readPiEntryAlignmentLaneCounts();
		const ids = resolve("anchored-out-of-order", entries, messages);
		// The fingerprint lane resolves the swapped pair correctly and, as
		// before, cannot tell the identical messages apart.
		expect([...(ids ?? [])]).toEqual([
			"a0",
			"u0",
			undefined,
			undefined,
			"a1",
			undefined,
		]);
		expect(__test.readPiEntryAlignmentLaneCounts().fingerprint).toBe(
			before.fingerprint + 1,
		);
		clearContextHandlerSession("anchored-out-of-order");
	});

	it("rebuilds the cached projection when an appended context_edit omits an earlier entry", () => {
		const entries = identicalPairEntries();
		const byId = new Map(entries.map((row) => [row.id, row]));
		let leafId = "a1";
		const sessionCtx = {
			sessionManager: {
				getLeafId: () => leafId,
				getEntry: (id: string) => byId.get(id),
				getBranch: () => {
					const path: SessionEntry[] = [];
					for (let id: string | null = leafId; id; ) {
						const row = byId.get(id);
						if (!row) break;
						path.unshift(row);
						id = row.parentId;
					}
					return path;
				},
			},
		} as unknown as ExtensionContext;
		const sessionId = "anchored-context-edit";
		__test.readPiBranchEntriesForContext(sessionCtx, sessionId);
		// Pi 0.87.1 omits the failed reply a1 before retrying.
		const omission = {
			type: "context_edit",
			id: "edit-1",
			parentId: "a1",
			timestamp: new Date(6_000).toISOString(),
			targetId: "a1",
			replacement: null,
		} as unknown as SessionEntry;
		const retry = entry("a2", "edit-1", {
			role: "assistant",
			content: [{ type: "text", text: "Retried." }],
			responseId: "r2",
			timestamp: 7_000,
		});
		byId.set("edit-1", omission);
		byId.set("a2", retry);
		leafId = "a2";
		const branch = __test.readPiBranchEntriesForContext(sessionCtx, sessionId);
		const all = [...entries, omission, retry];
		const messages = eventMessages(all);
		const before = __test.readPiEntryAlignmentLaneCounts();
		const ids = __test.resolvePiEventEntryIds(
			ctx,
			messages as Parameters<typeof __test.resolvePiEventEntryIds>[1],
			sessionId,
			branch,
		);
		expect([...(ids ?? [])]).toEqual(["u0", "a0", "u1", "u2", "a2"]);
		// Positional lane: neither off-lane counter moved.
		expect(__test.readPiEntryAlignmentLaneCounts()).toEqual(before);
		clearContextHandlerSession(sessionId);
	});
});
