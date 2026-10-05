#!/usr/bin/env bun
// Synthetic inputs only. Capture two isolated source trees, then compare the
// exact served arrays, not hashes calculated by the optimized implementation.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [mode, sourceOrLeft, outputOrRight] = Bun.argv.slice(2);
if (!sourceOrLeft || !outputOrRight)
	throw new Error(
		"capture <source-root> <output-dir> | compare <left-dir> <right-dir>",
	);
if (mode === "compare") {
	for (const host of ["opencode", "pi"]) {
		for (let pass = 0; pass < 6; pass++) {
			const name = `${host}-${pass}.wire`;
			assert.deepEqual(
				readFileSync(join(sourceOrLeft, name)),
				readFileSync(join(outputOrRight, name)),
				`${host} served bytes pass ${pass}`,
			);
			console.log(`IDENTICAL ${host} served bytes pass ${pass}`);
		}
	}
	console.log("12/12 served arrays byte-identical");
} else if (mode === "capture") {
	const source = resolve(sourceOrLeft);
	const output = resolve(outputOrRight);
	mkdirSync(output, { recursive: true });
	for (const name of [
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"MAGIC_CONTEXT_TEST_DATA_DIR",
	])
		process.env[name] = output;
	process.env.OPENCODE_DB = join(output, "absent-opencode.db");
	process.env.MAGIC_CONTEXT_LOG_PATH = join(output, "transform.log");
	process.env.NODE_ENV = "test";
	Date.now = () => 1_791_114_000_000;
	const load = (path: string) => import(join(source, path));
	const core = "packages/plugin/src/";
	const { Database } = await load(`${core}shared/sqlite.ts`);
	const { initializeDatabase } = await load(
		`${core}features/magic-context/storage-db.ts`,
	);
	const { runMigrations } = await load(
		`${core}features/magic-context/migrations.ts`,
	);
	const { createTagger } = await load(
		`${core}features/magic-context/tagger.ts`,
	);
	const { createLkgEntryProjector } = await load(
		`${core}hooks/magic-context/lkg-replay.ts`,
	);
	const { fitHistorianPrompt } = await load(
		`${core}hooks/magic-context/historian-prompt-fit.ts`,
	);
	const { createTransform } = await load(
		`${core}hooks/magic-context/transform.ts`,
	);
	const { replaceAllCompartments } = await load(
		`${core}features/magic-context/compartment-storage.ts`,
	);
	const { setRawMessageProvider } = await load(
		`${core}hooks/magic-context/read-session-chunk.ts`,
	);
	const { registerPiContextHandler } = await load(
		"packages/pi-plugin/src/context-handler.ts",
	);
	const { createFakePi, fakeContext, userMessage, assistantMessage } =
		await load("packages/pi-plugin/src/test-utils.test.ts");
	const { setPiTransformTimingObserver } = await load(
		"packages/pi-plugin/src/context-perf-hooks.ts",
	);
	const { getPiTagSnapshot } = await load(
		"packages/pi-plugin/src/tag-snapshot-pi.ts",
	);
	const { __test } = await load("packages/pi-plugin/src/context-handler.ts");
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	const timings: Record<string, number[]> = {};
	const measure = <T>(stage: string, operation: () => T): T => {
		const start = performance.now();
		const result = operation();
		timings[stage] ??= [];
		timings[stage].push(performance.now() - start);
		return result;
	};
	const raw = Array.from({ length: 5176 }, (_, i) => ({
		info: {
			id: `m-${i}`,
			role: i % 2 ? "assistant" : "user",
			sessionID: "synthetic-oc",
			time: { created: i + 1 },
			finish: "stop",
		},
		parts: [
			{ type: "text", text: `source ${i} α` },
			{
				type: "tool",
				tool: "Read",
				callID: `c-${i}`,
				state: {
					status: "completed",
					input: { path: `src/${i}.ts` },
					output: Array.from({ length: 35 }, (_, k) => ({
						line: k,
						text: `line ${i}-${k}: source material`,
					})),
				},
			},
		],
	}));
	const reuse: unknown[] = [];
	const project = createLkgEntryProjector({
		onReuse: (stats: unknown) => reuse.push(stats),
	});
	const oversized = createLkgEntryProjector({
		onReuse: (stats: unknown) => reuse.push(stats),
	});
	const trimmed = createLkgEntryProjector();
	for (let pass = 0; pass < 6; pass++) {
		const wire = structuredClone(raw);
		const head = wire[0];
		if (!head) throw new Error("synthetic history is empty");
		head.info.time.created += pass;
		measure("projection-leading-edit", () => project("synthetic-oc", wire));
		const shifted = structuredClone(raw.slice(pass * 2));
		measure("projection-head-trim", () =>
			trimmed("synthetic-trimmed", shifted),
		);
		// Same message count, but retained strings alone exceed the 64 MiB cap.
		const large = wire.map((m) => ({
			...m,
			parts: [{ type: "text", text: "history ".repeat(1000) }],
		}));
		measure("projection-over-budget", () =>
			oversized("synthetic-large", large),
		);
	}
	const fitArgs = {
		window: {
			modelKey: "test/unknown-historian",
			contextLimitTokens: 1_000_000,
			maxOutputTokens: 8000,
		},
		systemPrompt: "Historian system",
		requestedChunkTokens: 10000,
		sessionId: "synthetic-fit",
		chunkStart: 87184,
		lastOrdinal: 87371,
		sessionCompartments: [],
		memories: Array.from({ length: 318 }, (_, i) => ({
			id: i + 1,
			projectPath: output,
			category: "ARCHITECTURE",
			content: `Fact ${i}: ${"ledger source material ".repeat(180)}`,
		})),
		memoryEnabled: true,
	};
	for (let pass = 0; pass < 6; pass++)
		measure("fixed-historian-fit", () => fitHistorianPrompt(fitArgs));
	replaceAllCompartments(db, "synthetic-oc", [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: 4716,
			startMessageId: "m-0",
			endMessageId: "m-4715",
			title: "Restored history",
			content: "Deterministic restored history summary",
		},
	]);
	const rawMessages = raw.map((message, index) => ({
		id: message.info.id,
		role: message.info.role,
		parts: message.parts,
		ordinal: index + 1,
		createdAt: index + 1,
	}));
	const unregister = setRawMessageProvider("synthetic-oc", {
		readMessages: () => rawMessages,
		readMessageOrdinalById: (id: string) =>
			rawMessages.find((message) => message.id === id)?.ordinal ?? null,
	});
	const transform = createTransform({
		db,
		tagger: createTagger(),
		scheduler: { shouldExecute: () => "defer" },
		contextUsageMap: new Map([
			[
				"synthetic-oc",
				{
					usage: { percentage: 44.3, inputTokens: 386194 },
					updatedAt: Date.now(),
				},
			],
		]),
		directory: output,
		injectDocs: false,
		memoryConfig: {
			enabled: false,
			injectionBudgetTokens: 0,
			autoPromote: false,
		},
		historyRefreshSessions: new Set(),
		deferredHistoryRefreshSessions: new Set(),
		pendingMaterializationSessions: new Set(),
		lastHeuristicsTurnId: new Map(),
		clearReasoningAge: 1000,
		protectedTokens: 0,
		historianRunnable: false,
	});
	for (let pass = 0; pass < 6; pass++) {
		const messages = structuredClone(raw.slice(0, 5170 + pass));
		const served = { messages };
		await transform({}, served);
		writeFileSync(
			join(output, `opencode-${pass}.wire`),
			JSON.stringify(served.messages),
		);
	}
	unregister();
	const insert = db.prepare(
		"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size, entry_fingerprint) VALUES (?, 'message', ?, 'synthetic-pi', ?, 0, ?)",
	);
	db.transaction(() => {
		for (let i = 1; i <= 45737; i++)
			insert.run(
				i === 1 ? "pi-msg-orphan:p0" : `old-${i}:p0`,
				i <= 43327 ? "compacted" : "active",
				i,
				i === 1 ? "orphan" : null,
			);
	})();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi, {
		db,
		scheduler: { executeThresholdPercentage: 95 },
		injection: {
			memoryEnabled: false,
			injectDocs: false,
			injectionBudgetTokens: 4000,
			temporalAwareness: false,
		},
	});
	const handler = fake.handlers.get("context");
	const stages: unknown[] = [];
	setPiTransformTimingObserver((sample: unknown) => stages.push(sample));
	for (let pass = 0; pass < 6; pass++) {
		const messages = Array.from({ length: 869 + pass * 2 }, (_, i) =>
			i % 2
				? assistantMessage(`answer ${i}`, i + 1)
				: userMessage(`question ${i}`, i + 1),
		);
		const ids = messages.map((_, i) => `entry-${i}`);
		const result = await handler(
			{ messages },
			fakeContext("synthetic-pi", output, ids, messages),
		);
		if (!result?.messages)
			throw new Error(`Pi handler did not serve pass ${pass}`);
		const error = db
			.prepare(
				"SELECT last_transform_error AS error FROM session_meta WHERE session_id = 'synthetic-pi'",
			)
			.get() as { error?: string } | undefined;
		if (error?.error) throw new Error(`Pi handler failed open: ${error.error}`);
		writeFileSync(
			join(output, `pi-${pass}.wire`),
			JSON.stringify(result?.messages ?? messages),
		);
	}
	for (let pass = 0; pass < 6; pass++) {
		insert.run(`appended-${pass}`, "active", 47000 + pass, null);
		measure("tags-append", () => getPiTagSnapshot(db, "synthetic-pi"));
		measure("fallback-adoption-orphan", () =>
			__test.adoptPiFallbackTags(
				db,
				"synthetic-pi",
				createTagger(),
				new Map(
					Array.from({ length: 869 }, (_, i) => [`entry-${i}`, `absent-${i}`]),
				),
			),
		);
	}
	const summary = Object.fromEntries(
		Object.entries(timings).map(([stage, samples]) => [
			stage,
			{
				cold: samples[0],
				warmMedian: [...samples.slice(1)].sort((a, b) => a - b)[2],
				samples,
			},
		]),
	);
	writeFileSync(
		join(output, "timings.json"),
		JSON.stringify({ summary, reuse, piStages: stages }, null, 2),
	);
	console.log(JSON.stringify(summary, null, 2));
	console.log(
		"Captured 12 served arrays, 36 stage samples; synthetic in-memory database only",
	);
	db.close();
} else throw new Error("expected capture or compare");
