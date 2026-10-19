import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { clearWindowGeometryLogForTest } from "@magic-context/core/shared/window-geometry";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { persistPiPressureFromMessageEnd } from "./index";
import { computePiPressure, MAX_UNKNOWN_PI_INPUT_TOKENS } from "./pi-pressure";
import {
	recordPiProvenFloorModel,
	resolvePiProvenInputFloor,
} from "./pi-proven-floor";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const MODEL = {
	provider: "cursor",
	id: "grok-4.7",
	contextWindow: 256_000,
	maxTokens: 32_000,
};
const KEY = "cursor/grok-4.7";
// One usage record per assistant message, not a sum made by this test or MC.
const TURNS = [
	{
		id: "ae38d198",
		input: 427_711,
		cacheRead: 6_097_536,
		output: 87_698,
		contextTokens: 211_039,
	},
	{
		id: "578d2c9e",
		input: 100_479,
		cacheRead: 268_288,
		output: 3_906,
		contextTokens: 55_472,
	},
	{
		id: "df744803",
		input: 232_989,
		cacheRead: 467_584,
		output: 2_579,
		contextTokens: 703_152,
	},
	{
		id: "3710a742",
		input: 271_426,
		cacheRead: 1_302_016,
		output: 15_568,
		contextTokens: 102_597,
	},
];

function reply(usage: object) {
	return assistantMessage("done", 10, {
		provider: MODEL.provider,
		model: MODEL.id,
		stopReason: "stop",
		usage,
	});
}

function setup(sessionId: string) {
	const db = createTestDb();
	const logs: string[] = [];
	spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
		logs.push(parts.map(String).join(" "));
	});
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1, cacheTtl: "59m" });
	const fake = createFakePi();
	recordPiLiveModel(sessionId, KEY);
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 80 },
	});
	const messages = [
		userMessage("start", 1),
		assistantMessage("previous request", 2),
		userMessage("continue", 3),
	];
	const run = async (tokens?: number) => {
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["a", "b", "c"], messages),
			model: MODEL,
			getContextUsage: () => ({
				tokens,
				percent: (tokens ?? 0) / 2560,
				contextWindow: 256_000,
			}),
		};
		const handler = fake.handlers.get("context") as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		await handler({ messages: structuredClone(messages) }, ctx);
		await awaitInFlightHistorians();
	};
	const end = (usage: object, tokens?: number) =>
		persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message: reply(usage),
			piContextWindow: 256_000,
			piContextWindowSource: "observed",
			piModel: MODEL,
			piTokens: tokens,
		});
	return { db, logs, run, end };
}

afterEach(() => {
	mock.restore();
	clearWindowGeometryLogForTest();
});

describe("Pi/OMP turn-aggregate usage (issue 636)", () => {
	it.each(
		TURNS,
	)("rejects the single-message billing input for turn $id", async (turn) => {
		const sessionId = `ses-aggregate-${turn.id}`;
		const { db, logs, run, end } = setup(sessionId);
		try {
			await run(1_000);
			await end(turn, turn.contextTokens);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.observedSafeInputTokens).toBe(0);
			expect(meta.lastUsageContextLimit).toBe(224_000);
			expect(meta.lastInputTokens).toBe(
				turn.contextTokens <= 256_000 ? turn.contextTokens : 0,
			);
			expect(computePiPressure(turn, 224_000, 256_000)).toBeNull();
			const passTokens =
				turn.contextTokens <= MODEL.contextWindow ? turn.contextTokens : 1_000;
			await run(passTokens);
			await run(passTokens);
			const passes = logs.filter((line) =>
				line.startsWith("transform: usage="),
			);
			expect(passes.some((line) => line.includes("EMERGENCY=true"))).toBe(
				false,
			);
			expect(
				passes.some((line) =>
					line.includes(`${turn.input + turn.cacheRead} tokens`),
				),
			).toBe(false);
			expect(
				logs.filter((line) =>
					line.includes("provider_usage_not_single_request"),
				),
			).toHaveLength(1);
			if (turn.contextTokens === 211_039) {
				expect(
					passes.some((line) =>
						line.includes(
							"usage=94.2% (211039 tokens, limit=224000) decision=execute",
						),
					),
				).toBe(true);
			}
			if (turn.contextTokens > MODEL.contextWindow) {
				// Pi's 703K contextTokens value estimates the whole branch, not one
				// request. Use a safe host reading here to isolate whether the provider's
				// turn-total billing counters are mistaken for single-request usage.
				expect(passes.at(-1)).toContain("decision=defer");
			}
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("ordinary measured input still executes near the window and enters emergency at 250K", async () => {
		const sessionId = "ses-aggregate-normal-control";
		const { db, logs, run, end } = setup(sessionId);
		try {
			await run(1_000);
			await end({ input: 185_000, cacheRead: 0, output: 100 }, 185_000);
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(185_000);
			await run(185_000);
			expect(
				logs.some((line) =>
					line.includes(
						"usage=82.6% (185000 tokens, limit=224000) decision=execute",
					),
				),
			).toBe(true);
			expect(logs.some((line) => line.includes("EMERGENCY=true"))).toBe(false);
			await end({ input: 250_000, cacheRead: 0, output: 100 }, 250_000);
			await run(250_000);
			expect(logs.some((line) => line.includes("EMERGENCY=true"))).toBe(true);
			expect(
				logs.some((line) => line.includes("provider_usage_not_single_request")),
			).toBe(false);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("tokenizes the outgoing request when aggregate usage has no usable host fallback", async () => {
		const sessionId = "ses-aggregate-no-host-fallback";
		const { db, logs, run, end } = setup(sessionId);
		try {
			await run(1_000);
			await end(TURNS[0]);
			await run();
			const pass = logs
				.filter((line) => line.startsWith("transform: usage="))
				.at(-1);
			expect(pass).toContain("decision=defer");
			expect(pass).not.toContain("(0 tokens");
			expect(pass).not.toContain("6525247 tokens");
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(0);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("legacy and marked floors cannot adopt aggregate usage from branch history", () => {
		const db = createTestDb();
		const sessionId = "ses-aggregate-floor";
		try {
			for (const marked of [false, true]) {
				updateSessionMeta(db, sessionId, {
					observedSafeInputTokens: 6_525_247,
				});
				if (marked) recordPiProvenFloorModel(db, sessionId, KEY, 6_525_247);
				else
					db.prepare(
						"UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?",
					).run(
						JSON.stringify({
							piProvenInputFloor: { modelKey: KEY, tokens: 6_525_247 },
						}),
						sessionId,
					);
				expect(
					resolvePiProvenInputFloor({
						db,
						sessionId,
						modelKey: KEY,
						providerInputLimit: 256_000,
						readBranch: () =>
							TURNS.map((turn) => ({ type: "message", message: reply(turn) })),
					}),
				).toBe(0);
				expect(
					getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
				).toBe(0);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("unknown-window readings above the explicit 3M bound cannot prove capacity", async () => {
		const db = createTestDb();
		const sessionId = "ses-aggregate-unknown";
		try {
			expect(MAX_UNKNOWN_PI_INPUT_TOKENS).toBe(3_000_000);
			expect(computePiPressure(TURNS[0], 0)).toBeNull();
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: reply(TURNS[0]),
				piContextWindow: 0,
				piModel: { provider: MODEL.provider, id: MODEL.id },
			});
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(0);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
});
