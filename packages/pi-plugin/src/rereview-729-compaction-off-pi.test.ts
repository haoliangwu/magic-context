// Cache-safety witness for the bounded signed-thinking hold (issue 729).
//
// Pi compaction-off replays the cached m[0]/m[1] for an open signed turn on a
// prefix-bound model (its signatures stay valid only while every byte in front
// of them is unchanged). With no cached pair (cleared by a store rebase, a
// history repair or a migration) the first render proceeds; when it does not
// reproduce the head the last request carried, the turn's signed thinking must
// leave the wire with it. The case asserts that new head content never lands
// in front of kept signed thinking, so a red run means invalid signed thinking
// was served.
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
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

for (const restart of [false, true])
	test(`Pi compaction-off: a first render with no cached m[0]/m[1]${restart ? " after a restart" : ""} keeps new head content away from kept signed thinking`, async () => {
		const sessionId = `pi-rr729-off-first-${restart}`;
		const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-pi-rr729-"));
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
			const step = (n: number) => {
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
			};
			const pass = async () => {
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
			};
			const head = (messages: unknown[]) =>
				JSON.stringify(messages.slice(0, 2));
			await pass();
			step(1);
			const before = await pass();
			const identity = (
				db
					.prepare(
						"SELECT cached_m0_project_identity AS id FROM session_meta WHERE session_id = ?",
					)
					.get(sessionId) as { id: string | null }
			).id;
			expect(identity).toBeTruthy();
			insertMemory(db, {
				projectPath: identity as string,
				category: "PROJECT_RULES",
				content: "RR729-NEW-MEMORY: keep functions small",
				importance: 90,
			});
			bumpEpochsForWorkspaceMembers(db, identity as string);
			clearCachedM0M1(db, sessionId);
			if (restart) {
				clearContextHandlerSession(sessionId);
				handler = register();
			}
			step(2);
			const after = await pass();
			const served = JSON.stringify(after);
			console.log(
				`[rereview-729] pi off first-render restart=${restart} keepsSig1=${served.includes('"sig-1"')} newMemoryInHead=${head(after).includes("RR729-NEW-MEMORY")} headChanged=${head(after) !== head(before)}`,
			);
			// Valid outcomes: the head is unchanged, or the turn's thinking is gone.
			expect(served.includes('"sig-1"') && head(after) !== head(before)).toBe(
				false,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
			if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = originalXdg;
			rmSync(xdg, { recursive: true, force: true });
		}
	}, 60_000);
