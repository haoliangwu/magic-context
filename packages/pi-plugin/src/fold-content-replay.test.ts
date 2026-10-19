import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	encodePiContentDecision,
	getPiContentDecisions,
	PI_CONTENT_DECISION_LIMIT,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	clearCachedM0M1,
	getPendingOps,
	getSourceContents,
	getTagsBySession,
	insertTag,
	queuePendingOp,
	updateCavemanDepth,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	hasPendingMaterialization,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

function digest(messages: unknown[]) {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("Pi fold content replay", () => {
	it("consumes a flush on a hard fold and replays the next defer byte-identically", async () => {
		const db = createTestDb();
		const sessionId = "pi-fold-flush-defer";
		const fake = createFakePi();
		const lines: string[] = [];
		const restoreObserver =
			contextHandlerInternals.setPendingDecisionLogObserverForTests((line) =>
				lines.push(line),
			);
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000 },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("covered request", 1),
			assistantMessage("covered answer", 2),
			userMessage("retained request", 3),
			assistantMessage("retained answer", 4),
			userMessage("live tail", 5),
		];
		const ids = ["old", "end", "retained", "ack", "tail"];
		let modelId = "claude-opus-4-1";
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				{
					...fakeContext(sessionId, process.cwd(), ids, messages as never),
					model: { provider: "anthropic", id: modelId, contextWindow: 100_000 },
				},
			);
		};
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "old",
					endMessageId: "end",
					title: "Covered history",
					content: "U: covered request\nA: covered answer",
				},
			]);
			await pass();
			// A model change folds an already served prefix; the flush must ride that fold once.
			const tag = getTagsBySession(db, sessionId).find(
				(candidate) => candidate.messageId === "retained:p0",
			);
			if (!tag) throw new Error("Missing retained request tag");
			queuePendingOp(db, sessionId, tag.tagNumber, "drop");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 20,
				lastInputTokens: 20_000,
			});
			modelId = "claude-sonnet-4";
			signalPiPendingMaterialization(sessionId);
			lines.length = 0;
			const fold = await pass();
			expect(
				lines.filter((line) => line.includes("heuristics WILL RUN")),
			).toEqual([expect.stringContaining("reason=m0_hard_fold")]);
			expect(hasPendingMaterialization(sessionId)).toBe(false);
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
			expect(
				getTagsBySession(db, sessionId).find(
					(row) => row.tagNumber === tag.tagNumber,
				)?.status,
			).toBe("dropped");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				lastContextPercentage: 20,
				lastInputTokens: 20_000,
			});
			lines.length = 0;
			const defer = await pass();
			expect(lines).toContain(
				"heuristics WILL NOT RUN — reason=scheduler_defer",
			);
			expect(digest(defer.messages)).toBe(digest(fold.messages));
		} finally {
			restoreObserver();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("does not discover a reminder strip on defer without a frozen decision", async () => {
		const db = createTestDb();
		const sessionId = "pi-reminder-no-ride";
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: 1,
			lastInputTokens: 100,
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const text =
			"<!-- +9h 30m -->\n<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>";
		const messages = [
			userMessage(text, 1),
			assistantMessage("ack", 2),
			userMessage("tail", 3),
		];
		try {
			const result = await handler(
				{ messages },
				fakeContext(
					sessionId,
					process.cwd(),
					["reminder", "ack", "tail"],
					structuredClone(messages) as never,
				),
			);
			expect(textOf(result.messages[0] as never)).toContain(text);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
	it("replays a partial reminder strip on the next defer with original source intact", async () => {
		const db = createTestDb();
		const sessionId = "pi-fold-reminder";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const original =
			"<system-reminder>\n[BACKGROUND BASH COMPLETED]\n- task bash-fixture (exit 0)\n</system-reminder>";
		const raw = [
			assistantMessage("prior turn", 1000),
			userMessage(original, 34201000),
			assistantMessage("acknowledged", 34202000),
			userMessage("first tail message", 34203000),
		];
		const ids = ["prior", "reminder", "ack", "tail"];
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				fakeContext(sessionId, process.cwd(), ids, messages as never),
			);
		};
		try {
			const fold = await pass();
			const reminder = fold.messages.find((m) =>
				textOf(m as never).includes("+9h 30m"),
			);
			expect(reminder).toBeDefined();
			expect(textOf(reminder as never)).toMatch(/^§\d+§ <!-- \+9h 30m -->$/);
			expect(textOf(reminder as never)).not.toContain("BACKGROUND BASH");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 100,
			});
			const next = await pass();
			expect(digest(next.messages)).toBe(digest(fold.messages));
			clearContextHandlerSession(sessionId);
			expect(digest((await pass()).messages)).toBe(digest(fold.messages));
			const tag = getTagsBySession(db, sessionId).find(
				(t) => t.messageId === "reminder:p0",
			);
			if (!tag) throw new Error("Missing reminder fixture tag");
			expect(
				getSourceContents(db, sessionId, [tag.tagNumber]).get(tag.tagNumber),
			).toContain(original);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("replays a served completion notice before signed thinking across tool and user turns", async () => {
		const db = createTestDb();
		const sessionId = "pi-notice-signed-prefix";
		updateSessionMeta(db, sessionId, { counter: 29104, piStableIdScheme: 1 });
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const notice =
			"<system-reminder>\n[BACKGROUND BASH COMPLETED]\n- task bash-735a32d6db23783c (exit 0)\n    windows-migration / migration (windows-latest): .github#2\n</system-reminder>";
		const raw = [
			assistantMessage("release is still running", 1791820163681),
			userMessage([{ type: "text", text: notice }], 1791820897036),
			assistantMessage("release finished", 1791820917603),
			userMessage(".", 1791909303331),
		];
		const ids = ["7ebdc065", "1537194d", "df83515a", "tail"];
		let latestSignature: string | undefined;
		const pass = async () => {
			const messages = structuredClone(raw);
			const result = await handler(
				{ messages },
				{
					...fakeContext(sessionId, process.cwd(), [...ids], messages as never),
					model: {
						provider: "anthropic",
						id: "claude-opus-5-5",
						contextWindow: 1_000_000,
					},
				},
			);
			if (raw.at(-1)?.role === "toolResult") {
				if (!latestSignature) throw new Error("Missing signed tool turn");
				expect(JSON.stringify(result.messages)).toContain(latestSignature);
			}
			return result.messages.find((message) =>
				textOf(message as never).includes("§29106§"),
			);
		};
		const toolStep = (id: string) => {
			latestSignature = `sig-${id}`;
			raw.push(
				assistantMessage("", 1791909304000 + raw.length, {
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-5-5",
					stopReason: "toolUse",
					content: [
						{
							type: "thinking",
							thinking: "check the release",
							thinkingSignature: `sig-${id}`,
						},
						{
							type: "toolCall",
							id,
							name: "read",
							arguments: { path: "release.log" },
						},
					],
				}),
				toolResultMessage(id, "passed", 1791909305000 + raw.length),
			);
			ids.push(`assistant-${id}`, `result-${id}`);
		};
		try {
			const first = await pass();
			expect(first).toBeDefined();
			expect(textOf(first as never)).toBe("§29106§ <!-- +12m -->");
			expect(getPiContentDecisions(db, sessionId)).toContain(
				encodePiContentDecision("reminder-strip", "1537194d:p0"),
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "never",
				lastInputTokens: 100,
			});
			const served = JSON.stringify(first);
			toolStep("first");
			expect(JSON.stringify(await pass())).toBe(served);
			toolStep("second");
			expect(JSON.stringify(await pass())).toBe(served);
			raw.push(userMessage("continue", 1791909310000));
			ids.push("next-user");
			expect(JSON.stringify(await pass())).toBe(served);
			toolStep("third");
			expect(JSON.stringify(await pass())).toBe(served);
			clearContextHandlerSession(sessionId);
			expect(JSON.stringify(await pass())).toBe(served);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("replays the frozen temporal marker after caveman with no next-pass late trim", async () => {
		const db = createTestDb();
		const sessionId = "pi-fold-temporal";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: { caveman: { enabled: true, minChars: 1 } },
			injection: { injectionBudgetTokens: 10000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("old history", 1000),
			assistantMessage("previous end", 2000),
			userMessage(
				"Can you check this report: a retained user report",
				604802000,
			),
			assistantMessage("checking now", 604803000),
			userMessage("first tail message", 604804000),
		];
		const ids = ["old", "end", "seam", "ack", "tail"];
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				fakeContext(sessionId, process.cwd(), ids, messages as never),
			);
		};
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old",
					endMessageId: "old",
					title: "old",
					content: "old history",
				},
			]);
			await pass();

			const seamTag = getTagsBySession(db, sessionId).find((t) =>
				t.messageId.startsWith("seam"),
			);
			if (!seamTag) throw new Error("Missing seam fixture tag");
			updateCavemanDepth(db, sessionId, seamTag.tagNumber, 1);
			appendCompartments(db, sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "end",
					endMessageId: "end",
					title: "fold",
					content: "previous end",
				},
			]);
			clearCachedM0M1(db, sessionId);
			const fold = await pass();
			expect(textOf(fold.messages[2] as never)).toContain("<!-- +1w -->");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 100,
			});
			const next = await pass();
			expect(digest(next.messages)).toBe(digest(fold.messages));
			clearContextHandlerSession(sessionId);
			expect(digest((await pass()).messages)).toBe(digest(fold.messages));
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("keeps a legacy overwritten reminder byte-stable through defer, defer, restart, then freezes it on one reclaim ride", async () => {
		const db = createTestDb();
		const sessionId = "pi-legacy-reminder-deploy";
		updateSessionMeta(db, sessionId, { counter: 999, piStableIdScheme: 1 });
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const original =
			"<system-reminder>\n[BACKGROUND BASH COMPLETED]\n- task legacy-deploy (exit 0)\n</system-reminder>";
		const raw = [
			assistantMessage("prior", 1_000),
			userMessage(original, 37_801_000),
			assistantMessage("ack", 37_802_000),
			userMessage("tail", 37_803_000),
		];
		const ids = ["prior", "legacy-reminder", "ack", "tail"];
		const pass = async (percentage = 0, reclaimTurn = false) => {
			const messages = structuredClone(raw);
			const passIds = [...ids];
			if (reclaimTurn) {
				messages.push(assistantMessage("reclaim turn ack", 37_804_000));
				messages.push(userMessage("reclaim turn", 37_805_000));
				passIds.push("reclaim-ack", "reclaim-user");
			}
			return handler(
				{ messages },
				{
					...fakeContext(sessionId, process.cwd(), passIds, messages as never),
					getContextUsage: () => ({
						tokens: percentage * 1_000,
						percent: percentage,
						contextWindow: 100_000,
					}),
				},
			);
		};
		try {
			const preDeploy = await pass(70);
			const preDeployReminder = textOf(preDeploy.messages[3] as never);
			expect(preDeployReminder).toMatch(/^§\d+§ <!-- \+10h 30m -->$/);
			expect(preDeployReminder).toHaveLength(24);
			const tag = getTagsBySession(db, sessionId).find(
				(candidate) => candidate.messageId === "legacy-reminder:p0",
			);
			if (!tag) throw new Error("Missing legacy reminder fixture tag");
			db.prepare(
				"UPDATE source_contents SET content = ? WHERE session_id = ? AND tag_id = ?",
			).run(stripTagPrefix(preDeployReminder), sessionId, tag.tagNumber);
			db.prepare(
				"UPDATE session_meta SET merged_reasoning_stripped_ids = '[]' WHERE session_id = ?",
			).run(sessionId);
			expect(getPiContentDecisions(db, sessionId).size).toBe(0);
			updateSessionMeta(db, sessionId, {
				piStableIdScheme: 1,
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 100,
			});
			clearContextHandlerSession(sessionId);

			const firstDefer = await pass();
			const secondDefer = await pass();
			clearContextHandlerSession(sessionId);
			const restartedDefer = await pass();
			const preDeploySha = digest(preDeploy.messages);
			const firstDeferSha = digest(firstDefer.messages);
			const secondDeferSha = digest(secondDefer.messages);
			const restartedDeferSha = digest(restartedDefer.messages);
			console.log(
				`[pi-deploy-transition] pre=${preDeploySha} defer1=${firstDeferSha} defer2=${secondDeferSha} restart=${restartedDeferSha}`,
			);
			expect(firstDeferSha).toBe(preDeploySha);
			expect(secondDeferSha).toBe(preDeploySha);
			expect(restartedDeferSha).toBe(preDeploySha);
			expect(getPiContentDecisions(db, sessionId).size).toBe(0);

			signalPiPendingMaterialization(sessionId);
			const reclaimRide = await pass(70, true);
			const decisionsAfterRide = getPiContentDecisions(db, sessionId);
			expect(decisionsAfterRide).toEqual(
				new Set([
					encodePiContentDecision("reminder-strip", "legacy-reminder:p0"),
				]),
			);
			const frozenDefer = await pass(0, true);
			const rideSha = digest(reclaimRide.messages);
			const frozenSha = digest(frozenDefer.messages);
			console.log(
				`[pi-deploy-transition] reclaim=${rideSha} frozen=${frozenSha}`,
			);
			const reclaimReminder = reclaimRide.messages.find((message) =>
				textOf(message as never).includes("+10h 30m"),
			);
			expect(reclaimReminder).toBeDefined();
			expect(textOf(reclaimReminder as never)).toBe(preDeployReminder);
			expect(frozenSha).toBe(rideSha);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("declines a new reminder strip at the 4096 ledger cap while replaying an existing live strip byte-identically", async () => {
		const db = createTestDb();
		const sessionId = "pi-content-ledger-full";
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage(
				"<!-- +9h 30m -->\n<system-reminder>existing live replay</system-reminder>",
				1,
			),
			assistantMessage("middle", 2),
			userMessage(
				"<!-- +9h 30m -->\n<system-reminder>new cleanup must be declined</system-reminder>",
				3,
			),
			assistantMessage("ack", 4),
			userMessage("tail", 5),
		];
		const ids = ["existing", "middle", "new", "ack", "tail"];
		const pass = async (percentage = 0) => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				{
					...fakeContext(sessionId, process.cwd(), ids, messages as never),
					getContextUsage: () => ({
						tokens: percentage * 1_000,
						percent: percentage,
						contextWindow: 100_000,
					}),
				},
			);
		};
		try {
			await pass();
			const entries = [
				encodePiContentDecision("reminder-strip", "existing:p0"),
			];
			db.transaction(() => {
				for (let index = 1; index < PI_CONTENT_DECISION_LIMIT; index++) {
					const messageId = `ledger-${index}:p0`;
					insertTag(db, sessionId, messageId, "message", 1, 10_000 + index);
					entries.push(encodePiContentDecision("reminder-strip", messageId));
				}
				db.prepare(
					"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
				).run(JSON.stringify(entries), sessionId);
			})();

			signalPiPendingMaterialization(sessionId);
			const bust = await pass(70);
			const bustTexts = bust.messages.map((message) =>
				textOf(message as never),
			);
			const existingServed = bustTexts.find(
				(text) => text.includes("+9h 30m") && !text.includes("new cleanup"),
			);
			const declinedServed = bustTexts.find((text) =>
				text.includes("new cleanup must be declined"),
			);
			expect(existingServed).toBeDefined();
			expect(declinedServed).toBeDefined();
			expect(existingServed).not.toContain("existing live replay");
			expect(declinedServed).toContain("new cleanup must be declined");
			const decisions = getPiContentDecisions(db, sessionId);
			expect(decisions.size).toBe(PI_CONTENT_DECISION_LIMIT);
			expect(
				decisions.has(encodePiContentDecision("reminder-strip", "new:p0")),
			).toBe(false);

			const defer = await pass();
			const deferTexts = defer.messages.map((message) =>
				textOf(message as never),
			);
			const replayedExisting = deferTexts.find(
				(text) => text.includes("+9h 30m") && !text.includes("new cleanup"),
			);
			const replayedDeclined = deferTexts.find((text) =>
				text.includes("new cleanup must be declined"),
			);
			expect(replayedExisting).toBeDefined();
			if (!replayedExisting || !existingServed) {
				throw new Error("Missing served reminder fixture bytes");
			}
			expect(sha256(replayedExisting)).toBe(sha256(existingServed));
			expect(replayedExisting).toBe(existingServed);
			expect(replayedDeclined).toBe(declinedServed);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("keeps an old seam decision inert after a different head is promoted; the new head uses only its own stable-id decision", async () => {
		const db = createTestDb();
		const sessionId = "pi-seam-repromoted-head";
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: { caveman: { enabled: true, minChars: 1 } },
			injection: { injectionBudgetTokens: 10_000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("old history", 1_000),
			assistantMessage("old boundary", 2_000),
			userMessage("old promoted head", 602_000),
			assistantMessage("second boundary", 603_000),
			userMessage("different promoted head", 1_203_000),
			assistantMessage("ack", 1_204_000),
			userMessage("tail", 1_205_000),
		];
		const ids = [
			"old",
			"boundary-1",
			"head-1",
			"boundary-2",
			"head-2",
			"ack",
			"tail",
		];
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				fakeContext(sessionId, process.cwd(), ids, messages as never),
			);
		};
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old",
					endMessageId: "boundary-1",
					title: "first boundary",
					content: "old history",
					p1: "old history",
				},
			]);
			const firstHeadDecision = encodePiContentDecision(
				"seam-temporal-strip",
				"head-1",
			);
			// Model an old version's persisted seam choice, not a newly derived cut.
			db.prepare(
				"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
			).run(JSON.stringify([firstHeadDecision]), sessionId);
			await pass();
			expect(getPiContentDecisions(db, sessionId).has(firstHeadDecision)).toBe(
				true,
			);

			appendCompartments(db, sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "head-1",
					endMessageId: "boundary-2",
					title: "second boundary",
					content: "old promoted head",
					p1: "old promoted head",
				},
			]);
			clearCachedM0M1(db, sessionId);
			const secondFold = await pass();
			const secondHeadDecision = encodePiContentDecision(
				"seam-temporal-strip",
				"head-2",
			);
			const decisions = getPiContentDecisions(db, sessionId);
			expect(decisions.has(firstHeadDecision)).toBe(true);
			expect(decisions.has(secondHeadDecision)).toBe(false);
			const secondFoldHead = secondFold.messages.find((message) =>
				textOf(message as never).includes("different promoted head"),
			);
			expect(secondFoldHead).toBeDefined();
			expect(textOf(secondFoldHead as never)).toContain("<!-- +10m -->");

			db.prepare(
				"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
			).run(JSON.stringify([firstHeadDecision]), sessionId);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 100,
			});
			clearCachedM0M1(db, sessionId);
			clearContextHandlerSession(sessionId);
			const replayFake = createFakePi();
			registerPiContextHandler(replayFake.pi as never, {
				db,
				protectedTags: 0,
				heuristics: { caveman: { enabled: true, minChars: 1 } },
				injection: { injectionBudgetTokens: 10_000, temporalAwareness: false },
			});
			const replayHandler = replayFake.handlers.get("context") as (
				e: { messages: unknown[] },
				ctx: unknown,
			) => Promise<{ messages: unknown[] }>;
			const replayMessages = structuredClone(raw);
			replayMessages[4] = userMessage(
				"<!-- +10m 0s -->\ndifferent promoted head",
				1_203_000,
			);
			const deferWithoutNewDecision = await replayHandler(
				{ messages: replayMessages },
				fakeContext(sessionId, process.cwd(), ids, replayMessages as never),
			);
			const deferHead = deferWithoutNewDecision.messages.find((message) =>
				textOf(message as never).includes("different promoted head"),
			);
			expect(deferHead).toBeDefined();
			expect(textOf(deferHead as never)).toContain("<!-- +10m 0s -->");
			expect(getPiContentDecisions(db, sessionId).has(firstHeadDecision)).toBe(
				true,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
