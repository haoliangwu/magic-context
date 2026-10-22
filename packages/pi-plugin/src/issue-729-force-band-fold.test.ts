// Issue 729 reproduction on Pi (and Oh My Pi, which shares this handler).
//
// One real user message starts a long autonomous turn on Opus 5.5 (a
// prefix-bound thinking model): more than 22 tool steps, each with signed
// thinking, while usage climbs past the 85% force band. The historian
// publishes a compartment over the turn's first steps once the force band is
// reached. Before the bounded hold every pass of the turn was held, so that
// history never reached the prompt until the next real user message. Now the
// first eligible bust folds mid-turn and strips the turn's signed thinking
// once, the following steps replay the new prefix byte for byte, and a later
// bust strips the thinking produced after the fold, even though the turn's
// real user message was summarized away.
import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import { clearPiServedArraySession } from "./served-array-ledger";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const MODEL = "claude-opus-5-5";
const STEPS = 26;
const BULK = "ROW value = compute(input, options); // generated line\n".repeat(
	60,
);

function signatures(messages: unknown[]): string[] {
	return messages.flatMap((message) => {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return [];
		return content
			.filter(
				(part) =>
					(part as { type?: string }).type === "thinking" &&
					typeof (part as { thinkingSignature?: unknown }).thinkingSignature ===
						"string",
			)
			.map((part) =>
				String((part as { thinkingSignature: string }).thinkingSignature),
			);
	});
}

test("Pi: a long signed turn in the force band folds mid-turn, strips its thinking once and then replays", async () => {
	const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
	const sessionId = "pi-issue-729";
	const db = createTestDb();
	try {
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const fake = createFakePi();
		Object.assign(fake.pi, {
			getAllTools: () => [
				{
					name: "bash",
					description: "Run a command",
					parameters: { type: "object" },
				},
			],
			getActiveTools: () => ["bash"],
		});
		registerPiContextHandler(fake.pi as never, {
			db,
			tagger: createTagger(),
			protectedTokens: 2000,
			injection: {
				injectionBudgetTokens: 1000,
				memoryEnabled: false,
				injectDocs: false,
			},
			heuristics: { keepReasoningTokens: 100_000 },
			scheduler: { executeThresholdPercentage: 65 },
		});
		const extra = (content: unknown[]) => ({
			provider: "anthropic",
			model: MODEL,
			api: "anthropic-messages",
			content,
		});
		const source: PiMessage[] = [
			userMessage("earlier task", 1),
			assistantMessage(
				"earlier answer",
				2,
				extra([{ type: "text", text: "earlier answer" }]),
			),
			userMessage("run 26 bash commands", 3),
		];
		const ids = ["u-old", "a-old", "u-task"];
		const step = (n: number) => {
			// A todo continuation every few steps: synthetic, so it does not end
			// the turn.
			if (n % 5 === 4) {
				source.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Continue with the todo list.",
							synthetic: true,
						},
					],
					timestamp: 10 + n * 3,
				} as unknown as PiMessage);
				ids.push(`continue-${n}`);
			}
			source.push(
				assistantMessage(
					"",
					11 + n * 3,
					extra([
						{
							type: "thinking",
							thinking: `step ${n}: run the next command`,
							thinkingSignature: `sig-${n}`,
						},
						{
							type: "toolCall",
							id: `call-${n}`,
							name: "bash",
							arguments: { command: `seq ${n}` },
						},
					]),
				),
				toolResultMessage(`call-${n}`, `${n}\n${BULK}`, 12 + n * 3),
			);
			ids.push(`step-${n}`, `result-${n}`);
		};
		let percent = 47;
		const serve = async () => {
			const messages = structuredClone(source);
			const ctx = {
				...fakeContext(sessionId, process.cwd(), [...ids], messages),
				getSystemPrompt: () => "You are a coding agent.",
				model: {
					provider: "anthropic",
					id: MODEL,
					api: "anthropic-messages",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: percent * 2000,
					percent,
					contextWindow: 200_000,
				}),
			};
			const handler = fake.handlers.get("context")!;
			return (
				(await handler({ messages } as never, ctx as never)) as {
					messages: unknown[];
				}
			).messages;
		};
		const pair = () => {
			const meta = getOrCreateSessionMeta(db, sessionId);
			return `${String(meta.cachedM0Bytes)}\u0000${String(meta.cachedM1Bytes)}`;
		};
		const strips = () =>
			[...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
				id.startsWith("binding_mismatch:step-"),
			).length;

		await serve();
		const served: unknown[][] = [];
		const pairs: string[] = [];
		const stripCounts: number[] = [];
		let published = -1;
		for (let n = 0; n < STEPS; n++) {
			step(n);
			// After the fold the provider reports the smaller prompt.
			percent = published >= 0 ? 60 + (n - published - 1) * 2 : 47 + n * 2;
			if (published < 0 && percent >= 85) {
				appendCompartments(db, sessionId, [
					{
						sequence: 0,
						startMessage: 1,
						endMessage: 5,
						startMessageId: "u-old",
						endMessageId: "step-1",
						title: "earlier work and the first commands",
						content: "U: earlier task\nA: ran the first two commands",
					},
				]);
				signalPiHistoryRefresh(sessionId);
				published = n;
			}
			// A refusal throws here and fails the test.
			served.push(await serve());
			pairs.push(pair());
			stripCounts.push(strips());
		}
		expect(published).toBeGreaterThan(0);

		// The first eligible bust after publication folds mid-turn.
		const fold = pairs.findIndex(
			(value, index) => index > 0 && value !== pairs[index - 1],
		);
		expect(fold).toBe(published);
		const foldWire = JSON.stringify(served[fold]);
		expect(foldWire).not.toContain('"call-0"');
		expect(foldWire).toContain(`"call-${fold}"`);
		// It strips the turn's signed thinking once: every step so far is frozen
		// on that pass, and no signed block is served behind the new head.
		expect(stripCounts[fold - 1]).toBe(0);
		expect(stripCounts[fold]).toBe(fold + 1);
		expect(signatures(served[fold]!)).toEqual([]);

		// The following steps read the new prefix from cache: what the fold pass
		// served is served again byte for byte, and each new step keeps its
		// signed thinking.
		for (let next = fold + 1; next < STEPS; next++) {
			const previous = served[next - 1]!;
			const current = served[next]!;
			expect(JSON.stringify(current.slice(0, previous.length))).toBe(
				JSON.stringify(previous),
			);
			expect(pairs[next]).toBe(pairs[fold]);
			expect(stripCounts[next]).toBe(stripCounts[fold]);
		}
		const kept = signatures(served.at(-1)!);
		expect(kept).toContain(`sig-${STEPS - 1}`);

		// The turn's real user message is now summarized away, yet a later bust
		// (a user flush) still strips every signed block kept since the fold.
		signalPiPendingMaterialization(sessionId, "user_flush");
		const flushed = await serve();
		expect(signatures(flushed)).toEqual([]);
		expect(strips()).toBeGreaterThan(stripCounts.at(-1)!);
	} finally {
		logs.mockRestore();
		clearContextHandlerSession(sessionId);
		clearPiServedArraySession(sessionId);
		db.close();
	}
}, 120_000);
