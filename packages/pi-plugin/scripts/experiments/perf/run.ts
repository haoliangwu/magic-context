#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	buildAccumulationPasses,
	generateSyntheticFixture,
	loadFixture,
} from "./fixtures";
import {
	canonicalHash,
	canonicalJson,
	createDatabaseTimer,
	createTimingCollector,
	type DatabaseTiming,
	type PhaseTotals,
	summarizePhases,
} from "./instrumentation";

type PerfLane =
	| "default"
	| "historian-low"
	| "historian-high"
	| "execute-compacted"
	| "auto-search-sticky";

interface RunnerOptions {
	stepwise?: boolean;
	settledUsage?: boolean;
	contextWindow?: number;
	fixture?: string;
	database?: string;
	wireOutput?: string;
	messages: number;
	step: number;
	points?: number[];
	repeatFinal: number;
	output?: string;
	lane: PerfLane;
	/**
	 * Commit an unrelated write from a second connection before every pass.
	 * Production shares context.db with other OpenCode and Pi processes, so
	 * PRAGMA data_version almost always advances between passes; a single
	 * connection never shows that.
	 */
	externalWrites: boolean;
	/**
	 * Mirror Pi 0.87: the branch persists a system message entry, and
	 * emitContext withholds system messages from `context` handlers.
	 */
	pi087: boolean;
	/** Seed one `pi-msg-*` fallback message tag whose fingerprint matches no live message. */
	lingeringFallback: boolean;
	/**
	 * Seed this many tags with status 'compacted' for old messages that Pi no
	 * longer sends, as a long-lived session accumulates them.
	 */
	historicalTags: number;
	/** Seed hidden history after warm-up to keep cold tag allocation within the pass deadline. */
	historicalTagsAfterMessages?: number;
	toolResultRepeat?: number;
	/**
	 * Insert this many tags for another session after each seeded historical
	 * tag. A shared context.db interleaves sessions' rows, so one session's tags
	 * span many more pages than a freshly seeded contiguous run.
	 */
	foreignTagInterleave?: number;
	/**
	 * Seed historical tags as a long session holds them: two of every three are
	 * tool tags (call ID plus owner message) and a third of all rows are dropped
	 * rather than compacted. Without it every historical tag is a compacted
	 * message tag.
	 */
	historicalMix: boolean;
	/**
	 * Seeded randomized schedule for differential runs: after the given points,
	 * `chaosPasses` more passes append 0-3 messages each, and before each pass
	 * the runner may queue a drop, force an execute (flush) pass, publish a
	 * compartment (fold), switch the model, or write this session's tags from
	 * a second connection. The same seed gives the same schedule on every tree.
	 */
	chaosSeed?: number;
	chaosPasses: number;
	/** Branch message entries hidden behind a Magic Context compaction entry. */
	hiddenMessages?: number;
}

export interface PerfPassReport {
	decision?: "execute" | "defer";
	usagePercentage?: number;
	/** Complete handler wall time, including fit admission and publication. */
	handlerMs: number;
	fullArrayClones: number;
	fullArrayCloneMs: number;
	fitEnvelopeReads: number;
	pass: number;
	requestedMessages: number;
	inputMessages: number;
	outputMessages: number;
	outputBytes: number;
	outputHash: string;
	/** Hash the literal served JSON too, not only a key-sorted comparison. */
	wireHash: string;
	tagRows: number;
	tagRowsHash: string;
	stages: ReturnType<ReturnType<typeof createTimingCollector>["samples"]>;
	phases: PhaseTotals;
	db: DatabaseTiming;
	serializationMs: number;
	deferredDrainMs: number;
	deferredDb: DatabaseTiming;
	dbQueries: ReturnType<ReturnType<typeof createDatabaseTimer>["queries"]>;
	/** Randomized events applied before this pass (`--chaos-seed`). */
	chaos?: string[];
}

export interface PerfRunReport {
	contextWindow?: number;
	schemaVersion: 2;
	fixture: string;
	fixtureBytes: number;
	sessionId: string;
	requestedStep: number;
	lane: PerfLane;
	passes: PerfPassReport[];
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const fixture = options.fixture
		? loadFixture(options.fixture)
		: generateSyntheticFixture({
				messages: options.messages,
				systemEntry: options.pi087,
				toolResultRepeat: options.toolResultRepeat,
				hiddenMessages: options.hiddenMessages,
			});
	const totalMessages = fixture.entries.filter(
		(entry) => entry.type === "message",
	).length;
	const chaos =
		options.chaosSeed === undefined ? null : seededRandom(options.chaosSeed);
	const points = options.points ?? buildPoints(totalMessages, options.step);
	if (chaos) {
		let point = points.at(-1) ?? 1;
		for (let pass = 0; pass < options.chaosPasses; pass += 1) {
			point = Math.min(totalMessages, point + chaos(4));
			points.push(point);
		}
	}
	const passes = chaos
		? (() => {
				// Repeated points are deliberate here (a pass with no new message).
				const unique = buildAccumulationPasses(fixture, points);
				const byCount = new Map(
					unique.map((pass) => [pass.requestedMessages, pass]),
				);
				return points.map((point) => {
					const pass = byCount.get(point);
					if (!pass) throw new Error(`no pass for point ${point}`);
					// A repeated point reuses the same pass object. That is safe: the
					// pass loop below structuredClones pass.messages into each event.
					return pass;
				});
			})()
		: buildAccumulationPasses(fixture, points);
	if (passes.length === 0)
		throw new Error(`No message passes found in ${fixture.name}`);
	const finalPass = passes.at(-1);
	if (finalPass) {
		for (let repeat = 0; repeat < options.repeatFinal; repeat += 1) {
			// Each event is cloned immediately before invocation, so repeats can
			// share their immutable fixture instead of retaining hundreds of copies.
			passes.push(finalPass);
		}
	}

	const scratch = join(tmpdir(), "magic-context");
	mkdirSync(scratch, { recursive: true });
	const dataDir = mkdtempSync(join(scratch, "pi-append-perf-"));
	process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataDir;
	process.env.XDG_DATA_HOME = dataDir;
	process.env.XDG_CONFIG_HOME = join(dataDir, "config");
	process.env.XDG_STATE_HOME = join(dataDir, "state");
	process.env.XDG_RUNTIME_DIR = join(dataDir, "runtime");
	process.env.OPENCODE_DB = join(dataDir, "opencode.db");
	process.env.MAGIC_CONTEXT_STORAGE_DIR = dataDir;
	process.env.MAGIC_CONTEXT_LOG_PATH = join(dataDir, "magic-context.log");
	process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	process.env.NODE_ENV = "test";
	// The test logger is silent. Import it before restoring test mode so the
	// actual execute/defer decisions are logged, rather than inferred from timing.
	delete process.env.NODE_ENV;
	const { flushLogger, getLogFilePath } = await import(
		"@magic-context/core/shared/logger"
	);
	process.env.NODE_ENV = "test";

	const [
		{ Database },
		{ initializeDatabase },
		{ runMigrations },
		{ setHarness },
	] = await Promise.all([
		import("@magic-context/core/shared/sqlite"),
		import("@magic-context/core/features/magic-context/storage-db"),
		import("@magic-context/core/features/magic-context/migrations"),
		import("@magic-context/core/shared/harness"),
	]);
	const [
		{
			registerPiContextHandler,
			clearContextHandlerSession,
			awaitInFlightHistorians,
		},
		{ setPiTransformTimingObserver },
	] = await Promise.all([
		import("../../../src/context-handler"),
		import("../../../src/context-perf-hooks"),
	]);

	setHarness("pi");
	const { updateSessionMeta } = await import(
		"@magic-context/core/features/magic-context/storage-meta"
	);
	const logStart = existsSync(getLogFilePath())
		? statSync(getLogFilePath()).size
		: 0;
	const dbPath = join(dataDir, "context.db");
	if (options.database) {
		const seed = resolve(options.database);
		for (const suffix of ["", "-wal", "-shm"]) {
			if (existsSync(`${seed}${suffix}`))
				execFileSync("cp", ["-c", `${seed}${suffix}`, `${dbPath}${suffix}`]);
		}
	}
	const rawDb = new Database(dbPath);
	initializeDatabase(rawDb);
	runMigrations(rawDb);
	const externalDb = options.externalWrites ? new Database(dbPath) : null;
	if (externalDb) initializeDatabase(externalDb);
	externalDb?.exec("PRAGMA busy_timeout = 5000");
	externalDb?.exec(
		"CREATE TABLE IF NOT EXISTS perf_external_writes (pass INTEGER NOT NULL)",
	);
	if (options.lingeringFallback) {
		// A fallback row whose fingerprint matches no live message, as left by an
		// in-flight message that was edited before Pi persisted it.
		rawDb
			.prepare(
				`INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size,
				   tag_number, harness, entry_fingerprint, status)
				 VALUES (?, 'pi-msg-0-1-user:p0', 'message', 10, 0, 1, 'pi', ?, 'compacted')`,
			)
			.run(
				fixture.sessionId,
				JSON.stringify([null, 1, "user", null, "0".repeat(64)]),
			);
	}
	let historicalTagsSeeded = false;
	const seedHistoricalTags = () => {
		if (historicalTagsSeeded || options.historicalTags <= 0) return;
		historicalTagsSeeded = true;
		const firstNumber = (
			rawDb
				.prepare(
					"SELECT COALESCE(MAX(tag_number), 0) + 1 AS number FROM tags WHERE session_id = ?",
				)
				.get(fixture.sessionId) as { number: number }
		).number;
		const insert = rawDb.prepare(
			`INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size,
			   tag_number, harness, status, token_count)
			 VALUES (?, ?, 'message', 400, 0, ?, 'pi', 'compacted', 100)`,
		);
		const insertMixed = rawDb.prepare(
			`INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size,
			   tag_number, harness, status, token_count, tool_name, tool_owner_message_id,
			   input_byte_size, input_token_count)
			 VALUES (?, ?, ?, ?, 0, ?, 'pi', ?, ?, ?, ?, ?, ?)`,
		);
		rawDb.exec("BEGIN");
		const interleave = options.foreignTagInterleave ?? 0;
		for (let index = 0; index < options.historicalTags; index += 1) {
			if (options.historicalMix) {
				const tool = index % 3 !== 0;
				const owner = `historical-entry-${Math.floor(index / 3)}`;
				insertMixed.run(
					fixture.sessionId,
					tool ? `historical-call-${index}` : `${owner}:p0`,
					tool ? "tool" : "message",
					tool ? 4_000 : 400,
					firstNumber + index,
					index % 3 === 2 ? "dropped" : "compacted",
					tool ? 1_000 : 100,
					tool ? "read" : null,
					tool ? owner : null,
					tool ? 120 : null,
					tool ? 30 : null,
				);
			} else {
				insert.run(
					fixture.sessionId,
					`historical-entry-${index}:p0`,
					firstNumber + index,
				);
			}
			for (let foreign = 0; foreign < interleave; foreign += 1) {
				insert.run(
					`perf-foreign-session-${foreign}`,
					`foreign-entry-${index}:p0`,
					index + 1,
				);
			}
		}
		rawDb.exec("COMMIT");
	};
	if (!options.historicalTagsAfterMessages) seedHistoricalTags();
	const dbTimer = createDatabaseTimer(rawDb);
	const timings = createTimingCollector();
	const restoreObserver = setPiTransformTimingObserver((sample) =>
		timings.observe(sample),
	);

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let registryReads = 0;
	const pi = {
		getAllTools: () => {
			registryReads++;
			return [];
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
	};
	const historianEnabled =
		options.lane === "historian-low" || options.lane === "historian-high";
	registerPiContextHandler(pi as never, {
		db: dbTimer.database as never,
		protectedTags: 20,
		scheduler: {
			executeThresholdPercentage:
				options.lane === "execute-compacted" ? 10 : 95,
		},
		heuristics: { caveman: { enabled: false, minChars: 2_000 } },
		injection: {
			memoryEnabled: false,
			injectDocs: false,
			injectionBudgetTokens: 4_000,
			temporalAwareness: false,
		},
		historian: historianEnabled
			? {
					runner: {
						harness: "pi-perf",
						run: async () => ({ ok: false, reason: "model_error" }),
					} as never,
					model: "perf/mock-historian",
					historianChunkTokens: 8_000,
					executeThresholdPercentage: 65,
				}
			: undefined,
		autoSearch:
			options.lane === "auto-search-sticky"
				? {
						enabled: true,
						minPromptChars: Number.MAX_SAFE_INTEGER,
						scoreThreshold: 0.55,
					}
				: undefined,
	});
	const handler = handlers.get("context");
	if (!handler)
		throw new Error(
			"registerPiContextHandler did not register a context handler",
		);

	const reports: PerfPassReport[] = [];
	try {
		for (let index = 0; index < passes.length; index += 1) {
			const pass = passes[index];
			if (!pass) continue;
			if (options.stepwise) {
				const next = new Promise<void>((resolve) =>
					process.stdin.once("data", () => resolve()),
				);
				console.log("PERF_READY");
				process.stdin.resume();
				await next;
				process.stdin.pause();
			}
			externalDb
				?.prepare("INSERT INTO perf_external_writes (pass) VALUES (?)")
				.run(index);
			timings.reset();
			registryReads = 0;
			dbTimer.reset();
			if (options.lane === "execute-compacted" && index > 0) {
				rawDb
					.prepare(
						`UPDATE tags SET status = 'compacted'
						 WHERE session_id = ? AND tag_number < COALESCE(
						   (SELECT MAX(tag_number) - 20 FROM tags WHERE session_id = ?), 0
						 )`,
					)
					.run(fixture.sessionId, fixture.sessionId);
			}
			const chaosOps = chaos
				? applyChaos(chaos, {
						index,
						warmPasses: points.length - options.chaosPasses,
						sessionId: fixture.sessionId,
						rawDb,
						externalDb,
						branchEntries: pass.branchEntries,
					})
				: null;
			const usagePercentage = chaosOps?.flush
				? 96
				: options.lane === "historian-high"
					? 85
					: options.lane === "historian-low"
						? 25
						: options.lane === "execute-compacted"
							? 70
							: 0.25;
			const context = fakeContext(
				fixture.sessionId,
				options.database ? dataDir : fixture.cwd,
				pass.branchEntries,
				usagePercentage,
				chaosOps?.model,
				options.contextWindow,
			);
			const event = {
				messages: structuredClone(
					options.pi087
						? pass.messages.filter(
								(message) => (message as { role?: unknown }).role !== "system",
							)
						: pass.messages,
				),
			};
			const inputMessageCount = event.messages.length;
			const originalClone = globalThis.structuredClone;
			let fullArrayClones = 0;
			let fullArrayCloneMs = 0;
			globalThis.structuredClone = ((
				value: unknown,
				options?: Parameters<typeof structuredClone>[1],
			) => {
				if (!Array.isArray(value) || value.length < inputMessageCount)
					return originalClone(value, options);
				const start = performance.now();
				try {
					return originalClone(value, options);
				} finally {
					fullArrayClones++;
					fullArrayCloneMs += performance.now() - start;
				}
			}) as typeof structuredClone;
			const handlerStart = performance.now();
			let result: { messages?: unknown[] } | undefined;
			try {
				result = (await handler(event, context)) as
					| { messages?: unknown[] }
					| undefined;
			} finally {
				globalThis.structuredClone = originalClone;
			}
			const handlerMs = performance.now() - handlerStart;
			const fitEnvelopeReads = registryReads;
			const output = result?.messages ?? event.messages;
			if (options.wireOutput)
				writeFileSync(
					`${resolve(options.wireOutput)}-${index + 1}.json`,
					JSON.stringify(output),
				);
			const transformError = rawDb
				.prepare(
					"SELECT last_transform_error AS error FROM session_meta WHERE session_id = ?",
				)
				.get(fixture.sessionId) as { error?: string } | null;
			if (transformError?.error) {
				throw new Error(
					`Pi transform failed open on pass ${index + 1}: ${transformError.error}`,
				);
			}
			const dbSnapshot = dbTimer.snapshot();
			const serializationStart = performance.now();
			const outputCanonical = canonicalJson(output);
			const serializationMs = performance.now() - serializationStart;
			const drainStart = performance.now();
			await new Promise((resolve) => setTimeout(resolve, 150));
			await awaitInFlightHistorians();
			const deferredDrainMs = performance.now() - drainStart;
			const afterDrainDb = dbTimer.snapshot();
			const deferredDb = subtractDatabaseTiming(afterDrainDb, dbSnapshot);
			const tagRows = readTagRows(rawDb, fixture.sessionId);
			reports.push({
				handlerMs,
				fitEnvelopeReads,
				fullArrayClones,
				fullArrayCloneMs,
				pass: index + 1,
				requestedMessages: pass.requestedMessages,
				inputMessages: inputMessageCount,
				outputMessages: output.length,
				outputBytes: Buffer.byteLength(outputCanonical, "utf8"),
				outputHash: canonicalHash(output),
				wireHash: createHash("sha256")
					.update(JSON.stringify(output))
					.digest("hex"),
				tagRows: tagRows.length,
				tagRowsHash: canonicalHash(tagRows),
				stages: timings.samples(),
				phases: summarizePhases(timings.samples(), dbSnapshot),
				db: dbSnapshot,
				serializationMs,
				deferredDrainMs,
				deferredDb,
				dbQueries: dbTimer.queries(),
				chaos: chaosOps?.labels,
			});
			if (
				options.historicalTagsAfterMessages &&
				pass.requestedMessages >= options.historicalTagsAfterMessages
			)
				seedHistoricalTags();
			if (options.settledUsage)
				updateSessionMeta(rawDb, fixture.sessionId, {
					lastResponseTime: Date.now(),
					lastContextPercentage: usagePercentage,
					lastInputTokens: Math.round(
						((options.contextWindow ?? 400000) * usagePercentage) / 100,
					),
				});
			if (options.stepwise) console.log("PERF_DONE");
		}
		flushLogger();
		const decisionLines = readFileSync(getLogFilePath())
			.subarray(logStart)
			.toString("utf8")
			.split("\n")
			.filter(
				(line) =>
					line.includes(`[${fixture.sessionId}] transform:`) &&
					/decision=(execute|defer)\b/.test(line),
			);
		if (decisionLines.length !== reports.length)
			throw new Error(
				`Expected ${reports.length} transform decisions, read ${decisionLines.length}`,
			);
		reports.forEach((report, index) => {
			report.decision = decisionLines[index]?.match(
				/decision=(execute|defer)/,
			)?.[1] as "execute" | "defer";
			const pressure = decisionLines[index]?.match(/usage=([\d.]+)%/);
			if (pressure) report.usagePercentage = Number(pressure[1]);
		});
	} finally {
		restoreObserver();
		clearContextHandlerSession(fixture.sessionId);
		externalDb?.close();
		rawDb.close();
		rmSync(dataDir, { recursive: true, force: true });
	}

	const report: PerfRunReport = {
		contextWindow: options.contextWindow ?? 400_000,
		schemaVersion: 2,
		fixture: fixture.name,
		fixtureBytes: fixture.sourceBytes,
		sessionId: fixture.sessionId,
		requestedStep: options.step,
		lane: options.lane,
		passes: reports,
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output) writeFileSync(resolve(options.output), serialized);
	else process.stdout.write(serialized);
}

function fakeContext(
	sessionId: string,
	cwd: string,
	branchEntries: readonly SessionEntry[],
	usagePercentage: number,
	modelId = "claude-sonnet-4-5",
	contextWindow = 400_000,
): ExtensionContext {
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	return {
		cwd,
		hasUI: false,
		getSystemPrompt: () => "You are a synthetic coding agent.",
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		model: {
			provider: "anthropic",
			id: modelId,
			contextWindow,
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => branchEntries.at(-1)?.id ?? null,
			getBranch: () => branchEntries as SessionEntry[],
			getEntry: (id: string) => byId.get(id),
		},
		getContextUsage: () => ({
			tokens: Math.round((contextWindow * usagePercentage) / 100),
			percent: usagePercentage,
			contextWindow,
		}),
	} as unknown as ExtensionContext;
}

function seededRandom(seed: number): (limit: number) => number {
	let state = seed >>> 0;
	return (limit) => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state % limit;
	};
}

interface ChaosDatabase {
	prepare(sql: string): {
		run(...args: unknown[]): unknown;
		all(...args: unknown[]): unknown[];
		get(...args: unknown[]): unknown;
	};
}

let chaosModel = "claude-sonnet-4-5";
let chaosFolds = 0;

/**
 * Apply this pass's randomized external events (see `chaosSeed`). Draws from
 * the generator in a fixed order, so the baseline checkout and the checkout
 * under test see identical events when run with the same seed.
 */
function applyChaos(
	random: (limit: number) => number,
	input: {
		index: number;
		warmPasses: number;
		sessionId: string;
		rawDb: ChaosDatabase;
		externalDb: ChaosDatabase | null;
		branchEntries: readonly SessionEntry[];
	},
): { flush: boolean; model: string; labels: string[] } {
	const labels: string[] = [];
	const roll = Array.from({ length: 5 }, () => random(100));
	const pickNumber = random(1_000_000);
	if (input.index < input.warmPasses)
		return { flush: false, model: chaosModel, labels };
	const active = input.rawDb
		.prepare(
			"SELECT tag_number AS n FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number",
		)
		.all(input.sessionId) as { n: number }[];
	const anyTag = input.rawDb
		.prepare(
			"SELECT tag_number AS n FROM tags WHERE session_id = ? ORDER BY tag_number",
		)
		.all(input.sessionId) as { n: number }[];
	if ((roll[0] ?? 100) < 20 && active.length > 0) {
		// ctx_reduce queues a drop for an active tag on this process's connection.
		const tag = active[pickNumber % active.length]?.n;
		input.rawDb
			.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'pi')",
			)
			.run(input.sessionId, tag, 1_750_000_000_000 + input.index);
		labels.push(`drop:${tag}`);
	}
	const flush = (roll[1] ?? 100) < 10;
	if (flush) labels.push("flush");
	if ((roll[2] ?? 100) < 6 && input.externalDb) {
		// A compartment published by another process covers the next slice of
		// the branch's messages, as a historian run does.
		const messages = input.branchEntries.filter(
			(entry) => entry.type === "message",
		);
		const end = Math.min(
			messages.length - 40,
			Math.floor(messages.length * 0.97) + chaosFolds * 10,
		);
		const start = chaosFolds === 0 ? 1 : end - 9;
		const startEntry = messages[start - 1];
		const endEntry = messages[end - 1];
		if (startEntry && endEntry && end > start) {
			input.externalDb
				.prepare(
					`INSERT INTO compartments (session_id, sequence, start_message, end_message,
					   start_message_id, end_message_id, title, content, created_at, harness)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pi')`,
				)
				.run(
					input.sessionId,
					chaosFolds + 1,
					start,
					end,
					startEntry.id,
					endEntry.id,
					`Synthetic fold ${chaosFolds + 1}`,
					`Messages ${start}-${end} were summarized.`,
					1_750_000_000_000 + input.index,
				);
			chaosFolds += 1;
			labels.push(`fold:${start}-${end}`);
		}
	}
	if ((roll[3] ?? 100) < 8) {
		chaosModel =
			chaosModel === "claude-sonnet-4-5"
				? "claude-opus-4-1"
				: "claude-sonnet-4-5";
		labels.push(`model:${chaosModel}`);
	}
	if ((roll[4] ?? 100) < 8 && input.externalDb && active.length > 0) {
		// Another process drops an active tag of this session directly.
		const tag = active[(pickNumber >>> 3) % active.length]?.n;
		input.externalDb
			.prepare(
				"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
			)
			.run(input.sessionId, tag);
		labels.push(`foreign-drop:${tag}`);
	} else if ((roll[4] ?? 100) < 25 && input.externalDb && anyTag.length > 0) {
		// Another process rewrites one of this session's tags (size and status
		// of an old row), so the cached snapshot must notice a foreign write.
		const tag = anyTag[pickNumber % anyTag.length]?.n;
		input.externalDb
			.prepare(
				"UPDATE tags SET byte_size = byte_size + 1, status = CASE status WHEN 'compacted' THEN 'dropped' ELSE status END WHERE session_id = ? AND tag_number = ?",
			)
			.run(input.sessionId, tag);
		labels.push(`foreign:${tag}`);
	}
	return { flush, model: chaosModel, labels };
}

function readTagRows(
	database: { prepare(sql: string): { all(...args: unknown[]): unknown[] } },
	sessionId: string,
): unknown[] {
	return database
		.prepare(
			`SELECT tag_number, message_id, type, status, drop_mode, tool_name,
                    input_byte_size, byte_size, reasoning_byte_size, caveman_depth,
                    tool_owner_message_id, entry_fingerprint, token_count,
                    input_token_count, reasoning_token_count, harness
             FROM tags
             WHERE session_id = ?
             ORDER BY tag_number ASC, id ASC`,
		)
		.all(sessionId);
}

function subtractDatabaseTiming(
	after: DatabaseTiming,
	before: DatabaseTiming,
): DatabaseTiming {
	return {
		elapsedMs: after.elapsedMs - before.elapsedMs,
		operations: after.operations - before.operations,
		reads: after.reads - before.reads,
		writes: after.writes - before.writes,
	};
}

function buildPoints(messageCount: number, step: number): number[] {
	const points: number[] = [];
	for (
		let point = Math.min(step, messageCount);
		point < messageCount;
		point += step
	) {
		points.push(point);
	}
	points.push(messageCount);
	return points;
}

function parseOptions(args: readonly string[]): RunnerOptions {
	const options: RunnerOptions = {
		messages: 1_000,
		step: 500,
		repeatFinal: 0,
		lane: "default",
		externalWrites: false,
		pi087: false,
		lingeringFallback: false,
		historicalTags: 0,
		historicalMix: false,
		chaosPasses: 0,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--stepwise") {
			options.stepwise = true;
		} else if (arg === "--settled-usage") {
			options.settledUsage = true;
		} else if (arg === "--context-window" && value) {
			options.contextWindow = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--fixture" && value) {
			options.fixture = value;
			index += 1;
		} else if (arg === "--database" && value) {
			options.database = value;
			index += 1;
		} else if (arg === "--wire-output" && value) {
			options.wireOutput = value;
			index += 1;
		} else if (arg === "--messages" && value) {
			options.messages = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--step" && value) {
			options.step = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--points" && value) {
			options.points = value
				.split(",")
				.map((item) => positiveInteger(item, arg));
			index += 1;
		} else if (arg === "--repeat-final" && value) {
			options.repeatFinal = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--output" && value) {
			options.output = value;
			index += 1;
		} else if (arg === "--pi087") {
			options.pi087 = true;
		} else if (arg === "--lingering-fallback") {
			options.lingeringFallback = true;
		} else if (arg === "--historical-tags" && value) {
			options.historicalTags = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--historical-tags-after-messages" && value) {
			options.historicalTagsAfterMessages = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--tool-result-repeat" && value) {
			options.toolResultRepeat = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--chaos-seed" && value) {
			options.chaosSeed = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--chaos-passes" && value) {
			options.chaosPasses = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--historical-mix") {
			options.historicalMix = true;
		} else if (arg === "--foreign-tag-interleave" && value) {
			options.foreignTagInterleave = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--hidden-messages" && value) {
			options.hiddenMessages = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--external-writes") {
			options.externalWrites = true;
		} else if (arg === "--lane" && value) {
			if (!isPerfLane(value)) throw new Error(`Unknown perf lane: ${value}`);
			options.lane = value;
			index += 1;
		} else {
			throw new Error(`Unknown or incomplete argument: ${arg ?? "<missing>"}`);
		}
	}
	return options;
}

function isPerfLane(value: string): value is PerfLane {
	return [
		"default",
		"historian-low",
		"historian-high",
		"execute-compacted",
		"auto-search-sticky",
	].includes(value);
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive integer, got ${value}`);
	}
	return parsed;
}

await main();
