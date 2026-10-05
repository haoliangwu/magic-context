import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingOps,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import * as logger from "@magic-context/core/shared/logger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	getInitialSystemMessage,
} from "pi-ai-086";
import { SessionManager as SessionManager086 } from "pi-coding-agent-086";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "./context-handler";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { __test, injectM0M1Pi } from "./inject-compartments-pi";
import { clearNativeReasoning } from "./native-replay-pi";
import { createPiLkgCoordinator } from "./pi-lkg";
import { convertEntriesToRawMessages } from "./read-session-pi";
import {
	adoptPiCompactionSystemSnapshot,
	isPiSystemEntry,
	piToolIdentity,
	resolvePiEffectiveSystemState,
} from "./system-entry-pi";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createCtxReduceTool } from "./tools/ctx-reduce";
import { createPiTranscript } from "./transcript-pi";

const initial = {
	role: "system" as const,
	content: "Base instructions",
	toolsAdded: Array.from({ length: 70 }, (_, i) => ({
		name: `tool${i}`,
		description: "tool",
		parameters: { type: "object", properties: {} },
	})),
	timestamp: 0,
};
const delta = {
	role: "system" as const,
	content: "More instructions",
	sections: { policy: "keep" },
	toolsAdded: initial.toolsAdded.slice(55),
	timestamp: 2,
};

describe("Pi system entry preservation", () => {
	it("trim preserves initial and delta declarations with aligned ids", () => {
		const messages = [
			initial,
			{ role: "user" as const, content: "old", timestamp: 1 },
			delta,
			{ role: "user" as const, content: "tail", timestamp: 3 },
		];
		const ids = ["s0", "u0", "s1", "u1"];
		__test.trimPiMessagesToBoundary(messages, ids, "s1", true);
		expect(messages).toEqual([
			initial,
			delta,
			{ role: "user", content: "tail", timestamp: 3 },
		]);
		expect(ids).toEqual(["s0", "s1", "u1"]);
	});
	it("system entries never enter tagging or ctx_reduce target selection", () => {
		const messages = structuredClone([initial, delta]);
		const transcript = createPiTranscript(messages, "system-test", [
			"s0",
			"s1",
		]);
		expect(transcript.messages).toHaveLength(0);
		transcript.commit();
		expect(messages).toEqual([initial, delta]);
	});
	it("historian never treats system entries as foldable ordinals", () => {
		const entries = [
			initial,
			{ role: "user", content: "question", timestamp: 1 },
			delta,
		].map((message, index) => ({ type: "message", id: `e${index}`, message }));
		const raw = convertEntriesToRawMessages(entries);
		const sessionId = "system-historian-content";
		const chunk = withRawMessageProvider(
			sessionId,
			{ readMessages: () => raw },
			() => readSessionChunk(sessionId, 10000),
		);
		expect(chunk.text).toContain("question");
		expect(chunk.text).not.toContain(initial.content);
		expect(chunk.text).not.toContain(delta.content);
		expect(
			raw
				.filter(isPiSystemEntry)
				.every((message) => message.parts.length === 0),
		).toBe(true);
	});
});

describe("Pi 0.86 provider contract", () => {
	it("mirrors installed Pi 0.86 system resolvers across protocol fixtures", () => {
		const gateTool = (name: string) => ({
			name,
			description: name,
			parameters: { type: "object", properties: {} },
		});
		const gateInitial = {
			role: "system" as const,
			content: "BASE_GATE_PROMPT",
			toolsAdded: [gateTool("read"), gateTool("edit"), gateTool("bash")],
			timestamp: 0,
		};
		const racingExtension = {
			role: "system" as const,
			content: "RACING_EXTENSION",
			toolsRemoved: [{ name: "read" }],
			timestamp: 10,
		};
		const systemMessage = {
			role: "system" as const,
			content: "BASE_GATE_PROMPT\n\nRACING_EXTENSION",
			toolsAdded: [gateTool("edit"), gateTool("bash")],
			timestamp: 11,
		};
		const fixtures: { label: string; messages: unknown[] }[] = [
			{
				label: "initial plus delta",
				messages: [structuredClone(initial), structuredClone(delta)],
			},
			{
				label: "tools removed",
				messages: [
					structuredClone(initial),
					{
						role: "system",
						content: "",
						toolsRemoved: [{ name: "tool0" }],
						timestamp: 3,
					},
				],
			},
			{
				label: "sections set and null",
				messages: [
					{
						role: "system",
						content: "SECTION_BASE",
						sections: { policy: "keep", removed: "remove" },
						timestamp: 0,
					},
					{
						role: "system",
						content: "",
						sections: { policy: "replaced", removed: null },
						timestamp: 1,
					},
				],
			},
			{
				label: "empty system content",
				messages: [{ role: "system", content: "", timestamp: 0 }],
			},
			{
				label: "foreign system without tools",
				messages: [
					{ role: "system", content: "FOREIGN ".repeat(20_000), timestamp: 0 },
				],
			},
			{
				label: "racing extension",
				messages: [
					structuredClone(gateInitial),
					structuredClone(racingExtension),
				],
			},
			{
				label: "persisted systemMessage and summary head",
				messages: [
					structuredClone(systemMessage),
					{
						role: "compactionSummary",
						summary: "MC marker",
						tokensBefore: 70_000,
						timestamp: 12,
					},
				],
			},
		];

		for (const { label, messages } of fixtures) {
			const installedTools = getCurrentTools(messages as never)
				.map(piToolIdentity)
				.sort((left, right) =>
					left.name === right.name
						? left.identity.localeCompare(right.identity)
						: left.name.localeCompare(right.name),
				);
			expect(resolvePiEffectiveSystemState(messages), label).toEqual({
				tools: installedTools,
				prompt: getCurrentSystemPrompt(messages as never),
			});
		}
	});

	it("fold and four defer passes retain the initial request tools and prompt", () => {
		const db = createTestDb();
		const sessionId = `sys-fold-${crypto.randomUUID()}`;
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "s0",
					endMessageId: "u0",
					title: "old",
					content: "folded history",
				},
			]);
			const state = {
				sessionId,
				projectIdentity: "test-system",
				projectDirectory: process.cwd(),
			};
			const input = [
				initial,
				{ role: "user" as const, content: "old", timestamp: 1 },
				delta,
				{ role: "user" as const, content: "tail", timestamp: 3 },
			];
			let bytes = "";
			for (let pass = 0; pass < 5; pass++) {
				const messages = structuredClone(input);
				injectM0M1Pi(state, db, messages, ["s0", "u0", "s1", "u1"]);
				expect(messages[0]?.role).toBe("system");
				expect(getInitialSystemMessage(messages)?.toolsAdded).toHaveLength(70);
				expect(getCurrentTools(messages)).toEqual(initial.toolsAdded);
				expect(getCurrentSystemPrompt(messages)).toBe(
					getCurrentSystemPrompt(input),
				);
				expect(messages.map((m) => m.role)).toEqual([
					"system",
					"system",
					"user",
					"user",
					"user",
				]);
				if (pass === 0) bytes = JSON.stringify(messages);
				else expect(JSON.stringify(messages)).toBe(bytes);
			}
		} finally {
			db.close();
		}
	});
	it("host marker consolidation preserves effective state and replay bytes through restart and LKG", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "mc-system-086-"));
		const manager = SessionManager086.create(process.cwd(), dir);
		const sessionId = manager.getSessionId();
		const db = createTestDb();
		try {
			const s0 = manager.appendMessage(initial);
			const u0 = manager.appendMessage(userMessage("old", 1));
			manager.appendMessage(delta);
			manager.appendMessage({
				role: "system",
				content: "",
				sections: { policy: "replaced", removed: null },
				toolsRemoved: [{ name: "tool0" }],
				timestamp: 3,
			});
			const tail = manager.appendMessage(userMessage("tail", 4));
			manager.appendMessage(assistantMessage("answer", 5) as never);
			const before = manager.buildSessionContext().messages;

			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				injection: { injectionBudgetTokens: 10000 },
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: unknown[] },
				ctx: unknown,
			) => Promise<{ messages: unknown[] }>;
			const context = (sm: typeof manager, tokens: number) => ({
				cwd: process.cwd(),
				hasUI: false,
				signal: new AbortController().signal,
				ui: { notify() {} },
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					contextWindow: 100000,
				},
				sessionManager: sm,
				getContextUsage: () => ({
					tokens,
					percent: tokens / 1000,
					contextWindow: 100000,
				}),
			});
			await handler(
				{ messages: structuredClone(before) },
				context(manager, 10000),
			);
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: s0,
					endMessageId: u0,
					title: "old",
					content: "folded history",
				},
			]);
			setPendingPiCompactionMarkerState(db, sessionId, {
				firstKeptEntryId: tail,
				endMessageId: u0,
				ordinal: 2,
				tokensBefore: 70000,
				summary: "MC marker",
				publishedAt: Date.now(),
			});
			signalPiDeferredHistoryRefresh(sessionId);
			signalPiDeferredMaterialization(sessionId);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 70,
				lastInputTokens: 70000,
			});
			const folded = await handler(
				{ messages: structuredClone(before) },
				context(manager, 70000),
			);
			expect(
				manager.getBranch().filter((e) => e.type === "compaction"),
			).toHaveLength(1);
			const after = manager.buildSessionContext().messages;
			expect(getCurrentTools(after)).toEqual(getCurrentTools(before));
			expect(getCurrentSystemPrompt(after)).toBe(
				getCurrentSystemPrompt(before),
			);
			expect(folded.messages[0]).toEqual(after[0]);
			const bytes = JSON.stringify(folded.messages);
			updateSessionMeta(db, sessionId, {
				lastContextPercentage: 10,
				lastInputTokens: 10000,
			});
			for (let pass = 0; pass < 4; pass++) {
				const served = await handler(
					{ messages: structuredClone(after) },
					context(manager, 10000),
				);
				expect(JSON.stringify(served.messages)).toBe(bytes);
			}
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing session file");
			clearContextHandlerSession(sessionId);
			const restarted = SessionManager086.open(file);
			const served = await handler(
				{ messages: structuredClone(restarted.buildSessionContext().messages) },
				context(restarted, 10000),
			);
			expect(JSON.stringify(served.messages)).toBe(bytes);
			const lkg = createPiLkgCoordinator(db, (capture) => capture());
			const raw = restarted.buildSessionContext().messages;
			const ids = raw.map((_, index) => `raw-${index}`);
			const snapshot = lkg.beginPass({
				sessionId,
				messages: raw,
				entryIds: ids,
				modelKey: "m",
				providerKey: "p",
			});
			lkg.captureAppliedPass({
				snapshot,
				outputMessages: served.messages,
				cacheBusting: true,
			});
			const replay = lkg.replay(
				lkg.beginPass({
					sessionId,
					messages: raw,
					entryIds: ids,
					modelKey: "m",
					providerKey: "p",
				}),
			);
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(JSON.stringify(replay.messages)).toBe(bytes);
			const added = {
				name: "post-marker",
				description: "new",
				parameters: { type: "object" as const, properties: {} },
			};
			manager.appendMessage({
				role: "system",
				content: "post-marker instruction",
				toolsAdded: [added],
				timestamp: 9,
			});
			const post = manager.buildSessionContext().messages;
			expect(post[0]).toEqual(after[0]);
			expect(getCurrentTools(post)).toEqual([
				...getCurrentTools(before),
				added,
			]);
			const servedPost = await handler(
				{ messages: structuredClone(post) },
				context(manager, 10000),
			);
			expect(servedPost.messages.at(-1)).toEqual(post.at(-1));
		} finally {
			clearContextHandlerSession(sessionId);
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Pi 0.87 context contract", () => {
	// Pi 0.87 withholds system messages from `context` handlers and restores the
	// prompt and tools itself afterwards (runner.js emitContext). The folding
	// input then carries no system state for Magic Context to compare, while the
	// persisted compaction still records the host's complete system checkpoint.
	it("adopts a host checkpoint when the folding input carries no system messages", () => {
		const messages: unknown[] = [
			userMessage("history", 1),
			userMessage("live prompt", 2),
		];
		const before = structuredClone(messages);
		const entries = [
			{
				type: "compaction",
				id: "cmp-1",
				summary: "Magic Context compacted",
				firstKeptEntryId: "entry-2",
				tokensBefore: 10,
				systemMessage: initial,
			},
		];
		const adoption = adoptPiCompactionSystemSnapshot(
			messages,
			entries,
			"cmp-1",
			resolvePiEffectiveSystemState(messages),
		);
		expect(adoption).toEqual({ kind: "adopted" });
		// The host restores system state after the handler; injecting it here
		// would hand Pi a second copy.
		expect(messages).toEqual(before);
	});

	it("still refuses a checkpoint that differs from exposed system state", () => {
		const messages: unknown[] = [
			{ ...initial, toolsAdded: initial.toolsAdded.slice(0, 5) },
			userMessage("live prompt", 2),
		];
		const adoption = adoptPiCompactionSystemSnapshot(
			messages,
			[
				{
					type: "compaction",
					id: "cmp-1",
					summary: "Magic Context compacted",
					firstKeptEntryId: "entry-2",
					tokensBefore: 10,
					systemMessage: initial,
				},
			],
			"cmp-1",
			resolvePiEffectiveSystemState(messages),
		);
		expect(adoption.kind).toBe("divergent");
	});
});

describe("Pi protocol exclusions", () => {
	it("trim diagnostics discriminate zero from two preserved system entries", () => {
		const log = spyOn(logger, "sessionLog");
		try {
			__test.trimPiMessagesToBoundary(
				[userMessage("old")],
				["u"],
				"u",
				false,
				"log-system",
			);
			expect(
				log.mock.calls.filter((call) =>
					call[1].startsWith("pi system entries preserved"),
				),
			).toHaveLength(0);
			__test.trimPiMessagesToBoundary(
				[initial, delta, userMessage("old")],
				["s0", "s1", "u"],
				"u",
				false,
				"log-system",
			);
			expect(
				log.mock.calls
					.filter((call) => call[1].startsWith("pi system entries preserved"))
					.map((call) => call[1]),
			).toEqual(["pi system entries preserved across fold: 2"]);
		} finally {
			log.mockRestore();
		}
	});
	it("tagging, ctx_reduce and emergency cleanup at 95 percent cannot target system state", async () => {
		const db = createTestDb();
		const sessionId = "system-emergency";
		try {
			const messages = structuredClone([initial, delta]);
			const transcript = createPiTranscript(messages, sessionId, ["s0", "s1"]);
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			expect(targets.size).toBe(0);
			const tool = createCtxReduceTool({ db, protectedTags: 0 });
			const result = await tool.execute(
				"call",
				{ drop: "1" },
				new AbortController().signal,
				undefined,
				fakeContext(sessionId) as never,
			);
			expect(result.isError).toBe(true);
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
			applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
				emergency: {
					currentTotalInputTokens: 95000,
					ceilingTokens: 65000,
					usagePercentage: 95,
				},
			});
			transcript.commit();
			expect(JSON.stringify(messages)).toBe(JSON.stringify([initial, delta]));
			const measurement = measurePiTailHygiene({
				messages,
				tags: [],
				protectedTagNumbers: new Set(),
			});
			expect(measurement.t).toBe(0);
			expect(measurement.u).toBe(0);
			expect(
				measurement.parts.every(
					(part) => part.kind === "excluded" && part.tokens === 0,
				),
			).toBe(true);
		} finally {
			db.close();
		}
	});
});

it("LKG prefix shaving retains system entries owned by the removed raw head", () => {
	const db = createTestDb();
	const sessionId = `sys-lkg-${crypto.randomUUID()}`;
	try {
		const lkg = createPiLkgCoordinator(db, (capture) => capture());
		const tail = userMessage("tail", 4);
		const begin = (messages: unknown[], entryIds: string[]) =>
			lkg.beginPass({
				sessionId,
				messages,
				entryIds,
				modelKey: "m",
				providerKey: "p",
			});
		const snapshot = begin([initial, tail], ["s0", "u0"]);
		lkg.captureAppliedPass({
			snapshot,
			outputMessages: [initial, tail],
			outputEntryIds: ["s0", "u0"],
			cacheBusting: true,
		});
		const replay = lkg.replay(begin([tail], ["u0"]));
		expect(replay.ok).toBe(true);
		if (replay.ok) expect(replay.messages).toEqual([initial, tail]);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("LKG rejects a pre-upgrade snapshot that lost system declarations", () => {
	const db = createTestDb();
	const sessionId = `sys-upgrade-${crypto.randomUUID()}`;
	try {
		const lkg = createPiLkgCoordinator(db, (capture) => capture());
		const tail = userMessage("tail", 4);
		const args = {
			sessionId,
			messages: [initial, tail],
			entryIds: ["s0", "u0"],
			modelKey: "m",
			providerKey: "p",
		};
		lkg.captureAppliedPass({
			snapshot: lkg.beginPass(args),
			outputMessages: [tail],
			cacheBusting: true,
		});
		expect(lkg.replay(lkg.beginPass(args))).toEqual({
			ok: false,
			reason: "lkg_system_state_mismatch",
		});
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("native replay never edits system provider payloads", () => {
	const message = {
		...initial,
		providerPayload: {
			type: "openaiResponsesHistory",
			dt: true,
			items: [{ type: "reasoning", encrypted_content: "opaque" }],
		},
	};
	const before = JSON.stringify(message);
	expect(clearNativeReasoning(message, true)).toBe("not-native");
	expect(JSON.stringify(message)).toBe(before);
});

it("95 percent emergency reclaims tool outputs while retaining interleaved system state", () => {
	const db = createTestDb();
	const sessionId = "sys-mixed-emergency";
	try {
		const messages: unknown[] = [structuredClone(initial)];
		for (let i = 0; i < 8; i++) {
			messages.push(
				assistantToolCall(
					`read-${i}`,
					"read",
					{ path: `file-${i}` },
					i * 2 + 1,
				),
				toolResultMessage(`read-${i}`, "large output ".repeat(4000), i * 2 + 2),
			);
			if (i === 3) messages.push(structuredClone(delta));
		}
		const transcript = createPiTranscript(messages, sessionId);
		const tagger = createTagger();
		tagger.initFromDb(sessionId, db);
		const { targets } = tagTranscript(sessionId, transcript, tagger, db);
		const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
			routine: false,
			protectedTags: 0,
			staleReduceStripEnabled: false,
			emergency: {
				currentTotalInputTokens: 95000,
				ceilingTokens: 65000,
				usagePercentage: 95,
			},
		});
		expect(result.emergencyDroppedTools).toBeGreaterThan(0);
		transcript.commit();
		transcript.finalizeToolRemovals();
		expect(messages.filter(isPiSystemEntry)).toEqual([initial, delta]);
	} finally {
		db.close();
	}
});
