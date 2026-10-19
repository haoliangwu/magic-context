/**
 * Review probes for Pi tool-tag identity: one tool call must never carry two
 * different §N§ tag numbers, and repairing a duplicate (one row on the real
 * assistant entry, one on a temporary `pi-msg-` owner) must keep exactly the
 * number and status the model was last served. The former finding assertions
 * are now normal regression tests for status-preserving recovery and
 * accurate message refusal; their partner tests preserve the byte-safety checks.
 */
import { afterEach, expect, test } from "bun:test";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import {
	adoptPiFallbackMessageTag,
	adoptPiFallbackToolOwnerTag,
	findPiTagIdentityConflict,
	insertTag,
	PiTagIdentityConflictError,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	captureSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import type { Database } from "@magic-context/core/shared/sqlite";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	__test,
	clearContextHandlerSession,
	collectMessageEntryIdsByRef,
	registerPiContextHandler,
} from "./context-handler";
import { contextHost } from "./pi-context-host.test";
import { registerPiGuardedContext } from "./pi-context-refusal";
import { PiStorageBusyError } from "./pi-raw-fallback";
import { readPiIdentityRebuilds } from "./pi-tag-identity-repair";
import { piCachedToolSurvivor } from "./pi-tool-identity";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const REAL = 8;
const FALLBACK = 154;
const FALLBACK_OWNER = "pi-msg-0-20-assistant";
const usedSessions: string[] = [];

afterEach(() => {
	resetLkgSlotsForTest();
	for (const sessionId of usedSessions.splice(0))
		clearPiServedArraySession(sessionId);
});

function session(name: string): string {
	const id = `650-review-${name}`;
	usedSessions.push(id);
	return id;
}

type Status = "active" | "dropped";

/** Tag 8 on the real assistant entry and tag 154 on a `pi-msg-` owner, one call. */
function seedReporterRows(
	db: Database,
	sessionId: string,
	realStatus: Status,
	fallbackStatus: Status,
): void {
	insertTag(
		db,
		sessionId,
		"call",
		"tool",
		100,
		REAL,
		0,
		"codemode",
		40,
		"real",
	);
	insertTag(
		db,
		sessionId,
		"call",
		"tool",
		100,
		FALLBACK,
		0,
		"codemode",
		40,
		FALLBACK_OWNER,
	);
	if (realStatus === "dropped") updateTagStatus(db, sessionId, REAL, "dropped");
	if (fallbackStatus === "dropped")
		updateTagStatus(db, sessionId, FALLBACK, "dropped");
}

function toolRows(db: Database, sessionId: string): unknown[] {
	return db
		.prepare(
			"SELECT tag_number, status, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
		)
		.all(sessionId);
}

/** Make `cached` the exact bytes of both the LKG slot and the last returned array. */
function serveCached(
	sessionId: string,
	cached: readonly PiMessage[],
	servedTagNumbers: number[],
): void {
	captureSlot(sessionId, {
		jsonPrefix: JSON.stringify(cached),
		inputIdSeq: cached.map((_, index) => `entry-${index}`),
		inputContentDigests: cached.map(() => "a"),
		lastInputMessageId: `entry-${cached.length - 1}`,
		modelKey: null,
		providerKey: null,
		capturedAt: Date.now(),
	});
	capturePiServedArray(sessionId, cached, { servedTagNumbers });
}

function adoptRealOwner(db: Database, sessionId: string) {
	return __test.adoptPiFallbackTags(db, sessionId, createTagger(), new Map(), {
		messages: [assistantToolCall("call", "codemode", {}, 20)],
		resolveStableId: () => "real",
	});
}

// ---------------------------------------------------------------------------
// 1. Survivor selection: every status x served-set x cached-survivor combination
// ---------------------------------------------------------------------------

test("review 650: storage survivor matrix never changes the last-served number or status", () => {
	const statuses: Status[] = ["active", "dropped"];
	const servedSets: number[][] = [[], [FALLBACK], [REAL], [REAL, FALLBACK]];
	const cachedOptions: (number | undefined)[] = [undefined, FALLBACK, REAL];
	const refusedWithByteSafeFold: string[] = [];
	for (const fallbackStatus of statuses)
		for (const realStatus of statuses)
			for (const served of servedSets)
				for (const cached of cachedOptions) {
					const key = `fallback=${fallbackStatus} real=${realStatus} served=[${served.join(",")}] cached=${cached ?? "-"}`;
					const db = createTestDb();
					const sessionId = "650-review-matrix";
					try {
						seedReporterRows(db, sessionId, realStatus, fallbackStatus);
						const statusOf: Record<number, Status> = {
							[REAL]: realStatus,
							[FALLBACK]: fallbackStatus,
						};
						// The number the model last saw: cached bytes are exact; otherwise
						// a single cumulative served number is the only one ever sent.
						const lastServed =
							cached ??
							(served.length === 1
								? served[0]
								: served.length === 0
									? "none"
									: "unknown");
						const before = toolRows(db, sessionId);
						let refused = false;
						try {
							adoptPiFallbackToolOwnerTag(
								db,
								sessionId,
								FALLBACK,
								"call",
								FALLBACK_OWNER,
								"real",
								new Set(served),
								cached,
							);
						} catch (error) {
							expect(error, key).toBeInstanceOf(PiTagIdentityConflictError);
							expect(toolRows(db, sessionId), key).toEqual(before);
							refused = true;
						}
						if (refused) {
							if (typeof lastServed === "number")
								refusedWithByteSafeFold.push(key);
							continue;
						}
						const after = toolRows(db, sessionId) as {
							tag_number: number;
							status: string;
						}[];
						expect(after, key).toHaveLength(1);
						expect(lastServed, key).not.toBe("unknown");
						if (typeof lastServed === "number") {
							expect(after[0]?.tag_number, key).toBe(lastServed);
							expect(after[0]?.status, key).toBe(statusOf[lastServed]);
							if (
								statusOf[lastServed] === "active" &&
								(fallbackStatus === "dropped" || realStatus === "dropped")
							)
								expect(
									getPendingOps(db, sessionId).map((op) => op.tagId),
									key,
								).toEqual([lastServed]);
						}
					} finally {
						db.close();
					}
				}
	// Every proven survivor retains its number and status; losing drops remain queued.
	expect(refusedWithByteSafeFold).toEqual([]);
});

// How the reported duplicate arises: tag 8 (real assistant owner) was served as
// the dropped placeholder `[dropped §8§]`. A later pass could not match the
// assistant to its real entry id, so it tagged the same call again as 154 under
// a `pi-msg-` owner and served the result with the active prefix `§154§ `. Every later served array also carried 154, so the
// last-served (cached) bytes name 154, active.
function reporterCachedBytes(): PiMessage[] {
	return [
		assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
		toolResultMessage("call", "§154§ 1", 21),
	];
}

test("review 650: realistic reporter state — cached 154 stays active and the losing drop is queued", () => {
	const db = createTestDb();
	const sessionId = session("reporter-cached-154");
	try {
		seedReporterRows(db, sessionId, "dropped", "active");
		serveCached(sessionId, reporterCachedBytes(), [REAL, FALLBACK]);
		expect(
			piCachedToolSurvivor(sessionId, "call", 20, [
				{ tagNumber: REAL, status: "dropped" },
				{ tagNumber: FALLBACK, status: "active" },
			]),
		).toBe(FALLBACK);
		adoptRealOwner(db, sessionId);
		expect(toolRows(db, sessionId)).toEqual([
			{ tag_number: FALLBACK, status: "active", tool_owner_message_id: "real" },
		]);
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([
			FALLBACK,
		]);
	} finally {
		db.close();
	}
});

test("review 650 finding: realistic reporter state should self-repair to the served 154 active row", () => {
	const db = createTestDb();
	const sessionId = session("reporter-cached-154-repair");
	try {
		seedReporterRows(db, sessionId, "dropped", "active");
		serveCached(sessionId, reporterCachedBytes(), [REAL, FALLBACK]);
		adoptRealOwner(db, sessionId);
		expect(toolRows(db, sessionId)).toEqual([
			{ tag_number: FALLBACK, status: "active", tool_owner_message_id: "real" },
		]);
	} finally {
		db.close();
	}
});

test("review 650: low-level adoption without a declared rebuild refuses absent LKG evidence", () => {
	const db = createTestDb();
	const sessionId = session("reporter-no-lkg");
	try {
		seedReporterRows(db, sessionId, "dropped", "active");
		capturePiServedArray(sessionId, [], { servedTagNumbers: [REAL, FALLBACK] });
		const before = toolRows(db, sessionId);
		expect(() => adoptRealOwner(db, sessionId)).toThrow(
			"no byte-safe cached survivor is proven",
		);
		expect(toolRows(db, sessionId)).toEqual(before);
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// 2. Cached-byte evidence cannot be borrowed from another call
// ---------------------------------------------------------------------------

test("review 650: a reused call id in the cached bytes cannot prove a survivor", () => {
	const sessionId = session("cached-reused-id");
	const rows = [
		{ tagNumber: REAL, status: "dropped" },
		{ tagNumber: FALLBACK, status: "active" },
	];
	serveCached(
		sessionId,
		[
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 10),
			toolResultMessage("call", "§154§ 1", 11),
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
			toolResultMessage("call", "[dropped §8§]", 21),
		],
		[REAL, FALLBACK],
	);
	expect(piCachedToolSurvivor(sessionId, "call", 20, rows)).toBeUndefined();
});

test("review 650: an identical twin call's result vetoes, and cannot stand in for a missing result", () => {
	const rows = [
		{ tagNumber: REAL, status: "dropped" },
		{ tagNumber: FALLBACK, status: "active" },
	];
	const both = session("cached-twin-both");
	serveCached(
		both,
		[
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
			toolResultMessage("call", "[dropped §8§]", 21),
			assistantToolCall("twin", "codemode", { code: "console.log(1)" }, 30),
			toolResultMessage("twin", "§154§ 1", 31),
		],
		[REAL, FALLBACK],
	);
	expect(piCachedToolSurvivor(both, "call", 20, rows)).toBeUndefined();

	// The result for `call` is gone; only `twin` (same tool, arguments and output,
	// different call id) still shows a tag number.
	const twinOnly = session("cached-twin-only");
	serveCached(
		twinOnly,
		[
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
			assistantToolCall("twin", "codemode", { code: "console.log(1)" }, 30),
			toolResultMessage("twin", "§154§ 1", 31),
		],
		[REAL, FALLBACK],
	);
	expect(piCachedToolSurvivor(twinOnly, "call", 20, rows)).toBeUndefined();
});

test("review 650: cached evidence is bound to the fallback row's timestamp", () => {
	const sessionId = session("cached-wrong-timestamp");
	serveCached(
		sessionId,
		[
			assistantToolCall("call", "codemode", {}, 99),
			toolResultMessage("call", "[dropped §8§]", 100),
		],
		[REAL, FALLBACK],
	);
	expect(
		piCachedToolSurvivor(sessionId, "call", 20, [
			{ tagNumber: REAL, status: "dropped" },
			{ tagNumber: FALLBACK, status: "active" },
		]),
	).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 3. Assistant tool identity: distinct invocations stay distinct
// ---------------------------------------------------------------------------

function withProse(message: PiMessage): PiMessage {
	const copy = structuredClone(message) as { content: unknown[] };
	copy.content.unshift({ type: "text", text: "context-only prose" });
	return copy as PiMessage;
}

function tagEdited(
	db: Database,
	sessionId: string,
	branch: { type: string; id: string; message: PiMessage }[],
	context: PiMessage[],
): (string | undefined)[] {
	const ids = collectMessageEntryIdsByRef(
		{} as never,
		context,
		sessionId,
		branch,
	) as (string | undefined)[];
	const transcript = createPiTranscript(context, sessionId, ids);
	tagTranscript(sessionId, transcript, createTagger(), db);
	transcript.commit();
	return ids;
}

test("review 650: the same tool with the same arguments called twice keeps two owners and two tags", () => {
	const db = createTestDb();
	const sessionId = session("identity-same-args");
	try {
		const first = assistantToolCall("call-1", "bash", { cmd: "ls" }, 20);
		const second = assistantToolCall("call-2", "bash", { cmd: "ls" }, 30);
		const r1 = toolResultMessage("call-1", "same output", 21);
		const r2 = toolResultMessage("call-2", "same output", 31);
		const branch = [
			{ type: "message", id: "a1", message: first },
			{ type: "message", id: "r1", message: r1 },
			{ type: "message", id: "a2", message: second },
			{ type: "message", id: "r2", message: r2 },
		];
		const ids = tagEdited(db, sessionId, branch, [
			userMessage("framing", 5),
			withProse(first),
			structuredClone(r1),
			withProse(second),
			structuredClone(r2),
		]);
		expect(ids).toEqual([undefined, "a1", "r1", "a2", "r2"]);
		const tools = db
			.prepare(
				"SELECT message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
			)
			.all(sessionId);
		expect(tools).toEqual([
			{ message_id: "call-1", tool_owner_message_id: "a1" },
			{ message_id: "call-2", tool_owner_message_id: "a2" },
		]);
	} finally {
		db.close();
	}
});

test("review 650: a retried call that reuses the call id stays a separate invocation", () => {
	const db = createTestDb();
	const sessionId = session("identity-retry");
	try {
		const first = assistantToolCall("call-x", "bash", { cmd: "ls" }, 20);
		const retry = assistantToolCall("call-x", "bash", { cmd: "ls" }, 40);
		const r1 = toolResultMessage("call-x", "failed", 21);
		const r2 = toolResultMessage("call-x", "ok", 41);
		const branch = [
			{ type: "message", id: "a1", message: first },
			{ type: "message", id: "r1", message: r1 },
			{ type: "message", id: "a2", message: retry },
			{ type: "message", id: "r2", message: r2 },
		];
		const ids = tagEdited(db, sessionId, branch, [
			userMessage("framing", 5),
			withProse(first),
			structuredClone(r1),
			withProse(retry),
			structuredClone(r2),
		]);
		expect(ids).toEqual([undefined, "a1", "r1", "a2", "r2"]);
		const tools = db
			.prepare(
				"SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
			)
			.all(sessionId) as {
			tag_number: number;
			tool_owner_message_id: string;
		}[];
		expect(tools.map((row) => row.tool_owner_message_id)).toEqual(["a1", "a2"]);
		expect(new Set(tools.map((row) => row.tag_number)).size).toBe(2);
	} finally {
		db.close();
	}
});

test("review 650: two branch entries sharing timestamp and call ids are never merged by tool identity", () => {
	const sessionId = session("identity-clone");
	const call = assistantToolCall("call-y", "bash", { cmd: "ls" }, 50);
	const branch = [
		{ type: "message", id: "c1", message: call },
		{ type: "message", id: "c2", message: structuredClone(call) },
	];
	const ids = collectMessageEntryIdsByRef(
		{} as never,
		[userMessage("framing", 5), withProse(call)],
		sessionId,
		branch,
	);
	expect(ids).toEqual([undefined, undefined]);
});

// ---------------------------------------------------------------------------
// 4. Refusal wording and raw-history safety
// ---------------------------------------------------------------------------

// This test first asserted that the real host runner refuses this turn with an
// identity-conflict message. No identity conflict may refuse more than one
// turn: a served array that renders both numbers proves nothing, which is the
// same as having no array, so the pass now takes the one declared repair
// (newest number kept) and serves. The refusal wording itself is still
// covered by the synthetic-error notice tests.
test("review 650: the real context handler serves an unprovable tool identity conflict with one repair", async () => {
	const db = createTestDb();
	const sessionId = session("handler-refusal");
	const host = contextHost();
	const fake = createFakePi();
	let handler: ((...args: never[]) => unknown) | undefined;
	try {
		insertTag(
			db,
			sessionId,
			"call",
			"tool",
			100,
			REAL,
			0,
			"codemode",
			40,
			"real",
		);
		updateTagStatus(db, sessionId, REAL, "dropped");
		insertTag(
			db,
			sessionId,
			"call",
			"tool",
			100,
			FALLBACK,
			0,
			"codemode",
			40,
			"pi-msg-1-20-assistant",
		);
		serveCached(
			sessionId,
			[
				assistantToolCall("call", "codemode", {}, 20),
				toolResultMessage("call", "[dropped §8§]", 21),
				userMessage("§154§ rendered", 22),
			],
			[REAL, FALLBACK],
		);
		registerPiContextHandler(
			{
				...fake.pi,
				...host.api,
				on(name: string, fn: (...args: never[]) => unknown) {
					if (name === "context") handler = fn;
					fake.pi.on(name, fn);
				},
			} as never,
			{ db, protectedTags: 0 },
		);
		const input = [
			userMessage("first"),
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
			toolResultMessage("call", "1", 21),
			userMessage("next", 22),
		];
		await host.emit(
			handler as (...args: never[]) => unknown,
			structuredClone(input),
			fakeContext(
				sessionId,
				process.cwd(),
				["first", "real", "result", "next"],
				input,
			),
		);
		expect(host.controller.signal.aborted).toBe(false);
		expect(host.entries).toHaveLength(0);
		expect(toolRows(db, sessionId)).toEqual([
			{ tag_number: FALLBACK, status: "active", tool_owner_message_id: "real" },
		]);
		expect(readPiIdentityRebuilds(db, sessionId)).toEqual([]);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("review 650: a storage-busy refusal keeps its retry wording", async () => {
	const host = contextHost();
	let handler: (...args: never[]) => unknown = () => {
		throw new Error("missing context handler");
	};
	registerPiGuardedContext(
		{
			...host.api,
			on(name: string, fn: (...args: never[]) => unknown) {
				if (name === "context") handler = fn;
			},
		} as never,
		async () => {
			throw new PiStorageBusyError();
		},
	);
	const input = [userMessage("hello")];
	const served = await host.emit(handler, input, {
		sessionManager: { getSessionId: () => "650-review-busy" },
	});
	host.assertRefused(served as unknown[], [userMessage("hello")]);
	expect((host.entries[0]?.data as { message: string }).message).toContain(
		"storage is busy",
	);
});

function seedMessageConflict(db: Database, sessionId: string): void {
	insertTag(db, sessionId, "real-user:p0", "message", 233, 20);
	insertTag(db, sessionId, "pi-msg-0-5-user:p0", "message", 233, 440);
}

test("review 650: a served message-tag conflict (issue comment 2) has an accurate identity refusal", () => {
	const db = createTestDb();
	try {
		seedMessageConflict(db, "650-review-message");
		let thrown: unknown;
		try {
			adoptPiFallbackMessageTag(
				db,
				"650-review-message",
				440,
				"pi-msg-0-5-user:p0",
				"real-user:p0",
				new Set([20, 440]),
			);
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toContain(
			"message-tag identity conflict",
		);
		expect((thrown as Error).message).not.toContain("storage is busy");
		expect(findPiTagIdentityConflict(thrown)).toBeDefined();
	} finally {
		db.close();
	}
});

test("review 650 finding: a served message-tag conflict should refuse as an identity conflict", () => {
	const db = createTestDb();
	try {
		seedMessageConflict(db, "650-review-message-typed");
		let thrown: unknown;
		try {
			adoptPiFallbackMessageTag(
				db,
				"650-review-message-typed",
				440,
				"pi-msg-0-5-user:p0",
				"real-user:p0",
				new Set([20, 440]),
			);
		} catch (error) {
			thrown = error;
		}
		expect(findPiTagIdentityConflict(thrown)).toBeDefined();
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// 5. The collision fixtures' original shapes now refuse
// ---------------------------------------------------------------------------

test("review 650: the collision fixtures' original unserved shape now refuses instead of folding", () => {
	const db = createTestDb();
	const sessionId = session("fixture-unserved");
	try {
		insertTag(
			db,
			sessionId,
			"call",
			"tool",
			10,
			30,
			0,
			"Read",
			0,
			"pi-msg-0-20-assistant",
		);
		insertTag(db, sessionId, "call", "tool", 20, 31, 0, "Read", 0, "real");
		const before = toolRows(db, sessionId);
		expect(() =>
			__test.adoptPiFallbackTags(db, sessionId, createTagger(), new Map(), {
				messages: [assistantToolCall("call", "Read", {}, 20)],
				resolveStableId: () => "real",
			}),
		).toThrow("duplicate tool identities have no proven served-byte survivor");
		expect(toolRows(db, sessionId)).toEqual(before);
	} finally {
		db.close();
	}
});

test("review 650: the accounting fixture's served real active row retains its status and queues the losing drop", () => {
	const db = createTestDb();
	const sessionId = session("fixture-dropped-fallback");
	try {
		insertTag(
			db,
			sessionId,
			"call",
			"tool",
			12,
			10,
			1,
			"Read",
			3,
			"pi-msg-0-10-assistant",
		);
		updateTagStatus(db, sessionId, 10, "dropped");
		insertTag(db, sessionId, "call", "tool", 1000, 20, 7, "Read", 200, "real");
		capturePiServedArray(
			sessionId,
			[toolResultMessage("call", "§20§ result")],
			{
				servedTagNumbers: [20],
			},
		);
		__test.adoptPiFallbackTags(db, sessionId, createTagger(), new Map(), {
			messages: [assistantToolCall("call", "Read", {}, 10)],
			resolveStableId: () => "real",
		});
		expect(toolRows(db, sessionId)).toEqual([
			{ tag_number: 20, status: "active", tool_owner_message_id: "real" },
		]);
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([20]);
	} finally {
		db.close();
	}
});
