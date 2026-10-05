import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	clearWindowOverlayCacheForTest,
	setWindowOverlayPath,
} from "@magic-context/core/shared/window-geometry";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Replays the usage sequence from a Pi session on openai-codex gpt-6-sol
// (272K window, 64K output reserve → 206,464 usable). After a WebSocket 1012
// retry, Pi's own context estimate jumped to 425,334 tokens — more than the
// model's whole window — and the next reading was back to 37,812. That figure
// is Pi's estimate of its whole raw, unreduced branch, not a provider report,
// so it must not drive emergency reduction, historian force-firing, or the
// persisted pressure used by later passes. Provider reports, by contrast,
// count at any size (see "Pi provider usage above the configured window").
const MODEL = {
	provider: "openai-codex",
	id: "gpt-6-sol",
	contextWindow: 272_000,
	maxTokens: 65_536,
};

type Handler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] }>;

function setup(sessionId: string) {
	const db = createTestDb();
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const runner = {
		harness: "pi",
		run: mock(async () => ({
			ok: true as const,
			assistantText:
				'<compartment start="1" end="2" title="Replay"><p1>Replay history.</p1></compartment>',
			durationMs: 1,
		})),
	} as unknown as SubagentRunner;
	const fake = createFakePi();
	recordPiLiveModel(sessionId, "openai-codex/gpt-6-sol");
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 80 },
		historianContextLimit: 1_000_000,
		historianChunkTokens: 32_000,
		historian: {
			runner,
			model: "test/historian",
			historianChunkTokens: 32_000,
			historianContextLimit: 1_000_000,
			executeThresholdPercentage: 80,
			protectedTags: 0,
		},
	});
	const handler = fake.handlers.get("context") as Handler;
	const largeToolOutput = "word ".repeat(2999);
	const buildMessages = () => {
		const messages = [userMessage("start tool burst", 1)];
		for (let i = 0; i < 40; i++) {
			messages.push(assistantToolCall(`call-${i}`, "bash", {}, 2 + i * 2), {
				...toolResultMessage(`call-${i}`, largeToolOutput, 3 + i * 2),
				toolName: "bash",
			});
		}
		messages.push(userMessage("continue", 90));
		return messages as never[];
	};
	const entryIds = Array.from(
		{ length: buildMessages().length },
		(_, index) => `entry-${index + 1}`,
	);
	// When `retried` is set, the branch ends the way the reporter's session
	// file did: the attempt that died on WebSocket close 1012 (zero usage,
	// stopReason "error") followed by the `context_edit` Pi appends to remove
	// it before retrying. With no usage entry newer than that edit, Pi's live
	// figure is a chars/4 estimate of the whole raw branch.
	const contextFor = (messages: never[], tokens: number, retried = false) => {
		const base = fakeContext(sessionId, process.cwd(), entryIds, messages);
		return {
			...base,
			sessionManager: {
				...base.sessionManager,
				getBranch: () => [
					...base.sessionManager.getBranch(),
					...(retried ? websocketRetryEntries() : []),
				],
			},
			model: MODEL,
			getContextUsage: () => ({
				tokens,
				percent: (tokens / MODEL.contextWindow) * 100,
				contextWindow: MODEL.contextWindow,
			}),
		} as never;
	};
	// Mirrors index.ts message_end: the assistant's provider usage plus Pi's
	// live estimate, with the window Pi reports for the model.
	const messageEnd = (message: unknown, piTokens: number, retried = false) =>
		persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message,
			piContextWindow: MODEL.contextWindow,
			piContextWindowSource: "catalog",
			piModel: MODEL,
			piTokens,
			piTokensIsRawBranchEstimate: retried,
		});
	const runPass = (tokens: number, retried = false) => {
		const messages = buildMessages();
		return handler({ messages }, contextFor(messages, tokens, retried));
	};
	const droppedToolCount = () =>
		getTagsBySession(db, sessionId).filter(
			(tag) => tag.type === "tool" && tag.status === "dropped",
		).length;
	return { db, runner, runPass, messageEnd, droppedToolCount };
}

// The two entries from the reporter's session file (trimmed): the failed
// attempt and the context_edit that removes it.
function websocketRetryEntries() {
	return [
		{
			type: "message",
			id: "0491be9e",
			parentId: "3befc372",
			timestamp: "2026-09-25T12:18:55.369Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "**Reviewing recent work context**" },
				],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-6-sol",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				},
				stopReason: "error",
				errorMessage: "WebSocket closed 1012",
				diagnostics: [
					{
						type: "provider_transport_failure",
						error: { name: "WebSocketCloseError", code: 1012 },
						details: {
							configuredTransport: "auto",
							eventsEmitted: true,
							phase: "after_message_stream_start",
							requestBytes: 919_772,
						},
					},
				],
			},
		},
		{
			type: "context_edit",
			id: "22dc871c",
			parentId: "0491be9e",
			timestamp: "2026-09-25T12:18:55.373Z",
			targetId: "0491be9e",
			replacement: null,
		},
	];
}

function codexUsage(promptTokens: number) {
	return {
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: promptTokens - 140_000 > 0 ? promptTokens - 140_000 : promptTokens,
			cacheRead: promptTokens - 140_000 > 0 ? 140_000 : 0,
			cacheWrite: 0,
			output: 50,
			totalTokens: promptTokens + 50,
		},
	};
}

describe("Pi usage readings above the model window (issue 534 replay)", () => {
	afterEach(() => {
		mock.restore();
	});

	it("ignores Pi's 425K estimate on a 272K window: no emergency, drops, or historian force", async () => {
		const sessionId = "ses-issue-534-impossible";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const { db, runner, runPass, messageEnd, droppedToolCount } =
			setup(sessionId);
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);
			await runPass(147_839);
			expect(droppedToolCount()).toBe(0);

			// The WebSocket 1012 retry: after the context_edit Pi's live estimate
			// of the raw branch reports 425,334.
			await messageEnd(userMessage("tool result", 92), 425_334, true);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);
			await runPass(425_334, true);
			await runPass(425_334, true);
			await awaitInFlightHistorians();

			expect(droppedToolCount()).toBe(0);
			expect(runner.run).not.toHaveBeenCalled();
			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(false);
			expect(logs.some((line) => line.includes("force-firing"))).toBe(false);
			const setAside = logs.filter((line) =>
				line.includes("usage reading 425334 set aside"),
			);
			expect(setAside).toHaveLength(1);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);

			await messageEnd(assistantMessage("ok", 93, codexUsage(37_812)), 37_812);
			await runPass(37_812);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				37_812,
			);
			expect(droppedToolCount()).toBe(0);
			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(false);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("sets aside Pi's raw-branch estimate after a retry even below the window", async () => {
		const sessionId = "ses-issue-534-estimate-below-window";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const { db, runner, runPass, messageEnd, droppedToolCount } =
			setup(sessionId);
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			await runPass(147_839);

			// Same reporter shape, but the estimate (190K) fits the 272K window
			// while still sitting over the 206K usable limit.
			await messageEnd(userMessage("tool result", 92), 190_000, true);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);
			await runPass(190_000, true);
			await runPass(190_000, true);
			await awaitInFlightHistorians();

			expect(droppedToolCount()).toBe(0);
			expect(runner.run).not.toHaveBeenCalled();
			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(false);
			expect(
				logs.filter((line) => line.includes("usage reading 190000 set aside")),
			).toHaveLength(1);

			await messageEnd(assistantMessage("ok", 93, codexUsage(37_812)), 37_812);
			await runPass(37_812);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				37_812,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("still treats a 220K reading on a 272K window (over the 206K limit) as a real emergency", async () => {
		const sessionId = "ses-issue-534-real-overflow";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const { db, runPass, messageEnd, droppedToolCount } = setup(sessionId);
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			await runPass(147_839);
			expect(droppedToolCount()).toBe(0);

			await messageEnd(userMessage("tool result", 92), 220_000);
			await runPass(220_000);
			await awaitInFlightHistorians();

			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(true);
			expect(droppedToolCount()).toBeGreaterThan(0);
			expect(logs.some((line) => line.includes("exceeds model window"))).toBe(
				false,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});

describe("isPiLiveUsageRawBranchEstimate", () => {
	const usage = (total: number) => ({
		input: total,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total,
	});
	const assistant = (total: number, stopReason = "stop") => ({
		type: "message",
		message: { role: "assistant", stopReason, usage: usage(total) },
	});

	it("follows Pi's rule: an edit or compaction after the last usage means estimate", async () => {
		const { isPiLiveUsageRawBranchEstimate } = await import("./pi-pressure");
		expect(isPiLiveUsageRawBranchEstimate([assistant(100)])).toBe(false);
		expect(
			isPiLiveUsageRawBranchEstimate([
				assistant(100),
				{ type: "message", message: { role: "toolResult" } },
			]),
		).toBe(false);
		// The failed attempt carries zero usage and is hidden by a context_edit.
		expect(
			isPiLiveUsageRawBranchEstimate([
				assistant(100),
				assistant(0, "error"),
				{ type: "context_edit" },
			]),
		).toBe(true);
		expect(
			isPiLiveUsageRawBranchEstimate([assistant(100), { type: "compaction" }]),
		).toBe(true);
		// The reporter's sequence: failed attempt, context_edit, then our own
		// compaction marker; still an estimate until the retried reply lands.
		const reporterBranch = [
			assistant(147_839),
			...websocketRetryEntries(),
			{ type: "compaction", id: "7cc5da33", fromHook: true },
		];
		expect(isPiLiveUsageRawBranchEstimate(reporterBranch.slice(0, 3))).toBe(
			true,
		);
		expect(isPiLiveUsageRawBranchEstimate(reporterBranch)).toBe(true);
		expect(
			isPiLiveUsageRawBranchEstimate([...reporterBranch, assistant(31_700)]),
		).toBe(false);
		// The retried reply lands after the edit: Pi trusts its usage again.
		expect(
			isPiLiveUsageRawBranchEstimate([
				assistant(100),
				{ type: "context_edit" },
				assistant(120),
			]),
		).toBe(false);
		expect(isPiLiveUsageRawBranchEstimate(null)).toBe(false);
	});

	it("never uses the raw-branch estimate as pressure, even with no provider reading", async () => {
		const { resolvePiPressureSnapshotWithEstimateGuard } = await import(
			"./pi-pressure"
		);
		const base = {
			sessionId: "ses-issue-534-guard",
			source: "test",
			usableContextLimit: 206_464,
			liveIsRawBranchEstimate: true,
		};
		// A persisted provider reading stands; the estimate is ignored even
		// when it is smaller.
		expect(
			resolvePiPressureSnapshotWithEstimateGuard({
				...base,
				persistedInputTokens: 147_839,
				persistedPercentage: 71.6,
				liveInputTokens: 190_000,
			}).inputTokens,
		).toBe(147_839);
		// Without one, the caller's fallback (which is the same live figure) is
		// set aside too, leaving pressure unknown rather than inflated.
		expect(
			resolvePiPressureSnapshotWithEstimateGuard({
				...base,
				persistedFromLive: true,
				persistedInputTokens: 190_000,
				persistedPercentage: 92,
				liveInputTokens: 190_000,
			}).inputTokens,
		).toBe(0);
	});
});

// A measured overlay cell for the model: the strongest configured window the
// resolver knows, and the one a provider report above 272K contradicts.
function use272kOverlay(): () => void {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-534-overlay-"));
	const overlayPath = join(dir, "window-overlay.json");
	writeFileSync(
		overlayPath,
		JSON.stringify({
			schema: "fusiform-window-overlay/v1",
			generated_at: "2026-09-11T00:00:00Z",
			minted_provider_ids: [],
			cells: [
				{
					provider_id: MODEL.provider,
					model_id: MODEL.id,
					facts: {
						"window.enforced": {
							value: { kind: "stated", value: MODEL.contextWindow },
							grade: "measured",
							units: "provider",
							boundary: "Observed",
							source_ref: "issue 534 follow-up fixture",
							observed_at: "2026-09-11T00:00:00Z",
						},
					},
				},
			],
		}),
	);
	setWindowOverlayPath(overlayPath);
	return () => {
		setWindowOverlayPath(undefined);
		clearWindowOverlayCacheForTest();
		rmSync(dir, { recursive: true, force: true });
	};
}

describe("Pi provider usage above the configured window", () => {
	afterEach(() => {
		mock.restore();
	});

	it("treats a provider-reported 300K on a 272K window as real pressure on every pass", async () => {
		const sessionId = "ses-issue-534-provider-above-window";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const restoreOverlay = use272kOverlay();
		const { db, runPass, messageEnd, droppedToolCount } = setup(sessionId);
		const emergencyPasses = () =>
			logs.filter((line) => line.includes("EMERGENCY=true")).length;
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			await runPass(147_839);
			expect(emergencyPasses()).toBe(0);

			// The provider accepted a 300K request: a model whose real window is
			// larger than the configured 272K. The reading is the real prompt size.
			await messageEnd(
				assistantMessage("ok", 92, codexUsage(300_000)),
				300_000,
			);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				300_000,
			);
			await runPass(300_000);
			await awaitInFlightHistorians();
			expect(emergencyPasses()).toBe(1);
			expect(droppedToolCount()).toBeGreaterThan(0);

			// Context stays above the configured window: every reading counts.
			await messageEnd(
				assistantMessage("ok", 93, codexUsage(310_000)),
				310_000,
			);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				310_000,
			);
			await runPass(310_000);
			await awaitInFlightHistorians();
			expect(emergencyPasses()).toBe(2);
		} finally {
			restoreOverlay();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});

describe("Pi message_end provider usage above a trusted window", () => {
	it("counts every successful reading in full and still clamps after an overflow error", async () => {
		const db = createTestDb();
		const sessionId = "ses-issue-534-provider-usage";
		const piModel = {
			provider: "openai-codex",
			id: "gpt-6-sol",
			maxTokens: 65_536,
		};
		try {
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("ok", 1, { usage: { input: 147_839 } }),
				piContextWindow: 272_000,
				piContextWindowSource: "observed",
				piModel,
			});
			const accepted = (ordinal: number, input: number) =>
				persistPiPressureFromMessageEnd({
					db,
					sessionId,
					message: assistantMessage("ok", ordinal, { usage: { input } }),
					piContextWindow: 272_000,
					piContextWindowSource: "observed",
					piModel,
				});
			await accepted(2, 300_000);
			let meta = getOrCreateSessionMeta(db, sessionId);
			// Counted in full against the configured usable limit, and never
			// recorded as proven capacity that would widen the configured window.
			expect(meta.lastInputTokens).toBe(300_000);
			expect(meta.lastContextPercentage).toBeGreaterThan(100);
			expect(meta.observedSafeInputTokens).toBe(147_839);
			const usableLimit = meta.lastUsageContextLimit;

			await accepted(3, 310_000);
			meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(310_000);
			expect(meta.lastUsageContextLimit).toBe(usableLimit);
			expect(meta.lastContextPercentage).toBeCloseTo(
				(310_000 / usableLimit) * 100,
				5,
			);

			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("", 4, {
					usage: { input: 425_334 },
					stopReason: "error",
					errorMessage: "Your input exceeds the context window",
				}),
				piContextWindow: 272_000,
				piContextWindowSource: "observed",
				piModel,
			});
			meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(272_000);
		} finally {
			closeQuietly(db);
		}
	});
});
