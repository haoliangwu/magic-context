import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { __test as decisions } from "@magic-context/core/features/magic-context/transform-decision-log";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	frozenBindingEntryIds,
	handlePiProviderFailure,
} from "./provider-error-recovery-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const bindingError = {
	role: "assistant",
	provider: "anthropic",
	model: "claude-opus-5-5",
	errorMessage:
		'400 invalid_request_error: messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". Content before this block differs from when it was created, first at `messages.0.content.0`.',
};

for (const active of [false, true]) {
	// Signed thinking binds all preceding bytes, even blocks from earlier turns.
	test(`${active ? "WITNESS" : "CONTROL"}: binding 400 retry ${active ? "must not strip before kept active signed thinking" : "strips completed signed thinking"}`, async () => {
		const root = join(
			tmpdir(),
			"magic-context/pi-lkg-review",
			`binding-${active}`,
		);
		mkdirSync(root, { recursive: true });
		const path = join(root, "context.db");
		rmSync(path, { force: true });
		const db = createTestDb(path);
		const sessionId = `pi-binding-review-${active}`;
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
		const thinking = (text: string) => ({
			type: "thinking",
			thinking: text,
			thinkingSignature: `proof-${text}`,
		});
		const raw = [
			userMessage("head", 1),
			assistantMessage("old answer", 2, {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [
					thinking("old bound thought"),
					{ type: "text", text: "old answer" },
				],
			}),
			userMessage("run tool", 3),
			assistantToolCall("call-active", "Read", { path: "file" }, 4),
			toolResultMessage("call-active", "tool result", 5),
		];
		(raw[3] as { content: unknown[] }).content.unshift(
			thinking("active bound thought"),
		);
		Object.assign(raw[3], {
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
		});
		if (!active) raw.push(userMessage("next real user", 6));
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
				"/synthetic/pi-review",
				messages.map((m) => `entry-${m.timestamp}`),
				messages,
			);
			Object.assign(ctx, {
				getSystemPrompt: () => "Complete synthetic system.",
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
			const result = await handler(
				{ messages: messages as never[] },
				ctx as never,
			);
			expect(result).toBeDefined();
			await new Promise<void>((resolve) => setImmediate(resolve));
			return result?.messages ?? [];
		};
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			await pass([raw[0]]);
			const failed = await pass();
			expect(JSON.stringify(failed)).toContain("old bound thought");
			expect(JSON.stringify(failed)).toContain("active bound thought");
			expect(
				handlePiProviderFailure({ db, sessionId, message: bindingError }),
			).toEqual({ kind: "thinking_binding", armed: true });
			const retry = await pass();
			if (active) {
				expect(
					handlePiProviderFailure({ db, sessionId, message: bindingError }),
				).toEqual({ kind: "thinking_binding", armed: true });
				await expect(pass()).rejects.toMatchObject({
					name: "PiThinkingBindingRecoveryRefusal",
					code: "pi_thinking_binding_no_valid_shape",
				});
			}
			// Removing an older block changes the bytes bound by every later signature.
			if (active && JSON.stringify(retry).includes("active bound thought")) {
				const prefixBeforeActive = (messages: unknown[]) =>
					messages.slice(
						0,
						messages.findIndex((message) =>
							JSON.stringify(message).includes(
								'"thinkingSignature":"proof-active bound thought"',
							),
						),
					);
				expect(prefixBeforeActive(retry)).toEqual(prefixBeforeActive(failed));
			} else {
				expect(JSON.stringify(retry)).not.toContain("old bound thought");
				expect(JSON.stringify(retry)).not.toContain("active bound thought");
			}
		} finally {
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			db.close();
		}
	});
}

test("WITNESS: frozen unresolved thinking must not price cleanup on unchanged restart", async () => {
	const root = join(tmpdir(), "magic-context/pi-lkg-review/unresolved-restart");
	mkdirSync(root, { recursive: true });
	const path = join(root, "context.db");
	rmSync(path, { force: true });
	const db = createTestDb(path);
	const locker = new Database(path);
	const sessionId = "pi-unresolved-frozen-review";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		todowriteEnabled: true,
		protectedTags: 0,
		heuristics: {},
		injection: { injectionBudgetTokens: 10000 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	const raw = [
		userMessage("head", 1),
		assistantMessage("answer", 2, {
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{
					type: "thinking",
					thinking: "unresolved bound thought",
					thinkingSignature: "proof",
				},
				{ type: "text", text: "answer" },
			],
		}),
		userMessage("next real user", 3),
	];
	let gate: unknown;
	const restoreGate = __test.setMutationGateObserverForTests((value) => {
		gate = value;
	});
	const logs: string[] = [];
	const restoreLogs = __test.setLkgRecoveryLogObserverForTests((line) =>
		logs.push(line),
	);
	const pass = async (input = raw, busy = false) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastInputTokens: 76000,
			lastContextPercentage: 76,
		});
		const messages = structuredClone(input);
		const ctx = fakeContext(
			sessionId,
			"/synthetic/pi-review",
			messages.map((m) => `entry-${m.timestamp}`),
			messages,
		);
		const branch = ctx.sessionManager.getBranch();
		// Another extension can supply an assistant not owned by a SessionEntry.
		ctx.sessionManager.getBranch = () =>
			branch.filter((entry) => entry.message.timestamp !== 2);
		Object.assign(ctx, {
			getSystemPrompt: () => "Complete synthetic system.",
			model: {
				provider: "anthropic",
				id: "claude-opus-5-5",
				api: "anthropic-messages",
				contextWindow: 1000000,
				maxTokens: 10000,
			},
			getContextUsage: () => ({
				tokens: 760000,
				percent: 76,
				contextWindow: 1000000,
			}),
		});
		if (busy) {
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");
		}
		try {
			const result = await handler(
				{ messages: messages as never[] },
				ctx as never,
			);
			expect(result).toBeDefined();
			await new Promise<void>((resolve) => setImmediate(resolve));
			return result?.messages ?? [];
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			db.exec("PRAGMA busy_timeout=5000");
		}
	};
	try {
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		await pass([raw[0]]);
		await pass();
		signalPiPendingMaterialization(sessionId);
		const frozen = await pass();
		expect(JSON.stringify(frozen)).not.toContain("unresolved bound thought");
		expect(frozenBindingEntryIds(db, sessionId).size).toBeGreaterThan(0);
		const frozenIds = [...frozenBindingEntryIds(db, sessionId)];
		const replay = await pass(raw, true);
		expect(logs.join("\n")).toContain("LKG replay served");
		expect(replay).toEqual(frozen);
		updateSessionMeta(db, sessionId, {
			lastTodoState: JSON.stringify([
				{
					id: "todo-1",
					content: "Must wait for an actual byte rebuild",
					status: "pending",
					priority: "medium",
				},
			]),
		});
		clearContextHandlerSession(sessionId);
		const release = await pass();
		expect(decisions.getPendingPi(sessionId)?.lkgFrozenReleaseReason).toBe(
			"lkg_restart_rebuild",
		);
		console.info(
			"UNRESOLVED_RESTART_REVIEW",
			JSON.stringify({
				frozenIds,
				finalFrozenIds: [...frozenBindingEntryIds(db, sessionId)],
				gate,
				equalReplay: JSON.stringify(release) === JSON.stringify(replay),
				syntheticTodoAdded:
					JSON.stringify(release).includes("mc_synthetic_todo"),
			}),
		);
		expect(release).toEqual(replay);
		expect(gate).toMatchObject({
			shouldApplyPendingOps: false,
			shouldRunHeuristics: false,
			shouldRunReasoningCleanup: false,
		});
	} finally {
		restoreGate();
		restoreLogs();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		locker.close();
		db.close();
	}
});
