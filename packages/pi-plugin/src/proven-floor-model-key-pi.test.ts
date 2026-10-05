import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { persistPiPressureFromMessageEnd } from "./index";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import { readPiProvenFloorRecord } from "./pi-proven-floor";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	userMessage,
} from "./test-utils.test";

// Magic Context records the largest prompt a provider accepted in a session
// (the proven input floor) and lifts the usable context limit to it when the
// configured window is smaller. A session had a 786,172-token prompt accepted
// by a 1M-window model (model A), then moved to a model whose configured window
// is 500K (model B). A's acceptance says nothing about B, yet the floor kept
// lifting B's usable limit to 786,172.

const MODEL_A = {
	provider: "google-antigravity",
	id: "antigravity-gemini-3.8-flash",
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};
const MODEL_B = {
	provider: "openai-codex",
	id: "gpt-6.1-sol",
	contextWindow: 500_000,
	maxTokens: 128_000,
};
const KEY_A = `${MODEL_A.provider}/${MODEL_A.id}`;
const KEY_B = `${MODEL_B.provider}/${MODEL_B.id}`;
const FLOOR_A = 786_172;
const B_USABLE = resolvePiUsableContextLimit({
	rawContextWindow: MODEL_B.contextWindow,
	rawContextWindowSource: "catalog",
	model: MODEL_B,
});
const A_REPLY = assistantMessage("served on A", 2, {
	provider: MODEL_A.provider,
	model: MODEL_A.id,
	usage: {
		input: 3_368,
		cacheRead: 782_804,
		cacheWrite: 0,
		output: 400,
		totalTokens: 786_572,
	},
});

type Handler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] }>;

async function proveFloorOnA(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
) {
	await persistPiPressureFromMessageEnd({
		db,
		sessionId,
		message: A_REPLY,
		piContextWindow: MODEL_A.contextWindow,
		piContextWindowSource: "catalog",
		piModel: MODEL_A,
	});
	expect(getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens).toBe(
		FLOOR_A,
	);
}

function captureLogs(): string[] {
	const logs: string[] = [];
	spyOn(loggerModule, "sessionLog").mockImplementation(
		(_session: string, ...parts: unknown[]) => {
			logs.push(parts.map(String).join(" "));
		},
	);
	return logs;
}

/** The usable limit the transform logged for its pressure decision. */
function transformLimits(logs: string[]): number[] {
	return logs
		.map((line) => /^transform: usage=.*limit=(\d+)\)/.exec(line)?.[1])
		.filter((limit): limit is string => limit !== undefined)
		.map(Number);
}

/**
 * One context pass through the registered Pi context handler, on `model`,
 * with `extraBranchEntries` (such as `model_change`) placed between the
 * served history and the new prompt, as Pi writes them.
 */
async function runPass(args: {
	db: ReturnType<typeof createTestDb>;
	sessionId: string;
	model: typeof MODEL_A | typeof MODEL_B;
	extraBranchEntries?: unknown[];
}) {
	const runner = {
		harness: "pi",
		run: mock(async () => ({ ok: true as const, assistantText: "" })),
	} as unknown as SubagentRunner;
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db: args.db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 90 },
		historianContextLimit: 1_000_000,
		historianChunkTokens: 32_000,
		historian: {
			runner,
			model: "test/historian",
			historianChunkTokens: 32_000,
			historianContextLimit: 1_000_000,
			executeThresholdPercentage: 90,
			protectedTags: 0,
		},
	});
	const handler = fake.handlers.get("context") as Handler;
	const first = userMessage("start", 1);
	const prompt = userMessage("next", 3);
	const messages = [first, A_REPLY, prompt] as never[];
	const branch = [
		{ type: "message", id: "entry-1", message: first },
		{ type: "message", id: "entry-2", message: A_REPLY },
		...(args.extraBranchEntries ?? []),
		{ type: "message", id: "entry-3", message: prompt },
	];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		sessionManager: {
			getSessionId: () => args.sessionId,
			getBranch: () => branch,
		},
		model: args.model,
		getContextUsage: () => ({
			tokens: 200_000,
			percent: (200_000 / args.model.contextWindow) * 100,
			contextWindow: args.model.contextWindow,
		}),
	};
	await handler({ messages }, ctx as never);
}

describe("Pi proven input floor is keyed to the model that proved it", () => {
	afterEach(() => {
		mock.restore();
	});

	it("records the proving model and applies the floor on that model", async () => {
		const sessionId = "ses-floor-same-model";
		const db = createTestDb();
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const logs = captureLogs();
		try {
			await proveFloorOnA(db, sessionId);
			expect(readPiProvenFloorRecord(db, sessionId)).toEqual({
				modelKey: KEY_A,
				tokens: FLOOR_A,
			});
			// Model B itself accepts a prompt larger than its configured window:
			// that proof is about B, so it lifts B's usable limit.
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: { ...A_REPLY, provider: MODEL_B.provider, model: MODEL_B.id },
				piContextWindow: MODEL_B.contextWindow,
				piContextWindowSource: "catalog",
				piModel: MODEL_B,
			});
			expect(readPiProvenFloorRecord(db, sessionId)).toEqual({
				modelKey: KEY_B,
				tokens: FLOOR_A,
			});
			recordPiLiveModel(sessionId, KEY_B);
			await runPass({ db, sessionId, model: MODEL_B });
			expect(transformLimits(logs).at(-1)).toBe(FLOOR_A);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("mid-session: a reply on model B is measured against B's window, not A's floor", async () => {
		const sessionId = "ses-floor-mid-session";
		const db = createTestDb();
		try {
			await proveFloorOnA(db, sessionId);
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("served on B", 4, {
					provider: MODEL_B.provider,
					model: MODEL_B.id,
					usage: {
						input: 108,
						cacheRead: 237_805,
						cacheWrite: 0,
						output: 700,
						totalTokens: 238_613,
					},
				}),
				piContextWindow: MODEL_B.contextWindow,
				piContextWindowSource: "catalog",
				piModel: MODEL_B,
			});
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(B_USABLE).toBeDefined();
			expect(meta.lastUsageContextLimit).toBe(B_USABLE as number);
			expect(meta.lastContextPercentage).toBeCloseTo(
				(237_913 / (B_USABLE as number)) * 100,
				6,
			);
			// B's own accepted prompt is now the floor, recorded for B.
			expect(meta.observedSafeInputTokens).toBe(237_913);
			expect(readPiProvenFloorRecord(db, sessionId)).toEqual({
				modelKey: KEY_B,
				tokens: 237_913,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("mid-session: the transform does not apply A's floor while running on B", async () => {
		const sessionId = "ses-floor-transform-on-b";
		const db = createTestDb();
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const logs = captureLogs();
		try {
			await proveFloorOnA(db, sessionId);
			// The in-memory current model is already B, so this pass detects no
			// model switch: only the model recorded with the floor keeps A's
			// floor off B.
			recordPiLiveModel(sessionId, KEY_B);
			await runPass({ db, sessionId, model: MODEL_B });
			const limits = transformLimits(logs);
			expect(limits.length).toBeGreaterThan(0);
			expect(limits.at(-1)).toBe(B_USABLE as number);
			expect(limits).not.toContain(FLOOR_A);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("restart: a model_change before the first prompt is detected as a switch", async () => {
		const sessionId = "ses-floor-restart";
		const db = createTestDb();
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const logs = captureLogs();
		try {
			await proveFloorOnA(db, sessionId);
			// Simulate a new process: forget the in-memory current model and
			// the fact that a first pass has run.
			clearContextHandlerSession(sessionId);
			await runPass({
				db,
				sessionId,
				model: MODEL_B,
				extraBranchEntries: [
					{
						type: "model_change",
						id: "mc-1",
						provider: MODEL_B.provider,
						modelId: MODEL_B.id,
					},
				],
			});
			expect(
				logs.some((line) =>
					line.startsWith(`transform: model switch ${KEY_A} -> ${KEY_B}`),
				),
			).toBe(true);
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(0);
			expect(transformLimits(logs)).not.toContain(FLOOR_A);
			expect(transformLimits(logs).at(-1)).toBe(B_USABLE as number);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("a floor stored with no model is dropped on first use, not trusted", async () => {
		const sessionId = "ses-floor-unkeyed";
		const db = createTestDb();
		// What releases before this check stored: the floor's token count with
		// no record of the model that proved it.
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			observedSafeInputTokens: FLOOR_A,
			cacheAlertSent: true,
			lastObservedModelKey: "openai/gpt-6.1-sol",
		});
		const logs = captureLogs();
		try {
			recordPiLiveModel(sessionId, KEY_B);
			await runPass({ db, sessionId, model: MODEL_B });
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.observedSafeInputTokens).toBe(0);
			expect(meta.cacheAlertSent).toBe(false);
			expect(transformLimits(logs)).not.toContain(FLOOR_A);
			expect(
				logs.some((line) =>
					line.includes(`proven input floor ${FLOOR_A} has no recorded model`),
				),
			).toBe(true);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
