// Pi compaction-off mode has no bust permission, so nothing can strip signed
// thinking there. A fold it still runs (a project memory change, for example)
// would re-render m[0] in front of an open signed turn's kept thinking on a
// prefix-bound model. Such a turn keeps replaying its cached m[0]/m[1] until it
// ends, the same blanket hold OpenCode keeps in compaction-off.
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
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

test("Pi compaction-off keeps m[0] frozen in front of an open signed turn on a prefix-bound model", async () => {
	const sessionId = "pi-compaction-off-signed-hold";
	const xdg = createTestTempDirFromPath(
		join(tmpdir(), "mc-pi-compaction-off-hold-"),
	);
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
		const handler = fake.handlers.get("context")!;
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
		const head = (messages: unknown[]) => JSON.stringify(messages.slice(0, 2));
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
		// A project memory changes while the signed turn is open: m[0] is due to fold.
		insertMemory(db, {
			projectPath: identity as string,
			category: "PROJECT_RULES",
			content: "COMPACTION-OFF-NEW-MEMORY: keep functions small",
			importance: 90,
		});
		bumpEpochsForWorkspaceMembers(db, identity as string);
		step(2);
		const held = await pass();
		expect(JSON.stringify(held)).toContain('"sig-1"');
		expect(head(held)).toBe(head(before));
		expect(JSON.stringify(held)).not.toContain("COMPACTION-OFF-NEW-MEMORY");
		// Positive control: once a real user ends the turn the fold lands.
		source.push(userMessage("next task", 99));
		ids.push("next");
		const released = await pass();
		expect(JSON.stringify(released)).toContain("COMPACTION-OFF-NEW-MEMORY");
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdg;
		rmSync(xdg, { recursive: true, force: true });
	}
}, 60_000);
