#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
	buildCanonicalChunkTextFromFts,
	buildCompartmentSummaryFallbackText,
	CHUNK_WINDOW_SAFETY_RATIO,
	chunkCanonicalText,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { cosineSimilarity } from "../packages/plugin/src/features/magic-context/memory/cosine-similarity";
import {
	SynapseEmbeddingProvider,
	type SynapseLaneMetadata,
} from "../packages/plugin/src/features/magic-context/memory/embedding-synapse";
import {
	estimateTokens,
	preloadTokenizer,
} from "../packages/plugin/src/hooks/magic-context/read-session-formatting";
import { getMagicContextStorageDir } from "../packages/plugin/src/shared/data-path";
import {
	Database,
	type Database as DatabaseType,
} from "../packages/plugin/src/shared/sqlite";

const MAX_ROW_TOKENS = 512;
const MAX_BATCH_ROWS = 32;
const QUERY_TIMEOUT_MS = 60_000;
const BATCH_TIMEOUT_MS = 120_000;
const METAL_MODEL = "gte-modernbert-base-f16";
const METAL_FINGERPRINT_PREFIX = "24cc5271";
const ANE_MODEL = "gte-modernbert-base-ane-fp16";
const ANE_FINGERPRINT_PREFIX = "5a2374bc";
const TOKENIZER_CITATION =
	"packages/plugin/src/hooks/magic-context/read-session-formatting.ts::estimateTokens (ai-tokenizer Claude encoding)";
const MATCHER_CITATION = "scripts/ctx-search-benchmark.ts::resultMatchesGold";
const CHUNKER_CITATION =
	"packages/plugin/src/features/magic-context/compartment-chunk-embedding.ts::buildCanonicalChunkTextFromFts + chunkCanonicalText";

type SourceClass = "compartment" | "memory" | "git_commit";
type LaneKey = "metal" | "ane";
type QueryClass = "conversation" | "identifier" | "fact_rule" | "mixed_hard";
type GoldSource = SourceClass | "message" | "primer" | "note";

interface ProjectFixture {
	label: string;
	projectPath: string;
	sessionId: string;
}

interface GoldTarget {
	source: GoldSource;
	id: number | string;
	label: string;
	sequence?: number;
	startOrdinal?: number;
	endOrdinal?: number;
	ordinal?: number;
	compartmentId?: number;
	category?: string;
	date?: string;
}

interface QueryFixture {
	id: string;
	class: QueryClass;
	style: string;
	project: string;
	query: string;
	controlQuery?: string;
	expectedFilter?: string;
	gold: GoldTarget[];
}

interface Fixture {
	version: number;
	asOf: string;
	description: string;
	projects: Record<string, ProjectFixture>;
	queries: QueryFixture[];
}

interface CliArgs {
	fixturePath: string;
	contextDbPath: string;
	connectionFile: string;
	scratchPath: string;
	outputPath: string;
	reportPath: string;
}

interface CorpusRow {
	itemId: string;
	project: string;
	projectPath: string;
	source: SourceClass;
	sourceId: number | string;
	text: string;
	tokens: number;
	label: string;
	compartmentId?: number;
	startOrdinal?: number;
	endOrdinal?: number;
	windowStartOrdinal?: number;
	windowEndOrdinal?: number;
}

interface ExcludedRow {
	project: string;
	source: SourceClass;
	sourceId: number | string;
	tokens: number | null;
	reason: string;
}

interface RankedHit {
	source: string;
	id: number | string;
	score: number;
	label: string;
	ordinal?: number;
	startOrdinal?: number;
	endOrdinal?: number;
}

interface BatchPlan {
	index: number;
	rows: CorpusRow[];
}

interface BatchSample {
	batchIndex: number;
	itemIds: string[];
	itemCount: number;
	milliseconds: number;
	status: "accepted" | "refused" | "skipped";
}

interface RefusedBatch {
	lane: LaneKey;
	batchIndex: number;
	daemonMessage: string;
	items: Array<{
		itemId: string;
		project: string;
		source: SourceClass;
		sourceId: number | string;
		tokens: number;
		missingFromResponse: boolean;
	}>;
}

interface QuerySample {
	queryId: string;
	milliseconds: number;
}

interface LaneRun {
	key: LaneKey;
	label: string;
	model: string;
	expectedFingerprintPrefix: string;
	metadata: SynapseLaneMetadata;
	startedAt: string;
	stoppedAt: string;
	warmupMs: number;
	observedDims: number;
	batchSamples: BatchSample[];
	querySamples: QuerySample[];
}

interface RecallMetrics {
	denominator: number;
	recallAt1: number;
	recallAt5: number;
	recallAt10: number;
	mrr: number;
}

interface QueryRanks {
	id: string;
	class: QueryClass;
	project: string;
	ranks: Record<SourceClass | "overall", Record<LaneKey, number | null>>;
}

interface ScratchVectorRow {
	itemId: string;
	project: string;
	source: SourceClass;
	sourceId: string;
	label: string;
	compartmentId: number | null;
	startOrdinal: number | null;
	endOrdinal: number | null;
	dims: number;
	vector: Uint8Array | ArrayBuffer;
}

interface StoredCandidate extends RankedHit {
	itemId: string;
	project: string;
	vector: Float32Array;
	compartmentId: number | null;
}

interface LaneLatencySummary {
	corpus: ReturnType<typeof summarizeCorpusLatency>;
	queries: ReturnType<typeof summarizeQueryLatency>;
	warmupMs: number;
	windowWallMs: number;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const value = (flag: string, fallback: string): string => {
		const index = args.indexOf(flag);
		if (index < 0) return fallback;
		const found = args[index + 1];
		if (!found || found.startsWith("--"))
			throw new Error(`${flag} requires a value`);
		return found;
	};
	const localRoot = resolve(
		process.cwd(),
		"local-ignore",
		"ctx-search-synapse-lanes",
	);
	return {
		fixturePath: resolve(
			value(
				"--fixture",
				join(process.cwd(), "scripts/fixtures/ctx-search-known-answers.json"),
			),
		),
		contextDbPath: resolve(
			value("--context-db", join(getMagicContextStorageDir(), "context.db")),
		),
		connectionFile: resolve(
			value(
				"--connection-file",
				join(homedir(), ".local/share/cortexkit/run/subc-connection.json"),
			),
		),
		scratchPath: resolve(value("--scratch", join(localRoot, "vectors.sqlite"))),
		outputPath: resolve(value("--output", join(localRoot, "results.json"))),
		reportPath: resolve(
			value(
				"--report",
				join(
					process.cwd(),
					".cortexkit/internal-docs/research/synapse-metal-vs-ane-2026-09-08.md",
				),
			),
		),
	};
}

function assertUnder(path: string, parent: string, description: string): void {
	const pathFromParent = relative(parent, path);
	if (pathFromParent.startsWith("..") || isAbsolute(pathFromParent)) {
		throw new Error(`${description} must stay under ${parent}: ${path}`);
	}
}

function loadFixture(path: string): Fixture {
	const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	assert.equal(
		fixture.version,
		1,
		`Unsupported fixture version: ${fixture.version}`,
	);
	assert.equal(
		fixture.queries.length,
		50,
		"This comparison requires the 50-gold fixture",
	);
	const ids = new Set<string>();
	for (const query of fixture.queries) {
		assert(!ids.has(query.id), `Duplicate query id: ${query.id}`);
		ids.add(query.id);
		assert(
			fixture.projects[query.project],
			`Unknown project '${query.project}' on ${query.id}`,
		);
		assert(query.gold.length > 0, `Query ${query.id} has no gold targets`);
		const tokens = estimateTokens(query.query);
		assert(
			tokens <= MAX_ROW_TOKENS,
			`Query ${query.id} has ${tokens} tokens, above the ${MAX_ROW_TOKENS}-token lane cap`,
		);
	}
	return fixture;
}

function openContextReadOnly(path: string): {
	db: DatabaseType;
	uri: string;
	queryOnly: number;
} {
	if (!existsSync(path)) throw new Error(`Database does not exist: ${path}`);
	const uri = `file:${path}?mode=ro`;
	assert(uri.includes("mode=ro"), "context.db URI must explicitly use mode=ro");
	const db = new Database(uri, { readonly: true });
	db.exec("PRAGMA query_only=ON");
	const pragma = db.prepare("PRAGMA query_only").get() as
		| { query_only?: number }
		| undefined;
	const queryOnly = Number(pragma?.query_only ?? 0);
	assert.equal(
		queryOnly,
		1,
		"context.db connection did not enter PRAGMA query_only mode",
	);
	return { db, uri, queryOnly };
}

function initializeScratch(path: string): DatabaseType {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.exec(`
        PRAGMA journal_mode=WAL;
        DROP TABLE IF EXISTS query_vectors;
        DROP TABLE IF EXISTS corpus_vectors;
        CREATE TABLE corpus_vectors (
            lane TEXT NOT NULL,
            item_id TEXT NOT NULL,
            project_key TEXT NOT NULL,
            project_path TEXT NOT NULL,
            source_class TEXT NOT NULL,
            source_id TEXT NOT NULL,
            label TEXT NOT NULL,
            compartment_id INTEGER,
            start_ordinal INTEGER,
            end_ordinal INTEGER,
            window_start_ordinal INTEGER,
            window_end_ordinal INTEGER,
            token_count INTEGER NOT NULL,
            dims INTEGER NOT NULL,
            vector BLOB NOT NULL,
            PRIMARY KEY (lane, item_id)
        );
        CREATE INDEX idx_corpus_vectors_lane_project_source
            ON corpus_vectors(lane, project_key, source_class);
        CREATE TABLE query_vectors (
            lane TEXT NOT NULL,
            query_id TEXT NOT NULL,
            project_key TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            dims INTEGER NOT NULL,
            vector BLOB NOT NULL,
            latency_ms REAL NOT NULL,
            PRIMARY KEY (lane, query_id)
        );
    `);
	return db;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function vectorBytes(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function decodeVector(value: Uint8Array | ArrayBuffer): Float32Array {
	if (value instanceof Uint8Array) {
		const bytes = value.buffer.slice(
			value.byteOffset,
			value.byteOffset + value.byteLength,
		);
		return new Float32Array(bytes);
	}
	return new Float32Array(value.slice(0));
}

function countBySource(
	rows: readonly { source: SourceClass }[],
): Record<SourceClass, number> {
	const counts: Record<SourceClass, number> = {
		compartment: 0,
		memory: 0,
		git_commit: 0,
	};
	for (const row of rows) counts[row.source] += 1;
	return counts;
}

function prepareCorpus(
	db: DatabaseType,
	fixture: Fixture,
	memoryCutoffMs: number,
): {
	rows: CorpusRow[];
	excluded: ExcludedRow[];
	sourceRows: Record<SourceClass, number>;
	candidateRowsBeforeExclusion: Record<SourceClass, number>;
} {
	const rows: CorpusRow[] = [];
	const excluded: ExcludedRow[] = [];
	const sourceRows: Record<SourceClass, number> = {
		compartment: 0,
		memory: 0,
		git_commit: 0,
	};
	const candidateRowsBeforeExclusion: Record<SourceClass, number> = {
		compartment: 0,
		memory: 0,
		git_commit: 0,
	};

	const include = (row: Omit<CorpusRow, "tokens">): void => {
		const tokens = estimateTokens(row.text);
		candidateRowsBeforeExclusion[row.source] += 1;
		if (tokens > MAX_ROW_TOKENS || tokens === 0) {
			const reason =
				tokens > MAX_ROW_TOKENS
					? `estimated tokens ${tokens} exceed ${MAX_ROW_TOKENS}`
					: "empty tokenized text";
			const omission = {
				project: row.project,
				source: row.source,
				sourceId: row.sourceId,
				tokens,
				reason,
			} satisfies ExcludedRow;
			excluded.push(omission);
			console.log(
				`EXCLUDED project=${row.project} class=${row.source} id=${row.sourceId} tokens=${tokens} reason=${reason}`,
			);
			return;
		}
		rows.push({ ...row, tokens });
	};

	for (const [projectKey, project] of Object.entries(fixture.projects)) {
		const memoryRows = db
			.prepare(
				`SELECT id, content, category
                 FROM memories
                 WHERE project_path = ?
                   AND status IN ('active', 'permanent')
                   AND (expires_at IS NULL OR expires_at > ?)
                 ORDER BY id ASC`,
			)
			.all(project.projectPath, memoryCutoffMs) as Array<{
			id: number;
			content: string;
			category: string;
		}>;
		sourceRows.memory += memoryRows.length;
		for (const memory of memoryRows) {
			include({
				itemId: `${projectKey}:memory:${memory.id}`,
				project: projectKey,
				projectPath: project.projectPath,
				source: "memory",
				sourceId: memory.id,
				text: memory.content,
				label: memory.category,
			});
		}

		const commitRows = db
			.prepare(
				`SELECT sha, short_sha AS shortSha, message
                 FROM git_commits
                 WHERE project_path = ?
                 ORDER BY committed_at DESC, sha ASC`,
			)
			.all(project.projectPath) as Array<{
			sha: string;
			shortSha: string;
			message: string;
		}>;
		sourceRows.git_commit += commitRows.length;
		for (const commit of commitRows) {
			include({
				itemId: `${projectKey}:git_commit:${commit.sha}`,
				project: projectKey,
				projectPath: project.projectPath,
				source: "git_commit",
				sourceId: commit.sha,
				text: commit.message,
				label: commit.shortSha,
			});
		}

		const compartmentRows = db
			.prepare(
				`SELECT c.id,
                        c.title,
                        c.start_message AS startOrdinal,
                        c.end_message AS endOrdinal
                 FROM compartments c
                 JOIN session_projects sp
                   ON sp.session_id = c.session_id
                  AND sp.harness = c.harness
                  AND sp.project_path = ?
                 WHERE c.session_id = ?
                 ORDER BY c.start_message ASC, c.id ASC`,
			)
			.all(project.projectPath, project.sessionId) as Array<{
			id: number;
			title: string;
			startOrdinal: number;
			endOrdinal: number;
		}>;
		sourceRows.compartment += compartmentRows.length;
		for (const compartment of compartmentRows) {
			const mapped = buildCanonicalChunkTextFromFts(
				db,
				project.sessionId,
				compartment.startOrdinal,
				compartment.endOrdinal,
			);
			if (mapped === null) {
				const omission = {
					project: projectKey,
					source: "compartment",
					sourceId: compartment.id,
					tokens: null,
					reason: "message FTS ordinal map incomplete",
				} satisfies ExcludedRow;
				excluded.push(omission);
				console.log(
					`EXCLUDED project=${projectKey} class=compartment id=${compartment.id} tokens=unknown reason=${omission.reason}`,
				);
				continue;
			}
			const canonical =
				mapped || buildCompartmentSummaryFallbackText(db, compartment.id);
			if (!canonical) {
				const omission = {
					project: projectKey,
					source: "compartment",
					sourceId: compartment.id,
					tokens: 0,
					reason: "empty canonical transcript and summary fallback",
				} satisfies ExcludedRow;
				excluded.push(omission);
				console.log(
					`EXCLUDED project=${projectKey} class=compartment id=${compartment.id} tokens=0 reason=${omission.reason}`,
				);
				continue;
			}
			const windows = chunkCanonicalText(
				canonical,
				compartment.startOrdinal,
				compartment.endOrdinal,
				MAX_ROW_TOKENS,
			);
			if (windows.length === 0) {
				const omission = {
					project: projectKey,
					source: "compartment",
					sourceId: compartment.id,
					tokens: 0,
					reason: "chunker produced no transcript windows",
				} satisfies ExcludedRow;
				excluded.push(omission);
				console.log(
					`EXCLUDED project=${projectKey} class=compartment id=${compartment.id} tokens=0 reason=${omission.reason}`,
				);
				continue;
			}
			for (const window of windows) {
				include({
					itemId: `${projectKey}:compartment:${compartment.id}:${window.windowIndex}`,
					project: projectKey,
					projectPath: project.projectPath,
					source: "compartment",
					sourceId: compartment.id,
					text: window.text,
					label: compartment.title,
					compartmentId: compartment.id,
					startOrdinal: compartment.startOrdinal,
					endOrdinal: compartment.endOrdinal,
					windowStartOrdinal: window.startOrdinal,
					windowEndOrdinal: window.endOrdinal,
				});
			}
		}
	}

	return { rows, excluded, sourceRows, candidateRowsBeforeExclusion };
}

function validateGolds(db: DatabaseType, fixture: Fixture): void {
	for (const query of fixture.queries) {
		const project = fixture.projects[query.project];
		for (const gold of query.gold) {
			if (gold.source === "compartment") {
				const row = db
					.prepare(
						`SELECT session_id AS sessionId,
                                start_message AS startOrdinal,
                                end_message AS endOrdinal
                         FROM compartments WHERE id = ?`,
					)
					.get(gold.id) as
					| { sessionId: string; startOrdinal: number; endOrdinal: number }
					| undefined;
				assert(
					row && row.sessionId === project.sessionId,
					`Invalid compartment gold ${gold.id}`,
				);
				if (gold.startOrdinal !== undefined) {
					assert.equal(
						row.startOrdinal,
						gold.startOrdinal,
						`Stale start ordinal on ${query.id}`,
					);
					assert.equal(
						row.endOrdinal,
						gold.endOrdinal,
						`Stale end ordinal on ${query.id}`,
					);
				}
			} else if (gold.source === "message") {
				const row = db
					.prepare(
						`SELECT CAST(message_ordinal AS INTEGER) AS ordinal
                         FROM message_history_fts
                         WHERE session_id = ? AND message_id = ? LIMIT 1`,
					)
					.get(project.sessionId, gold.id) as { ordinal: number } | undefined;
				assert(row, `Invalid message gold ${gold.id}`);
				if (gold.ordinal !== undefined) {
					assert.equal(
						row.ordinal,
						gold.ordinal,
						`Stale message ordinal on ${query.id}`,
					);
				}
			} else if (gold.source === "memory") {
				const row = db
					.prepare(
						"SELECT project_path AS projectPath FROM memories WHERE id = ?",
					)
					.get(gold.id) as { projectPath: string } | undefined;
				assert(
					row && row.projectPath === project.projectPath,
					`Invalid memory gold ${gold.id}`,
				);
			} else if (gold.source === "git_commit") {
				const row = db
					.prepare(
						"SELECT project_path AS projectPath FROM git_commits WHERE sha = ?",
					)
					.get(gold.id) as { projectPath: string } | undefined;
				assert(
					row && row.projectPath === project.projectPath,
					`Invalid commit gold ${gold.id}`,
				);
			} else if (gold.source === "note") {
				assert(
					db.prepare("SELECT id FROM notes WHERE id = ?").get(gold.id),
					`Invalid note gold ${gold.id}`,
				);
			} else if (gold.source === "primer") {
				assert(
					db.prepare("SELECT id FROM primers WHERE id = ?").get(gold.id),
					`Invalid primer gold ${gold.id}`,
				);
			}
		}
	}
}

function discoverLane(
	key: LaneKey,
	model: string,
	expectedFingerprintPrefix: string,
	connectionFile: string,
	runId: string,
): Promise<SynapseLaneMetadata> {
	return SynapseEmbeddingProvider.discover({
		connectionFile,
		projectRoot: process.cwd(),
		session: `script:ctx-search-synapse-lanes:${runId}:${key}:discover`,
		model,
		queryTimeoutMs: QUERY_TIMEOUT_MS,
	}).then((metadata) => {
		assert.equal(
			metadata.model,
			model,
			`${key} discovery returned the wrong model`,
		);
		assert(
			metadata.fingerprint.startsWith(expectedFingerprintPrefix),
			`${key} fingerprint ${metadata.fingerprint} does not start with ${expectedFingerprintPrefix}`,
		);
		assert.notEqual(metadata.certified, false, `${key} lane is not certified`);
		assert.notEqual(
			metadata.status,
			"not_certified",
			`${key} lane is not certified`,
		);
		return metadata;
	});
}

function sharedBatchPolicy(metadata: readonly SynapseLaneMetadata[]): {
	rowLimit: number;
	estimatedTokenBudget: number | null;
} {
	const rowLimit = Math.min(
		MAX_BATCH_ROWS,
		...metadata.map((lane) => lane.recommended_batch ?? MAX_BATCH_ROWS),
	);
	const budgets = metadata
		.map((lane) => lane.recommended_token_budget)
		.filter((value): value is number => typeof value === "number" && value > 0);
	return {
		rowLimit: Math.max(1, Math.floor(rowLimit)),
		estimatedTokenBudget: budgets.length > 0 ? Math.min(...budgets) : null,
	};
}

function planBatches(
	rows: readonly CorpusRow[],
	rowLimit: number,
	estimatedTokenBudget: number | null,
): BatchPlan[] {
	const batches: BatchPlan[] = [];
	let current: CorpusRow[] = [];
	let currentBudget = 0;
	const flush = (): void => {
		if (current.length === 0) return;
		batches.push({ index: batches.length + 1, rows: current });
		current = [];
		currentBudget = 0;
	};
	for (const row of rows) {
		// Match SynapseEmbeddingProvider's published page-budget estimate.
		const estimated = Math.ceil(row.text.length / 4);
		if (
			current.length >= rowLimit ||
			(estimatedTokenBudget !== null &&
				current.length > 0 &&
				currentBudget + estimated > estimatedTokenBudget)
		) {
			flush();
		}
		current.push(row);
		currentBudget += estimated;
	}
	flush();
	return batches;
}

function createProvider(
	key: LaneKey,
	metadata: SynapseLaneMetadata,
	connectionFile: string,
	runId: string,
): SynapseEmbeddingProvider {
	return new SynapseEmbeddingProvider({
		connectionFile,
		projectRoot: process.cwd(),
		session: `script:ctx-search-synapse-lanes:${runId}:${key}`,
		model: metadata.model,
		fingerprint: metadata.fingerprint,
		tableEpoch: metadata.table_epoch,
		...(metadata.dims ? { dims: metadata.dims } : {}),
		...(metadata.recommended_batch
			? {
					recommendedBatch: Math.min(
						MAX_BATCH_ROWS,
						metadata.recommended_batch,
					),
				}
			: { recommendedBatch: MAX_BATCH_ROWS }),
		queryTimeoutMs: QUERY_TIMEOUT_MS,
		batchTimeoutMs: BATCH_TIMEOUT_MS,
	});
}

function saveCorpusVectors(
	scratch: DatabaseType,
	lane: LaneKey,
	rows: readonly CorpusRow[],
	vectors: ReadonlyMap<string, Float32Array>,
): void {
	const insert = scratch.prepare(
		`INSERT INTO corpus_vectors (
            lane, item_id, project_key, project_path, source_class, source_id, label,
            compartment_id, start_ordinal, end_ordinal, window_start_ordinal,
            window_end_ordinal, token_count, dims, vector
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	scratch.transaction(() => {
		for (const row of rows) {
			const vector = vectors.get(row.itemId);
			assert(vector, `Missing ${lane} vector for ${row.itemId}`);
			insert.run(
				lane,
				row.itemId,
				row.project,
				row.projectPath,
				row.source,
				String(row.sourceId),
				row.label,
				row.compartmentId ?? null,
				row.startOrdinal ?? null,
				row.endOrdinal ?? null,
				row.windowStartOrdinal ?? null,
				row.windowEndOrdinal ?? null,
				row.tokens,
				vector.length,
				vectorBytes(vector),
			);
		}
	})();
}

function saveQueryVector(
	scratch: DatabaseType,
	lane: LaneKey,
	query: QueryFixture,
	vector: Float32Array,
	milliseconds: number,
): void {
	scratch
		.prepare(
			`INSERT INTO query_vectors
                (lane, query_id, project_key, token_count, dims, vector, latency_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			lane,
			query.id,
			query.project,
			estimateTokens(query.query),
			vector.length,
			vectorBytes(vector),
			milliseconds,
		);
}

async function runLane(args: {
	key: LaneKey;
	label: string;
	model: string;
	expectedFingerprintPrefix: string;
	metadata: SynapseLaneMetadata;
	connectionFile: string;
	runId: string;
	batches: readonly BatchPlan[];
	fixture: Fixture;
	scratch: DatabaseType;
	excludedItemIds: Set<string>;
	refusedBatches: RefusedBatch[];
}): Promise<LaneRun> {
	const startedAt = new Date().toISOString();
	console.log(`LANE ${args.key} START ${startedAt}`);
	let provider = createProvider(
		args.key,
		args.metadata,
		args.connectionFile,
		args.runId,
	);
	let observedDims = args.metadata.dims ?? 0;
	const batchSamples: BatchSample[] = [];
	const querySamples: QuerySample[] = [];
	let warmupMs = 0;
	let stoppedAt = "";
	try {
		const warmupStarted = performance.now();
		const warmup = await provider.embed("warmup");
		warmupMs = performance.now() - warmupStarted;
		if (!warmup) {
			const message =
				provider.getLastFailureReason()?.reason ?? "embed.query returned null";
			throw new Error(`${args.key} warm-up failed: ${message}`);
		}
		observedDims = warmup.length;
		console.log(
			`LANE ${args.key} WARMUP discarded ms=${warmupMs.toFixed(1)} dims=${observedDims}`,
		);

		for (const batch of args.batches) {
			if (batch.rows.some((row) => args.excludedItemIds.has(row.itemId))) {
				batchSamples.push({
					batchIndex: batch.index,
					itemIds: batch.rows.map((row) => row.itemId),
					itemCount: batch.rows.length,
					milliseconds: 0,
					status: "skipped",
				});
				continue;
			}
			const requests = batch.rows.map((row) => {
				const contentSha256 = hashText(row.text);
				return {
					row,
					item: {
						// A run-scoped transport id prevents stale daemon item caches from
						// confusing a changed live row with an earlier benchmark request.
						id: `${args.key}:${hashText(`${args.runId}\0${row.itemId}\0${contentSha256}`)}`,
						text: row.text,
						contentSha256,
					},
				};
			});
			const started = performance.now();
			const responseVectors = await provider.embedItems(
				requests.map((request) => request.item),
			);
			const milliseconds = performance.now() - started;
			const vectors = new Map<string, Float32Array>();
			for (const request of requests) {
				const vector = responseVectors.get(request.item.id);
				if (vector) vectors.set(request.row.itemId, vector);
			}
			const missing = batch.rows.filter((row) => !vectors.has(row.itemId));
			if (missing.length > 0 || vectors.size !== batch.rows.length) {
				const daemonMessage =
					provider.getLastFailureReason()?.reason ??
					`embedItems returned ${vectors.size}/${batch.rows.length} vectors`;
				console.log(
					`REFUSED lane=${args.key} batch=${batch.index} daemon_message=${daemonMessage}`,
				);
				const missingIds = new Set(missing.map((row) => row.itemId));
				for (const row of batch.rows) {
					console.log(
						`REFUSED_ROW lane=${args.key} batch=${batch.index} id=${row.itemId} tokens=${row.tokens} missing=${missingIds.has(row.itemId)}`,
					);
					args.excludedItemIds.add(row.itemId);
				}
				args.scratch
					.prepare(
						`DELETE FROM corpus_vectors
                         WHERE item_id IN (${batch.rows.map(() => "?").join(",")})`,
					)
					.run(...batch.rows.map((row) => row.itemId));
				args.refusedBatches.push({
					lane: args.key,
					batchIndex: batch.index,
					daemonMessage,
					items: batch.rows.map((row) => ({
						itemId: row.itemId,
						project: row.project,
						source: row.source,
						sourceId: row.sourceId,
						tokens: row.tokens,
						missingFromResponse: missingIds.has(row.itemId),
					})),
				});
				batchSamples.push({
					batchIndex: batch.index,
					itemIds: batch.rows.map((row) => row.itemId),
					itemCount: batch.rows.length,
					milliseconds,
					status: "refused",
				});
				await provider.dispose();
				provider = createProvider(
					args.key,
					args.metadata,
					args.connectionFile,
					args.runId,
				);
				continue;
			}
			for (const vector of vectors.values()) {
				assert.equal(
					vector.length,
					observedDims,
					`${args.key} vector dimensions changed`,
				);
			}
			saveCorpusVectors(args.scratch, args.key, batch.rows, vectors);
			batchSamples.push({
				batchIndex: batch.index,
				itemIds: batch.rows.map((row) => row.itemId),
				itemCount: batch.rows.length,
				milliseconds,
				status: "accepted",
			});
			if (batch.index % 25 === 0 || batch.index === args.batches.length) {
				console.log(
					`LANE ${args.key} CORPUS batch=${batch.index}/${args.batches.length} rows=${batch.rows.length} ms=${milliseconds.toFixed(1)}`,
				);
			}
		}

		for (const [index, query] of args.fixture.queries.entries()) {
			const started = performance.now();
			const vector = await provider.embed(query.query);
			const milliseconds = performance.now() - started;
			if (!vector) {
				const message =
					provider.getLastFailureReason()?.reason ??
					"embed.query returned null";
				throw new Error(`${args.key} query ${query.id} failed: ${message}`);
			}
			assert.equal(
				vector.length,
				observedDims,
				`${args.key} query dimensions changed`,
			);
			saveQueryVector(args.scratch, args.key, query, vector, milliseconds);
			querySamples.push({ queryId: query.id, milliseconds });
			console.log(
				`LANE ${args.key} QUERY ${index + 1}/${args.fixture.queries.length} id=${query.id} ms=${milliseconds.toFixed(1)}`,
			);
		}
	} finally {
		await provider.dispose();
		stoppedAt = new Date().toISOString();
		console.log(`LANE ${args.key} STOP ${stoppedAt}`);
	}
	return {
		key: args.key,
		label: args.label,
		model: args.model,
		expectedFingerprintPrefix: args.expectedFingerprintPrefix,
		metadata: args.metadata,
		startedAt,
		stoppedAt,
		warmupMs,
		observedDims,
		batchSamples,
		querySamples,
	};
}

function percentile(
	values: readonly number[],
	quantile: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor((sorted.length - 1) * quantile)] ?? null;
}

function rounded(value: number | null, digits = 3): number | null {
	return value === null ? null : Number(value.toFixed(digits));
}

function summarizeCorpusLatency(
	samples: readonly BatchSample[],
	excludedItemIds: ReadonlySet<string>,
): {
	batchCount: number;
	itemCount: number;
	batchWallMsP50: number | null;
	batchWallMsP95: number | null;
	totalMs: number;
	perItemMs: number | null;
	refusedBatchCount: number;
	skippedBatchCount: number;
	rawAcceptedSamples: Array<{
		batchIndex: number;
		itemCount: number;
		milliseconds: number;
	}>;
} {
	const accepted = samples.filter(
		(sample) =>
			sample.status === "accepted" &&
			!sample.itemIds.some((itemId) => excludedItemIds.has(itemId)),
	);
	const milliseconds = accepted.map((sample) => sample.milliseconds);
	const itemCount = accepted.reduce((sum, sample) => sum + sample.itemCount, 0);
	const totalMs = milliseconds.reduce((sum, value) => sum + value, 0);
	return {
		batchCount: accepted.length,
		itemCount,
		batchWallMsP50: rounded(percentile(milliseconds, 0.5), 1),
		batchWallMsP95: rounded(percentile(milliseconds, 0.95), 1),
		totalMs: Number(totalMs.toFixed(1)),
		perItemMs: itemCount > 0 ? Number((totalMs / itemCount).toFixed(3)) : null,
		refusedBatchCount: samples.filter((sample) => sample.status === "refused")
			.length,
		skippedBatchCount: samples.filter((sample) => sample.status === "skipped")
			.length,
		rawAcceptedSamples: accepted.map((sample) => ({
			batchIndex: sample.batchIndex,
			itemCount: sample.itemCount,
			milliseconds: Number(sample.milliseconds.toFixed(3)),
		})),
	};
}

function summarizeQueryLatency(samples: readonly QuerySample[]): {
	count: number;
	p50Ms: number | null;
	p95Ms: number | null;
	totalMs: number;
	perItemMs: number | null;
	rawSamples: Array<{ queryId: string; milliseconds: number }>;
} {
	const values = samples.map((sample) => sample.milliseconds);
	const totalMs = values.reduce((sum, value) => sum + value, 0);
	return {
		count: samples.length,
		p50Ms: rounded(percentile(values, 0.5), 1),
		p95Ms: rounded(percentile(values, 0.95), 1),
		totalMs: Number(totalMs.toFixed(1)),
		perItemMs:
			values.length > 0 ? Number((totalMs / values.length).toFixed(3)) : null,
		rawSamples: samples.map((sample) => ({
			queryId: sample.queryId,
			milliseconds: Number(sample.milliseconds.toFixed(3)),
		})),
	};
}

function loadCandidates(
	scratch: DatabaseType,
	lane: LaneKey,
): Map<string, Map<SourceClass, StoredCandidate[]>> {
	const output = new Map<string, Map<SourceClass, StoredCandidate[]>>();
	const rows = scratch
		.prepare(
			`SELECT item_id AS itemId,
                    project_key AS project,
                    source_class AS source,
                    source_id AS sourceId,
                    label,
                    compartment_id AS compartmentId,
                    start_ordinal AS startOrdinal,
                    end_ordinal AS endOrdinal,
                    dims,
                    vector
             FROM corpus_vectors
             WHERE lane = ?
             ORDER BY project_key, source_class, item_id`,
		)
		.all(lane) as ScratchVectorRow[];
	for (const row of rows) {
		let bySource = output.get(row.project);
		if (!bySource) {
			bySource = new Map();
			output.set(row.project, bySource);
		}
		let candidates = bySource.get(row.source);
		if (!candidates) {
			candidates = [];
			bySource.set(row.source, candidates);
		}
		const vector = decodeVector(row.vector);
		assert.equal(
			vector.length,
			row.dims,
			`Corrupt scratch vector ${row.itemId}`,
		);
		candidates.push({
			itemId: row.itemId,
			project: row.project,
			source: row.source,
			id: row.source === "memory" ? Number(row.sourceId) : row.sourceId,
			label: row.label,
			score: 0,
			vector,
			compartmentId: row.compartmentId,
			...(row.startOrdinal === null ? {} : { startOrdinal: row.startOrdinal }),
			...(row.endOrdinal === null ? {} : { endOrdinal: row.endOrdinal }),
		});
	}
	return output;
}

function loadQueryVector(
	scratch: DatabaseType,
	lane: LaneKey,
	queryId: string,
): Float32Array {
	const row = scratch
		.prepare(
			"SELECT dims, vector FROM query_vectors WHERE lane = ? AND query_id = ?",
		)
		.get(lane, queryId) as
		| { dims: number; vector: Uint8Array | ArrayBuffer }
		| undefined;
	assert(row, `Missing scratch query vector ${lane}:${queryId}`);
	const vector = decodeVector(row.vector);
	assert.equal(
		vector.length,
		row.dims,
		`Corrupt scratch query vector ${lane}:${queryId}`,
	);
	return vector;
}

function resultMatchesGold(
	result: RankedHit,
	golds: readonly GoldTarget[],
): boolean {
	return golds.some((gold) => {
		if (result.source === gold.source && String(result.id) === String(gold.id))
			return true;
		if (result.source === "compartment") {
			if (gold.source === "compartment" && result.id === gold.id) return true;
			if (gold.compartmentId !== undefined && result.id === gold.compartmentId)
				return true;
			if (
				gold.ordinal !== undefined &&
				result.startOrdinal !== undefined &&
				result.endOrdinal !== undefined &&
				gold.ordinal >= result.startOrdinal &&
				gold.ordinal <= result.endOrdinal
			) {
				return true;
			}
		}
		if (
			result.source === "message" &&
			result.ordinal !== undefined &&
			gold.startOrdinal !== undefined &&
			gold.endOrdinal !== undefined
		) {
			return (
				result.ordinal >= gold.startOrdinal && result.ordinal <= gold.endOrdinal
			);
		}
		return false;
	});
}

function rankSource(
	queryVector: Float32Array,
	candidates: readonly StoredCandidate[],
	golds: readonly GoldTarget[],
	source: SourceClass,
): { rank: number | null; hits: RankedHit[] } {
	if (source === "compartment") {
		const byCompartment = new Map<string, RankedHit>();
		for (const candidate of candidates) {
			assert.equal(
				candidate.vector.length,
				queryVector.length,
				"Scratch dimensions differ within lane",
			);
			const score = cosineSimilarity(queryVector, candidate.vector);
			const key = String(candidate.compartmentId ?? candidate.id);
			const prior = byCompartment.get(key);
			if (!prior || score > prior.score) {
				byCompartment.set(key, {
					...candidate,
					id: candidate.compartmentId ?? candidate.id,
					score,
				});
			}
		}
		const hits = [...byCompartment.values()].sort(
			(left, right) =>
				right.score - left.score ||
				String(left.id).localeCompare(String(right.id)),
		);
		const index = hits.findIndex((hit) => resultMatchesGold(hit, golds));
		return { rank: index < 0 ? null : index + 1, hits };
	}
	const hits = candidates
		.map((candidate) => {
			assert.equal(
				candidate.vector.length,
				queryVector.length,
				"Scratch dimensions differ within lane",
			);
			return {
				...candidate,
				score: cosineSimilarity(queryVector, candidate.vector),
			};
		})
		.sort(
			(left, right) =>
				right.score - left.score ||
				String(left.id).localeCompare(String(right.id)),
		);
	const index = hits.findIndex((hit) => resultMatchesGold(hit, golds));
	return { rank: index < 0 ? null : index + 1, hits };
}

function metrics(ranks: readonly (number | null)[]): RecallMetrics {
	const denominator = ranks.length;
	const rate = (cutoff: number): number =>
		denominator === 0
			? 0
			: Number(
					(
						ranks.filter((rank) => rank !== null && rank <= cutoff).length /
						denominator
					).toFixed(4),
				);
	const reciprocal = ranks.reduce<number>(
		(sum, rank) => sum + (rank === null ? 0 : 1 / rank),
		0,
	);
	return {
		denominator,
		recallAt1: rate(1),
		recallAt5: rate(5),
		recallAt10: rate(10),
		mrr: denominator === 0 ? 0 : Number((reciprocal / denominator).toFixed(4)),
	};
}

function computeRecall(
	scratch: DatabaseType,
	fixture: Fixture,
): {
	bySource: Record<SourceClass, Record<LaneKey, RecallMetrics>>;
	overall: Record<LaneKey, RecallMetrics>;
	byQueryClass: Record<QueryClass, Record<LaneKey, RecallMetrics>>;
	paired: QueryRanks[];
	differingQueriesOverall: number;
	differingQueriesAnyRank: number;
	differingQueriesBySource: Record<SourceClass, number>;
} {
	const candidates: Record<
		LaneKey,
		Map<string, Map<SourceClass, StoredCandidate[]>>
	> = {
		metal: loadCandidates(scratch, "metal"),
		ane: loadCandidates(scratch, "ane"),
	};
	const paired: QueryRanks[] = [];
	for (const query of fixture.queries) {
		const ranks: QueryRanks["ranks"] = {
			compartment: { metal: null, ane: null },
			memory: { metal: null, ane: null },
			git_commit: { metal: null, ane: null },
			overall: { metal: null, ane: null },
		};
		for (const lane of ["metal", "ane"] as const) {
			const queryVector = loadQueryVector(scratch, lane, query.id);
			const bySource = candidates[lane].get(query.project) ?? new Map();
			const allHits: RankedHit[] = [];
			for (const source of ["compartment", "memory", "git_commit"] as const) {
				const ranked = rankSource(
					queryVector,
					bySource.get(source) ?? [],
					query.gold,
					source,
				);
				ranks[source][lane] = ranked.rank;
				allHits.push(...ranked.hits);
			}
			allHits.sort(
				(left, right) =>
					right.score - left.score ||
					left.source.localeCompare(right.source) ||
					String(left.id).localeCompare(String(right.id)),
			);
			const overallIndex = allHits.findIndex((hit) =>
				resultMatchesGold(hit, query.gold),
			);
			ranks.overall[lane] = overallIndex < 0 ? null : overallIndex + 1;
		}
		paired.push({
			id: query.id,
			class: query.class,
			project: query.project,
			ranks,
		});
	}

	const bySource = Object.fromEntries(
		(["compartment", "memory", "git_commit"] as const).map((source) => [
			source,
			Object.fromEntries(
				(["metal", "ane"] as const).map((lane) => [
					lane,
					metrics(paired.map((query) => query.ranks[source][lane])),
				]),
			),
		]),
	) as Record<SourceClass, Record<LaneKey, RecallMetrics>>;
	const overall = Object.fromEntries(
		(["metal", "ane"] as const).map((lane) => [
			lane,
			metrics(paired.map((query) => query.ranks.overall[lane])),
		]),
	) as Record<LaneKey, RecallMetrics>;
	const byQueryClass = Object.fromEntries(
		(["conversation", "identifier", "fact_rule", "mixed_hard"] as const).map(
			(queryClass) => [
				queryClass,
				Object.fromEntries(
					(["metal", "ane"] as const).map((lane) => [
						lane,
						metrics(
							paired
								.filter((query) => query.class === queryClass)
								.map((query) => query.ranks.overall[lane]),
						),
					]),
				),
			],
		),
	) as Record<QueryClass, Record<LaneKey, RecallMetrics>>;
	return {
		bySource,
		overall,
		byQueryClass,
		paired,
		differingQueriesOverall: paired.filter(
			(query) => query.ranks.overall.metal !== query.ranks.overall.ane,
		).length,
		differingQueriesAnyRank: paired.filter((query) =>
			(["compartment", "memory", "git_commit", "overall"] as const).some(
				(source) => query.ranks[source].metal !== query.ranks[source].ane,
			),
		).length,
		differingQueriesBySource: Object.fromEntries(
			(["compartment", "memory", "git_commit"] as const).map((source) => [
				source,
				paired.filter(
					(query) => query.ranks[source].metal !== query.ranks[source].ane,
				).length,
			]),
		) as Record<SourceClass, number>,
	};
}

function ratio(
	numerator: number | null,
	denominator: number | null,
): number | null {
	if (numerator === null || denominator === null || denominator === 0)
		return null;
	return Number((numerator / denominator).toFixed(3));
}

function rankCell(rank: number | null): string {
	return rank === null ? "—" : String(rank);
}

function markdownEscape(value: unknown): string {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function metricsRows(
	groups: Record<string, Record<LaneKey, RecallMetrics>>,
): string[] {
	const lines = [
		"| Group | Lane | N | R@1 | R@5 | R@10 | MRR |",
		"|---|---:|---:|---:|---:|---:|---:|",
	];
	for (const [group, lanes] of Object.entries(groups)) {
		for (const lane of ["metal", "ane"] as const) {
			const value = lanes[lane];
			lines.push(
				`| ${group} | ${lane} | ${value.denominator} | ${value.recallAt1.toFixed(4)} | ${value.recallAt5.toFixed(4)} | ${value.recallAt10.toFixed(4)} | ${value.mrr.toFixed(4)} |`,
			);
		}
	}
	return lines;
}

function buildMarkdown(result: Record<string, unknown>): string {
	const runWindow = result.runWindow as {
		start: string;
		stop: string;
		lanes: Record<LaneKey, { start: string; stop: string }>;
	};
	const lanes = result.lanes as Record<
		LaneKey,
		{
			label: string;
			model: string;
			fingerprint: string;
			dims: number;
			status?: string;
		}
	>;
	const corpus = result.corpus as {
		sourceRows: Record<SourceClass, number>;
		candidateRowsBeforeExclusion: Record<SourceClass, number>;
		finalRows: Record<SourceClass, number>;
		excludedCounts: Record<SourceClass, number>;
		excludedRows: ExcludedRow[];
		refusedBatches: RefusedBatch[];
		finalRowCount: number;
	};
	const recall = result.recall as ReturnType<typeof computeRecall>;
	const latency = result.latency as Record<LaneKey, LaneLatencySummary>;
	const comparison = result.comparison as {
		exactRecallMetricParity: boolean;
		queryP50RatioAneOverMetal: number | null;
		queryP95RatioAneOverMetal: number | null;
		corpusPerItemRatioAneOverMetal: number | null;
	};
	const verdict = result.verdict as string;
	const overallGroups = { overall: recall.overall };
	const excludedLines =
		corpus.excludedRows.length === 0
			? ["No rows were excluded by preprocessing."]
			: [
					"| Project | Class | ID | Tokens | Reason |",
					"|---|---|---|---:|---|",
					...corpus.excludedRows.map(
						(row) =>
							`| ${row.project} | ${row.source} | ${markdownEscape(row.sourceId)} | ${row.tokens ?? "unknown"} | ${markdownEscape(row.reason)} |`,
					),
				];
	const refusedLines =
		corpus.refusedBatches.length === 0
			? ["No daemon-refused batches (0)."]
			: [
					"| Lane | Batch | Daemon message | Rows (token counts) |",
					"|---|---:|---|---|",
					...corpus.refusedBatches.map(
						(batch) =>
							`| ${batch.lane} | ${batch.batchIndex} | ${markdownEscape(batch.daemonMessage)} | ${batch.items.map((item) => `${markdownEscape(item.itemId)}=${item.tokens}`).join(", ")} |`,
					),
				];
	const pairedLines = [
		"| Query | Project | Query class | Compartment M/A | Memory M/A | Commit M/A | Overall M/A |",
		"|---|---|---|---:|---:|---:|---:|",
		...recall.paired.map(
			(query) =>
				`| ${query.id} | ${query.project} | ${query.class} | ${rankCell(query.ranks.compartment.metal)}/${rankCell(query.ranks.compartment.ane)} | ${rankCell(query.ranks.memory.metal)}/${rankCell(query.ranks.memory.ane)} | ${rankCell(query.ranks.git_commit.metal)}/${rankCell(query.ranks.git_commit.ane)} | ${rankCell(query.ranks.overall.metal)}/${rankCell(query.ranks.overall.ane)} |`,
		),
	];
	const formatMs = (value: number | null): string =>
		value === null ? "—" : value.toFixed(1);

	return `# SYNAPSE Metal vs ANE — 50-gold ctx_search comparison

Generated from the live daemon on 2026-09-08. This is a paired Metal-vs-ANE run only; the qwen primary embedding space was not read or compared.

## Verdict

${verdict}

Exact aggregate recall metric parity: **${comparison.exactRecallMetricParity ? "yes" : "no"}**. Query p50 ANE/Metal: **${comparison.queryP50RatioAneOverMetal ?? "n/a"}x**; query p95 ANE/Metal: **${comparison.queryP95RatioAneOverMetal ?? "n/a"}x**; corpus per-item ANE/Metal: **${comparison.corpusPerItemRatioAneOverMetal ?? "n/a"}x**.

## Run windows (UTC)

| Window | START | STOP |
|---|---|---|
| Entire daemon-facing run | ${runWindow.start} | ${runWindow.stop} |
| Metal | ${runWindow.lanes.metal.start} | ${runWindow.lanes.metal.stop} |
| ANE | ${runWindow.lanes.ane.start} | ${runWindow.lanes.ane.stop} |

## Lane identities

| Lane | Model | Full fingerprint | Dimensions | Status |
|---|---|---|---:|---|
| Metal | ${lanes.metal.model} | \`${lanes.metal.fingerprint}\` | ${lanes.metal.dims} | ${lanes.metal.status ?? "ready/certified"} |
| ANE | ${lanes.ane.model} | \`${lanes.ane.fingerprint}\` | ${lanes.ane.dims} | ${lanes.ane.status ?? "ready/certified"} |

Vectors were kept in separate scratch tables by lane and were never mixed. Dimension parity: **${lanes.metal.dims === lanes.ane.dims ? "same" : "different"}**.

## Corpus and exclusions

Memory rows use the ctx_search-visible states (active/permanent and non-expired at the recorded cutoff). Compartment rows are canonical transcript windows generated with the production shadow chunker at a 512-token cap (90% safety margin = ${CHUNK_WINDOW_SAFETY_RATIO}); commits use their stored message. Every candidate row is measured by the production token estimator and rows over 512 are excluded, never truncated.

| Class | Source records | Candidate rows before exclusion | Excluded | Final paired rows |
|---|---:|---:|---:|---:|
| compartment | ${corpus.sourceRows.compartment} | ${corpus.candidateRowsBeforeExclusion.compartment} | ${corpus.excludedCounts.compartment} | ${corpus.finalRows.compartment} |
| memory | ${corpus.sourceRows.memory} | ${corpus.candidateRowsBeforeExclusion.memory} | ${corpus.excludedCounts.memory} | ${corpus.finalRows.memory} |
| git_commit | ${corpus.sourceRows.git_commit} | ${corpus.candidateRowsBeforeExclusion.git_commit} | ${corpus.excludedCounts.git_commit} | ${corpus.finalRows.git_commit} |
| **total** | ${Object.values(corpus.sourceRows).reduce((sum, value) => sum + value, 0)} | ${Object.values(corpus.candidateRowsBeforeExclusion).reduce((sum, value) => sum + value, 0)} | ${corpus.excludedRows.length} | ${corpus.finalRowCount} |

### Every excluded row

${excludedLines.join("\n")}

### Daemon-refused batches

${refusedLines.join("\n")}

## Recall by corpus class

All class rows use the full 50-query denominator, matching the existing harness's per-lane summary convention. A miss contributes zero to MRR.

${metricsRows(recall.bySource).join("\n")}

## Overall recall

${metricsRows(overallGroups).join("\n")}

## Overall recall by fixture query class

${metricsRows(recall.byQueryClass).join("\n")}

Rank differences: overall ${recall.differingQueriesOverall}/50; any reported rank ${recall.differingQueriesAnyRank}/50; compartment ${recall.differingQueriesBySource.compartment}/50; memory ${recall.differingQueriesBySource.memory}/50; commit ${recall.differingQueriesBySource.git_commit}/50.

## Latency

Warm-ups are shown for auditability but excluded from every timed distribution. Corpus timings are client-side wall time around each shared batch plan. Query timings are 50 sequential single-item \`embed\` calls, the ctx_search-relevant path.

| Lane | Warm-up ms (discarded) | Accepted batches | Items | Batch p50 ms | Batch p95 ms | Corpus total ms | Per-item ms | Lane window ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Metal | ${latency.metal.warmupMs.toFixed(1)} | ${latency.metal.corpus.batchCount} | ${latency.metal.corpus.itemCount} | ${formatMs(latency.metal.corpus.batchWallMsP50)} | ${formatMs(latency.metal.corpus.batchWallMsP95)} | ${latency.metal.corpus.totalMs.toFixed(1)} | ${latency.metal.corpus.perItemMs?.toFixed(3) ?? "—"} | ${latency.metal.windowWallMs.toFixed(1)} |
| ANE | ${latency.ane.warmupMs.toFixed(1)} | ${latency.ane.corpus.batchCount} | ${latency.ane.corpus.itemCount} | ${formatMs(latency.ane.corpus.batchWallMsP50)} | ${formatMs(latency.ane.corpus.batchWallMsP95)} | ${latency.ane.corpus.totalMs.toFixed(1)} | ${latency.ane.corpus.perItemMs?.toFixed(3) ?? "—"} | ${latency.ane.windowWallMs.toFixed(1)} |

| Lane | Single queries | Query p50 ms | Query p95 ms | Query total ms | Query mean ms |
|---|---:|---:|---:|---:|---:|
| Metal | ${latency.metal.queries.count} | ${formatMs(latency.metal.queries.p50Ms)} | ${formatMs(latency.metal.queries.p95Ms)} | ${latency.metal.queries.totalMs.toFixed(1)} | ${latency.metal.queries.perItemMs?.toFixed(3) ?? "—"} |
| ANE | ${latency.ane.queries.count} | ${formatMs(latency.ane.queries.p50Ms)} | ${formatMs(latency.ane.queries.p95Ms)} | ${latency.ane.queries.totalMs.toFixed(1)} | ${latency.ane.queries.perItemMs?.toFixed(3) ?? "—"} |

## Paired per-query ranks

M/A means Metal rank / ANE rank; — means no matching gold in that ranked class.

${pairedLines.join("\n")}

## Method and safety

- Token cut: \`${TOKENIZER_CITATION}\`; tokenizer preload was required, so the character fallback was not used.
- Chunk transcript construction: \`${CHUNKER_CITATION}\`, configured at ${MAX_ROW_TOKENS} tokens with the production ${CHUNK_WINDOW_SAFETY_RATIO} safety ratio.
- Gold matching: copied from \`${MATCHER_CITATION}\` (exact source/id plus the same compartment id and ordinal-range rules).
- Source database: opened as a \`file:...?mode=ro\` URI with the constructor's readonly flag and \`PRAGMA query_only=1\` asserted before reads.
- Vectors: persisted only to the ignored scratch SQLite; context.db was never opened writable and no project configuration was changed.
`;
}

async function main(): Promise<void> {
	const cli = parseArgs();
	const localIgnoreRoot = resolve(process.cwd(), "local-ignore");
	assertUnder(cli.scratchPath, localIgnoreRoot, "Scratch SQLite");
	assertUnder(cli.outputPath, localIgnoreRoot, "Result JSON");
	assert.notEqual(
		cli.scratchPath,
		cli.contextDbPath,
		"Scratch SQLite must not be context.db",
	);
	if (!existsSync(cli.connectionFile)) {
		throw new Error(
			`SYNAPSE connection file does not exist: ${cli.connectionFile}`,
		);
	}
	const tokenizerReady = await preloadTokenizer();
	assert(
		tokenizerReady,
		"ai-tokenizer must be available; refusing a heuristic token-cap run",
	);
	const fixture = loadFixture(cli.fixturePath);
	const context = openContextReadOnly(cli.contextDbPath);
	const scratch = initializeScratch(cli.scratchPath);
	const memoryCutoffMs = Date.now();
	let globalStart = "";
	let globalStop = "";
	try {
		validateGolds(context.db, fixture);
		const corpus = prepareCorpus(context.db, fixture, memoryCutoffMs);
		console.log(
			`CORPUS candidates=${corpus.rows.length} excluded=${corpus.excluded.length} counts=${JSON.stringify(countBySource(corpus.rows))}`,
		);

		const runId = `${Date.now()}`;
		globalStart = new Date().toISOString();
		console.log(`START ${globalStart}`);
		const metalMetadata = await discoverLane(
			"metal",
			METAL_MODEL,
			METAL_FINGERPRINT_PREFIX,
			cli.connectionFile,
			runId,
		);
		const aneMetadata = await discoverLane(
			"ane",
			ANE_MODEL,
			ANE_FINGERPRINT_PREFIX,
			cli.connectionFile,
			runId,
		);
		const batchPolicy = sharedBatchPolicy([metalMetadata, aneMetadata]);
		const batches = planBatches(
			corpus.rows,
			batchPolicy.rowLimit,
			batchPolicy.estimatedTokenBudget,
		);
		console.log(
			`BATCH_POLICY rows<=${batchPolicy.rowLimit} token_budget=${batchPolicy.estimatedTokenBudget ?? "none"} batches=${batches.length}`,
		);
		const excludedItemIds = new Set<string>();
		const refusedBatches: RefusedBatch[] = [];
		const metal = await runLane({
			key: "metal",
			label: "Metal f16",
			model: METAL_MODEL,
			expectedFingerprintPrefix: METAL_FINGERPRINT_PREFIX,
			metadata: metalMetadata,
			connectionFile: cli.connectionFile,
			runId,
			batches,
			fixture,
			scratch,
			excludedItemIds,
			refusedBatches,
		});
		const ane = await runLane({
			key: "ane",
			label: "ANE fp16",
			model: ANE_MODEL,
			expectedFingerprintPrefix: ANE_FINGERPRINT_PREFIX,
			metadata: aneMetadata,
			connectionFile: cli.connectionFile,
			runId,
			batches,
			fixture,
			scratch,
			excludedItemIds,
			refusedBatches,
		});
		globalStop = new Date().toISOString();
		console.log(`STOP ${globalStop}`);

		const finalRows = corpus.rows.filter(
			(row) => !excludedItemIds.has(row.itemId),
		);
		const finalCounts = countBySource(finalRows);
		const refusalExclusions: ExcludedRow[] = [];
		const refusedIds = new Set<string>();
		for (const batch of refusedBatches) {
			for (const item of batch.items) {
				if (refusedIds.has(item.itemId)) continue;
				refusedIds.add(item.itemId);
				refusalExclusions.push({
					project: item.project,
					source: item.source,
					sourceId: item.sourceId,
					tokens: item.tokens,
					reason: `daemon-refused batch ${batch.batchIndex} on ${batch.lane}: ${batch.daemonMessage}`,
				});
			}
		}
		const excludedRows = [...corpus.excluded, ...refusalExclusions];
		const recall = computeRecall(scratch, fixture);
		const latency: Record<LaneKey, LaneLatencySummary> = {
			metal: {
				corpus: summarizeCorpusLatency(metal.batchSamples, excludedItemIds),
				queries: summarizeQueryLatency(metal.querySamples),
				warmupMs: Number(metal.warmupMs.toFixed(1)),
				windowWallMs: Date.parse(metal.stoppedAt) - Date.parse(metal.startedAt),
			},
			ane: {
				corpus: summarizeCorpusLatency(ane.batchSamples, excludedItemIds),
				queries: summarizeQueryLatency(ane.querySamples),
				warmupMs: Number(ane.warmupMs.toFixed(1)),
				windowWallMs: Date.parse(ane.stoppedAt) - Date.parse(ane.startedAt),
			},
		};
		assert.equal(
			latency.metal.corpus.itemCount,
			finalRows.length,
			"Metal final corpus mismatch",
		);
		assert.equal(
			latency.ane.corpus.itemCount,
			finalRows.length,
			"ANE final corpus mismatch",
		);
		assert.equal(
			latency.metal.queries.count,
			50,
			"Metal did not embed all 50 queries",
		);
		assert.equal(
			latency.ane.queries.count,
			50,
			"ANE did not embed all 50 queries",
		);
		const metricParity = (lanes: Record<LaneKey, RecallMetrics>): boolean =>
			JSON.stringify(lanes.metal) === JSON.stringify(lanes.ane);
		const exactRecallMetricParity =
			metricParity(recall.overall) &&
			(["compartment", "memory", "git_commit"] as const).every((source) =>
				metricParity(recall.bySource[source]),
			);
		const comparison = {
			exactRecallMetricParity,
			queryP50RatioAneOverMetal: ratio(
				latency.ane.queries.p50Ms,
				latency.metal.queries.p50Ms,
			),
			queryP95RatioAneOverMetal: ratio(
				latency.ane.queries.p95Ms,
				latency.metal.queries.p95Ms,
			),
			corpusPerItemRatioAneOverMetal: ratio(
				latency.ane.corpus.perItemMs,
				latency.metal.corpus.perItemMs,
			),
		};
		const parityPhrase = exactRecallMetricParity
			? "The Metal and ANE lanes reached exact aggregate recall parity"
			: "The Metal and ANE lanes did not reach exact aggregate recall parity";
		const verdict = `${parityPhrase} on the identical ${finalRows.length}-row corpus and all 50 fixture queries (overall R@10 ${recall.overall.metal.recallAt10.toFixed(4)} Metal vs ${recall.overall.ane.recallAt10.toFixed(4)} ANE; MRR ${recall.overall.metal.mrr.toFixed(4)} vs ${recall.overall.ane.mrr.toFixed(4)}). Exact overall ranks differed for ${recall.differingQueriesOverall}/50 queries. Warm query latency was ${comparison.queryP50RatioAneOverMetal ?? "not-computable"}x at p50 and ${comparison.queryP95RatioAneOverMetal ?? "not-computable"}x at p95 for ANE relative to Metal; corpus throughput cost was ${comparison.corpusPerItemRatioAneOverMetal ?? "not-computable"}x per item.`;
		const result = {
			schemaVersion: 1,
			study: "synapse-metal-vs-ane-50-gold",
			generatedAt: new Date().toISOString(),
			runWindow: {
				start: globalStart,
				stop: globalStop,
				lanes: {
					metal: { start: metal.startedAt, stop: metal.stoppedAt },
					ane: { start: ane.startedAt, stop: ane.stoppedAt },
				},
			},
			fixture: {
				path: cli.fixturePath,
				version: fixture.version,
				asOf: fixture.asOf,
				queryCount: fixture.queries.length,
			},
			readOnlySource: {
				contextDbPath: cli.contextDbPath,
				uri: context.uri,
				constructorReadonly: true,
				pragmaQueryOnly: context.queryOnly,
			},
			scratch: {
				sqlitePath: cli.scratchPath,
				resultJsonPath: cli.outputPath,
				vectorsMixedAcrossLanes: false,
			},
			methodology: {
				tokenCap: MAX_ROW_TOKENS,
				tokenizer: TOKENIZER_CITATION,
				tokenizerPreloaded: tokenizerReady,
				tokenizerFallbackUsed: false,
				chunker: CHUNKER_CITATION,
				chunkWindowSafetyRatio: CHUNK_WINDOW_SAFETY_RATIO,
				goldMatcher: MATCHER_CITATION,
				ranking:
					"cosine within fixture project and source class; compartment windows collapse to best score per compartment",
				classMetricDenominator: "all 50 fixture queries",
				primaryQwenCompared: false,
				batchPolicy,
				memoryCutoffMs,
				memoryCutoffUtc: new Date(memoryCutoffMs).toISOString(),
			},
			lanes: {
				metal: {
					label: metal.label,
					model: metal.model,
					fingerprint: metal.metadata.fingerprint,
					tableEpoch: metal.metadata.table_epoch,
					dims: metal.observedDims,
					recommendedBatch: metal.metadata.recommended_batch ?? null,
					recommendedTokenBudget:
						metal.metadata.recommended_token_budget ?? null,
					certified: metal.metadata.certified ?? null,
					status: metal.metadata.status,
					provenance: metal.metadata.provenance ?? null,
				},
				ane: {
					label: ane.label,
					model: ane.model,
					fingerprint: ane.metadata.fingerprint,
					tableEpoch: ane.metadata.table_epoch,
					dims: ane.observedDims,
					recommendedBatch: ane.metadata.recommended_batch ?? null,
					recommendedTokenBudget: ane.metadata.recommended_token_budget ?? null,
					certified: ane.metadata.certified ?? null,
					status: ane.metadata.status,
					provenance: ane.metadata.provenance ?? null,
				},
				dimensionsDiffer: metal.observedDims !== ane.observedDims,
			},
			corpus: {
				sourceRows: corpus.sourceRows,
				candidateRowsBeforeExclusion: corpus.candidateRowsBeforeExclusion,
				selectedBeforeRefusals: countBySource(corpus.rows),
				finalRows: finalCounts,
				finalRowCount: finalRows.length,
				excludedCounts: countBySource(excludedRows),
				excludedRows,
				refusedBatchCount: refusedBatches.length,
				refusedBatches,
			},
			recall,
			latency,
			comparison,
			verdict,
		};
		mkdirSync(dirname(cli.outputPath), { recursive: true });
		writeFileSync(cli.outputPath, `${JSON.stringify(result, null, 2)}\n`);
		mkdirSync(dirname(cli.reportPath), { recursive: true });
		writeFileSync(cli.reportPath, buildMarkdown(result));
		console.log(`WROTE_RESULTS ${cli.outputPath}`);
		console.log(`WROTE_REPORT ${cli.reportPath}`);
		console.log(`VERDICT ${verdict}`);
	} finally {
		if (globalStart && !globalStop) {
			globalStop = new Date().toISOString();
			console.log(`STOP ${globalStop}`);
		}
		scratch.close();
		context.db.close();
	}
}

await main();
