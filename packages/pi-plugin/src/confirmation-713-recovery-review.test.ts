/**
 * Failing witnesses for queued drops after a degraded pass that was served
 * from the last-known-good (LKG) request copy. Cache invariant under test:
 * automatic drops may only ride a pass that already rewrites the provider's
 * cached request prefix; they must never cause a rewrite of their own.
 *
 * Scenario on every host: a drop is queued, one pass fails internally and is
 * served from the LKG copy, then a genuine user flush drains the drop. The
 * drop becomes durable ("dropped", no pending operations), yet the flush pass
 * keeps sending the original message bytes. Two consequences are asserted:
 *
 * 1. After a process restart, the next ordinary warm pass (40%, no flush, no
 *    pressure, unchanged system prompt) renders "[dropped §1§]" for the first
 *    time. That rewrites the cached prefix on a pass with no other cause.
 * 2. Without a restart, later genuine busts (another flush, forced pressure)
 *    still do not render the drained drop, so the reclaim never reaches the
 *    provider until a model switch or restart.
 *
 * The control cases run the same steps without the degraded pass and pass.
 */

import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { createScheduler } from "@magic-context/core/features/magic-context/scheduler";
import { sessionDecisionCalibration } from "@magic-context/core/features/magic-context/session-decision-calibration";
import {
	closeDatabase,
	getPendingOps,
	getTagsBySession,
	openDatabase,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	beginV2LkgRequest,
	clearLkgMeasuredRequest,
	noteLkgProviderResponse,
} from "@magic-context/core/hooks/magic-context/lkg-measured-request";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { requestPendingMaterialization } from "@magic-context/core/hooks/magic-context/pending-materialization";
import { prewarmTagOwners } from "@magic-context/core/hooks/magic-context/tag-owner-warmup";
import {
	createTransform,
	type TransformDeps,
} from "@magic-context/core/hooks/magic-context/transform";
import * as transformOperations from "@magic-context/core/hooks/magic-context/transform-operations";
import { createMessagesTransformHandler } from "@magic-context/core/plugin/messages-transform";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import { bindV2SystemPromptResponse } from "@magic-context/core/v2/hooks/system-prompt-response";
import type { StoreRow } from "@magic-context/core/v2/store-reader";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

type Host = "pi" | "opencode" | "opencode2";

interface Driver {
	/** Serves one request and returns a snapshot of the bytes sent. */
	pass(percent?: number): Promise<unknown>;
	/** Serves one request whose preparation fails before the pipeline runs. */
	degradedPass(): Promise<unknown>;
	flush(): void;
	/** Drops process memory (tagger, transform, LKG slots); keeps the database. */
	restart(): void;
	/** Whether the last Pi pass was allowed to apply pending operations. */
	lastPiPermission(): boolean | undefined;
	/** Waits for startup tag-owner indexing that can still hold the SQLite writer. */
	waitForTagOwnerWarmup(): Promise<void>;
	db: ReturnType<typeof createTestDb>;
	sessionId: string;
	close(): void;
}

function piDriver(label: string): Driver {
	const { dir } = createTestTempDir("confirmation-713-pi-");
	_resetHarnessForTesting();
	const db = createTestDb(join(dir, "context.db"));
	const sessionId = `confirmation-713-pi-${label}`;
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	const register = () =>
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: {
				injectionBudgetTokens: 1000,
				memoryEnabled: false,
				injectDocs: false,
			},
			scheduler: { executeThresholdPercentage: 65 },
		});
	register();
	let allowed: boolean | undefined;
	const restoreObserver = __test.setMutationGateObserverForTests((state) => {
		allowed = state.shouldApplyPendingOps;
	});
	const source = [
		userMessage("original task", 1),
		assistantToolCall("read-1", "Read", { path: "a.ts" }, 2),
		toolResultMessage("read-1", "unchanged result", 3),
		userMessage("follow-up", 4),
	];
	const model = {
		provider: "test",
		id: "test-model",
		api: "openai-completions",
		contextWindow: 200000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		name: "confirmation-review",
	};
	Object.assign(source[1]!, {
		provider: model.provider,
		model: model.id,
		api: model.api,
	});
	const pass = async (percent = 40) => {
		allowed = undefined;
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(
				sessionId,
				dir,
				messages.map((_, i) => `entry-${i}`),
				messages,
			),
			getSystemPrompt: () => "Fixed final instructions.",
			model,
			getContextUsage: () => ({
				tokens: percent * 2000,
				percent,
				contextWindow: 200000,
			}),
		};
		const result = (await fake.handlers.get("context")!(
			{ messages } as never,
			ctx as never,
		)) as { messages: unknown[] };
		await new Promise((resolve) => setImmediate(resolve));
		// Serialize the request as the provider adapter would send it.
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
	};
	return {
		db,
		sessionId,
		pass,
		async degradedPass() {
			let reached = false;
			const restore = __test.setBeforePipelineForTests(async () => {
				reached = true;
				throw new Error("isolated recovery fault");
			});
			try {
				const served = await pass();
				expect(reached).toBe(true);
				return served;
			} finally {
				restore();
			}
		},
		flush: () => signalPiPendingMaterialization(sessionId, "user_flush"),
		async waitForTagOwnerWarmup() {},
		restart() {
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			register();
		},
		lastPiPermission: () => allowed,
		close() {
			restoreObserver();
			clearContextHandlerSession(sessionId);
			db.close();
			cleanupTestTempDir(dir);
		},
	};
}

function openCodeDriver(host: "opencode" | "opencode2", label: string): Driver {
	_resetHarnessForTesting();
	const { dir } = createTestTempDir("confirmation-713-oc-");
	const oldTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
	const oldXdgDataHome = process.env.XDG_DATA_HOME;
	process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
	process.env.XDG_DATA_HOME = dir;
	setHarness(host);
	const storageDir = join(dir, "cortexkit", "magic-context");
	mkdirSync(storageDir, { recursive: true });
	const db = openDatabase(join(storageDir, "context.db"));
	if (!db) throw new Error("Could not open isolated OpenCode test database");
	const sessionId = `confirmation-713-${host}-${label}`;
	const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
	const modelKey = `${model.providerID}/${model.modelID}`;
	const project = "/nonexistent-confirmation-713-project";
	const responseRows: StoreRow<"assistant">[] = [];
	updateSessionMeta(db, sessionId, {
		cacheTtl: "59m",
		lastResponseTime: Date.now(),
	});
	const deps: TransformDeps = {
		db,
		tagger: createTagger(),
		scheduler: createScheduler({ executeThresholdPercentage: 65 }),
		contextUsageMap: new Map(),
		protectedTokens: 0,
		historyRefreshSessions: new Set(),
		pendingMaterializationSessions: new Set(),
		deferredHistoryRefreshSessions: new Set(),
		deferredMaterializationSessions: new Set(),
		lastHeuristicsTurnId: new Map(),
		liveModelBySession: new Map([[sessionId, model]]),
		getModelKey: () => modelKey,
		directory: project,
		projectPath: project,
		sessionDirectoryBySession: new Map([[sessionId, project]]),
		historianRunnable: false,
		memoryConfig: {
			enabled: false,
			injectionBudgetTokens: 1000,
			autoPromote: false,
		},
		client: {
			session: { get: async () => ({ data: { directory: project } }) },
		} as unknown as TransformDeps["client"],
		...(host === "opencode2"
			? {
					storeGeneration: "v2" as const,
					hostCleanupCompactionMarkers: () => ({
						verified: true,
						removedLineages: 0,
						removedRows: 0,
						retainedLineages: 0,
					}),
				}
			: {}),
	};
	const source = [
		{
			info: {
				id: "user-1",
				role: "user",
				sessionID: sessionId,
				time: { created: 1 },
				model,
			},
			parts: [{ type: "text", text: "original task" }],
		},
		{
			info: {
				id: "assistant-2",
				role: "assistant",
				sessionID: sessionId,
				time: { created: 2 },
				providerID: model.providerID,
				modelID: model.modelID,
				finish: "stop",
			},
			parts: [{ type: "text", text: "original answer" }],
		},
		{
			info: {
				id: "user-3",
				role: "user",
				sessionID: sessionId,
				time: { created: 3 },
				model,
			},
			parts: [{ type: "text", text: "follow-up" }],
		},
	] as unknown as transformOperations.MessageLike[];
	let transform = createTransform(deps);
	const handler = createMessagesTransformHandler({
		magicContext: {
			"experimental.chat.messages.transform": (input, output) =>
				transform(input, output),
		},
	});
	let passNumber = 0;
	const pass = async (percent = 40) => {
		const n = ++passNumber;
		updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
		deps.contextUsageMap.set(sessionId, {
			usage: { percentage: percent, inputTokens: percent * 2000 },
			updatedAt: Date.now(),
		});
		// Request identity and provider completion let the LKG copy be committed.
		if (host === "opencode2")
			beginV2LkgRequest(
				sessionId,
				modelKey,
				`response-${n - 1}`,
				responseRows.length,
			);
		else
			noteLkgProviderResponse({
				sessionId,
				responseId: `response-${n}`,
				modelKey,
				inputTokens: 0,
			});
		const output = { messages: structuredClone(source) };
		await handler({}, output as never);
		// Snapshot the request bytes before a later pass can reuse the objects.
		const served = JSON.parse(
			JSON.stringify(
				output.messages.map((m) => ({ role: m.info.role, parts: m.parts })),
			),
		);
		if (host === "opencode2") {
			responseRows.push({
				id: `response-${n}`,
				session_id: sessionId,
				type: "assistant",
				seq: responseRows.length + 1,
				data: {
					model: { providerID: model.providerID, id: model.modelID },
					time: { created: Date.now() + 1 },
				},
			} as never);
			bindV2SystemPromptResponse(sessionId, {
				assistantSince: (_session, after) =>
					responseRows.filter((row) => row.seq > after),
			});
		}
		noteLkgProviderResponse({
			sessionId,
			responseId: `response-${n}`,
			modelKey,
			inputTokens: 2000,
			finish: "stop",
			completedAt: Date.now() + 1,
			createdAt: Date.now() + 1,
			v2: host === "opencode2",
		});
		await new Promise((resolve) => setImmediate(resolve));
		return served;
	};
	return {
		db,
		sessionId,
		pass,
		async degradedPass() {
			const fault = spyOn(
				transformOperations,
				"applyFlushedStatuses",
			).mockImplementationOnce(() => {
				throw new Error("isolated recovery fault");
			});
			try {
				return await pass();
			} finally {
				fault.mockRestore();
			}
		},
		flush: () =>
			requestPendingMaterialization(
				deps.pendingMaterializationSessions!,
				sessionId,
				"user_flush",
			),
		async waitForTagOwnerWarmup() {
			await prewarmTagOwners(
				db,
				sessionId,
				sessionDecisionCalibration(db, sessionId).proseRatio,
			);
		},
		restart() {
			deps.tagger = createTagger();
			deps.lastHeuristicsTurnId?.clear();
			resetLkgSlotsForTest();
			transform = createTransform(deps);
		},
		lastPiPermission: () => undefined,
		close() {
			clearLkgMeasuredRequest(sessionId);
			closeDatabase();
			if (oldTestDataDir === undefined)
				delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
			else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = oldTestDataDir;
			if (oldXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = oldXdgDataHome;
			cleanupTestTempDir(dir);
			_resetHarnessForTesting();
		},
	};
}

const drivers: Record<Host, (label: string) => Driver> = {
	pi: piDriver,
	opencode: (label) => openCodeDriver("opencode", label),
	opencode2: (label) => openCodeDriver("opencode2", label),
};

/** Queues a drop on the first user message, then optionally serves one degraded pass. */
async function queueDrop(driver: Driver, degraded: boolean) {
	const initial = await driver.pass();
	// The first pass starts a background tag-owner warm-up. Wait for its actual
	// completion before the separate flush pass so the test does not race its writer.
	await driver.waitForTagOwnerWarmup();
	const target = getTagsBySession(driver.db, driver.sessionId).find(
		(tag) => tag.type === "message" && tag.tagNumber === 1,
	);
	if (!target) throw new Error("missing original user tag");
	queuePendingOp(driver.db, driver.sessionId, target.tagNumber, "drop");
	if (degraded) expect(await driver.degradedPass()).toEqual(initial);
	return target.tagNumber;
}

function expectDrained(driver: Driver, tagNumber: number) {
	expect(getPendingOps(driver.db, driver.sessionId)).toHaveLength(0);
	expect(
		getTagsBySession(driver.db, driver.sessionId).find(
			(tag) => tag.tagNumber === tagNumber,
		)?.status,
	).toBe("dropped");
}

for (const host of ["pi", "opencode", "opencode2"] as const) {
	test(`${host} control: without a degraded pass, a flush renders the drop and a warm restart replays it`, async () => {
		const driver = drivers[host]("control");
		try {
			const tagNumber = await queueDrop(driver, false);
			driver.flush();
			const admitted = await driver.pass(66);
			expectDrained(driver, tagNumber);
			expect(JSON.stringify(admitted)).toContain("[dropped §1§]");
			driver.restart();
			expect(await driver.pass()).toEqual(admitted);
		} finally {
			driver.close();
		}
	});

	test(`${host}: a warm restart after degraded-pass recovery must not first-render a drained drop`, async () => {
		const driver = drivers[host]("restart");
		try {
			const tagNumber = await queueDrop(driver, true);
			driver.flush();
			const admitted = await driver.pass(66);
			expectDrained(driver, tagNumber);
			expect(await driver.pass()).toEqual(admitted);
			driver.restart();
			const next = await driver.pass();
			// Ordinary warm pass: 40% context usage (below the 65% execute threshold),
			// no flush, same system prompt and model.
			if (host === "pi") expect(driver.lastPiPermission()).toBe(false);
			expect(next).toEqual(admitted);
		} finally {
			driver.close();
		}
	});

	test(`${host}: a forced pass after degraded-pass recovery must render the drained drop`, async () => {
		const driver = drivers[host]("liveness");
		try {
			const tagNumber = await queueDrop(driver, true);
			driver.flush();
			await driver.pass(66);
			expectDrained(driver, tagNumber);
			driver.flush();
			await driver.pass(40);
			// 86% context usage is above the 85% force threshold, so pending cleanup is
			// materialized; the already-dropped message must reach the provider.
			expect(JSON.stringify(await driver.pass(86))).toContain("[dropped §1§]");
		} finally {
			driver.close();
		}
	});
}
