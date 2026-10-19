import { afterEach, expect, test } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	getPendingOps,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage-ops";
import {
	getSourceContents,
	saveSourceContent,
} from "@magic-context/core/features/magic-context/storage-source";
import {
	adoptPiFallbackMessageTag,
	adoptPiFallbackToolOwnerTag,
	insertTag,
	PiTagIdentityConflictError,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	captureSlot,
	dropSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	__test,
	clearContextHandlerSession,
	collectMessageEntryIdsByRef,
	registerPiContextHandler,
} from "./context-handler";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import {
	capturePiServedArray,
	clearPiServedArraySession,
	flushPiServedArrayLedger,
} from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const source = "ordinary user source ".padEnd(221, "x");
const raw = () => userMessage([{ type: "text", text: source }], 1700000000000);
afterEach(() => resetLkgSlotsForTest());

for (const kind of ["message", "tool"] as const) {
	test(`issue 650 message: shared ${kind} selector refuses allocated duplicates without a serve receipt`, () => {
		const db = createTestDb();
		try {
			for (const number of [20, 440])
				insertTag(
					db,
					"unobserved",
					kind === "tool"
						? "call"
						: `${number === 20 ? "real" : "pi-msg-0-1-user"}:p0`,
					kind,
					1,
					number,
					0,
					null,
					0,
					kind === "tool"
						? number === 20
							? "real"
							: "pi-msg-0-1-assistant"
						: null,
				);
			const before = db.prepare("SELECT * FROM tags ORDER BY tag_number").all();
			expect(() =>
				kind === "tool"
					? adoptPiFallbackToolOwnerTag(
							db,
							"unobserved",
							440,
							"call",
							"pi-msg-0-1-assistant",
							"real",
						)
					: adoptPiFallbackMessageTag(
							db,
							"unobserved",
							440,
							"pi-msg-0-1-user:p0",
							"real:p0",
						),
			).toThrow(PiTagIdentityConflictError);
			expect(
				db.prepare("SELECT * FROM tags ORDER BY tag_number").all(),
			).toEqual(before);
		} finally {
			db.close();
		}
	});
}

test("issue 650 message: pre-compaction fingerprint copies cannot orphan the retained entry", () => {
	const db = createTestDb();
	try {
		const message = raw();
		const branch = [
			{ type: "message", id: "old", message: structuredClone(message) },
			{ type: "message", id: "real", message },
			{ type: "compaction", id: "cut", firstKeptEntryId: "real" },
		];
		const ids = collectMessageEntryIdsByRef(
			{} as never,
			[structuredClone(message)],
			"projection",
			branch,
		);
		expect(ids).toEqual(["real"]);
		const tagger = createTagger();
		insertTag(
			db,
			"projection",
			"real:p0",
			"message",
			233,
			20,
			0,
			null,
			0,
			null,
			piMessageEntryFingerprint(message),
		);
		const transcript = createPiTranscript(
			[structuredClone(message)],
			"projection",
			ids ?? undefined,
		);
		tagTranscript("projection", transcript, tagger, db);
		transcript.commit();
		expect(JSON.stringify(transcript.getOutputMessages())).toContain("§20§");
		expect(db.prepare("SELECT tag_number,message_id FROM tags").all()).toEqual([
			{ tag_number: 20, message_id: "real:p0" },
		]);
	} finally {
		db.close();
	}
});

// First asserted a refusal from the allocation guard. No identity conflict may
// refuse more than one turn, so the guard now reports the unresolved id (the
// pass logs it and allocates) and still guesses no entry.
test("issue 650 message: active duplicate fingerprints are reported instead of guessing an entry", () => {
	const db = createTestDb();
	try {
		const message = raw();
		const branch = ["a", "b"].map((id) => ({
			type: "message",
			id,
			message: structuredClone(message),
		}));
		expect(
			collectMessageEntryIdsByRef(
				{} as never,
				[structuredClone(message)],
				"ambiguous",
				branch,
			),
		).toEqual([undefined]);
		const fingerprint = piMessageEntryFingerprint(message)!;
		insertTag(
			db,
			"ambiguous",
			"real:p0",
			"message",
			233,
			20,
			0,
			null,
			0,
			null,
			fingerprint,
		);
		expect(
			__test.guardPiMessageAllocations(
				db,
				"ambiguous",
				new Map([["pi-msg-0-1700000000000-user", fingerprint]]),
			),
		).toEqual([{ kind: "message", id: "pi-msg-0-1700000000000-user" }]);
		expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({
			n: 1,
		});
	} finally {
		db.close();
	}
});

test("issue 650 message: adoption cannot pick between two real entries sharing a fingerprint", () => {
	const db = createTestDb();
	try {
		const fingerprint = piMessageEntryFingerprint(raw())!;
		insertTag(
			db,
			"targets",
			"pi-msg-0-1700000000000-user:p0",
			"message",
			233,
			440,
			0,
			null,
			0,
			null,
			fingerprint,
		);
		__test.adoptPiFallbackTags(
			db,
			"targets",
			createTagger(),
			new Map([
				["a", fingerprint],
				["b", fingerprint],
			]),
		);
		expect(db.prepare("SELECT message_id FROM tags").get()).toEqual({
			message_id: "pi-msg-0-1700000000000-user:p0",
		});
	} finally {
		db.close();
	}
});

// "both-cached" (440 quoted inside another message's text) and
// "wrong-fingerprint" (the served copy's text differs from the entry) first
// refused here. The cached proof now reads only numbers rendered as tags and
// matches the served message by header, so both prove 20. "both-rendered"
// (440 rendered as another message's leading tag) and "wrong-header" (the
// served copy has another timestamp) keep the refusing side of that proof.
for (const evidence of [
	"sole20",
	"current20",
	"current440",
	"reshape",
	"cold",
	"both-cached",
	"wrong-fingerprint",
	"both-rendered",
	"no-proof",
	"wrong-header",
	"wrong-ordinal",
	"unserved-lkg",
] as const) {
	test(`issue 650 message: ${evidence} recovery preserves the proven number and pending drop`, () => {
		const db = createTestDb();
		const sessionId = `message-${evidence}`;
		try {
			const message =
				evidence === "wrong-ordinal"
					? userMessage(
							[
								{ type: "text", text: "before" },
								{ type: "text", text: source },
							],
							1700000000000,
						)
					: raw();
			const fingerprint = piMessageEntryFingerprint(message)!;
			const ordinal = evidence === "wrong-ordinal" ? 1 : 0;
			for (const number of [20, 440]) {
				insertTag(
					db,
					sessionId,
					`${number === 20 ? "real" : "pi-msg-0-1700000000000-user"}:p${ordinal}`,
					"message",
					233,
					number,
					0,
					null,
					0,
					null,
					fingerprint,
					{ tokenCount: 103, inputTokenCount: null, reasoningTokenCount: null },
				);
				saveSourceContent(db, sessionId, number, source);
			}
			queuePendingOp(db, sessionId, 20, "drop", 100);
			const winner = evidence === "current440" ? 440 : 20;
			const cached = structuredClone(message);
			const content = (cached as { content: { type: string; text: string }[] })
				.content;
			content[0]!.text = `§${winner}§ ${content[0]!.text}`;
			if (evidence === "wrong-fingerprint") content[0]!.text += " edited";
			if (evidence === "wrong-header")
				(cached as { timestamp: number }).timestamp += 1;
			const cachedArray = [
				cached,
				...(evidence === "both-cached" ? [userMessage("quoted §440§")] : []),
				...(evidence === "both-rendered" ? [userMessage("§440§ quoted")] : []),
			];
			if (evidence !== "sole20")
				capturePiServedArray(sessionId, [], { servedTagNumbers: [20, 440] });
			if (evidence !== "no-proof" && evidence !== "unserved-lkg")
				capturePiServedArray(sessionId, cachedArray, {
					servedTagNumbers: [winner],
				});
			if (evidence === "cold" || evidence === "unserved-lkg") {
				captureSlot(sessionId, {
					jsonPrefix: JSON.stringify(cachedArray),
					inputIdSeq: ["real"],
					inputContentDigests: ["raw"],
					lastInputMessageId: "real",
					modelKey: null,
					providerKey: null,
					capturedAt: Date.now(),
				});
				flushPiServedArrayLedger();
				clearPiServedArraySession(sessionId);
			}
			if (evidence === "reshape")
				dropSlot(sessionId, "lkg_invalidated_reshape");
			const before = db.prepare("SELECT * FROM tags ORDER BY tag_number").all();
			const opsBefore = getPendingOps(db, sessionId);
			const tagger = createTagger();
			const adopt = () =>
				__test.adoptPiFallbackTags(
					db,
					sessionId,
					tagger,
					new Map([["real", fingerprint]]),
				);
			if (
				[
					"sole20",
					"current20",
					"current440",
					"reshape",
					"cold",
					"both-cached",
					"wrong-fingerprint",
				].includes(evidence)
			) {
				adopt();
				expect(
					db
						.prepare(
							"SELECT tag_number,message_id,status,byte_size,token_count FROM tags",
						)
						.all(),
				).toEqual([
					{
						tag_number: winner,
						message_id: `real:p${ordinal}`,
						status: "active",
						byte_size: 233,
						token_count: 103,
					},
				]);
				expect(getPendingOps(db, sessionId)).toEqual(
					opsBefore.map((op) => ({ ...op, tagId: winner })),
				);
				expect(getSourceContents(db, sessionId, [20, 440]).get(winner)).toBe(
					source,
				);
				adopt();
				expect(tagger.getTag(sessionId, `real:p${ordinal}`, "message")).toBe(
					winner,
				);
			} else {
				expect(adopt).toThrow(PiTagIdentityConflictError);
				expect(
					db.prepare("SELECT * FROM tags ORDER BY tag_number").all(),
				).toEqual(before);
				expect(getPendingOps(db, sessionId)).toEqual(opsBefore);
				expect(getSourceContents(db, sessionId, [20, 440]).size).toBe(2);
			}
		} finally {
			clearPiServedArraySession(sessionId);
			db.close();
		}
	});
}

test("issue 650 message: repaired queue stays pending across byte-identical defer passes", async () => {
	const db = createTestDb();
	const sessionId = "message-defer";
	try {
		const fingerprint = piMessageEntryFingerprint(raw())!;
		insertTag(
			db,
			sessionId,
			"real:p0",
			"message",
			233,
			20,
			0,
			null,
			0,
			null,
			fingerprint,
		);
		saveSourceContent(db, sessionId, 20, source);
		queuePendingOp(db, sessionId, 20, "drop", 100);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, protectedTokens: 16000 });
		const input = [raw(), userMessage("next", 1700000000001)];
		const ctx = fakeContext(sessionId, process.cwd(), ["real", "next"], input);
		const handler = fake.handlers.get("context")!;
		const pass = async () =>
			(await handler(
				{ messages: structuredClone(input) } as never,
				ctx as never,
			)) as { messages: unknown[] };
		const first = await pass();
		const bytes = JSON.stringify(first.messages);
		capturePiServedArray(sessionId, first.messages, {
			servedTagNumbers: [20, 440],
		});
		insertTag(
			db,
			sessionId,
			"pi-msg-0-1700000000000-user:p0",
			"message",
			233,
			440,
			0,
			null,
			0,
			null,
			fingerprint,
		);
		saveSourceContent(db, sessionId, 440, source);
		dropSlot(sessionId, "lkg_invalidated_reshape");
		for (let n = 0; n < 3; n++)
			expect(JSON.stringify((await pass()).messages)).toBe(bytes);
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([20]);
		expect(
			db
				.prepare("SELECT tag_number FROM tags WHERE entry_fingerprint = ?")
				.all(fingerprint),
		).toEqual([{ tag_number: 20 }]);
	} finally {
		clearContextHandlerSession(sessionId);
		clearPiServedArraySession(sessionId);
		db.close();
	}
});

test("issue 650 message: the host abort notice explains identity conflict rather than storage contention", async () => {
	const fake = createFakePi();
	const entries: { message: string }[] = [];
	const controller = new AbortController();
	const { registerPiGuardedContext } = await import("./pi-context-refusal");
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (_type: string, data: { message: string }) =>
				entries.push(data),
		} as never,
		async () => {
			throw new PiTagIdentityConflictError(
				"Conflicting served Pi message tag numbers",
				"message",
			);
		},
	);
	await fake.handlers.get("context")!(
		{ messages: [raw()] } as never,
		{
			...fakeContext("message-refusal"),
			abort: () => controller.abort(),
		} as never,
	);
	expect(controller.signal.aborted).toBe(true);
	expect(entries[0]?.message).toContain("message-tag identity conflict");
	expect(entries[0]?.message).toContain("resending alone will not repair");
	expect(entries[0]?.message).not.toContain("storage is busy");
	expect(entries[0]?.message).not.toContain("send your message again");
});
