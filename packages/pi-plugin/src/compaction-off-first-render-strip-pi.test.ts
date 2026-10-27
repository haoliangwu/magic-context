// Pi compaction-off: the thinking strip a first render takes when it changes
// the head in front of an open signed turn (no cached m[0]/m[1] to replay).
// The strip must replay on every later pass, a restart included, and later
// steps keep their own thinking; a first render that reproduces the served
// head keeps the turn's thinking.
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { clearCachedM0M1 } from "@magic-context/core/features/magic-context/storage-meta-shared";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { bumpEpochsForWorkspaceMembers } from "@magic-context/core/features/magic-context/workspaces";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
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
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const MODEL = "claude-opus-5-5";

async function withSession(
	sessionId: string,
	body: (s: {
		db: ReturnType<typeof createTestDb>;
		step: (n: number) => void;
		pass: () => Promise<unknown[]>;
		restart: () => void;
		editMemory: (content: string) => void;
	}) => Promise<void>,
) {
	const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-pi-off-strip-"));
	const originalXdg = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = xdg;
	const db = createTestDb();
	try {
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const register = () => {
			const fake = createFakePi();
			registerPiContextHandler(
				fake.pi as never,
				{
					db,
					tagger: createTagger(),
					compactionOff: true,
					injection: {
						injectionBudgetTokens: 2000,
						memoryEnabled: true,
						injectDocs: false,
					},
					scheduler: { executeThresholdPercentage: 65 },
				} as never,
			);
			return fake.handlers.get("context")!;
		};
		let handler = register();
		const source: PiMessage[] = [userMessage("task", 1)];
		const ids = ["task"];
		await body({
			db,
			step: (n) => {
				source.push(
					assistantMessage("", 10 + 2 * n, {
						provider: "anthropic",
						model: MODEL,
						api: "anthropic-messages",
						content: [
							{
								type: "thinking",
								thinking: `thought ${n}`,
								thinkingSignature: `sig-${n}`,
							},
							{
								type: "toolCall",
								id: `call-${n}`,
								name: "read",
								arguments: { path: `${n}.ts` },
							},
						],
					}),
					toolResultMessage(`call-${n}`, `result ${n}`, 11 + 2 * n),
				);
				ids.push(`step-${n}`, `result-${n}`);
			},
			pass: async () => {
				const messages = structuredClone(source);
				const ctx = {
					...fakeContext(sessionId, process.cwd(), [...ids], messages),
					model: {
						provider: "anthropic",
						id: MODEL,
						api: "anthropic-messages",
						contextWindow: 200_000,
					},
					getContextUsage: () => ({
						tokens: 20_000,
						percent: 10,
						contextWindow: 200_000,
					}),
				};
				return (
					(await handler({ messages } as never, ctx as never)) as {
						messages: unknown[];
					}
				).messages;
			},
			restart: () => {
				clearContextHandlerSession(sessionId);
				handler = register();
			},
			editMemory: (content) => {
				const identity = (
					db
						.prepare(
							"SELECT cached_m0_project_identity AS id FROM session_meta WHERE session_id = ?",
						)
						.get(sessionId) as { id: string | null }
				).id as string;
				insertMemory(db, {
					projectPath: identity,
					category: "PROJECT_RULES",
					content,
					importance: 90,
				});
				bumpEpochsForWorkspaceMembers(db, identity);
			},
		});
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdg;
		rmSync(xdg, { recursive: true, force: true });
	}
}

const signatures = (messages: unknown[]) =>
	[
		...JSON.stringify(messages).matchAll(/"thinkingSignature":"(sig-\d+)"/g),
	].map((match) => match[1]);

test("Pi compaction-off replays a first render's thinking strip on later passes and after a restart", async () => {
	const sessionId = "pi-off-first-render-strip-replay";
	await withSession(sessionId, async (s) => {
		await s.pass();
		s.step(1);
		await s.pass();
		s.step(2);
		await s.pass();
		s.editMemory("OFF-STRIP-MEMORY: keep functions small");
		clearCachedM0M1(s.db, sessionId);
		s.step(3);
		const stripped = await s.pass();
		expect(signatures(stripped)).toEqual([]);
		const ledger = [...getMergedReasoningStrippedIds(s.db, sessionId)];
		expect(ledger).toEqual(
			expect.arrayContaining([
				"binding_mismatch:step-1",
				"binding_mismatch:step-3",
				"binding_mismatch_order:end",
			]),
		);
		s.step(4);
		const later = await s.pass();
		expect(signatures(later)).toEqual(["sig-4"]);
		// The head is the one the strip went out with.
		expect(JSON.stringify(later.slice(0, 2))).toBe(
			JSON.stringify(stripped.slice(0, 2)),
		);
		s.restart();
		s.step(5);
		const restarted = await s.pass();
		expect(signatures(restarted)).toEqual(["sig-4", "sig-5"]);
	});
});

test("Pi compaction-off keeps a first render's thinking when the head is unchanged", async () => {
	const sessionId = "pi-off-first-render-same-head";
	await withSession(sessionId, async (s) => {
		await s.pass();
		s.step(1);
		await s.pass();
		clearCachedM0M1(s.db, sessionId);
		s.step(2);
		const out = await s.pass();
		expect(signatures(out)).toEqual(["sig-1", "sig-2"]);
	});
});
