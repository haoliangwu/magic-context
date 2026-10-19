import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionContext } from "../../plugin/src/v2/hooks/types";

function evidenceRoot(): string {
	const root = process.env.REVIEW_OUTPUT;
	if (!root)
		throw new Error("REVIEW_OUTPUT is required for the opt-in fixture");
	return root;
}

const source = resolve(
	process.env.REVIEW_SOURCE ?? resolve(import.meta.dir, "../../.."),
);
const load = (path: string) => import(join(source, "packages", path));
const digest = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");
const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function fenceIo() {
	const operations: string[] = [];
	// The baseline predates recovery fences, so only a revision containing that
	// implementation can observe its file I/O. Both compare complete host output.
	if (
		!existsSync(
			join(
				source,
				"packages/plugin/src/hooks/magic-context/lkg-recovery-fence.ts",
			),
		)
	)
		return { operations, restore: () => {} };
	const { __test } = await load(
		"plugin/src/hooks/magic-context/lkg-recovery-fence.ts",
	);
	return {
		operations,
		restore: __test.setIoObserver((operation: string) =>
			operations.push(operation),
		),
	};
}

// A fixed PRNG seed makes two independent revisions receive identical raw bytes.
function corpusText(index: number): string {
	let state = (0x653641 + index * 7919) >>> 0;
	const atoms = [
		"plain",
		"λ",
		"日本語",
		"🙂",
		"\n",
		"\t",
		'"quoted"',
		"<xml>",
		"§literal§",
		"a\\b",
	];
	let text = `sample ${index}: `;
	for (let i = 0; i < 12 + (index % 31); i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		text += atoms[state % atoms.length];
	}
	return text;
}

// Opt-in review witness. Run baseline and candidate in separate processes and
// compare every complete output file directly, not a digest of a shared proxy.

test.skipIf(process.env.REVIEW_OUTPUT === undefined)(
	"review randomized no-busy Pi complete served bytes",
	async () => {
		expect(import.meta.resolve("@magic-context/core/shared/sqlite")).toContain(
			join(source, "packages/plugin/src/shared/sqlite.ts"),
		);
		const {
			createFakePi,
			createTestDb,
			fakeContext,
			userMessage,
			assistantMessage,
			assistantToolCall,
			toolResultMessage,
		} = await load("pi-plugin/src/test-utils.test.ts");
		const { registerPiContextHandler, clearContextHandlerSession } = await load(
			"pi-plugin/src/context-handler.ts",
		);
		const { resetLkgSlotsForTest } = await load(
			"plugin/src/hooks/magic-context/lkg-slot.ts",
		);
		const { setPiTransformTimingObserver } = await load(
			"pi-plugin/src/context-perf-hooks.ts",
		);
		const lkgTimes: number[] = [];
		const transformTimes: number[] = [];
		const restoreTiming = setPiTransformTimingObserver(
			(sample: { stage: string; elapsedMs: number }) => {
				if (sample.stage === "lkgCapture") lkgTimes.push(sample.elapsedMs);
				if (sample.stage === "total") transformTimes.push(sample.elapsedMs);
			},
		);
		const db = createTestDb(join(evidenceRoot(), "pi-context.db"));
		const fake = createFakePi();
		registerPiContextHandler(fake.pi, {
			db,
			historian: undefined,
			heuristics: { keepReasoningTokens: 1000 },
			injection: {
				memoryEnabled: false,
				injectDocs: false,
				temporalAwareness: false,
			},
		});
		const messageCount = 90;
		if (!Number.isSafeInteger(messageCount) || messageCount < 1)
			throw new Error("Invalid REVIEW_PI_MESSAGES");
		const raw = Array.from({ length: messageCount }, (_, i) =>
			i % 2
				? assistantMessage(corpusText(i), i + 1)
				: userMessage(corpusText(i), i + 1),
		);
		raw.push(
			assistantToolCall(
				"call",
				"read",
				{ path: "fixture.ts" },
				messageCount + 1,
			),
		);
		raw.push(
			toolResultMessage(
				"call",
				"export const budget = 21000;",
				messageCount + 2,
			),
		);
		raw.push(
			assistantMessage("The budget includes preparation.", messageCount + 3),
		);
		raw.push(userMessage("Please inspect writer admission", messageCount + 4));

		const times: number[] = [];
		const settledTimes: number[] = [];
		const wires: string[] = [];
		const io = await fenceIo();
		try {
			for (let i = 0; i < 32; i++) {
				io.operations.length = 0;
				raw.push(userMessage(corpusText(100 + i), 100 + i));
				const messages = structuredClone(raw);
				const ctx = fakeContext(
					"review-pi",
					process.env.REVIEW_CWD ?? process.cwd(),
					raw.map((_, index) => `e${index}`),
					raw,
				);
				const start = performance.now();
				const result = await fake.handlers.get("context")({ messages }, ctx);
				times.push(performance.now() - start);
				const wire = JSON.stringify(result.messages);
				wires.push(wire);
				await new Promise((resolve) => setImmediate(resolve));
				settledTimes.push(performance.now() - start);
				if (i >= 2) expect(io.operations).toEqual([]);
			}
			expect(wires).toHaveLength(32);
			expect(new Set(wires).size).toBe(32);
			expect(lkgTimes).toHaveLength(32);
			expect(transformTimes).toHaveLength(32);
			expect(wires[0]).toContain("§1§");
			writeFileSync(join(evidenceRoot(), "pi.json"), JSON.stringify(wires));
			console.log(
				"REVIEW_PI",
				JSON.stringify({
					source,

					samples: 32,
					messages: raw.length,
					bytes: Buffer.byteLength(wires[0]),
					sha256: digest(wires[0]),
					coldMs: times[0],
					lkgColdMs: lkgTimes[0],
					lkgWarmMedianMs: median(lkgTimes.slice(2)),
					lkgWarmMaxMs: Math.max(...lkgTimes.slice(2)),
					publicationColdMs: times[0] - transformTimes[0],
					publicationWarmMedianMs: median(
						times
							.slice(2)
							.map((time, index) => time - transformTimes[index + 2]),
					),
					warmMedianMs: median(times.slice(2)),
					settledWarmMedianMs: median(settledTimes.slice(2)),
					warmFenceIo: io.operations.length,
					warmMinMs: Math.min(...times.slice(2)),
					warmMaxMs: Math.max(...times.slice(2)),
					wireSha256: digest(wires[0]),
				}),
			);
		} finally {
			io.restore();
			restoreTiming();
			clearContextHandlerSession("review-pi");
			resetLkgSlotsForTest();
			db.close();
		}
	},
);

test.skipIf(process.env.REVIEW_OUTPUT === undefined)(
	"review randomized no-busy OpenCode1 complete served bytes",
	async () => {
		const { openDatabase, closeDatabase } = await load(
			"plugin/src/features/magic-context/storage-db.ts",
		);
		const { createTransform } = await load(
			"plugin/src/hooks/magic-context/transform.ts",
		);
		const { createMessagesTransformHandler } = await load(
			"plugin/src/plugin/messages-transform.ts",
		);
		const { createTagger } = await load(
			"plugin/src/features/magic-context/tagger.ts",
		);
		const {
			resetCtxReduceRegisteredGloballyForTest,
			setCtxReduceRegisteredGlobally,
		} = await load("plugin/src/hooks/magic-context/ctx-reduce-availability.ts");
		const { resetLkgSlotsForTest } = await load(
			"plugin/src/hooks/magic-context/lkg-slot.ts",
		);
		const db = openDatabase();
		if (!db) throw new Error("isolated database unavailable");
		const sessionId = "review-oc1";
		setCtxReduceRegisteredGlobally(true);
		const transform = createTransform({
			db,
			tagger: createTagger(),
			scheduler: { shouldExecute: () => "defer" },
			contextUsageMap: new Map(),
			historyRefreshSessions: new Set(),
			pendingMaterializationSessions: new Set(),
			lastHeuristicsTurnId: new Map(),
			historianRunnable: false,
			protectedTokens: 0,
			clearReasoningAge: 1000,
			directory: process.env.REVIEW_CWD,
			memoryConfig: { enabled: false },
			injectDocs: false,
			liveModelBySession: new Map([
				[sessionId, { providerID: "openai", modelID: "gpt-4.1" }],
			]),
		});
		const handler = createMessagesTransformHandler({
			magicContext: { "experimental.chat.messages.transform": transform },
		});
		const makeMessage = (i: number) => ({
			info: {
				id: `m${i}`,
				role: i % 2 ? "assistant" : "user",
				sessionID: sessionId,
				model: { providerID: "openai", modelID: "gpt-4.1" },
				tools: { ctx_reduce: true, read: true },
				time: { created: i + 1 },
				...(i % 2 ? { finish: "stop" } : {}),
			},
			parts: [{ type: "text", text: corpusText(i) }],
		});
		const raw = Array.from({ length: 90 }, (_, i) => makeMessage(i));
		const times: number[] = [];
		const settledTimes: number[] = [];
		const wires: string[] = [];
		const io = await fenceIo();
		try {
			for (let i = 0; i < 32; i++) {
				io.operations.length = 0;
				raw.push(makeMessage(100 + i));
				const output = { messages: structuredClone(raw) };
				const start = performance.now();
				await handler({}, output);
				times.push(performance.now() - start);
				wires.push(JSON.stringify(output.messages));
				await new Promise((resolve) => setImmediate(resolve));
				settledTimes.push(performance.now() - start);
				if (i >= 2) expect(io.operations).toEqual([]);
			}
			expect(wires).toHaveLength(32);
			expect(new Set(wires).size).toBe(32);
			expect(wires[0]).toContain("§1§ sample 0");
			expect(
				JSON.parse(wires[0])
					.slice(0, 2)
					.map(
						(message: { info: { syntheticHead?: boolean } }) =>
							message.info.syntheticHead,
					),
			).toEqual([true, true]);
			writeFileSync(join(evidenceRoot(), "oc1.json"), JSON.stringify(wires));
			console.log(
				"REVIEW_OC1",
				JSON.stringify({
					source,

					samples: 32,
					bytes: Buffer.byteLength(wires[0]),
					sha256: digest(wires[0]),
					coldMs: times[0],
					warmMedianMs: median(times.slice(2)),
					settledWarmMedianMs: median(settledTimes.slice(2)),
					warmFenceIo: io.operations.length,
					warmMinMs: Math.min(...times.slice(2)),
					warmMaxMs: Math.max(...times.slice(2)),
					wireSha256: digest(wires[0]),
				}),
			);
		} finally {
			io.restore();
			transform.disposeRust();
			resetLkgSlotsForTest();
			resetCtxReduceRegisteredGloballyForTest();
			closeDatabase();
		}
	},
);

test.skipIf(process.env.REVIEW_OUTPUT === undefined)(
	"review randomized no-busy OpenCode2 complete served bytes",
	async () => {
		const { spyOn } = await import("bun:test");
		const configLoader = await load("plugin/src/config/index.ts");
		const { MagicContextConfigSchema } = await load(
			"plugin/src/config/schema/magic-context.ts",
		);
		const { openDatabase, closeDatabase } = await load(
			"plugin/src/features/magic-context/storage-db.ts",
		);
		const { registerContext } = await load("plugin/src/v2/hooks/context.ts");
		const storageGate = await load("plugin/src/v2/hooks/storage-gate.ts");
		const { Database } = await load("plugin/src/shared/sqlite.ts");
		const dir = join(evidenceRoot(), "v2-store");
		mkdirSync(join(dir, "opencode"), { recursive: true });
		const oldDb = process.env.OPENCODE_DB;
		process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
		const store = new Database(process.env.OPENCODE_DB);
		store.exec(
			"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
		);
		store.close();
		const db = openDatabase(join(dir, "context.db"));
		if (!db) throw new Error("disposable context.db unavailable");
		const config = MagicContextConfigSchema.parse({
			historian: { disable: true },
			dreamer: { disable: true },
			memory: { enabled: false },
		});
		const configSpy = spyOn(
			configLoader,
			"loadPluginConfigDetailed",
		).mockReturnValue({ config });
		const bootSpy = spyOn(
			storageGate,
			"probeV2StorageAtBoot",
		).mockResolvedValue(db);
		let hook: ((draft: SessionContext) => Promise<void>) | undefined;
		let duties: { dispose(): Promise<void> } | undefined;
		const host = {
			location: { directory: process.env.REVIEW_CWD },
			agent: { transform: async () => {}, reload: async () => {} },
			model: { list: () => [] },
			storage: { get: async () => undefined, set: async () => {} },
			event: { subscribe: async function* () {} },
			tool: { hook: async () => {} },
			session: {
				remove: async () => {},
				compact: async () => {},
				interrupt: async () => {
					throw new Error("unexpected refusal");
				},
				hook: async (
					name: string,
					fn: (draft: SessionContext) => Promise<void>,
				) => {
					if (name === "context") hook = fn;
				},
				get: async () => ({ location: { directory: process.env.REVIEW_CWD } }),
			},
		};
		const raw: SessionContext = {
			sessionID: "review-oc2",
			model: {
				providerID: "openai",
				id: "gpt-4.1",
				limit: { context: 1000000 },
			},
			agent: "build",
			system: [],
			options: {},
			tools: {
				ctx_reduce: { description: "reduce", input: { type: "object" } },
				read: { description: "read file", input: { type: "object" } },
			},
			messages: Array.from({ length: 90 }, (_, i) => ({
				id: `m${i}`,
				role: i % 2 ? ("assistant" as const) : ("user" as const),
				content: [{ type: "text" as const, text: corpusText(i) }],
			})),
		};
		const times: number[] = [];
		const settledTimes: number[] = [];
		const wires: string[] = [];
		const io = await fenceIo();
		try {
			duties = await registerContext(host);
			if (!hook) throw new Error("no context hook");
			for (let i = 0; i < 32; i++) {
				io.operations.length = 0;
				raw.messages.push({
					id: `m${100 + i}`,
					role: "user",
					content: [{ type: "text", text: corpusText(100 + i) }],
				});

				const draft = structuredClone(raw);
				const start = performance.now();
				await hook(draft);
				times.push(performance.now() - start);
				wires.push(JSON.stringify(draft));
				await new Promise((resolve) => setImmediate(resolve));
				settledTimes.push(performance.now() - start);
				if (i >= 2) expect(io.operations).toEqual([]);
			}
			expect(wires).toHaveLength(32);
			expect(new Set(wires).size).toBe(32);
			expect(wires[0]).toContain("§1§ sample 0");
			writeFileSync(join(evidenceRoot(), "oc2.json"), JSON.stringify(wires));
			console.log(
				"REVIEW_OC2",
				JSON.stringify({
					source,

					samples: 32,
					bytes: Buffer.byteLength(wires[0]),
					sha256: digest(wires[0]),
					coldMs: times[0],
					warmMedianMs: median(times.slice(2)),
					settledWarmMedianMs: median(settledTimes.slice(2)),
					warmFenceIo: io.operations.length,
					warmMinMs: Math.min(...times.slice(2)),
					warmMaxMs: Math.max(...times.slice(2)),
				}),
			);
		} finally {
			io.restore();
			await duties?.dispose();
			bootSpy.mockRestore();
			configSpy.mockRestore();
			closeDatabase();
			if (oldDb === undefined) delete process.env.OPENCODE_DB;
			else process.env.OPENCODE_DB = oldDb;
		}
	},
);
