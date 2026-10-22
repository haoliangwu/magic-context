import { expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	THINKING_BINDING_STRIP_ORDER_END_MARKER,
	thinkingBindingRecoveryFrozenId,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { __test as decisionLogInternals } from "@magic-context/core/features/magic-context/transform-decision-log";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextInternals,
	registerPiContextHandler,
} from "./context-handler";
import { frozenBindingEntryIds } from "./provider-error-recovery-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

it("Sonnet 4.6 replays frozen thinking omissions on a recovery rebuild and its warm successor", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-frozen-thinking-"));
	const db = createTestDb(join(dir, "context.db"));
	const sessionId = "sonnet-frozen-thinking-rebuild";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, { db });
	const answer = assistantMessage("closed answer", 2);
	const source = [userMessage("head", 1), answer, userMessage("next turn", 3)];
	Object.assign(answer, {
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
	});
	(answer as { content: unknown[] }).content.unshift({
		type: "thinking",
		thinking: "previously omitted thought",
		thinkingSignature: "frozen-signature",
	});
	let signedPrefixRewritten = false;
	const restoreObserver = contextInternals.setPipelineResultObserverForTests(
		(_id, result) => {
			signedPrefixRewritten = result.signedPrefixRewritten;
		},
	);
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("Pi context handler was not registered");
	const pass = async (raw = source) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = structuredClone(raw);
		const ctx = fakeContext(
			sessionId,
			dir,
			["head", "answer", "next"],
			messages,
		);
		Object.assign(ctx, {
			getSystemPrompt: () => "Fixed system prompt.",
			getContextUsage: () => ({
				tokens: 80000,
				percent: 40,
				contextWindow: 200000,
			}),
			model: {
				provider: "anthropic",
				id: "claude-sonnet-4-6",
				contextWindow: 200000,
				maxTokens: 4096,
			},
		});
		const result = (await handler({ messages } as never, ctx as never)) as {
			messages: unknown[];
		};
		await new Promise((resolve) => setImmediate(resolve));
		return JSON.stringify(result.messages);
	};
	try {
		await pass();
		// Seed the durable result of an earlier permitted thinking strip. Raw host
		// history still contains the block, so later requests must replay its omission.
		expect(
			addMergedReasoningStrippedIds(db, sessionId, [
				thinkingBindingRecoveryFrozenId("answer"),
				THINKING_BINDING_STRIP_ORDER_END_MARKER,
			]),
		).toBe(true);
		const omitted = await pass();
		expect(omitted).not.toContain("frozen-signature");
		let faultReached = false;
		const restoreFault = contextInternals.setBeforePipelineForTests(
			async () => {
				faultReached = true;
				throw new Error("isolated recovery fault");
			},
		);
		try {
			expect(await pass()).toBe(omitted);
			expect(faultReached).toBe(true);
		} finally {
			restoreFault();
		}
		// Changing an input invalidates the recovery copy and requires a rebuild.
		const edited = [userMessage("edited head", 1), ...source.slice(1)];
		const rebuilt = await pass(edited);
		expect(
			decisionLogInternals.getPendingPi(sessionId)?.lkgFrozenReleaseReason,
		).toBe("lkg_recovery_input_rebuild");
		expect(signedPrefixRewritten).toBe(true);
		expect(rebuilt).not.toContain("previously omitted thought");
		expect(rebuilt).not.toContain("frozen-signature");
		const warm = await pass(edited);
		expect(warm).not.toContain("frozen-signature");
		expect(warm).toBe(rebuilt);
		expect(frozenBindingEntryIds(db, sessionId).has("answer")).toBe(true);
	} finally {
		restoreObserver();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
		cleanupTestTempDir(dir);
	}
});
