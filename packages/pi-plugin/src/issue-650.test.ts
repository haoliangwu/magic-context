import { afterEach, expect, test } from "bun:test";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import {
	adoptPiFallbackToolOwnerTag,
	insertTag,
	PiTagIdentityConflictError,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	captureSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	__test,
	clearContextHandlerSession,
	collectMessageEntryIdsByRef,
	registerPiContextHandler,
} from "./context-handler";
import { contextHost } from "./pi-context-host.test";
import { registerPiGuardedContext } from "./pi-context-refusal";
import {
	capturePiServedArray,
	clearPiServedArraySession,
	flushPiServedArrayLedger,
} from "./served-array-ledger";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

afterEach(() => {
	resetLkgSlotsForTest();
});

test("issue 650: context-only prose/count edits cannot mint a second served tool tag", () => {
	const db = createTestDb();
	try {
		const call = assistantToolCall(
			"call650",
			"codemode",
			{ code: "console.log(1)" },
			20,
		);
		const result = toolResultMessage("call650", "1", 21);
		const branch = [
			{ type: "message", id: "real", message: call },
			{ type: "message", id: "result", message: result },
		];
		const tagger = createTagger();
		const first = createPiTranscript(structuredClone([call, result]), "repro", [
			"real",
			"result",
		]);
		tagTranscript("repro", first, tagger, db);
		const edited = structuredClone([userMessage("framing"), call, result]);
		(edited[1] as { content: unknown[] }).content.unshift({
			type: "text",
			text: "context-only prose",
		});
		const ids = collectMessageEntryIdsByRef(
			{} as never,
			edited,
			"repro",
			branch,
		)!;
		expect(ids[1]).toBe("real");
		const transcript = createPiTranscript(edited, "repro", ids);
		tagTranscript("repro", transcript, tagger, db);
		transcript.commit();
		expect(
			db
				.prepare(
					"SELECT tag_number, tool_owner_message_id FROM tags WHERE type = 'tool'",
				)
				.all(),
		).toEqual([{ tag_number: 1, tool_owner_message_id: "real" }]);
		expect(JSON.stringify(transcript.getOutputMessages()[2])).toContain(
			"§1§ 1",
		);
	} finally {
		db.close();
	}
});

test("issue 650: drifting unresolved fallback index adopts the served number", () => {
	const db = createTestDb();
	const sessionId = "650-drift";
	try {
		insertTag(
			db,
			sessionId,
			"call",
			"tool",
			8,
			8,
			0,
			"bash",
			0,
			"pi-msg-0-20-assistant",
		);
		capturePiServedArray(sessionId, [toolResultMessage("call", "§8§ result")], {
			servedTagNumbers: [8],
		});
		const tagger = createTagger();
		__test.adoptPiFallbackTags(db, sessionId, tagger, new Map(), {
			messages: [assistantToolCall("call", "bash", {}, 20)],
			resolveStableId: () => "pi-msg-3-20-assistant",
		});
		expect(
			tagger.assignToolTag(sessionId, "call", "pi-msg-3-20-assistant", 8, db),
		).toBe(8);
		expect(db.prepare("SELECT tag_number FROM tags").all()).toEqual([
			{ tag_number: 8 },
		]);
	} finally {
		clearPiServedArraySession(sessionId);
		db.close();
	}
});

for (const evidence of [
	"one",
	"historical-both",
	"restart",
	"both-cached",
	"missing",
	"unserved-lkg",
	"wrong-call",
	"wrong-status",
] as const) {
	test(`issue 650: reporter-shaped conflict ${evidence} repairs only proven cached bytes`, () => {
		const db = createTestDb();
		const sessionId = `650-repair-${evidence}`;
		try {
			insertTag(
				db,
				sessionId,
				"call",
				"tool",
				100,
				8,
				0,
				"codemode",
				40,
				"real",
			);
			updateTagStatus(db, sessionId, 8, "dropped");
			insertTag(
				db,
				sessionId,
				"call",
				"tool",
				100,
				154,
				0,
				"codemode",
				40,
				"pi-msg-0-20-assistant",
			);
			const cached = [
				assistantToolCall(
					evidence === "wrong-call" ? "other" : "call",
					"codemode",
					{ __magic_context_dropped__: true },
					20,
				),
				toolResultMessage(
					"call",
					evidence === "wrong-status" ? "§8§ active" : "[dropped §8§]",
					21,
				),
			];
			if (evidence === "both-cached") cached.push(userMessage("§154§"));
			const before = JSON.stringify(cached);
			if (evidence !== "one")
				capturePiServedArray(sessionId, [], { servedTagNumbers: [8, 154] });
			if (evidence !== "missing") {
				captureSlot(sessionId, {
					jsonPrefix: before,
					inputIdSeq: ["real", "result"],
					inputContentDigests: ["a", "b"],
					lastInputMessageId: "result",
					modelKey: null,
					providerKey: null,
					capturedAt: Date.now(),
				});
				if (evidence !== "unserved-lkg")
					capturePiServedArray(sessionId, cached, { servedTagNumbers: [8] });
			}
			if (evidence === "restart") {
				flushPiServedArrayLedger();
				clearPiServedArraySession(sessionId);
			}
			const tagger = createTagger();
			const adopt = () =>
				__test.adoptPiFallbackTags(db, sessionId, tagger, new Map(), {
					messages: [assistantToolCall("call", "codemode", {}, 20)],
					resolveStableId: () => "real",
				});
			if (["one", "historical-both", "restart"].includes(evidence)) {
				adopt();
				expect(
					db
						.prepare(
							"SELECT tag_number, status, tool_owner_message_id FROM tags",
						)
						.all(),
				).toEqual([
					{ tag_number: 8, status: "dropped", tool_owner_message_id: "real" },
				]);
				adopt();
				expect(tagger.assignToolTag(sessionId, "call", "real", 100, db)).toBe(
					8,
				);
			} else {
				const rowsBefore = db
					.prepare("SELECT * FROM tags ORDER BY tag_number")
					.all();
				expect(adopt).toThrow(PiTagIdentityConflictError);
				expect(
					db.prepare("SELECT * FROM tags ORDER BY tag_number").all(),
				).toEqual(rowsBefore);
			}
			expect(JSON.stringify(cached)).toBe(before);
		} finally {
			clearPiServedArraySession(sessionId);
			db.close();
		}
	});
}

test("issue 650: recovery and subsequent defer passes replay identical dropped tool bytes", async () => {
	const db = createTestDb();
	const sessionId = "650-defer";
	const fake = createFakePi();
	try {
		insertTag(db, sessionId, "call", "tool", 100, 8, 0, "codemode", 40, "real");
		updateTagStatus(db, sessionId, 8, "dropped");
		registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
		const input = [
			userMessage("first"),
			assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
			toolResultMessage("call", "large result", 21),
			userMessage("next", 22),
		];
		(input[1] as { content: unknown[] }).content.unshift({
			type: "thinking",
			thinking: "signed thought",
			thinkingSignature: "sig",
		});
		const ctx = fakeContext(
			sessionId,
			process.cwd(),
			["first", "real", "result", "next"],
			input,
		);
		const handler = fake.handlers.get("context")!;
		const first = (await handler(
			{ messages: structuredClone(input) } as never,
			ctx as never,
		)) as { messages: unknown[] };
		await new Promise((resolve) => setImmediate(resolve));
		const bytes = JSON.stringify(first.messages);
		expect(bytes).toContain("[dropped §8§]");
		capturePiServedArray(sessionId, first.messages, {
			servedTagNumbers: [8, 154],
		});
		insertTag(
			db,
			sessionId,
			"call",
			"tool",
			100,
			154,
			0,
			"codemode",
			40,
			"pi-msg-1-20-assistant",
		);
		for (let n = 0; n < 3; n++) {
			const pass = (await handler(
				{ messages: structuredClone(input) } as never,
				ctx as never,
			)) as { messages: unknown[] };
			expect(JSON.stringify(pass.messages)).toBe(bytes);
		}
		expect(
			db
				.prepare("SELECT tag_number,status FROM tags WHERE type = 'tool'")
				.all(),
		).toEqual([{ tag_number: 8, status: "dropped" }]);
	} finally {
		clearContextHandlerSession(sessionId);
		clearPiServedArraySession(sessionId);
		db.close();
	}
});

// The two guard tests below first asserted a refusal. No identity conflict may
// refuse more than one turn, so the guard now reports the allocation it cannot
// tie to an existing tag (the pass logs it and tags as before the guard
// existed) and writes nothing itself.
test("issue 650: unresolved existing owner is reported instead of refusing", () => {
	const db = createTestDb();
	try {
		insertTag(db, "guard", "call", "tool", 1, 8, 0, "bash", 0, "real");
		expect(
			__test.guardPiToolAllocations(
				db,
				"guard",
				[assistantToolCall("call", "bash", {}, 20)],
				() => "pi-msg-0-20-assistant",
			),
		).toEqual([{ kind: "tool", id: "pi-msg-0-20-assistant/call" }]);
		expect(db.prepare("SELECT COUNT(*) AS count FROM tags").get()).toEqual({
			count: 1,
		});
	} finally {
		db.close();
	}
});

test("issue 650: ambiguous or timestamp-less fallback evidence is reported for a real-owner allocation", () => {
	const db = createTestDb();
	try {
		insertTag(
			db,
			"ambiguous",
			"call",
			"tool",
			1,
			8,
			0,
			"bash",
			0,
			"pi-msg-0-assistant",
		);
		expect(
			__test.guardPiToolAllocations(
				db,
				"ambiguous",
				[assistantToolCall("call", "bash", {}, 20)],
				() => "real",
			),
		).toEqual([{ kind: "tool", id: "real/call" }]);
		expect(db.prepare("SELECT COUNT(*) AS count FROM tags").get()).toEqual({
			count: 1,
		});
	} finally {
		db.close();
	}
});

test("issue 650: distinct real owners may still reuse a call id", () => {
	const db = createTestDb();
	try {
		insertTag(db, "reuse", "call", "tool", 1, 8, 0, "bash", 0, "real-first");
		__test.guardPiToolAllocations(
			db,
			"reuse",
			[assistantToolCall("call", "bash", {}, 30)],
			() => "real-second",
		);
		const tagger = createTagger();
		expect(
			tagger.assignToolTag("reuse", "call", "real-second", 1, db),
		).not.toBe(8);
	} finally {
		db.close();
	}
});

test("issue 650: a dropped duplicate must not change served active survivor bytes", () => {
	const db = createTestDb();
	try {
		insertTag(db, "status-guard", "call", "tool", 1, 8, 0, "bash", 0, "real");
		updateTagStatus(db, "status-guard", 8, "dropped");
		insertTag(
			db,
			"status-guard",
			"call",
			"tool",
			1,
			154,
			0,
			"bash",
			0,
			"pi-msg-0-20-assistant",
		);
		adoptPiFallbackToolOwnerTag(
			db,
			"status-guard",
			154,
			"call",
			"pi-msg-0-20-assistant",
			"real",
			new Set([154]),
		);
		expect(db.prepare("SELECT tag_number,status FROM tags").all()).toEqual([
			{ tag_number: 154, status: "active" },
		]);
		expect(getPendingOps(db, "status-guard").map((op) => op.tagId)).toEqual([
			154,
		]);
	} finally {
		db.close();
	}
});

test("issue 650: identity refusal aborts the real host hook without storage-busy or resend advice", async () => {
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
			throw new PiTagIdentityConflictError(
				"Conflicting served Pi tool tag numbers",
			);
		},
	);
	const input = [userMessage("hello")];
	await host.emit(handler, input, {
		sessionManager: { getSessionId: () => "650-refusal" },
	});
	expect(host.controller.signal.aborted).toBe(true);
	const message = (host.entries[0]!.data as { message: string }).message;
	expect(message).toContain("tool-tag identity conflict");
	expect(message).toContain("resending alone will not repair");
	expect(message).not.toContain("storage is busy");
	expect(message).not.toContain("send your message again");
});
