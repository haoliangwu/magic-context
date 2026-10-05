import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	_setTestProviderFactoryForProject,
	embedTextForProject,
	getProjectEmbeddingSnapshot,
	unregisterProjectEmbedding,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resetEmbeddingCacheForTests } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { OpenAICompatibleEmbeddingProvider } from "@magic-context/core/features/magic-context/memory/embedding-openai";
import {
	createUnifiedSearchDiagnostics,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { setHarness } from "@magic-context/core/shared/harness";
import { Database } from "@magic-context/core/shared/sqlite";
import { runAutoSearchHintForPi } from "../../../src/auto-search-pi";
import { loadPiConfigDetailed } from "../../../src/config";
import { ensureProjectRegisteredFromPiDirectory } from "../../../src/embedding-bootstrap";
import { createDatabaseTimer } from "./instrumentation";

// Only copied stores and an isolated log root are writable. Project
// configuration is read from the original directory, never modified.
const root = resolve(process.argv[2] ?? "");
const seed = join(root, "context.db");
const sessionId = "019de471-4fdc-762d-9286-624dfad0b5fe";
const cwd = "/Users/ufukaltinok/Work/Projects/CortexKit/anthropic-auth";
process.env.NODE_ENV = "test";
process.env.MAGIC_CONTEXT_DATA_DIR = join(root, "auto-search-profile");
mkdirSync(process.env.MAGIC_CONTEXT_DATA_DIR, { recursive: true });
setHarness("pi");
const config = loadPiConfigDetailed({ cwd }).config;
const prompts = [
	"Pi reloaded, we can continue.",
	"What's the current status ?",
	"Let me know where we are for the anthropic side.",
	"Let's go with the implementation.",
];
const reports: unknown[] = [];
const network = process.argv.includes("--network");
const label =
	process.argv.find((value) => value.startsWith("--label="))?.slice(8) ??
	"auto-search-profile";
let embeddingMs = 0;
let embeddingOutcome = "not-called";
class MeasuredProvider extends OpenAICompatibleEmbeddingProvider {
	override async embedBatch(
		...args: Parameters<OpenAICompatibleEmbeddingProvider["embedBatch"]>
	) {
		const start = performance.now();
		try {
			const result = await super.embedBatch(...args);
			embeddingOutcome = result.some(Boolean) ? "vector" : "null";
			return result;
		} finally {
			embeddingMs += performance.now() - start;
		}
	}
}
if (network)
	_setTestProviderFactoryForProject((config) => {
		if (config.provider !== "openai-compatible")
			throw new Error(
				"This probe permits only the explicitly requested remote compatible provider",
			);
		return new MeasuredProvider({
			endpoint: config.endpoint,
			model: config.model,
			apiKey: config.api_key,
			inputType: config.input_type,
			queryInputType: config.query_input_type,
			queryInstruction: config.query_instruction,
			documentPrefix: config.document_prefix,
			truncate: config.truncate,
			maxInputTokens: config.max_input_tokens,
		});
	});
for (const [index, prompt] of prompts.entries()) {
	const file = join(
		process.env.MAGIC_CONTEXT_DATA_DIR,
		`probe-${process.pid}-${index}.db`,
	);
	execFileSync("cp", ["-c", seed, file]);
	const rawDb = new Database(file);
	const timer = createDatabaseTimer(rawDb);
	const db = timer.database;
	const projectPath = (
		db
			.prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
			.get(sessionId) as { project_path: string }
	).project_path;
	resetEmbeddingCacheForTests();
	const preparationStart = performance.now();
	await ensureProjectRegisteredFromPiDirectory(cwd, db);
	const coldPreparationMs = performance.now() - preparationStart;
	const coldPreparationSql = timer.queries();
	const snapshotStart = performance.now();
	const snapshot = getProjectEmbeddingSnapshot(projectPath);
	const snapshotMs = performance.now() - snapshotStart;
	const standaloneStart = performance.now();
	let vector: Float32Array | null = null;
	if (network)
		vector =
			(await embedTextForProject(projectPath, prompt, undefined, "query"))
				?.vector ?? null;
	const standaloneEmbeddingMs = network
		? performance.now() - standaloneStart
		: null;
	const standaloneEmbeddingOutcome = embeddingOutcome;
	timer.reset();
	embeddingMs = 0;
	embeddingOutcome = "not-called";
	let preparationMs = 0;
	let timerFiredMs: number | null = null;
	const stageStart = performance.now();
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) =>
		originalSetTimeout(() => {
			if (ms !== undefined && ms >= 2900 && ms <= 3000)
				timerFiredMs = performance.now() - stageStart;
			callback(...args);
		}, ms)) as typeof setTimeout;
	const messages = [
		{ role: "user" as const, content: prompt, timestamp: Date.now() },
	];
	try {
		await runAutoSearchHintForPi({
			sessionId,
			db,
			messages,
			entryIds: [`probe-${index}`],
			options: {
				enabled: true,
				projectPath,
				minPromptChars: config.memory.auto_search.min_prompt_chars,
				scoreThreshold: config.memory.auto_search.score_threshold,
			},
			ensureProjectRegistered: async () => {
				const start = performance.now();
				await ensureProjectRegisteredFromPiDirectory(cwd, db);
				preparationMs = performance.now() - start;
			},
		});
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	const servedMs = performance.now() - stageStart;
	// Allow abort continuations to settle before reusing the connection for the tool probe.
	await new Promise((resolve) => setTimeout(resolve, 10));
	const sql = timer.queries();
	const autoEmbeddingMs = embeddingMs;
	const autoEmbeddingOutcome = embeddingOutcome;
	timer.reset();
	embeddingMs = 0;
	embeddingOutcome = "not-called";
	const ctxStart = performance.now();
	const diagnostics = createUnifiedSearchDiagnostics();
	const ctxResult = await unifiedSearch(db, sessionId, projectPath, prompt, {
		limit: 10,
		memoryEnabled: snapshot?.features.memoryEnabled ?? true,
		embeddingEnabled: snapshot ? snapshot.historyEnabled : true,
		gitCommitsEnabled: snapshot?.gitCommitEnabled ?? false,
		embedQuery: async (text, signal) =>
			(await embedTextForProject(projectPath, text, signal, "query"))?.vector ??
			null,
		isEmbeddingRuntimeEnabled: () => snapshot?.historyEnabled ?? true,
		explicitSearch: true,
		maxMessageOrdinal: Math.max(0, getLastCompartmentEndMessage(db, sessionId)),
		diagnostics,
		visibleMemoryIds: getVisibleMemoryIds(db, sessionId),
		countRetrievals: false,
		measurementDisabled: true,
		sources: ["memory", "message", "git_commit"],
	});
	const ctxSearchMs = performance.now() - ctxStart;
	const ctxSql = timer.queries();
	const lane = (pattern: RegExp) =>
		sql
			.filter((row) => pattern.test(row.sql))
			.reduce((sum, row) => sum + row.elapsedMs, 0);
	const report = {
		prompt,
		minPromptChars: config.memory.auto_search.min_prompt_chars,
		coldPreparationMs,
		preparationMs,
		snapshotMs,
		standaloneEmbeddingMs,
		standaloneEmbeddingOutcome,
		standaloneVectorDims: vector?.length ?? null,
		embeddingMs: autoEmbeddingMs,
		embeddingOutcome: autoEmbeddingOutcome,
		servedMs,
		timerFiredMs,
		hintServed: messages[0]?.content.includes("<ctx-search-hint>"),
		ctxSearchMs,
		ctxEmbeddingMs: embeddingMs,
		ctxResultCount: ctxResult.length,
		ctxDiagnostics: diagnostics,
		lanes: {
			messageFtsMs: lane(/message_history_fts/),
			historyVectorMs: lane(/compartment_chunk_embeddings/),
			memoryFtsMs: lane(/memories_fts/),
			memoryVectorAndPoolMs: lane(/FROM memories\b|FROM memory_embeddings/),
			gitFtsMs: lane(/git_commits_fts/),
			gitVectorAndPoolMs: lane(/FROM git_commits\b|FROM git_commit_embeddings/),
		},
		coldPreparationSql,
		sql,
		ctxSql,
	};
	reports.push(report);
	writeFileSync(join(root, `${label}.json`), JSON.stringify(reports, null, 2));
	console.log(
		JSON.stringify({
			...report,
			coldPreparationSql: undefined,
			sql: undefined,
			ctxSql: undefined,
		}),
	);
	unregisterProjectEmbedding(projectPath);
	rawDb.close();
}
