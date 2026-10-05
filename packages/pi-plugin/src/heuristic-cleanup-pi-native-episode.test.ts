import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	addNativeReasoningIds,
	getNativeReasoningIds,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const model = {
	id: "native-upgrade-codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	contextWindow: 100_000,
	compat: {
		requiresReasoningContentForAllAssistantTurns: false,
		requiresReasoningContentForToolCalls: false,
	},
};

function fixture(sessionId: string, dbPath: string) {
	const db = createTestDb(dbPath);
	let closed = false;
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		injection: { injectionBudgetTokens: 10_000 },
		heuristics: { clearReasoningAge: 100 },
		scheduler: { executeThresholdPercentage: 80 },
	});
	const sample = () =>
		(
			db
				.prepare(
					"SELECT last_emergency_input_sample AS sample FROM session_meta WHERE session_id=?",
				)
				.get(sessionId) as { sample: number }
		).sample;
	const pass = async (percent: number, late = false, tailTurns = 24) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastInputTokens: percent * 1000,
			lastContextPercentage: percent,
			lastUsageContextLimit: 100_000,
		});
		const messages = [
			userMessage("first", 1),
			assistantMessage("visible answer", 2, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: model.provider,
					dt: true,
					items: [
						{ type: "reasoning", encrypted_content: "old cipher", summary: [] },
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "visible answer" }],
						},
					],
				},
			}),
			userMessage("continue", 3),
		];
		const ids = ["entry-user", "entry-old", "entry-next"];
		if (late) {
			messages.push(
				assistantMessage("", 4, {
					content: [
						{
							type: "toolCall",
							id: "late-bash",
							name: "bash",
							arguments: { command: "echo large" },
						},
					],
				}),
				{
					...toolResultMessage("late-bash", "late mass ".repeat(15000), 5),
					toolName: "bash",
				},
				userMessage("continue after tool", 6),
			);
			ids.push("entry-late-assistant", "entry-late-result", "entry-late-user");
			for (let i = 0; i < tailTurns; i++) {
				messages.push(
					assistantMessage(`later answer ${i}`, 7 + i * 2),
					userMessage(
						`later question ${i} ${"padding ".repeat(500)}`,
						8 + i * 2,
					),
				);
				ids.push(`later-a-${i}`, `later-u-${i}`);
			}
		}
		const handler = fake.handlers.get("context") as (
			event: unknown,
			context: unknown,
		) => Promise<{ messages: unknown[] }>;
		const result = await handler(
			{ messages },
			{
				...fakeContext(sessionId, process.cwd(), ids, messages),
				model,
				getContextUsage: () => ({
					percent,
					tokens: percent * 1000,
					contextWindow: 100_000,
				}),
			},
		);
		return result.messages;
	};
	return {
		db,
		sample,
		pass,
		seedLegacy: async () => {
			await pass(0);
			// A local-only cleanup predates native replay activation. Its durable watermark
			// must not authorize changing the retained ciphertext on a deferred pass.
			updateSessionMeta(db, sessionId, {
				clearedReasoningThroughTag: Math.max(
					...getTagsBySession(db, sessionId).map((t) => t.tagNumber),
				),
			});
		},
		close: () => {
			clearContextHandlerSession(sessionId);
			if (!closed) {
				db.close();
				closed = true;
			}
		},
	};
}

for (const latchControl of [false, true]) {
	const name = latchControl
		? "persisted latch control prevents a second tool batch"
		: "native-only force batch consumes the shared episode";
	test(name, async () => {
		const sessionId = `native-force-${latchControl}`;
		const childDb = process.env.MC_NATIVE_EPISODE_RESTART_DB;
		const directory = childDb
			? dirname(childDb)
			: createTestTempDirFromPath(join(tmpdir(), "pi-native-episode-"));
		const dbPath = childDb ?? join(directory, "context.db");
		const f = fixture(sessionId, dbPath);
		try {
			if (childDb) {
				const second = await f.pass(90, true);
				const lateTag = getTagsBySession(f.db, sessionId).find(
					(t) => t.messageId === "late-bash",
				);
				expect(lateTag?.status).toBe("active");
				expect(JSON.stringify(second)).toContain("late mass late mass");
				expect(f.sample()).toBe(90000);
				return;
			}
			await f.seedLegacy();
			expect(JSON.stringify(await f.pass(0))).toContain("old cipher");
			expect(JSON.stringify(await f.pass(90))).not.toContain("old cipher");
			expect(getNativeReasoningIds(f.db, sessionId).has("entry-old")).toBe(
				true,
			);
			// Supply only the expected durable latch in the control. An independent HARD
			// or the >=95% escape would still reclaim the later tool despite this write.
			if (latchControl)
				f.db
					.prepare(
						"UPDATE session_meta SET last_emergency_input_sample=90000 WHERE session_id=?",
					)
					.run(sessionId);
			expect(JSON.stringify(await f.pass(90, true, 4))).toContain(
				"late mass late mass",
			);
			f.close();
			const child = Bun.spawnSync(
				[process.execPath, "test", import.meta.path, "-t", name],
				{
					windowsHide: true,
					cwd: process.cwd(),
					env: { ...process.env, MC_NATIVE_EPISODE_RESTART_DB: dbPath },
					stdout: "pipe",
					stderr: "pipe",
					timeout: 30_000,
				},
			);
			if (child.exitCode !== 0) {
				console.error(new TextDecoder().decode(child.stdout));
				console.error(new TextDecoder().decode(child.stderr));
			}
			expect(child.exitCode).toBe(0);
		} finally {
			f.close();
			if (!childDb) rmSync(directory, { recursive: true, force: true });
		}
	}, 40_000);
}

for (const mode of ["replay-only", "failed-persistence", "defer"] as const) {
	test(`${mode} native reasoning does not consume a force episode`, async () => {
		const sessionId = `native-force-${mode}`;
		const f = fixture(sessionId, ":memory:");
		try {
			await f.seedLegacy();
			if (mode === "replay-only")
				addNativeReasoningIds(f.db, sessionId, ["entry-old"]);
			if (mode === "failed-persistence") {
				f.db.exec(`CREATE TRIGGER refuse_native_reasoning BEFORE UPDATE OF trailing_blank_decisions ON session_meta
     WHEN COALESCE(json_extract(NEW.trailing_blank_decisions, '$.piNative.reasoningIds'), '[]')
       != COALESCE(json_extract(NULLIF(OLD.trailing_blank_decisions, ''), '$.piNative.reasoningIds'), '[]')
     BEGIN SELECT RAISE(FAIL, 'native reasoning persistence refused'); END`);
			}
			const messages = await f.pass(mode === "defer" ? 0 : 90);
			expect(f.sample()).toBe(0);
			if (mode === "replay-only") {
				expect(JSON.stringify(messages)).not.toContain("old cipher");
			} else {
				expect(JSON.stringify(messages)).toContain("old cipher");
				expect(getNativeReasoningIds(f.db, sessionId).size).toBe(0);
				if (mode === "failed-persistence")
					f.db.exec("DROP TRIGGER refuse_native_reasoning");
				expect(JSON.stringify(await f.pass(90))).not.toContain("old cipher");
				expect(f.sample()).toBe(90000);
			}
		} finally {
			f.close();
		}
	});
}
