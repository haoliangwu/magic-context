import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
	getStrippedPlaceholderIds,
	getTagsBySession,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyFlushedStatuses } from "@magic-context/core/hooks/magic-context/apply-operations";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const callId = "call_01a13701|fc_01a13701";
const dropped = () => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "bash",
	content: [{ type: "text", text: "[dropped §6192§]" }],
	isError: false,
	timestamp: 3,
});
const call = () =>
	assistantMessage("", 2, {
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "bash",
				arguments: { command: "printf output" },
			},
		],
	});
const fixture = () => [
	userMessage("keep", 1),
	dropped(),
	userMessage("next", 4),
];

describe("issue 686 dropped tool results", () => {
	test("ordinary passes with no orphan never load active or legacy tool facts", async () => {
		const db = createTestDb();
		const sessionId = "ordinary-no-orphan-facts";
		const query = spyOn(db, "prepare");
		let factLoads = 0;
		let activeReads = 0;
		let legacyReads = 0;
		const getToolDropFacts = () => {
			factLoads++;
			return {
				get active() {
					activeReads++;
					return false;
				},
				get legacyDroppedTag() {
					legacyReads++;
					return 6192;
				},
			};
		};
		const factQueries = () =>
			query.mock.calls.filter(([sql]) =>
				sql.includes("MAX(status = 'active')"),
			);
		try {
			for (const flags of [
				{ isCacheBusting: false },
				{ isCacheBusting: true },
				{ isCacheBusting: false, retireOrphansBeforeRefusal: true },
			]) {
				const messages = [
					userMessage("keep", 1),
					call(),
					dropped(),
					userMessage("next", 4),
				];
				stripPiDroppedPlaceholderMessages({
					db,
					sessionId,
					messages,
					getToolDropFacts,
					...flags,
				});
			}
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context") as unknown as (
				event: { messages: unknown[] },
				ctx: unknown,
			) => Promise<unknown>;
			const raw = [
				userMessage("keep", 1),
				call(),
				{ ...dropped(), content: [{ type: "text", text: "real output" }] },
				userMessage("next", 4),
			];
			for (let i = 0; i < 3; i++) {
				const messages = structuredClone(raw);
				await handler(
					{ messages },
					{
						...fakeContext(
							sessionId,
							process.cwd(),
							["u", "call", "result", "next"],
							messages as never,
						),
						model: { api: "openai-responses", provider: "mock", id: "mock" },
					},
				);
			}
			expect(factLoads).toBe(0);
			expect(activeReads).toBe(0);
			expect(legacyReads).toBe(0);
			expect(factQueries()).toHaveLength(0);
		} finally {
			query.mockRestore();
			clearContextHandlerSession(sessionId);
			db.close();
		}
	});

	test("orphan facts use one indexed lookup per distinct call ID", () => {
		const db = createTestDb();
		const query = spyOn(db, "prepare");
		try {
			const messages = [
				userMessage("keep", 1),
				{
					...dropped(),
					content: [{ type: "text", text: "first real output" }],
				},
				{
					...dropped(),
					timestamp: 4,
					content: [{ type: "text", text: "second real output" }],
				},
			];
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "indexed-orphan",
				messages,
				isCacheBusting: false,
			});
			const lookups = query.mock.calls.filter(([sql]) =>
				sql.includes("MAX(status = 'active')"),
			);
			expect(lookups).toHaveLength(1);
			const plan = db
				.query(`EXPLAIN QUERY PLAN ${lookups[0][0]}`)
				.all("indexed-orphan", callId) as { detail: string }[];
			expect(
				plan.some((row) =>
					row.detail.includes(
						"idx_tags_session_message_id (session_id=? AND message_id=?)",
					),
				),
			).toBe(true);
		} finally {
			query.mockRestore();
			db.close();
		}
	});

	test("legacy truncated replay does not placeholder an incomplete tool arc", () => {
		const db = createTestDb();
		const sessionId = "legacy-incomplete";
		try {
			for (const messages of [
				[call(), userMessage("next", 4)],
				[
					userMessage("keep", 1),
					{ ...dropped(), content: [{ type: "text", text: "real output" }] },
				],
			]) {
				const tagger = createTagger();
				tagger.initFromDb(sessionId, db);
				const transcript = createPiTranscript(messages, sessionId);
				const { targets } = tagTranscript(sessionId, transcript, tagger, db);
				for (const tag of getTagsBySession(db, sessionId)) {
					if (tag.type !== "tool") continue;
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					updateTagDropMode(db, sessionId, tag.tagNumber, "truncated");
				}
				const before = JSON.stringify(transcript.getWorkingMessages());
				applyFlushedStatuses(sessionId, db, targets);
				transcript.commit();
				transcript.finalizeToolRemovals();
				expect(JSON.stringify(messages)).toBe(before);
			}
		} finally {
			db.close();
		}
	});

	test("row 312 orphan placeholder retires before a refusing dispatch and freezes once", () => {
		const db = createTestDb();
		try {
			const messages = fixture();
			const snapshot = piPreparedStructure(messages);
			const wire = {
				input: [
					{ role: "user", content: "keep" },
					{
						role: "user",
						content: `<stale-tool-result tool="bash" id="${callId}">\n[dropped §6192§]\n</stale-tool-result>`,
					},
					{ role: "user", content: "next" },
				],
			};
			expect(piMatchesPreparedStructure(wire, snapshot)).toBe(false);
			expect(
				stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "row-312",
					messages,
					isCacheBusting: false,
					retireOrphansBeforeRefusal: true,
				}),
			).toEqual({ removed: 1, discovered: 1 });
			expect(messages).toEqual([
				userMessage("keep", 1),
				userMessage("next", 4),
			]);
			expect(getStrippedPlaceholderIds(db, "row-312").size).toBe(1);
			expect(
				piMatchesPreparedStructure(
					{
						input: [wire.input[0], wire.input[2]],
					},
					piPreparedStructure(messages),
				),
			).toBe(true);
		} finally {
			db.close();
		}
	});

	test("Chat retirement waits for an existing bust", () => {
		const db = createTestDb();
		try {
			const args = { db, sessionId: "chat-cache", isCacheBusting: false };
			const messages = fixture();
			const before = JSON.stringify(messages);
			expect(stripPiDroppedPlaceholderMessages({ ...args, messages })).toEqual({
				removed: 0,
				discovered: 0,
			});
			expect(JSON.stringify(messages)).toBe(before);
			expect(
				stripPiDroppedPlaceholderMessages({
					...args,
					messages,
					canFirstApply: true,
				}),
			).toEqual({ removed: 1, discovered: 1 });
		} finally {
			db.close();
		}
	});

	test("retirement never takes real results or paired placeholders", () => {
		const db = createTestDb();
		try {
			const results = [
				{ ...dropped(), content: [{ type: "text", text: "real output" }] },
				{
					...dropped(),
					content: [
						...dropped().content,
						{ type: "text", text: "real output" },
					],
				},
				dropped(),
			];
			const messages = [userMessage("keep", 1), call(), ...results];
			const before = JSON.stringify(messages);
			expect(
				stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "keep-pairs",
					messages,
					isCacheBusting: true,
					retireOrphansBeforeRefusal: true,
				}),
			).toEqual({ removed: 0, discovered: 0 });
			expect(JSON.stringify(messages)).toBe(before);
			const prepared = piPreparedStructure([call(), dropped()]);
			expect(prepared?.messages.map((row) => row.role)).toEqual([
				"assistant",
				"toolResult",
			]);
			expect(
				piMatchesPreparedStructure(
					{
						messages: [
							{ role: "assistant", tool_calls: [{ id: callId }] },
							{ role: "user", content: "[dropped §6192§]" },
						],
					},
					prepared,
				),
			).toBe(false);
		} finally {
			db.close();
		}
	});

	test("active real orphan results and mixed placeholders remain results and mismatches refuse", () => {
		const db = createTestDb();
		try {
			for (const result of [
				{ ...dropped(), content: [{ type: "text", text: "real output" }] },
				{
					...dropped(),
					content: [
						...dropped().content,
						{ type: "text", text: "real output" },
					],
				},
			]) {
				const messages = [
					userMessage("keep", 1),
					result,
					userMessage("next", 4),
				];
				const before = JSON.stringify(messages);
				expect(
					stripPiDroppedPlaceholderMessages({
						db,
						sessionId: "active-orphan",
						messages,
						isCacheBusting: true,
						retireOrphansBeforeRefusal: true,
					}),
				).toEqual({ removed: 0, discovered: 0 });
				expect(JSON.stringify(messages)).toBe(before);
				const prepared = piPreparedStructure(messages);
				expect(prepared?.messages[1].role).toBe("toolResult");
				expect(
					piMatchesPreparedStructure(
						{
							messages: [
								{ role: "user", content: "keep" },
								{ role: "user", content: "real output" },
								{ role: "user", content: "next" },
							],
						},
						prepared,
					),
				).toBe(false);
			}
		} finally {
			db.close();
		}
	});

	test("legacy orphan Chat replay keeps master bytes until a bust and paired legacy tags stay paired", () => {
		const db = createTestDb();
		try {
			const real = {
				...dropped(),
				content: [{ type: "text", text: "pristine output" }],
			};
			const messages = [userMessage("keep", 1), real, userMessage("next", 4)];
			const args = {
				db,
				sessionId: "legacy-chat",
				getToolDropFacts: () => ({ active: false, legacyDroppedTag: 6192 }),
				isCacheBusting: false,
			};
			expect(stripPiDroppedPlaceholderMessages({ ...args, messages })).toEqual({
				removed: 0,
				discovered: 0,
			});
			expect(messages).toEqual(fixture());
			expect(real.content[0].text).toBe("pristine output");
			expect(
				stripPiDroppedPlaceholderMessages({
					...args,
					messages,
					canFirstApply: true,
				}),
			).toEqual({ removed: 1, discovered: 1 });
			const paired = [call(), dropped()];
			const before = JSON.stringify(paired);
			expect(
				stripPiDroppedPlaceholderMessages({
					...args,
					messages: paired,
					retireOrphansBeforeRefusal: true,
				}),
			).toEqual({ removed: 0, discovered: 0 });
			expect(JSON.stringify(paired)).toBe(before);
		} finally {
			db.close();
		}
	});

	test("an explicitly restored active result overrides a frozen orphan retirement", () => {
		const db = createTestDb();
		try {
			const args = {
				db,
				sessionId: "expanded-orphan",
				isCacheBusting: false,
				retireOrphansBeforeRefusal: true,
			};
			stripPiDroppedPlaceholderMessages({ ...args, messages: fixture() });
			const restored = [
				userMessage("keep", 1),
				{
					...dropped(),
					content: [{ type: "text", text: "restored real output" }],
				},
				userMessage("next", 4),
			];
			const before = JSON.stringify(restored);
			expect(
				stripPiDroppedPlaceholderMessages({
					...args,
					messages: restored,
					getToolDropFacts: () => ({ active: true }),
				}),
			).toEqual({ removed: 0, discovered: 0 });
			expect(JSON.stringify(restored)).toBe(before);
		} finally {
			db.close();
		}
	});

	test("restored JSONL legacy orphan heals once and frozen replay survives ten passes and restart", async () => {
		const { dir: directory, cleanup } = createTestTempDir("mc-dropped-result-");
		const path = join(directory, "context.db");
		const sessionId = "restored-jsonl-orphan";
		let db = createTestDb(path);
		const raw = [
			userMessage("keep", 1),
			{
				...dropped(),
				content: [{ type: "text", text: "pristine bash output" }],
			},
			userMessage("next", 4),
		];
		const ids = ["original-user", "original-result", "next-user"];
		const seedTagger = createTagger();
		seedTagger.initFromDb(sessionId, db);
		tagTranscript(
			sessionId,
			createPiTranscript(structuredClone(raw), sessionId, ids),
			seedTagger,
			db,
		);
		const tag = getTagsBySession(db, sessionId).find(
			(row) => row.type === "tool",
		);
		expect(tag).toBeDefined();
		if (!tag) throw new Error("fixture has no tool tag");
		updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
		updateTagDropMode(db, sessionId, tag.tagNumber, "truncated");
		const install = () => {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			return fake.handlers.get("context") as unknown as (
				event: { messages: unknown[] },
				ctx: unknown,
			) => Promise<{ messages: unknown[] }>;
		};
		let handler = install();
		const pass = async () => {
			const messages = structuredClone(raw);
			return (
				await handler(
					{ messages },
					{
						...fakeContext(sessionId, directory, ids, messages as never),
						model: {
							api: "openai-responses",
							provider: "openai",
							id: "mock-model",
						},
					},
				)
			).messages;
		};
		try {
			const first = await pass();
			expect(
				first.some(
					(message) => (message as { role?: string }).role === "toolResult",
				),
			).toBe(false);
			expect(getStrippedPlaceholderIds(db, sessionId)).toEqual(
				new Set(["original-result"]),
			);
			const bytes = JSON.stringify(first);
			for (let i = 0; i < 10; i++)
				expect(JSON.stringify(await pass())).toBe(bytes);
			clearContextHandlerSession(sessionId);
			db.close();
			db = createTestDb(path);
			handler = install();
			expect(JSON.stringify(await pass())).toBe(bytes);
			expect(getStrippedPlaceholderIds(db, sessionId)).toEqual(
				new Set(["original-result"]),
			);
		} finally {
			clearContextHandlerSession(sessionId);
			db.close();
			cleanup();
		}
	});
});
