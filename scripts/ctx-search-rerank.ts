import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadPluginConfig } from "../packages/plugin/src/config";
import {
	buildCanonicalChunkTextFromFts,
	loadCompartmentChunkEmbeddingsForSearch,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { getLastCompartmentEndMessage } from "../packages/plugin/src/features/magic-context/compartment-storage";
import { loadProjectCommitEmbeddings } from "../packages/plugin/src/features/magic-context/git-commits/storage-git-commit-embeddings";
import { cosineSimilarity } from "../packages/plugin/src/features/magic-context/memory/cosine-similarity";
import { getProjectEmbeddings } from "../packages/plugin/src/features/magic-context/memory/embedding-cache";
import type { SynapseClientLike } from "../packages/plugin/src/features/magic-context/memory/embedding-synapse";
import { getMemoriesByProject } from "../packages/plugin/src/features/magic-context/memory/storage-memory";
import {
	embedTextForProject,
	registerProjectEmbedding,
} from "../packages/plugin/src/features/magic-context/project-embedding-registry";
import {
	type UnifiedSearchOptions,
	type UnifiedSearchResult,
	unifiedSearch,
} from "../packages/plugin/src/features/magic-context/search";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { getActivePrimers } from "../packages/plugin/src/features/magic-context/storage-primers";
import { getVisibleMemoryIds } from "../packages/plugin/src/hooks/magic-context/inject-compartments";
import { Database } from "../packages/plugin/src/shared/sqlite";
import {
	type Fixture,
	type GoldTarget,
	loadFixture,
	openReadOnly,
	type ProjectFixture,
	type QueryFixture,
	resultMatchesGold,
	type SafeHit,
	safeResult,
	validateGolds,
} from "./ctx-search-benchmark";
import {
	ARMS,
	type Arm,
	assertOfflinePath,
	type Candidate,
	candidateText,
	contribution,
	orderLogits,
	type PinnedLane,
	percentile,
	pinReranker,
	type RankRow,
	type RerankSample,
	rrf,
	scorePool,
	summarizeArms,
} from "./lib/ctx-search-rerank";

const SNAPSHOT_ROOT = resolve("local-ignore/ctx-search-rerank");
const EVIDENCE_ROOT = resolve(
	".cortexkit/internal-docs/investigations/reports/ctx-search-rerank-spike",
);
const LANE_LIMIT = 25;

interface SpikeRow extends RankRow {
	query: string;
	project: string;
	class: string;
	gold: GoldTarget[];
	invalidGolds: { gold: GoldTarget; reason: string }[];
	eligible: boolean;
	arms: Record<Arm, SafeHit[]>;
	poolGoldRank: number | null;
	latencyMs: Record<Arm, number>;
	rerankAttempts: RerankSample[];
	laneCounts: Record<string, number>;
}

interface PoolRow {
	queryId: string;
	query: string;
	pool: Candidate<SafeHit>[];
}
interface SpikeResult {
	schemaVersion: number;
	startedAt: string;
	finishedAt: string;
	lane: PinnedLane;
	deadlineMs: number;
	fixtureAsOf: string;
	embedding: { provider: string; modelId: string; chunkModelId: string };
	queries: SpikeRow[];
	summary: ReturnType<typeof summarizeArms>;
	supplementSummary: ReturnType<typeof summarizeArms>;
	fallbacks: Record<Arm, Record<string, number>>;
	latency: Record<
		Arm,
		{ count: number; p50: number | null; p95: number | null }
	>;
}

export function spikeArgs(argv = process.argv.slice(2)) {
	const value = (flag: string, fallback?: string): string => {
		const index = argv.indexOf(flag);
		const found = index < 0 ? fallback : argv[index + 1];
		if (!found || found.startsWith("--"))
			throw new Error(`${flag} requires a value`);
		return found;
	};
	const deadlineMs = Number(value("--deadline-ms", "3000"));
	if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000)
		throw new Error("--deadline-ms must be an integer in 1..120000");
	return {
		context: resolve(value("--context-db")),
		opencode: resolve(value("--opencode-db")),
		fixture: resolve(
			value("--fixture", "scripts/fixtures/ctx-search-known-answers.json"),
		),
		out: resolve(value("--out", join(EVIDENCE_ROOT, "results.json"))),
		connection: resolve(
			value(
				"--connection-file",
				join(homedir(), ".local/share/cortexkit/run/subc-connection.json"),
			),
		),
		poolPath: resolve(value("--pool-cache", join(SNAPSHOT_ROOT, "pools.json"))),
		latencyOnly: argv.includes("--latency-only"),
		deadlineMs,
	};
}

export function fullCandidate(
	db: Database,
	project: ProjectFixture,
	result: UnifiedSearchResult,
): Candidate<SafeHit> {
	const safe = safeResult(result);
	const key = `${safe.source}:${safe.id}`;
	let title = safe.label;
	let body = result.content;
	let createdAt: number | undefined;
	let verified: boolean | undefined;
	let seenCount: number | undefined;
	let location = `${result.source} ${safe.id} ${project.projectPath}`;
	if (result.source === "memory") {
		const row = db
			.prepare(
				"SELECT content, created_at AS createdAt, seen_count AS seenCount, verification_status AS verification FROM memories WHERE id=?",
			)
			.get(result.memoryId) as {
			content: string;
			createdAt: number;
			seenCount: number;
			verification: string;
		};
		body = row.content;
		title = body.split("\n")[0];
		createdAt = row.createdAt;
		verified = row.verification === "verified";
		seenCount = row.seenCount;
	} else if (result.source === "compartment") {
		body =
			buildCanonicalChunkTextFromFts(
				db,
				result.sessionId,
				result.startOrdinal,
				result.endOrdinal,
			) ?? "";
		title = result.title;
		location = `compartment ${result.compartmentId} ${result.sessionId} @${result.startOrdinal}-${result.endOrdinal}`;
		const row = db
			.prepare("SELECT created_at AS createdAt FROM compartments WHERE id=?")
			.get(result.compartmentId) as { createdAt: number };
		createdAt = row.createdAt;
	} else if (result.source === "message") {
		const row = db
			.prepare(
				"SELECT content FROM message_history_fts WHERE session_id=? AND message_id=? ORDER BY CAST(message_ordinal AS INTEGER) LIMIT 1",
			)
			.get(project.sessionId, result.messageId) as { content: string };
		body = row.content;
		title = `${result.role}: ${body.split("\n")[0]}`;
		location = `message ${result.messageId} ${project.sessionId} @${result.messageOrdinal}`;
	} else if (result.source === "primer") {
		const row = db
			.prepare(
				"SELECT question, answer, created_at AS createdAt FROM primers WHERE id=?",
			)
			.get(result.primerId) as {
			question: string;
			answer: string;
			createdAt: number;
		};
		title = row.question;
		body = `Q: ${row.question}\nA: ${row.answer}`;
		createdAt = row.createdAt;
	} else if (result.source === "git_commit") {
		const row = db
			.prepare("SELECT message FROM git_commits WHERE sha=?")
			.get(result.sha) as { message: string };
		body = row.message;
		title = `${result.shortSha} ${body.split("\n")[0]}`;
		createdAt = result.committedAtMs;
	} else if (result.source === "note") {
		const row = db
			.prepare(
				"SELECT content, ready_reason AS readyReason FROM notes WHERE id=?",
			)
			.get(result.noteId) as { content: string; readyReason: string | null };
		body = `${row.content}${row.readyReason ? `\nReason: ${row.readyReason}` : ""}`;
		title = body.split("\n")[0];
		createdAt = result.createdAt;
	}
	return {
		key,
		value: safe,
		text: candidateText(location, title, body),
		createdAt,
		verified,
		seenCount,
	};
}

// Obtain separate full-text and vector-ranked lists for RRF instead of the production source-family score blend.
export async function collectLanes(
	db: Database,
	project: ProjectFixture,
	query: string,
	shared: UnifiedSearchOptions,
	vector: Float32Array,
	modelId: string,
	chunkModelId: string,
): Promise<Record<string, UnifiedSearchResult[]>> {
	const fts = (
		source: "memory" | "primer" | "message" | "git_commit" | "note",
	) =>
		unifiedSearch(db, project.sessionId, project.projectPath, query, {
			...shared,
			limit: LANE_LIMIT,
			embeddingEnabled: false,
			sources: [source],
		});
	const memoryFts = await fts("memory");
	const primerFts = await fts("primer");
	const messageFts = await fts("message");
	const gitFts = await fts("git_commit");
	const notes = await fts("note");
	const memoryEmbeddings = getProjectEmbeddings(
		db,
		project.projectPath,
		modelId,
	);
	const memoryVector: UnifiedSearchResult[] = getMemoriesByProject(
		db,
		project.projectPath,
	)
		.filter(
			(memory) =>
				!shared.visibleMemoryIds?.has(memory.id) &&
				memoryEmbeddings.has(memory.id),
		)
		.map((memory) => ({
			source: "memory" as const,
			memoryId: memory.id,
			category: memory.category,
			content: memory.content,
			matchType: "semantic" as const,
			score:
				(1 +
					cosineSimilarity(
						vector,
						memoryEmbeddings.get(memory.id)?.embedding ?? new Float32Array(),
					)) /
				2,
		}))
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score || a.memoryId - b.memoryId)
		.slice(0, LANE_LIMIT);
	const primerVector: UnifiedSearchResult[] = getActivePrimers(
		db,
		project.projectPath,
	)
		.filter(
			(primer) =>
				primer.questionEmbedding && primer.questionEmbeddingModelId === modelId,
		)
		.map((primer) => ({
			source: "primer" as const,
			primerId: primer.id,
			content: `Q: ${primer.question}\nA: ${primer.answer}`,
			question: primer.question,
			support: primer.totalSupport,
			lastObservedAt: primer.lastObservedAt,
			matchType: "semantic" as const,
			score:
				(1 +
					cosineSimilarity(
						vector,
						primer.questionEmbedding ?? new Float32Array(),
					)) /
				2,
		}))
		.filter((row) => row.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || b.support - a.support || a.primerId - b.primerId,
		)
		.slice(0, LANE_LIMIT);
	const chunks = await loadCompartmentChunkEmbeddingsForSearch(
		db,
		project.sessionId,
		project.projectPath,
		chunkModelId,
	);
	const byCompartment = new Map<
		number,
		UnifiedSearchResult & { source: "compartment" }
	>();
	for (const row of chunks) {
		if (
			shared.maxMessageOrdinal !== undefined &&
			shared.maxMessageOrdinal >= 0 &&
			row.endOrdinal > shared.maxMessageOrdinal
		)
			continue;
		const score = (1 + cosineSimilarity(vector, row.vector)) / 2;
		if (
			score <= 0 ||
			score <= (byCompartment.get(row.compartmentId)?.score ?? -Infinity)
		)
			continue;
		byCompartment.set(row.compartmentId, {
			source: "compartment",
			content: row.title,
			score,
			compartmentId: row.compartmentId,
			sessionId: row.sessionId,
			title: row.title,
			startOrdinal: row.startOrdinal,
			endOrdinal: row.endOrdinal,
			matchType: "semantic",
		});
	}
	const chunkVector = [...byCompartment.values()]
		.sort((a, b) => b.score - a.score || a.startOrdinal - b.startOrdinal)
		.slice(0, LANE_LIMIT);
	const commitVectors = loadProjectCommitEmbeddings(
		db,
		project.projectPath,
		modelId,
	);
	const commits = db
		.prepare(
			"SELECT sha, short_sha AS shortSha, message, author, committed_at AS committedAtMs FROM git_commits WHERE project_path=?",
		)
		.all(project.projectPath) as {
		sha: string;
		shortSha: string;
		message: string;
		author: string | null;
		committedAtMs: number;
	}[];
	const gitVector: UnifiedSearchResult[] = commits
		.filter((row) => commitVectors.has(row.sha))
		.map((row) => ({
			...row,
			source: "git_commit" as const,
			content: row.message,
			matchType: "semantic" as const,
			score: Math.max(
				0,
				cosineSimilarity(
					vector,
					commitVectors.get(row.sha) ?? new Float32Array(),
				),
			),
		}))
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score || b.committedAtMs - a.committedAtMs)
		.slice(0, LANE_LIMIT);
	return {
		memory_fts: memoryFts,
		memory_vector: memoryVector,
		primer_fts: primerFts,
		primer_vector: primerVector,
		message_fts: messageFts,
		chunk_vector: chunkVector,
		git_fts: gitFts,
		git_vector: gitVector,
		notes,
	};
}

export function validatedGolds(
	db: Database,
	opencode: Database,
	fixture: Fixture,
	query: QueryFixture,
) {
	const gold: GoldTarget[] = [];
	const invalidGolds: SpikeRow["invalidGolds"] = [];
	for (const target of query.gold) {
		try {
			validateGolds(db, opencode, {
				...fixture,
				queries: [{ ...query, gold: [target] }],
			});
			gold.push(target);
		} catch (error) {
			invalidGolds.push({
				gold: target,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { gold, invalidGolds };
}

export function rank(
	hits: readonly SafeHit[],
	gold: GoldTarget[],
): number | null {
	const index = hits.findIndex((hit) => resultMatchesGold(hit, gold));
	return index < 0 ? null : index + 1;
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fallbackCounts(
	rows: readonly SpikeRow[],
): Record<Arm, Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const row of rows)
		for (const sample of row.rerankAttempts)
			if (sample.fallback)
				counts[sample.fallback] = (counts[sample.fallback] ?? 0) + 1;
	return { A: {}, B: {}, C: counts, D: { ...counts } };
}

function latencySummary(rows: readonly SpikeRow[]) {
	return Object.fromEntries(
		ARMS.map((arm) => {
			const values = rows
				.filter((row) => row.eligible)
				.map((row) => row.latencyMs[arm]);
			return [
				arm,
				{
					count: values.length,
					p50: percentile(values, 0.5),
					p95: percentile(values, 0.95),
				},
			];
		}),
	) as SpikeResult["latency"];
}

export function createSpikeScratch(): Database {
	// openDatabase(":memory:") secures "." and creates a placeholder file before opening SQLite's in-memory database.
	// Bypass that filesystem policy for disposable registration state.
	const db = new Database(":memory:");
	initializeDatabase(db);
	return db;
}

export async function runRerankSpike(): Promise<void> {
	const args = spikeArgs();
	assertOfflinePath(args.context, SNAPSHOT_ROOT);
	assertOfflinePath(args.opencode, SNAPSHOT_ROOT);
	const { SubcClient } = (await import(
		import.meta.resolve(
			"@cortexkit/subc-client",
			new URL(
				"../packages/plugin/src/features/magic-context/memory/embedding-synapse.ts",
				import.meta.url,
			).href,
		)
	)) as {
		SubcClient: {
			connect(options: { connectionFile: string }): Promise<SynapseClientLike>;
		};
	};
	const client = await SubcClient.connect({ connectionFile: args.connection });
	const options = {
		timeoutMs: 10000,
		targetKind: "management_surface" as const,
		identity: {
			project_root: process.cwd(),
			harness: "mason",
			session: "ctx-search-rerank-spike",
		},
	};
	try {
		const lane = pinReranker(
			await client.call("synapse", "models.list", {}, options),
		);
		if (args.latencyOnly) {
			const pools = JSON.parse(
				readFileSync(args.poolPath, "utf8"),
			) as PoolRow[];
			const startedAt = new Date().toISOString();
			const calls: { queryId: string; attempts: RerankSample[] }[] = [];
			for (const row of pools) {
				const attempts: RerankSample[] = [];
				for (let attempt = 0; attempt < 6; attempt++) {
					const sample = await scorePool(
						client,
						lane,
						row.query,
						row.pool,
						args.deadlineMs,
						process.cwd(),
					);
					attempts.push(sample);
					if (sample.scores) break;
				}
				if (!attempts.at(-1)?.scores)
					throw new Error(
						`Latency pass never obtained real scores for ${row.queryId}: ${JSON.stringify(attempts)}`,
					);
				calls.push({ queryId: row.queryId, attempts });
			}
			const all = calls.flatMap((row) => row.attempts);
			const success = all
				.filter((row) => row.scores)
				.map((row) => row.elapsedMs);
			writeJson(args.out, {
				schemaVersion: 1,
				startedAt,
				finishedAt: new Date().toISOString(),
				lane,
				deadlineMs: args.deadlineMs,
				calls,
				success: {
					count: success.length,
					p50: percentile(success, 0.5),
					p95: percentile(success, 0.95),
				},
				allAttempts: {
					count: all.length,
					p50: percentile(
						all.map((row) => row.elapsedMs),
						0.5,
					),
					p95: percentile(
						all.map((row) => row.elapsedMs),
						0.95,
					),
				},
			});
			console.log(
				`Latency pass: ${calls.length} real reranks, ${all.length - success.length} fallbacks; p50=${percentile(success, 0.5)}ms p95=${percentile(success, 0.95)}ms`,
			);
			return;
		}
		const fixture = loadFixture(args.fixture);
		const queries = [
			...fixture.queries,
			...(fixture.rerankSupplementQueries ?? []),
		];
		if (queries.some((query) => !query.shape))
			throw new Error("Every spike query requires a manually assigned shape");
		// An online backup has no WAL sidecars. Immutable reads avoid trying to create them and cannot write the snapshot.
		const db = openReadOnly(args.context, true);
		const opencode = openReadOnly(args.opencode, true);
		const scratch = createSpikeScratch();
		try {
			const startedAt = new Date().toISOString();
			const config = loadPluginConfig(process.cwd());
			const snapshots = new Map<
				string,
				ReturnType<typeof registerProjectEmbedding>
			>();
			for (const [key, project] of Object.entries(fixture.projects)) {
				const snapshot = registerProjectEmbedding(
					scratch,
					project.projectPath,
					config.embedding,
					{ memoryEnabled: true, gitCommitEnabled: true },
					process.cwd(),
				);
				const stored = db
					.prepare(
						"SELECT model_id AS modelId, chunk_model_id AS chunkModelId FROM embedding_registrations WHERE project_path=?",
					)
					.get(project.projectPath) as
					| { modelId: string; chunkModelId: string }
					| undefined;
				if (
					!stored ||
					snapshot.modelId !== stored.modelId ||
					snapshot.chunkModelId !== stored.chunkModelId
				)
					throw new Error(
						`Configured embedding space does not match snapshot for ${key}: ${snapshot.modelId}/${snapshot.chunkModelId} vs ${stored?.modelId}/${stored?.chunkModelId}`,
					);
				snapshots.set(key, snapshot);
			}
			const rows: SpikeRow[] = [];
			const pools: PoolRow[] = [];
			for (const query of queries) {
				const project = fixture.projects[query.project];
				const validation = validatedGolds(db, opencode, fixture, query);
				if (!validation.gold.length) {
					rows.push({
						id: query.id,
						shape: query.shape ?? "prose",
						class: query.class,
						query: query.query,
						project: query.project,
						...validation,
						eligible: false,
						ranks: { A: null, B: null, C: null, D: null },
						arms: { A: [], B: [], C: [], D: [] },
						poolGoldRank: null,
						latencyMs: { A: 0, B: 0, C: 0, D: 0 },
						rerankAttempts: [],
						laneCounts: {},
					});
					console.log(
						`${query.id} excluded: ${validation.invalidGolds.map((row) => row.reason).join("; ")}`,
					);
					continue;
				}
				const captured = await embedTextForProject(
					project.projectPath,
					query.query,
					undefined,
					"query",
				);
				if (!captured)
					throw new Error(`Real query embedding unavailable for ${query.id}`);
				const snapshot = snapshots.get(query.project);
				if (!snapshot)
					throw new Error(`Missing embedding snapshot for ${query.project}`);
				const shared: UnifiedSearchOptions = {
					rerank: false,
					limit: 10,
					memoryEnabled: true,
					embeddingEnabled: true,
					embedQuery: async () => captured,
					isEmbeddingRuntimeEnabled: () => true,
					maxMessageOrdinal: getLastCompartmentEndMessage(
						db,
						project.sessionId,
					),
					gitCommitsEnabled: true,
					visibleMemoryIds: getVisibleMemoryIds(db, project.sessionId),
					explicitSearch: true,
					countRetrievals: false,
					measurementDisabled: true,
					backfillMemoryEmbeddings: false,
				};
				const aStart = performance.now();
				const a = (
					await unifiedSearch(
						db,
						project.sessionId,
						project.projectPath,
						query.query,
						shared,
					)
				).map(safeResult);
				const aMs = performance.now() - aStart;
				const bStart = performance.now();
				const lanes = await collectLanes(
					db,
					project,
					query.query,
					shared,
					captured.vector,
					snapshot.modelId,
					snapshot.chunkModelId,
				);
				const candidateCache = new Map<string, Candidate<SafeHit>>();
				const candidate = (hit: UnifiedSearchResult) => {
					const key = `${hit.source}:${safeResult(hit).id}`;
					let value = candidateCache.get(key);
					if (!value) {
						value = fullCandidate(db, project, hit);
						candidateCache.set(key, value);
					}
					return value;
				};
				// A raw message inside a retrieved compartment is evidence for that compartment, not a duplicate slot.
				const compartments = lanes.chunk_vector.filter(
					(hit) => hit.source === "compartment",
				);
				lanes.message_fts = lanes.message_fts.map((hit) =>
					hit.source === "message"
						? (compartments.find(
								(chunk) =>
									hit.messageOrdinal >= chunk.startOrdinal &&
									hit.messageOrdinal <= chunk.endOrdinal,
							) ?? hit)
						: hit,
				);
				const pool = rrf(
					Object.values(lanes).map((list) => list.map(candidate)),
					20,
				);
				if (!pool.length)
					throw new Error(
						`No fused candidates for ${query.id}; cannot measure a real rerank`,
					);
				const bMs = performance.now() - bStart;
				pools.push({ queryId: query.id, query: query.query, pool });
				writeJson(args.poolPath, pools);
				const attempts: RerankSample[] = [];
				for (let attempt = 0; attempt < 6; attempt++) {
					const sample = await scorePool(
						client,
						lane,
						query.query,
						pool,
						args.deadlineMs,
						process.cwd(),
					);
					attempts.push(sample);
					if (sample.scores) break;
					console.log(
						`${query.id} fallback ${sample.fallback}: C/D fused order; retrying for quality`,
					);
				}
				const success = attempts.at(-1);
				if (!success?.scores)
					throw new Error(
						`Quality run never obtained real rerank scores for ${query.id}: ${JSON.stringify(attempts)}`,
					);
				const cStart = performance.now();
				const c = orderLogits(pool, success.scores).map((row) => row.value);
				const cOrderMs = performance.now() - cStart;
				const dStart = performance.now();
				const d = orderLogits(pool, success.scores, Date.parse(startedAt)).map(
					(row) => row.value,
				);
				const dOrderMs = performance.now() - dStart;
				const arms = { A: a, B: pool.map((row) => row.value), C: c, D: d };
				const ranks = Object.fromEntries(
					ARMS.map((arm) => [arm, rank(arms[arm], validation.gold)]),
				) as SpikeRow["ranks"];
				rows.push({
					id: query.id,
					shape: query.shape ?? "prose",
					class: query.class,
					query: query.query,
					project: query.project,
					...validation,
					eligible: true,
					arms,
					ranks,
					poolGoldRank: ranks.B,
					latencyMs: {
						A: aMs,
						B: bMs,
						C: bMs + success.elapsedMs + cOrderMs,
						D: bMs + success.elapsedMs + dOrderMs,
					},
					rerankAttempts: attempts,
					laneCounts: Object.fromEntries(
						Object.entries(lanes).map(([key, value]) => [key, value.length]),
					),
				});
				console.log(
					`[${rows.length}/${queries.length}] ${query.id}: ${ARMS.map((arm) => `${arm}=${ranks[arm] ?? "miss"}`).join(" ")} rerank=${success.elapsedMs.toFixed(1)}ms`,
				);
				writeJson(args.out, {
					schemaVersion: 1,
					startedAt,
					lane,
					queries: rows,
				});
			}
			const snapshot = snapshots.values().next().value;
			if (!snapshot) throw new Error("No project snapshots");
			const result: SpikeResult = {
				schemaVersion: 1,
				startedAt,
				finishedAt: new Date().toISOString(),
				lane,
				deadlineMs: args.deadlineMs,
				fixtureAsOf: fixture.asOf,
				embedding: {
					provider: config.embedding.provider,
					modelId: snapshot.modelId,
					chunkModelId: snapshot.chunkModelId,
				},
				queries: rows,
				summary: summarizeArms(
					rows.filter((row) => row.eligible && !row.id.startsWith("path-")),
				),
				supplementSummary: summarizeArms(
					rows.filter((row) => row.eligible && row.id.startsWith("path-")),
				),
				fallbacks: fallbackCounts(rows),
				latency: latencySummary(rows),
			};
			writeJson(args.out, result);
			console.log(
				`Wrote ${args.out}; measured ${rows.filter((row) => row.eligible).length}/${rows.length} queries with real scores`,
			);
		} finally {
			db.close();
			opencode.close();
			scratch.close();
		}
	} finally {
		client.close();
	}
}

export function renderSpikeTables(result: SpikeResult): string {
	const fmt = (value: number | null, digits = 3) =>
		value === null ? "n/a" : value.toFixed(digits);
	const lines = [
		"## Quality (first known-answer hit; MRR truncated at 10)",
		"",
		"| Shape | n | Arm | R@1 | R@5 | R@10 | MRR@10 |",
		"|---|---:|---|---:|---:|---:|---:|",
	];
	for (const [cohort, summary] of [
		...Object.entries(result.summary).filter(([, stats]) => stats.count > 0),
		["supplemental:path", result.supplementSummary.path] as const,
	]) {
		for (const arm of ARMS) {
			const stats = summary.arms[arm];
			lines.push(
				`| ${cohort} | ${summary.count} | ${arm} | ${["recall1", "recall5", "recall10", "mrr"].map((key) => fmt(stats.metrics[key as keyof typeof stats.metrics])).join(" | ")} |`,
			);
		}
	}
	lines.push(
		"",
		"## Paired differences from A (95% percentile bootstrap)",
		"",
		"| Shape | Arm | ΔR@1 [CI] | ΔR@5 [CI] | ΔR@10 [CI] | ΔMRR@10 [CI] |",
		"|---|---|---|---|---|---|",
	);
	for (const [cohort, summary] of [
		...Object.entries(result.summary).filter(([, stats]) => stats.count > 0),
		["supplemental:path", result.supplementSummary.path] as const,
	])
		for (const arm of ["B", "C", "D"] as const) {
			const stats = summary.arms[arm];
			lines.push(
				`| ${cohort} | ${arm} | ${Object.values(stats.differencesFromA)
					.map(
						(value) =>
							`${fmt(value.delta)} [${fmt(value.low)}, ${fmt(value.high)}]`,
					)
					.join(" | ")} |`,
			);
		}
	lines.push(
		"",
		"## Large per-query wins/losses",
		"",
		"Compared with A (today's ranking), an arm's change is large when |Δ reciprocal rank at 10| ≥ 0.25 or recall@10 changes. Ranks beyond 10 count as misses for MRR; `—` is absent from the returned pool.",
		"",
		"| Query | Shape | Arm | A rank | Arm rank | ΔRR@10 | Query text |",
		"|---|---|---|---:|---:|---:|---|",
	);
	for (const row of result.queries.filter((row) => row.eligible))
		for (const arm of ["B", "C", "D"] as const) {
			const delta =
				contribution(row.ranks[arm], "mrr") - contribution(row.ranks.A, "mrr");
			if (
				Math.abs(delta) < 0.25 &&
				contribution(row.ranks[arm], "recall10") ===
					contribution(row.ranks.A, "recall10")
			)
				continue;
			lines.push(
				`| ${row.id} | ${row.shape} | ${arm} | ${row.ranks.A ?? "—"} | ${row.ranks[arm] ?? "—"} | ${fmt(delta)} | ${row.query.replaceAll("|", "\\|")} |`,
			);
		}
	lines.push(
		"",
		"## Every query",
		"",
		"| Query | Shape | A | B | C | D | Eligibility / invalid golds |",
		"|---|---|---:|---:|---:|---:|---|",
	);
	for (const row of result.queries)
		lines.push(
			`| ${row.id} | ${row.shape} | ${ARMS.map((arm) => row.ranks[arm] ?? "—").join(" | ")} | ${row.eligible ? "scored" : "excluded: no surviving gold"}${row.invalidGolds.length ? `; ${row.invalidGolds.map((g) => g.reason).join("; ")}` : ""} |`,
		);
	return `${lines.join("\n")}\n`;
}
