/**
 * Adversarial reproduction: a Pi HARD fold whose only served-prefix change is
 * the mural image. Pi serves the mural as an image part in m[0], so the bust
 * predicate must compare the image as well as the m[0]/m[1] text; otherwise the
 * pass swaps the image the provider sees while reporting that the fold kept the
 * cached prefix, and the queued drop is withheld.
 */
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	computeCueContentHash,
	setMuralCue,
} from "@magic-context/core/features/magic-context/mural/storage-mural-cues";
import {
	getPendingOps,
	getTagsBySession,
	queueM0Mutation,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { bumpEpochsForWorkspaceMembers } from "@magic-context/core/features/magic-context/workspaces";
import {
	clearModelsDevCache,
	refreshModelLimitsFromApi,
} from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const SESSION = "ses-adv-pi-mural-only";
const MODEL = "anthropic/opus";
const ids = ["entry-user", "entry-call", "entry-result"];
const build = () =>
	[
		userMessage("start", 1),
		assistantToolCall("call-1", "bash", {}, 2),
		{ ...toolResultMessage("call-1", "x".repeat(4000), 3), toolName: "bash" },
	] as never[];

function imageOf(messages: unknown[]): string | null {
	const head = messages[0] as { content?: unknown } | undefined;
	if (!head || !Array.isArray(head.content)) return null;
	for (const part of head.content as Array<{ type?: string; data?: string }>) {
		if (part?.type === "image") return part.data ?? null;
	}
	return null;
}

describe("ADV Pi: mural-only HARD fold and the shared bust permission", () => {
	it("a fold that swaps only the mural image opens the lanes", async () => {
		const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-adv-pi-mural-"));
		const originalXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = xdg;
		clearModelsDevCache();
		const db = createTestDb();
		const gates: Array<Record<string, boolean>> = [];
		const restore = contextHandlerInternals.setMutationGateObserverForTests(
			(snapshot) => {
				gates.push(snapshot);
			},
		);
		try {
			// The mural needs a vision-capable model on record.
			await refreshModelLimitsFromApi({
				config: {
					providers: async () => ({
						data: {
							providers: [
								{
									id: "anthropic",
									models: {
										opus: {
											limit: { context: 200_000, input: 200_000 },
											modalities: { input: ["text", "image"] },
										},
									},
								},
							],
						},
					}),
				},
			} as never);
			updateSessionMeta(db, SESSION, {
				piStableIdScheme: 1,
				systemPromptHash: "sys-v1",
			});
			recordPiLiveModel(SESSION, MODEL);
			const fake = createFakePi();
			registerPiContextHandler(
				fake.pi as never,
				{
					db,
					protectedTags: 0,
					heuristics: {},
					injection: { injectionBudgetTokens: 400, muralEnabled: true },
					scheduler: { executeThresholdPercentage: 80 },
				} as never,
			);
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const pass = async () => {
				const messages = build();
				const out = await handler({ messages }, {
					...fakeContext(SESSION, process.cwd(), ids, messages),
					getContextUsage: () => ({
						tokens: 4_000,
						percent: 4,
						contextWindow: 100_000,
					}),
				} as never);
				return out.messages as unknown[];
			};

			await pass();
			const identity = (
				db
					.prepare(
						"SELECT cached_m0_project_identity AS id FROM session_meta WHERE session_id = ?",
					)
					.get(SESSION) as { id: string | null }
			).id;
			expect(identity).toBeTruthy();

			// Enough cued memories to pass the coverage gate, and more content
			// than the 400-token budget so most of them overflow into the mural.
			const memoryIds: number[] = [];
			for (let i = 0; i < 24; i++) {
				const content = `ADV_MURAL_MEMORY_${i}: ${"rule text ".repeat(20)}`;
				const memory = insertMemory(db, {
					projectPath: identity as string,
					category: "PROJECT_RULES",
					content,
					importance: 50,
				});
				memoryIds.push(memory.id);
				setMuralCue(
					db,
					identity as string,
					memory.id,
					`cue-a-${i}`,
					computeCueContentHash(content),
				);
			}
			bumpEpochsForWorkspaceMembers(db, identity as string);
			updateSessionMeta(db, SESSION, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 40,
				lastInputTokens: 4_000,
			});
			const withMural = await pass();
			const imageA = imageOf(withMural);
			const deferA = await pass();
			expect(JSON.stringify(deferA)).toBe(JSON.stringify(withMural));

			// Queue a drop, then change only the compressed cues (the
			// background compress-cues trickle does this at any time).
			const toolTag = getTagsBySession(db, SESSION).find(
				(tag) => tag.type === "tool",
			);
			if (!toolTag) throw new Error("expected a tool tag");
			queuePendingOp(db, SESSION, toolTag.tagNumber, "drop", 1);
			const rows = db
				.prepare("SELECT id, content FROM memories WHERE project_path = ?")
				.all(identity as string) as Array<{ id: number; content: string }>;
			for (const row of rows) {
				setMuralCue(
					db,
					identity as string,
					row.id,
					`cue-b-${row.id}`,
					computeCueContentHash(row.content),
				);
			}
			const heldDefer = await pass();
			expect(imageOf(heldDefer)).toBe(imageA);

			// A structural mutation-log entry arms a HARD that re-renders text
			// identically; the fold re-resolves the mural and picks up the new cues.
			queueM0Mutation(db, {
				sessionId: SESSION,
				mutationType: "compartment_delete",
			});
			gates.length = 0;
			const hard = await pass();
			const imageB = imageOf(hard);
			const summary = {
				imageBeforePresent: imageA !== null,
				imageAfterPresent: imageB !== null,
				imageChanged: imageA !== imageB,
				m0TextIdentical:
					textOf(hard[0] as never) === textOf(withMural[0] as never),
				m1TextIdentical:
					textOf(hard[1] as never) === textOf(withMural[1] as never),
				gate: gates[0],
				dropStatus: getTagsBySession(db, SESSION).find(
					(tag) => tag.tagNumber === toolTag.tagNumber,
				)?.status,
				pendingOps: getPendingOps(db, SESSION).length,
			};
			console.log("ADV_PI_MURAL_ONLY", JSON.stringify(summary));
			const after = await pass();
			console.log(
				"ADV_PI_MURAL_ONLY_AFTER",
				JSON.stringify({
					afterEqualsHard: JSON.stringify(after) === JSON.stringify(hard),
				}),
			);
			// The served prefix changed (the image), so the permission must open.
			expect(summary.imageChanged).toBe(true);
			expect(summary.gate?.foldExecuted).toBe(true);
			expect(summary.gate?.foldBustsServedPrefix).toBe(true);
		} finally {
			restore();
			clearContextHandlerSession(SESSION);
			closeQuietly(db);
			if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = originalXdg;
			clearModelsDevCache();
			rmSync(xdg, { recursive: true, force: true });
		}
	}, 60_000);
});
