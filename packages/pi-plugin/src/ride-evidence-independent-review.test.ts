import { expect, test } from "bun:test";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { ExtensionRunner } from "pi-coding-agent-087";
import {
	clearContextHandlerSession,
	__test as contextInternals,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiSystemHashChange,
} from "./context-handler";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const model = {
	id: "deepseek-v4.1-flash-free",
	name: "independent-ride-review",
	provider: "test",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 4096,
};

function harness(laterOverride: boolean) {
	const db = createTestDb();
	const id = `independent-system-ride-${laterOverride}`;
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		scheduler: { executeThresholdPercentage: 65 },
	});
	const raw = [
		userMessage("baseline request", 1),
		assistantMessage("baseline response", 2),
	];
	for (let i = 0; i < 16; i++) {
		raw.push(
			userMessage(`request ${i}`, 3 + i * 4),
			assistantToolCall(
				`call-${i}`,
				"Read",
				{ path: `file-${i}.txt` },
				4 + i * 4,
			),
			toolResultMessage(
				`call-${i}`,
				`File ${i}: preserving the content and order matters.\n`.repeat(10),
				5 + i * 4,
			),
			assistantMessage(`answer ${i}`, 6 + i * 4),
		);
	}
	for (const message of raw) {
		if (message.role === "assistant") {
			Object.assign(message, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
		}
	}
	let effectiveSystem = "";
	let finalSystem = "Fixed effective system prompt.";
	const observedUpstream: string[] = [];
	const runnerErrors: unknown[] = [];
	// The prompt observer uses the same hash processing as before_agent_start.
	// The real host runner then lets the later extension replace that prompt.
	const extensions = [
		{
			path: "upstream-prompt-observer",
			handlers: new Map([
				[
					"before_agent_start",
					[
						(event: { systemPrompt: string }) => {
							observedUpstream.push(event.systemPrompt);
							const result = processSystemPromptForCache({
								db,
								sessionId: id,
								systemPrompt: event.systemPrompt,
								isCacheBusting: false,
							});
							if (result.hashChanged)
								signalPiSystemHashChange(id, result.currentHash);
							return { systemPrompt: result.systemPrompt };
						},
					],
				],
			]),
		},
		...(laterOverride
			? [
					{
						path: "later-final-prompt",
						handlers: new Map([
							["before_agent_start", [() => ({ systemPrompt: finalSystem })]],
						]),
					},
				]
			: []),
	] as unknown as ConstructorParameters<typeof ExtensionRunner>[0];
	const runner = new ExtensionRunner(
		extensions,
		{} as never,
		process.cwd(),
		{} as never,
		{} as never,
	);
	runner.onError((error) => runnerErrors.push(error));
	return {
		db,
		id,
		observedUpstream,
		setFinalPrompt(prompt: string) {
			finalSystem = prompt;
		},
		async pass(upstream: string, percent = 64) {
			const started = await runner.emitBeforeAgentStart("task", undefined, {
				cwd: process.cwd(),
				forceSystemPrompt: upstream,
			});
			expect(runnerErrors).toEqual([]);
			effectiveSystem = started.systemPromptOptions.forceSystemPrompt ?? "";
			updateSessionMeta(db, id, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: percent,
				lastInputTokens: percent * 1000,
			});
			const messages = structuredClone(raw);
			const ctx = {
				...fakeContext(
					id,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				model,
				getSystemPrompt: () => effectiveSystem,
				getContextUsage: () => ({
					tokens: percent * 1000,
					percent,
					contextWindow: 100_000,
				}),
			};
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler was not registered");
			const result = (await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			};
			return structuredClone(
				convertMessages(
					model as never,
					{
						systemPrompt: ctx.getSystemPrompt(),
						messages: result.messages,
					} as never,
					{ supportsDeveloperRole: false } as never,
				),
			);
		},
		queueAssistant() {
			const target = getTagsBySession(db, id).find(
				(tag) => tag.type === "message" && tag.messageId.includes("entry-13"),
			);
			if (!target) throw new Error("missing queued assistant text");
			queuePendingOp(db, id, target.tagNumber, "drop");
		},
		queue() {
			const target = getTagsBySession(db, id).find(
				(tag) => tag.type === "tool" && tag.messageId === "call-2",
			);
			if (!target) throw new Error("missing queued tool result");
			queuePendingOp(db, id, target.tagNumber, "drop");
		},
		close() {
			clearContextHandlerSession(id);
			clearPiSystemPromptSession(id);
			db.close();
		},
	};
}

test("identical effective Pi system bytes with a later extension override must not admit queued drops", async () => {
	const h = harness(true);
	try {
		const previous = await h.pass("Upstream instructions one.");
		h.queue();
		const next = await h.pass("Upstream instructions two.");
		expect(h.observedUpstream).toEqual([
			"Upstream instructions one.",
			"Upstream instructions two.",
		]);
		expect(next[0]).toEqual(previous[0]);
		const firstChangedWireMessage = previous.findIndex(
			(message, index) =>
				JSON.stringify(message) !== JSON.stringify(next[index]),
		);
		expect({
			firstChangedWireMessage,
			pendingDrops: getPendingOps(h.db, h.id).length,
		}).toEqual({ firstChangedWireMessage: -1, pendingDrops: 1 });
		expect(next).toEqual(previous);
	} finally {
		h.close();
	}
});

test("a later extension changing effective Pi system bytes must carry queued drops even with an unchanged upstream hash", async () => {
	const h = harness(true);
	try {
		const previous = await h.pass("Upstream instructions one.");
		h.queue();
		h.setFinalPrompt("Changed effective system prompt.");
		const next = await h.pass("Upstream instructions one.");
		expect(h.observedUpstream).toEqual([
			"Upstream instructions one.",
			"Upstream instructions one.",
		]);
		expect(next[0]).not.toEqual(previous[0]);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
	} finally {
		h.close();
	}
});

test("a changed effective Pi system prompt still carries the queued drop", async () => {
	const h = harness(false);
	try {
		const previous = await h.pass("Upstream instructions one.");
		h.queue();
		const next = await h.pass("Upstream instructions two.");
		expect(next[0]).not.toEqual(previous[0]);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
	} finally {
		h.close();
	}
});

test("an unchanged upstream and effective Pi system prompt keeps the queued drop pending", async () => {
	const h = harness(true);
	try {
		const previous = await h.pass("Upstream instructions one.");
		h.queue();
		const next = await h.pass("Upstream instructions one.");
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(next).toEqual(previous);
	} finally {
		h.close();
	}
});

test("a no-op Pi history refresh must not first-strip a served assistant drop placeholder", async () => {
	const h = harness(false);
	let drainAllowed: boolean | undefined;
	const restore = contextInternals.setMutationGateObserverForTests((state) => {
		drainAllowed = state.shouldApplyPendingOps;
	});
	try {
		await h.pass("Fixed upstream instructions.");
		h.queueAssistant();
		// Force can commit a drop without discovering tiny assistant shells.
		// A later refresh must not prune the served shell while the shared gate is closed.
		const forced = await h.pass("Fixed upstream instructions.", 86);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
		expect(JSON.stringify(forced)).toContain("[dropped");
		const previous = await h.pass("Fixed upstream instructions.");
		expect(previous).toEqual(forced);
		signalPiHistoryRefresh(h.id);
		const next = await h.pass("Fixed upstream instructions.");
		expect(drainAllowed).toBe(false);
		expect(next[0]).toEqual(previous[0]);
		const firstChangedWireMessage = previous.findIndex(
			(message, index) =>
				JSON.stringify(message) !== JSON.stringify(next[index]),
		);
		expect(firstChangedWireMessage).toBe(-1);
		expect(next).toEqual(previous);
	} finally {
		restore();
		h.close();
	}
});
