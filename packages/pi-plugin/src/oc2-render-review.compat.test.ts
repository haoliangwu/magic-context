import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MagicContextConfigSchema } from "../../plugin/src/config/schema/magic-context";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { createScheduler } from "../../plugin/src/features/magic-context/scheduler";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { createTagger } from "../../plugin/src/features/magic-context/tagger";
import { resolveCtxReduceAvailabilityFromMessages } from "../../plugin/src/hooks/magic-context/ctx-reduce-availability";
import { resetLkgSlotsForTest } from "../../plugin/src/hooks/magic-context/lkg-slot";
import { createSystemPromptHashHandler } from "../../plugin/src/hooks/magic-context/system-prompt-hash";
import { createTransform } from "../../plugin/src/hooks/magic-context/transform";
import { setHarness } from "../../plugin/src/shared/harness";
import * as modelCache from "../../plugin/src/shared/models-dev-cache";
import { createPromptSurfaceRuntime } from "../../plugin/src/shared/prompt-surface-runtime";
import { Database } from "../../plugin/src/shared/sqlite";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	composeMagicContextSystemPrompt,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	createFakePi,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// Run this same harness in each complete source tree, in separate processes.
// Only host delivery, clock and model catalog are synthetic; the processors and stores are real.
test.skipIf(!process.env.RENDER_REVIEW_ROOT)(
	"render review: 320 default OC1 and Pi passes against release snapshots",
	async () => {
		const root = process.env.RENDER_REVIEW_ROOT!;
		if (!root.includes("/magic-context/oc2-render-review/"))
			throw new Error("throwaway root required");
		const host = process.env.RENDER_REVIEW_HOST;
		if (host !== "oc1" && host !== "pi")
			throw new Error("one host per process required");
		setHarness(host === "oc1" ? "opencode" : "pi");
		const createReviewDb = (path: string) => {
			const db = new Database(path);
			initializeDatabase(db);
			runMigrations(db);
			return db;
		};
		const config = MagicContextConfigSchema.parse({});
		let now = 1770000000000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const vision = spyOn(modelCache, "modelSupportsVision").mockReturnValue(
			true,
		);
		const output: Record<string, unknown[]> = { oc1: [], pi: [] };
		let random = 4910;
		const next = () =>
			(random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
		const hashes = (db: ReturnType<typeof createReviewDb>, session: string) => {
			const tables = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as { name: string }[];
			return Object.fromEntries(
				tables.flatMap(({ name }) => {
					const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as {
						name: string;
					}[];
					const fields = columns
						.map((c) => c.name)
						.filter((n) => /hash|fingerprint/i.test(n));
					if (!fields.length || !columns.some((c) => c.name === "session_id"))
						return [];
					return [
						[
							name,
							db
								.prepare(
									`SELECT ${fields.map((n) => `"${n}"`).join(",")} FROM "${name}" WHERE session_id = ? ORDER BY rowid`,
								)
								.all(session),
						],
					];
				}),
			);
		};
		try {
			for (let seed = 0; seed < 20; seed++) {
				now = 1770000000000 + seed * 10000000;
				const db = createReviewDb(join(root, `default-${seed}.db`));
				const session = `render-default-${seed}`;
				const shared = {
					systemPromptRefreshSessions: new Set<string>(),
					historyRefreshSessions: new Set<string>(),
					pendingMaterializationSessions: new Set<string>(),
					lastHeuristicsTurnId: new Map<string, string>(),
				};
				const system = createSystemPromptHashHandler({
					db,
					dreamerEnabled: true,
					memoryEnabled: true,
					...shared,
					promptSurfaceRuntime: createPromptSurfaceRuntime({
						userConfigDirectory: root,
						warn: () => {},
					}),
				});
				const liveModels = new Map([
					[session, { providerID: "openai", modelID: "gpt-4.1" }],
				]);
				const transform = createTransform({
					db,
					tagger: createTagger(),
					...shared,
					scheduler: createScheduler({
						executeThresholdPercentage: config.execute_threshold_percentage,
					}),
					directory: root,
					projectPath: root,
					contextUsageMap: new Map([
						[
							session,
							{
								usage: { percentage: 10, inputTokens: 10000 },
								updatedAt: Date.now(),
							},
						],
					]),
					liveModelBySession: liveModels,
					hostRawMessages: () => [],
					hostPrepareRawOrdinals: async () => true,
					protectedTokens: config.protected_tokens,
					keepReasoningTokens: config.keep_reasoning_tokens,
					historyBudgetPercentage: config.history_budget_percentage,
					executeThresholdPercentage: config.execute_threshold_percentage,
					executeThresholdTokens: config.execute_threshold_tokens,
					injectDocs: config.dreamer?.inject_docs,
					memoryConfig: {
						enabled: config.memory.enabled,
						injectionBudgetTokens: config.memory.injection_budget_tokens,
						autoPromote: config.memory.auto_promote,
					},
					muralEnabled: config.mural.enabled,
					experimentalTemporalAwareness: config.temporal_awareness,
					autoSearch: {
						enabled: config.memory.auto_search.enabled,
						directory: root,
						scoreThreshold: config.memory.auto_search.score_threshold,
						minPromptChars: config.memory.auto_search.min_prompt_chars,
					},
				});
				const piDb = createReviewDb(join(root, `pi-default-${seed}.db`));
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, {
					db: piDb,
					protectedTokens: config.protected_tokens,
					heuristics: { keepReasoningTokens: config.keep_reasoning_tokens },
					injection: {
						memoryEnabled: config.memory.enabled,
						injectionBudgetTokens: config.memory.injection_budget_tokens,
						injectDocs: config.dreamer?.inject_docs,
						temporalAwareness: config.temporal_awareness,
						muralEnabled: config.mural.enabled,
					},
					autoSearch: {
						enabled: config.memory.auto_search.enabled,
						scoreThreshold: config.memory.auto_search.score_threshold,
						minPromptChars: config.memory.auto_search.min_prompt_chars,
					},
				});
				const handle = fake.handlers.get("context")!;
				const count = 4 + (next() % 8);
				const raw = Array.from({ length: count * 2 + 1 }, (_, n) => ({
					info: {
						id: `msg-${seed}-${n}`,
						sessionID: session,
						role: n % 2 ? "assistant" : "user",
						time: { created: 1700000000000 + n * 1000 },
					},
					parts: [
						{
							type: "text",
							text: `${next()} Please review the cache behavior. ${"Detail. ".repeat(1 + (next() % 40))}`,
						},
					],
				}));
				const piRaw = raw.map((m, n) =>
					n % 2
						? assistantMessage(m.parts[0]!.text, m.info.time.created)
						: userMessage(m.parts[0]!.text, m.info.time.created),
				);
				const ids = raw.map((m) => m.info.id);
				let epoch = 0;
				try {
					for (let pass = 0; pass < 16; pass++) {
						if (next() % 4 === 0) epoch++;
						if (next() % 5 === 0) now += 3600000;
						if (next() % 5 === 0)
							liveModels.set(session, {
								providerID: "openai",
								modelID: pass % 2 ? "gpt-4.1-mini" : "gpt-4.1",
							});
						if (pass > 0 && next() % 3 === 0) {
							for (const role of ["assistant", "user"]) {
								const id = `msg-${seed}-${raw.length}`;
								const text = `Next detail ${next()}`;
								raw.push({
									info: {
										id,
										sessionID: session,
										role,
										time: { created: now },
									},
									parts: [{ type: "text", text }],
								});
								piRaw.push(
									role === "user"
										? userMessage(text, now)
										: assistantMessage(text, now),
								);
								ids.push(id);
							}
						}
						const model = liveModels.get(session)!;
						const prompt = `You are a precise assistant. Seed ${seed}. Instruction epoch ${epoch}.\nToday's date is 2026-02-02.`;
						const head = { system: [prompt] };
						if (host === "oc1") {
							resolveCtxReduceAvailabilityFromMessages(session, raw);
							await system.handler({ sessionID: session, model }, head);
							const messages = { messages: structuredClone(raw) };
							await transform({}, messages);
							expect(
								getOrCreateSessionMeta(db, session).systemPromptHash,
							).toMatch(/^[0-9a-f]{32}$/);
							expect(
								getOrCreateSessionMeta(db, session).cachedM0SystemHash,
							).toMatch(/^[0-9a-f]{32}$/);
							output.oc1!.push({
								seed,
								pass,
								wire: JSON.stringify({
									model,
									system: head.system,
									messages: messages.messages,
									tools: {},
								}),
								hashes: hashes(db, session),
							});
						} else {
							const piSystem = processSystemPromptForCache({
								db: piDb,
								sessionId: session,
								systemPrompt: composeMagicContextSystemPrompt(
									prompt,
									buildMagicContextBlock({
										db: piDb,
										cwd: root,
										memoryEnabled: config.memory.enabled,
										dreamerEnabled: !config.dreamer?.disable,
										smartNotesEnabled: config.smart_notes.enabled,
									}),
								),
								isCacheBusting: false,
							});
							const piMessages = structuredClone(piRaw);
							const ctx = {
								...fakeContext(session, root, ids, piMessages),
								model: {
									provider: "openai",
									id: model.modelID,
									contextWindow: 1000000,
								},
								getContextUsage: () => ({
									tokens: 10000,
									percent: 1,
									contextWindow: 1000000,
								}),
							};
							const result = (await handle(
								{ messages: piMessages } as never,
								ctx as never,
							)) as { messages?: unknown[] } | undefined;
							output.pi!.push({
								seed,
								pass,
								wire: JSON.stringify({
									model,
									system: piSystem.systemPrompt,
									messages: result?.messages ?? piMessages,
									tools: {},
								}),
								hashes: hashes(piDb, session),
							});
							expect(
								getOrCreateSessionMeta(piDb, session).systemPromptHash,
							).toMatch(/^[0-9a-f]{32}$/);
							expect(
								getOrCreateSessionMeta(piDb, session).cachedM0SystemHash,
							).toMatch(/^[0-9a-f]{32}$/);
						}
					}
				} finally {
					clearContextHandlerSession(session);
					clearPiSystemPromptSession(session);
					system.clearSession(session);
					resetLkgSlotsForTest();
					db.close();
					piDb.close();
				}
			}
			expect(output[host]).toHaveLength(320);
			writeFileSync(process.env.RENDER_REVIEW_OUTPUT!, JSON.stringify(output));
			if (process.env.RENDER_REVIEW_EXPECT) {
				const baseline = JSON.parse(
					readFileSync(process.env.RENDER_REVIEW_EXPECT, "utf8"),
				);
				{
					const differences = output[host]!.flatMap((row, n) =>
						JSON.stringify(row) === JSON.stringify(baseline[host][n])
							? []
							: [n],
					);
					console.log(
						`RELEASE_COMPARISON ${host}: ${output[host]!.length} passes; changed=${JSON.stringify(differences)}`,
					);
					expect(differences, host).toEqual([]);
				}
			} else
				console.log(
					`RELEASE_SNAPSHOT ${host}=320; request bytes and every session-scoped persisted hash captured`,
				);
		} finally {
			vision.mockRestore();
			clock.mockRestore();
		}
	},
	120000,
);
