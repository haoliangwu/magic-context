/**
 * Second independent review of the issue 650 fix (tool and message tag
 * identity on Pi). Each finding was pinned as a `test.failing` stating the
 * behaviour the reviewer expected; the fix round turned them into ordinary
 * tests ("finding" in the name marks them). Each partner `test` pins the
 * neighbouring behaviour that held at review time, so a fix cannot silently
 * trade one for the other. Where the fix's ruling (no tag-identity conflict
 * may refuse more than one turn) changed what a test may expect, the test says
 * so in a comment.
 * "Finding N" section headers group the reproduction cases; "field question"
 * marks an Oh My Pi host-behavior case.
 */
import { afterEach, expect, test } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import { saveSourceContent } from "@magic-context/core/features/magic-context/storage-source";
import {
	insertTag,
	PiTagIdentityConflictError,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import type { Database } from "@magic-context/core/shared/sqlite";
import { classifyCacheBust } from "../../plugin/scripts/cache-bust-attribution";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import {
	readPiIdentityRebuilds,
	readPiIdentityRecurrences,
} from "./pi-tag-identity-repair";
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

const OLD = 8;
const NEWEST = 154;
const FALLBACK_OWNER = "pi-msg-1-20-assistant";
const usedSessions: string[] = [];

afterEach(() => {
	resetLkgSlotsForTest();
	for (const sessionId of usedSessions.splice(0)) {
		clearPiServedArraySession(sessionId);
		clearContextHandlerSession(sessionId);
	}
});

function session(name: string): string {
	const id = `650-r2-${name}-${Math.random().toString(36).slice(2, 8)}`;
	usedSessions.push(id);
	return id;
}

/**
 * The reporter's realistic state: tag 8 on the real assistant entry was dropped
 * (by the agent's ctx_reduce), the lost owner then minted 154 under a `pi-msg-`
 * owner and served it active. Both numbers are in the cumulative served ledger.
 */
function seedReporterRows(db: Database, sessionId: string): void {
	insertTag(db, sessionId, "call", "tool", 100, OLD, 0, "codemode", 40, "real");
	insertTag(
		db,
		sessionId,
		"call",
		"tool",
		100,
		NEWEST,
		0,
		"codemode",
		40,
		FALLBACK_OWNER,
	);
	updateTagStatus(db, sessionId, OLD, "dropped");
}

/**
 * The last served array: the call's result carries `§154§ ` (the exact proof
 * piCachedToolSurvivor looks for). With `quoteOld`, it also carries the
 * ctx_reduce result that dropped tag 8. That text is what the real ctx_reduce
 * tool returns (`Queued: drop §8§.`, tools/ctx-reduce.ts formatIds).
 */
function lastServedArray(quoteOld: boolean): PiMessage[] {
	const messages: PiMessage[] = [
		userMessage("§150§ first", 1),
		assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
		toolResultMessage("call", `§${NEWEST}§ 1`, 21),
	];
	if (quoteOld)
		messages.push(
			assistantToolCall("reduce", "ctx_reduce", { drop: `${OLD}` }, 30),
			toolResultMessage("reduce", `§160§ Queued: drop §${OLD}§.`, 31),
		);
	messages.push(userMessage("§161§ next", 40));
	return messages;
}

function toolRows(db: Database, sessionId: string): unknown[] {
	return db
		.prepare(
			"SELECT tag_number, status, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call' ORDER BY tag_number",
		)
		.all(sessionId);
}

/** Same options the production pipeline passes (runPipeline sets allowUnprovenRebuild). */
function adoptLikeProduction(db: Database, sessionId: string) {
	return __test.adoptPiFallbackTags(db, sessionId, createTagger(), new Map(), {
		allowUnprovenRebuild: true,
		messages: [
			userMessage("first", 1),
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
		],
		resolveStableId: (_message: unknown, index: number) =>
			index === 1 ? "real" : "first",
	});
}

// ---------------------------------------------------------------------------
// Finding 1: a §8§ quoted anywhere in the last served array vetoes the cached
// proof, and the presence of that array also disables the automatic repair.
// ---------------------------------------------------------------------------

test("review 650 r2: without a quoted old number, the cached array proves 154 and the fold keeps it active", () => {
	const db = createTestDb();
	const sessionId = session("unquoted");
	try {
		seedReporterRows(db, sessionId);
		capturePiServedArray(sessionId, lastServedArray(false), {
			servedTagNumbers: [OLD, NEWEST],
		});
		const outcome = adoptLikeProduction(db, sessionId);
		expect(toolRows(db, sessionId)).toEqual([
			{ tag_number: NEWEST, status: "active", tool_owner_message_id: "real" },
		]);
		// Evidence-backed: no unproven rebuild is declared.
		expect(outcome.rebuilds).toEqual([]);
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([
			NEWEST,
		]);
	} finally {
		db.close();
	}
});

test("review 650 r2 finding: a ctx_reduce result quoting the dropped number must not block the proven 154 survivor", () => {
	const db = createTestDb();
	const sessionId = session("quoted");
	try {
		seedReporterRows(db, sessionId);
		capturePiServedArray(sessionId, lastServedArray(true), {
			servedTagNumbers: [OLD, NEWEST],
		});
		// At the reviewed commit this throws PiTagIdentityConflictError ("Conflicting served Pi
		// tool tag numbers"): `§8§` in the ctx_reduce result vetoes the cached
		// proof, and because a cached array exists the automatic repair is not
		// offered either.
		const outcome = adoptLikeProduction(db, sessionId);
		expect(toolRows(db, sessionId)).toEqual([
			{ tag_number: NEWEST, status: "active", tool_owner_message_id: "real" },
		]);
		// Proven by the rendered tags, so no unproven rebuild is declared: the
		// quoted `§8§` inside the receipt is not a tag position.
		expect(outcome.rebuilds).toEqual([]);
	} finally {
		db.close();
	}
});

/**
 * Drive the real context handler for the reporter state. The last served
 * array is held in process memory (as after any served pass in a running Pi);
 * Pi registers no durable LKG backend, so only a process restart clears it.
 * `flushBeforePass` raises the same pending-materialization signal `/ctx-flush`
 * raises, just before that pass (0-based). The session is already on the current
 * stable-id scheme, so no scheme cutover forces its own flush.
 */
async function servePasses(
	quoteOld: boolean,
	passes: number,
	flushBeforePass?: number,
) {
	const db = createTestDb();
	const sessionId = session(quoteOld ? "handler-quoted" : "handler-unquoted");
	const call = assistantToolCall(
		"call",
		"codemode",
		{ code: "console.log(1)" },
		20,
	);
	const input: PiMessage[] = [
		userMessage("first", 1),
		call,
		toolResultMessage("call", "1", 21),
	];
	const ids = ["first", "real", "result"];
	if (quoteOld) {
		input.push(
			assistantToolCall("reduce", "ctx_reduce", { drop: `${OLD}` }, 30),
			toolResultMessage("reduce", `Queued: drop §${OLD}§.`, 31),
		);
		ids.push("reduce-call", "reduce-result");
	}
	input.push(userMessage("next", 40));
	ids.push("next");
	seedReporterRows(db, sessionId);
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	capturePiServedArray(sessionId, lastServedArray(quoteOld), {
		servedTagNumbers: [OLD, NEWEST],
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const ctx = fakeContext(sessionId, process.cwd(), ids, input);
	const handler = fake.handlers.get("context")!;
	const outcomes: string[] = [];
	const pendingAfterPass: number[][] = [];
	try {
		for (let n = 0; n < passes; n++) {
			if (n === flushBeforePass) signalPiPendingMaterialization(sessionId);
			try {
				const result = (await handler(
					{ messages: structuredClone(input) } as never,
					ctx as never,
				)) as { messages: unknown[] };
				outcomes.push(JSON.stringify(result.messages));
			} catch (error) {
				outcomes.push(
					error instanceof PiTagIdentityConflictError
						? "refused: identity conflict"
						: `error: ${String(error)}`,
				);
			}
			pendingAfterPass.push(getPendingOps(db, sessionId).map((op) => op.tagId));
		}
		return { outcomes, rows: toolRows(db, sessionId), pendingAfterPass };
	} finally {
		db.close();
	}
}

test("review 650 r2: unquoted reporter state serves the proven 154 on every pass with identical bytes", async () => {
	const { outcomes, rows, pendingAfterPass } = await servePasses(false, 3);
	expect(outcomes[0]).toContain(`§${NEWEST}§ 1`);
	expect(outcomes[0]).not.toContain(`§${OLD}§`);
	expect(new Set(outcomes).size).toBe(1);
	expect(rows).toEqual([
		{ tag_number: NEWEST, status: "active", tool_owner_message_id: "real" },
	]);
	// The recovered drop stays queued across scheduler-defer passes.
	expect(pendingAfterPass).toEqual([[NEWEST], [NEWEST], [NEWEST]]);
});

test("review 650 r2 finding: reporter state with the ctx_reduce receipt in view should serve rather than refuse every turn", async () => {
	const { outcomes } = await servePasses(true, 3);
	// At the reviewed commit: three refusals in a row; nothing changes the in-memory last served
	// array, so every later turn in this process refuses the same way.
	expect(outcomes.filter((o) => o.startsWith("refused"))).toEqual([]);
	expect(outcomes[0]).toContain(`§${NEWEST}§ 1`);
});

// ---------------------------------------------------------------------------
// Finding 2: the fold's protection reuses `thinkingDropProtected`, which also
// keeps a pending flush signal alive. The queued drop then applies on the next
// pass even though the scheduler deferred it: a second bust after the flush.
// ---------------------------------------------------------------------------

test("review 650 r2: a flush raised after the fold pass applies the queued drop on that flush pass only", async () => {
	// The fold happens on pass 0 without a flush signal; the flush arrives
	// before pass 1, and the drop rides that single declared bust.
	const { outcomes, pendingAfterPass } = await servePasses(false, 3, 1);
	expect(outcomes[0]).toContain(`§${NEWEST}§ 1`);
	expect(outcomes[1]).toContain(`[dropped §${NEWEST}§]`);
	expect(outcomes[2]).toBe(outcomes[1]);
	expect(pendingAfterPass).toEqual([[NEWEST], [], []]);
});

test("review 650 r2 finding: a fold on a /ctx-flush pass must not make the next scheduler-defer pass bust again", async () => {
	const { outcomes, pendingAfterPass } = await servePasses(false, 3, 0);
	// Pass 0 is the flush pass; it keeps 154 active (the fold protects it) and
	// leaves the drop queued. At the reviewed commit the flush signal survives because the
	// protected target carries thinkingDropProtected, so pass 1 (scheduler
	// defer) applies the drop and changes `§154§ 1` to `[dropped §154§]`.
	expect(outcomes[0]).toContain(`§${NEWEST}§ 1`);
	expect(pendingAfterPass[0]).toEqual([NEWEST]);
	expect(outcomes[1]).toBe(outcomes[0]);
});

// ---------------------------------------------------------------------------
// Finding 1, message variant: when the served copy of a message differs from
// the raw entry by anything besides the leading §N§ (here a stripped system
// reminder), the cached proof fails, and the presence of the served array
// again blocks the automatic repair.
// ---------------------------------------------------------------------------

const MSG_OLD = 20;
const MSG_NEW = 440;
const MSG_FALLBACK_ID = "pi-msg-0-1700000000000-user";

function seedMessageConflict(
	db: Database,
	sessionId: string,
	message: PiMessage,
	parts: number,
	numbers: { real: number[]; fallback: number[] },
): string {
	const fingerprint = piMessageEntryFingerprint(message)!;
	for (let part = 0; part < parts; part++) {
		for (const [owner, number] of [
			["real", numbers.real[part]!],
			[MSG_FALLBACK_ID, numbers.fallback[part]!],
		] as const) {
			insertTag(
				db,
				sessionId,
				`${owner}:p${part}`,
				"message",
				100,
				number,
				0,
				null,
				0,
				null,
				fingerprint,
			);
			saveSourceContent(db, sessionId, number, `part ${part}`);
		}
	}
	return fingerprint;
}

function adoptMessage(db: Database, sessionId: string, fingerprint: string) {
	return __test.adoptPiFallbackTags(
		db,
		sessionId,
		createTagger(),
		new Map([["real", fingerprint]]),
		{ allowUnprovenRebuild: true },
	);
}

function messageRows(db: Database, sessionId: string): unknown[] {
	return db
		.prepare(
			"SELECT tag_number, message_id, status FROM tags WHERE session_id = ? AND type = 'message' ORDER BY message_id",
		)
		.all(sessionId);
}

const REMINDER = "\n<system-reminder>remember the plan</system-reminder>";

for (const transformed of [false, true]) {
	const name = transformed
		? "review 650 r2 finding: a served message whose reminder was stripped must not block its proven survivor"
		: "review 650 r2: a served message identical to its entry apart from the tag proves the survivor";
	test(name, () => {
		const db = createTestDb();
		const sessionId = session(transformed ? "msg-transformed" : "msg-exact");
		try {
			const raw = userMessage(
				`alpha${transformed ? REMINDER : ""}`,
				1700000000000,
			);
			const fingerprint = seedMessageConflict(db, sessionId, raw, 1, {
				real: [MSG_OLD],
				fallback: [MSG_NEW],
			});
			// Last served array: the message carries §440§ and, when transformed,
			// lacks the reminder text (the bytes Pi actually received).
			const served = userMessage(`§${MSG_NEW}§ alpha`, 1700000000000);
			capturePiServedArray(sessionId, [served], {
				servedTagNumbers: [MSG_OLD, MSG_NEW],
			});
			// At the reviewed commit, the served copy without the reminder text makes
			// this adoption throw PiTagIdentityConflictError.
			const outcome = adoptMessage(db, sessionId, fingerprint);
			expect(messageRows(db, sessionId)).toEqual([
				{ tag_number: MSG_NEW, message_id: "real:p0", status: "active" },
			]);
			expect(outcome.rebuilds).toEqual([]);
		} finally {
			db.close();
		}
	});
}

// ---------------------------------------------------------------------------
// Field question (b): a message whose `:pN` parts all have served numbers on
// both identities. Each part is its own repair key; the survivor and repair
// rules must settle every part once and then serve stable bytes.
// ---------------------------------------------------------------------------

function twoPartMessage(): PiMessage {
	return userMessage(
		[
			{ type: "text", text: "alpha" },
			{ type: "text", text: "beta" },
		],
		1700000000000,
	);
}

test("review 650 r2: every served :pN part with a cached array folds to its served number without a rebuild", () => {
	const db = createTestDb();
	const sessionId = session("parts-cached");
	try {
		const raw = twoPartMessage();
		const fingerprint = seedMessageConflict(db, sessionId, raw, 2, {
			real: [10, 11],
			fallback: [30, 31],
		});
		const served = structuredClone(raw) as {
			content: { type: string; text: string }[];
		};
		served.content[0]!.text = "§30§ alpha";
		served.content[1]!.text = "§31§ beta";
		capturePiServedArray(sessionId, [served], {
			servedTagNumbers: [10, 11, 30, 31],
		});
		const outcome = adoptMessage(db, sessionId, fingerprint);
		expect(messageRows(db, sessionId)).toEqual([
			{ tag_number: 30, message_id: "real:p0", status: "active" },
			{ tag_number: 31, message_id: "real:p1", status: "active" },
		]);
		expect(outcome.rebuilds).toEqual([]);
		// Second pass: nothing left to fold, nothing refused.
		expect(adoptMessage(db, sessionId, fingerprint).rebuilds).toEqual([]);
	} finally {
		db.close();
	}
});

test("review 650 r2: every served :pN part without a cached array is repaired once, per part, and then stays settled", () => {
	const db = createTestDb();
	const sessionId = session("parts-missing");
	try {
		const raw = twoPartMessage();
		const fingerprint = seedMessageConflict(db, sessionId, raw, 2, {
			real: [10, 11],
			fallback: [30, 31],
		});
		capturePiServedArray(sessionId, [], {
			servedTagNumbers: [10, 11, 30, 31],
		});
		clearPiServedArraySession(sessionId);
		const outcome = adoptMessage(db, sessionId, fingerprint);
		expect(messageRows(db, sessionId)).toEqual([
			{ tag_number: 30, message_id: "real:p0", status: "active" },
			{ tag_number: 31, message_id: "real:p1", status: "active" },
		]);
		expect(
			outcome.rebuilds.map((r) => [r.key, r.kept, r.removed]).sort(),
		).toEqual([
			[JSON.stringify(["message", "real:p0"]), 30, [10]],
			[JSON.stringify(["message", "real:p1"]), 31, [11]],
		]);
		// The pending rebuild record is acknowledged only by a served pass;
		// another adoption before that re-reports it but folds nothing new.
		const again = adoptMessage(db, sessionId, fingerprint);
		expect(again.rebuilds.map((r) => r.kept).sort()).toEqual([30, 31]);
		expect(readPiIdentityRebuilds(db, sessionId)).toHaveLength(2);
	} finally {
		db.close();
	}
});

test("review 650 r2 finding: a served :pN part whose cached text was transformed must not refuse the whole message", () => {
	// Mixed evidence: part 0 is proven by the cached array, part 1's served
	// text differs (a stripped reminder). At the reviewed commit the whole pass refuses.
	const db = createTestDb();
	const sessionId = session("parts-mixed");
	try {
		const raw = userMessage(
			[
				{ type: "text", text: "alpha" },
				{ type: "text", text: `beta${REMINDER}` },
			],
			1700000000000,
		);
		const fingerprint = seedMessageConflict(db, sessionId, raw, 2, {
			real: [10, 11],
			fallback: [30, 31],
		});
		const served = userMessage(
			[
				{ type: "text", text: "§30§ alpha" },
				{ type: "text", text: "§31§ beta" },
			],
			1700000000000,
		);
		capturePiServedArray(sessionId, [served], {
			servedTagNumbers: [10, 11, 30, 31],
		});
		adoptMessage(db, sessionId, fingerprint);
		expect(messageRows(db, sessionId)).toEqual([
			{ tag_number: 30, message_id: "real:p0", status: "active" },
			{ tag_number: 31, message_id: "real:p1", status: "active" },
		]);
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// Finding 3 (field question a): an event message that no lane can map to a branch entry
// gets `pi-msg-<index>-<timestamp>-<role>`. Message adoption only targets real
// ids, so when that message's index moves (a request-built or custom message
// appears ahead of it, or a compaction removes earlier messages), the guard
// finds its own earlier fallback row under the old index and refuses.
// ---------------------------------------------------------------------------

async function serveUnmapped(shift: boolean) {
	const db = createTestDb();
	const sessionId = session(shift ? "unmapped-shift" : "unmapped-append");
	// Persisted, mapped messages (the branch has exactly these entries).
	const hello = userMessage("hello", 10);
	const reply = assistantMessageText("hi", 11);
	const next = userMessage("next", 12);
	// Present in the context event but not a branch entry (for example an OMP
	// request-built note), so every lane leaves it unmapped.
	const note = userMessage("Context notes: build is green", 5);
	const ctx = fakeContext(
		sessionId,
		process.cwd(),
		["hello", "reply", "next", "later"],
		[hello, reply, next, userMessage("later", 13)],
	);
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const handler = fake.handlers.get("context")!;
	const run = async (messages: PiMessage[]) => {
		try {
			const result = (await handler(
				{ messages: structuredClone(messages) } as never,
				ctx as never,
			)) as { messages: unknown[] };
			return JSON.stringify(result.messages);
		} catch (error) {
			return error instanceof PiTagIdentityConflictError
				? `refused: ${error.message}`
				: `error: ${String(error)}`;
		}
	};
	try {
		const first = await run([note, hello, reply, next]);
		const custom = {
			role: "custom",
			customType: "omp-context",
			content: [{ type: "text", text: "request-built" }],
			display: false,
			timestamp: 4,
		} as unknown as PiMessage;
		const second = await run(
			shift
				? [custom, note, hello, reply, next, userMessage("later", 13)]
				: [note, hello, reply, next, userMessage("later", 13)],
		);
		const noteTag = (json: string) =>
			/§(\d+)§ Context notes/.exec(json)?.[1] ?? "none";
		return { first, second, noteTag };
	} finally {
		db.close();
	}
}

function assistantMessageText(text: string, timestamp: number): PiMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {},
		stopReason: "stop",
		timestamp,
	} as PiMessage;
}

test("review 650 r2: an unmapped message that keeps its index keeps its number across passes", async () => {
	const { first, second, noteTag } = await serveUnmapped(false);
	expect(first.startsWith("[")).toBe(true);
	expect(second.startsWith("[")).toBe(true);
	expect(noteTag(first)).not.toBe("none");
	expect(noteTag(second)).toBe(noteTag(first));
});

test("review 650 r2 finding: an unmapped message whose index shifts must keep its number instead of refusing", async () => {
	const { first, second, noteTag } = await serveUnmapped(true);
	expect(first.startsWith("[")).toBe(true);
	// At the reviewed commit the guard refuses this pass with: "refused: Magic
	// Context message-tag identity conflict: the
	// message's existing entry cannot be safely resolved; ..."
	expect(second.startsWith("[")).toBe(true);
	expect(noteTag(second)).toBe(noteTag(first));
});

// ---------------------------------------------------------------------------
// Finding 4 (field question a), alignment-lane switch: a message whose event content
// differs from its persisted entry (any context-time rewrite) is mapped by the
// positional or header-anchored lane, which compare headers. When a later
// pass falls back to the content-fingerprint lane (here because a custom
// message is emitted at a different position than Pi's projection puts it,
// which makes the anchors out of order), the same message is unmapped, gets a
// `pi-msg-*` id, and the guard refuses on its own real-entry row.
// ---------------------------------------------------------------------------

async function serveLaneSwitch(moveCustom: boolean) {
	const db = createTestDb();
	const sessionId = session(moveCustom ? "lane-switch" : "lane-steady");
	const iso = (ms: number) => new Date(ms).toISOString();
	const u1 = userMessage("first", 1_000);
	const persistedM = userMessage("look at this", 3_000);
	const a1 = assistantMessageText("ok", 4_000);
	const u2 = userMessage("next", 5_000);
	const entries = [
		{ type: "message", id: "u1", message: u1, timestamp: iso(1_000) },
		{
			type: "custom_message",
			id: "note",
			customType: "note",
			content: [{ type: "text", text: "a persisted note" }],
			display: true,
			timestamp: iso(2_000),
		},
		{ type: "message", id: "m", message: persistedM, timestamp: iso(3_000) },
		{ type: "message", id: "a1", message: a1, timestamp: iso(4_000) },
		{ type: "message", id: "u2", message: u2, timestamp: iso(5_000) },
	];
	const custom = {
		role: "custom",
		customType: "note",
		content: [{ type: "text", text: "a persisted note" }],
		display: true,
		timestamp: 2_000,
	} as unknown as PiMessage;
	// The event copy of `m` differs from the persisted entry in content only.
	const eventM = userMessage("look at this [image: 1 attachment]", 3_000);
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
		},
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100_000 }),
	};
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const handler = fake.handlers.get("context")!;
	const run = async (messages: PiMessage[]) => {
		try {
			const result = (await handler(
				{ messages: structuredClone(messages) } as never,
				ctx as never,
			)) as { messages: unknown[] };
			return JSON.stringify(result.messages);
		} catch (error) {
			return error instanceof PiTagIdentityConflictError
				? `refused: ${error.message}`
				: `error: ${String(error)}`;
		}
	};
	try {
		const first = await run([u1, custom, eventM, a1, u2]);
		const second = await run(
			moveCustom ? [u1, eventM, a1, u2, custom] : [u1, custom, eventM, a1, u2],
		);
		const rows = db
			.prepare(
				"SELECT tag_number, message_id FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number",
			)
			.all(sessionId);
		const mTag = (json: string) =>
			/§(\d+)§ look at this/.exec(json)?.[1] ?? "none";
		return { first, second, rows, mTag };
	} finally {
		db.close();
	}
}

test("review 650 r2: a content-rewritten message mapped by header keeps its number while the lane is unchanged", async () => {
	const { first, second, rows, mTag } = await serveLaneSwitch(false);
	expect(first.startsWith("[")).toBe(true);
	expect(second).toBe(first);
	expect(mTag(first)).not.toBe("none");
	expect(rows).toContainEqual({
		tag_number: Number(mTag(first)),
		message_id: "m:p0",
	});
});

test("review 650 r2 finding: a switch to the fingerprint lane must not refuse a message the header lanes already mapped", async () => {
	const { first, second, mTag } = await serveLaneSwitch(true);
	expect(first.startsWith("[")).toBe(true);
	// At the reviewed commit the guard refuses this pass with: "refused: Magic
	// Context message-tag identity conflict: the
	// message's existing entry cannot be safely resolved; ..."
	expect(second.startsWith("[")).toBe(true);
	expect(mTag(second)).toBe(mTag(first));
});

// ---------------------------------------------------------------------------
// Finding 5 (low): the once-guard key embeds the owner id. For an assistant
// that no lane can map, that id is `pi-msg-<index>-<timestamp>-assistant`, so
// the same logical call gets a new key whenever its index moves and can be
// repaired again. A real-entry owner refuses the same recurrence.
// ---------------------------------------------------------------------------

function seedToolDuplicate(
	db: Database,
	sessionId: string,
	number: number,
	owner: string,
): void {
	insertTag(db, sessionId, "call", "tool", 100, number, 0, "bash", 0, owner);
}

function adoptAt(
	db: Database,
	sessionId: string,
	index: number,
	owner: (index: number) => string,
) {
	const messages: PiMessage[] = [];
	for (let n = 0; n < index; n++) messages.push(userMessage(`pad ${n}`, n + 1));
	messages.push(assistantToolCall("call", "bash", {}, 20));
	return __test.adoptPiFallbackTags(db, sessionId, createTagger(), new Map(), {
		allowUnprovenRebuild: true,
		messages,
		resolveStableId: (_message: unknown, at: number) =>
			at === index ? owner(at) : `pad-${at}`,
	});
}

for (const ownerKind of ["real", "unresolved"] as const) {
	// These two tests first asserted a refusal by the once guard. The fix ruled
	// that no identity conflict may refuse more than one turn, so a recurrence
	// after the one repair is now served unmerged and recorded instead; what
	// still matters is that the guard recognises the recurrence (no second
	// rebuild), also when the unresolved owner's index-bearing id moved.
	const name =
		ownerKind === "real"
			? "review 650 r2: a recurring duplicate on a real-entry owner is served without a second rebuild"
			: "review 650 r2 finding: a recurring duplicate on an unresolved owner whose index moved is served without a second rebuild";
	test(name, () => {
		const db = createTestDb();
		const sessionId = session(`guard-${ownerKind}`);
		const owner = (index: number) =>
			ownerKind === "real" ? "real" : `pi-msg-${index}-20-assistant`;
		try {
			// First conflict: no served array in memory, both numbers served.
			seedToolDuplicate(db, sessionId, 8, owner(1));
			seedToolDuplicate(db, sessionId, 154, "pi-msg-7-20-assistant");
			capturePiServedArray(sessionId, [], { servedTagNumbers: [8, 154] });
			clearPiServedArraySession(sessionId);
			expect(adoptAt(db, sessionId, 1, owner).rebuilds).toHaveLength(1);
			// A later writer reintroduces a duplicate for the same call; for the
			// unresolved owner the assistant has meanwhile moved to index 2.
			seedToolDuplicate(db, sessionId, 300, "pi-msg-9-20-assistant");
			capturePiServedArray(sessionId, [], { servedTagNumbers: [300] });
			clearPiServedArraySession(sessionId);
			const second = adoptAt(db, sessionId, 2, owner);
			// Only the first repair (still awaiting a served pass) is reported.
			expect(second.rebuilds.map((repair) => repair.kept)).toEqual([NEWEST]);
			expect(readPiIdentityRecurrences(db, sessionId)).toEqual([
				JSON.stringify(["tool", 20, "call"]),
			]);
			// The recurring row is left as written rather than folded again.
			expect(
				(toolRows(db, sessionId) as { tag_number: number }[]).map(
					(row) => row.tag_number,
				),
			).toEqual([NEWEST, 300]);
		} finally {
			db.close();
		}
	});
}

// ---------------------------------------------------------------------------
// Finding 6 (low): the cache-bust classifier has no class for the new
// `tag_identity_repair` reason; an unmaterialized repair pass is reported as
// an m1 refresh (accounted_soft_m1_execute), a materialized one as a generic
// HARD fold.
// ---------------------------------------------------------------------------

function classify(reason: string, materialized: boolean) {
	return classifyCacheBust({
		divergenceIndex: 5,
		previousMessageCount: 10,
		rewrittenTokens: 500,
		promptTokens: 10_000,
		providerComparableRead: 5_000,
		directInput: 100,
		previousTotal: 10_000,
		decision: {
			timestampMs: 1,
			decision: "execute",
			materialized,
			materializeReason: reason,
			emergency: false,
			droppedTokens: 0,
			droppedCount: 0,
			inputTokens: 10_000,
			flush: false,
			source: "transform_decisions",
		},
	});
}

test("review 650 r2: the classifier names an existing materialize reason it knows", () => {
	expect(classify("model_change", true)).toBe("accounted_hard_model_change");
	// This partner first pinned that a repair pass was filed under classes
	// that do not name it (soft m1 execute, generic hard fold). With the
	// identity-repair class both states now name the repair.
	expect(classify("tag_identity_repair", true)).toBe(
		"accounted_tag_identity_repair",
	);
	expect(classify("model_change", false)).toBe("accounted_soft_m1_execute");
});

test("review 650 r2 finding: an identity-repair pass should get its own cache-bust class", () => {
	expect(classify("tag_identity_repair", false)).toMatch(/identity/);
});

// ---------------------------------------------------------------------------
// Finding 1, third trigger: duplicates whose numbers were never served. No
// served byte is at stake, yet a present (unrelated) served array closes the
// repair path and the explicit "no proven served-byte survivor" refusal fires.
// ---------------------------------------------------------------------------

for (const bodyPresent of [false, true]) {
	const name = bodyPresent
		? "review 650 r2 finding: never-served duplicates must not refuse just because a served array is in memory"
		: "review 650 r2: never-served duplicates with no served array in memory are repaired";
	test(name, () => {
		const db = createTestDb();
		const sessionId = session(bodyPresent ? "unserved-body" : "unserved-none");
		try {
			const raw = userMessage("same identity", 1700000000000);
			const fingerprint = seedMessageConflict(db, sessionId, raw, 1, {
				real: [MSG_OLD],
				fallback: [MSG_NEW],
			});
			if (bodyPresent)
				// The last served array of this process, from before the duplicate
				// message existed; neither candidate number was ever served.
				capturePiServedArray(sessionId, [userMessage("§1§ earlier", 1)], {
					servedTagNumbers: [1],
				});
			// At the reviewed commit, with the array present: PiTagIdentityConflictError
			// ("duplicate message identities have no proven served-byte survivor").
			adoptMessage(db, sessionId, fingerprint);
			expect(messageRows(db, sessionId)).toHaveLength(1);
		} finally {
			db.close();
		}
	});
}
