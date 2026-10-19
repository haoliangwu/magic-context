import { expect, test } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

test("Pi binding recovery refuses second and third rejections across restart without resending bytes", async () => {
	const db = createTestDb();
	const sessionId = "pi-binding-third-rejection";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		heuristics: {},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	const thought = (thinking: string) => ({
		type: "thinking",
		thinking,
		thinkingSignature: `sig-${thinking}`,
	});
	const raw = [
		userMessage("head", 1),
		assistantMessage("old answer", 2, {
			content: [thought("old"), { type: "text", text: "old answer" }],
		}),
		userMessage("run tool", 3),
		assistantToolCall("active", "Read", { path: "file" }, 4),
		toolResultMessage("active", "result", 5),
	];
	(raw[3] as { content: unknown[] }).content.unshift(thought("active"));
	const pass = async (input = raw) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastInputTokens: 40000,
			lastContextPercentage: 40,
		});
		const messages = structuredClone(input);
		const ctx = fakeContext(
			sessionId,
			"/synthetic/pi-binding",
			messages.map((m) => `entry-${m.timestamp}`),
			messages,
		);
		Object.assign(ctx, {
			getSystemPrompt: () => "Synthetic binding recovery system.",
			model: {
				provider: "anthropic",
				id: "claude-opus-5-5",
				api: "anthropic-messages",
				contextWindow: 1000000,
				maxTokens: 10000,
			},
			getContextUsage: () => ({
				tokens: 400000,
				percent: 40,
				contextWindow: 1000000,
			}),
		});
		return handler({ messages: messages as never[] }, ctx as never);
	};
	const reject = () =>
		expect(
			handlePiProviderFailure({
				db,
				sessionId,
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-opus-5-5",
					errorMessage:
						"400 invalid_request_error: thinking block is bound to a different conversation",
				},
			}),
		).toEqual({ kind: "thinking_binding", armed: true });
	try {
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		await pass([raw[0]]);
		const failed = await pass();
		expect(JSON.stringify(failed)).toContain(
			'"thinkingSignature":"sig-active"',
		);
		reject();
		const retry = await pass();
		expect(retry).toBeDefined();
		expect(retry).not.toEqual(failed);
		expect(JSON.stringify(retry)).not.toContain('"type":"thinking"');
		// The saved thinking removals must stop retries even after the handler loses its in-memory state.
		for (let rejection = 2; rejection <= 3; rejection++) {
			reject();
			clearContextHandlerSession(sessionId);
			await expect(pass()).rejects.toMatchObject({
				name: "PiThinkingBindingRecoveryRefusal",
				code: "pi_thinking_binding_no_valid_shape",
			});
		}
	} finally {
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});
