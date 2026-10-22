import { expect, spyOn, test } from "bun:test";
import {
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	clearEmergencyDropSample,
	setEmergencyDropSample,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import * as cleanup from "./heuristic-cleanup-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

function fixture() {
	const db = createTestDb();
	const sessionId = "zen-stale-reduce";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 0,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: PiMessage[] },
		ctx: never,
	) => Promise<{ messages: PiMessage[] }>;
	const original = cleanup.applyPiHeuristicCleanup;
	const spy = spyOn(cleanup, "applyPiHeuristicCleanup");
	const build = (count: number, bash = false): PiMessage[] => {
		const messages = [userMessage("start", 1)];
		for (let i = 0; i < count; i++)
			messages.push(
				assistantToolCall(`reduce-${i}`, "ctx_reduce", {}, i * 2 + 100),
				{
					...toolResultMessage(
						`reduce-${i}`,
						bash ? "ok" : "r".repeat(20000),
						i * 2 + 101,
					),
					toolName: "ctx_reduce",
				},
			);
		if (bash)
			for (let i = 0; i < 40; i++)
				messages.push(assistantToolCall(`bash-${i}`, "bash", {}, i * 2 + 2), {
					...toolResultMessage(`bash-${i}`, "word ".repeat(2999), i * 2 + 3),
					toolName: "bash",
				});
		messages.push(
			assistantMessage("answered", 200),
			userMessage("continue", 201),
		);
		return messages;
	};
	return {
		db,
		sessionId,
		spy,
		build,
		original,
		async pass(count: number, tokens = 1000, bash = false) {
			const messages = build(count, bash);
			return handler({ messages }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((message) => `entry-${message.timestamp}`),
					messages,
				),
				model: {
					provider: "opencode-zen",
					id: "gpt-5",
					api: "openai-completions",
					contextWindow: 100000,
				},
				getContextUsage: () => ({
					tokens,
					percent: tokens / 1000,
					contextWindow: 100000,
				}),
			} as never);
		},
		warm(tokens = 1000) {
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: tokens / 1000,
				lastInputTokens: tokens,
			});
		},
		close() {
			spy.mockRestore();
			clearContextHandlerSession(sessionId);
			db.close();
		},
	};
}

function reduceStatuses(f: ReturnType<typeof fixture>) {
	return getTagsBySession(f.db, f.sessionId)
		.filter((tag) => tag.toolName === "ctx_reduce")
		.map((tag) => tag.status);
}

test("Zen stale-reduce caller: admitted routine cleanup persists old arcs and defer replays their mode", async () => {
	const f = fixture();
	try {
		await f.pass(3);
		f.warm();
		f.spy.mockClear();
		signalPiPendingMaterialization(f.sessionId);
		const rewritten = await f.pass(6);
		expect(reduceStatuses(f)).toEqual([
			"dropped",
			"dropped",
			"dropped",
			"active",
			"active",
			"active",
		]);
		expect(JSON.stringify(rewritten.messages)).not.toContain('"id":"reduce-0"');
		f.warm();
		f.spy.mockClear();
		const deferred = await f.pass(6);
		expect(f.spy).not.toHaveBeenCalled();
		expect(deferred.messages).toEqual(rewritten.messages);
	} finally {
		f.close();
	}
});

test("Zen stale-reduce caller: emergency progress admits the riding cleanup when routine was withheld", async () => {
	const f = fixture();
	try {
		await f.pass(3, 1000, true);
		f.warm(68000);
		clearEmergencyDropSample(f.db, f.sessionId);
		f.spy.mockClear();
		const original = f.original;
		// A sibling can change session_meta.last_emergency_input_sample (zero
		// rearms cleanup; nonzero records a prior batch) between admission,
		// routine selection, and emergency planning. Simulate those changes and
		// an adapter that must keep paired tool calls/results. Replacing these
		// tiny results saves no emergency tokens, leaving stale ctx_reduce
		// cleanup, rather than emergency selection, to make their visible edits.
		f.spy.mockImplementationOnce((...args) => {
			clearEmergencyDropSample(args[1], args[0]);
			for (const [number, target] of args[2]) {
				if (
					getTagsBySession(args[1], args[0]).some(
						(tag) => tag.tagNumber === number && tag.toolName === "ctx_reduce",
					)
				) {
					target.requiresToolArcSkeleton = true;
					target.cannotRemove = () => true;
				}
			}
			return original(...args);
		});
		const release = __test.setMutationGateObserverForTests(() =>
			setEmergencyDropSample(f.db, f.sessionId, 85000),
		);
		let rewritten: Awaited<ReturnType<typeof f.pass>>;
		try {
			rewritten = await f.pass(6, 90000, true);
		} finally {
			release();
		}
		expect(f.spy.mock.calls[0]?.[4].routine).toBe(false);
		expect(f.spy.mock.results[0]?.value.emergencyDroppedTools).toBeGreaterThan(
			0,
		);
		expect(f.spy.mock.calls[1]?.[4].routine).toBe(true);
		expect(f.spy.mock.results[1]?.value.droppedStaleReduceCalls).toBe(3);
		expect(reduceStatuses(f)).toEqual([
			"dropped",
			"dropped",
			"dropped",
			"active",
			"active",
			"active",
		]);
		f.warm(90000);
		const deferred = await f.pass(6, 90000, true);
		expect(deferred.messages).toEqual(rewritten.messages);
	} finally {
		f.close();
	}
});
