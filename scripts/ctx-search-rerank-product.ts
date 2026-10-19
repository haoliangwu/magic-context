import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadPluginConfig } from "../packages/plugin/src/config";
import { getLastCompartmentEndMessage } from "../packages/plugin/src/features/magic-context/compartment-storage";
import type { SynapseClientLike } from "../packages/plugin/src/features/magic-context/memory/embedding-synapse";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import {
	embedTextForProject,
	registerProjectEmbedding,
} from "../packages/plugin/src/features/magic-context/project-embedding-registry";
import {
	type UnifiedSearchOptions,
	type UnifiedSearchResult,
	unifiedSearch,
} from "../packages/plugin/src/features/magic-context/search";
import {
	candidateTexts,
	fuseSearchLanes,
	isProseQuery,
	prepareReranker,
	rerankSearchResults,
	type SearchLanes,
} from "../packages/plugin/src/features/magic-context/search-rerank";
import { getVisibleMemoryIds } from "../packages/plugin/src/hooks/magic-context/inject-compartments";
import { loadFixture, openReadOnly, safeResult } from "./ctx-search-benchmark";
import {
	collectLanes,
	createSpikeScratch,
	fullCandidate,
	rank,
	spikeArgs,
	validatedGolds,
} from "./ctx-search-rerank";
import { assertOfflinePath, percentile } from "./lib/ctx-search-rerank";

// This runner never resolves a default store: both fenced backup paths are mandatory.
const args = spikeArgs();
const root = resolve("local-ignore/ctx-search-rerank");
assertOfflinePath(args.context, root);
assertOfflinePath(args.opencode, root);
const baselineFlag = process.argv.indexOf("--baseline-module");
const baselinePath =
	baselineFlag >= 0 ? resolve(process.argv[baselineFlag + 1]) : null;
if (baselinePath) assertOfflinePath(baselinePath, root);
const beforeSearch: typeof unifiedSearch = baselinePath
	? (await import(baselinePath)).unifiedSearch
	: unifiedSearch;
const spikeResultsFlag = process.argv.indexOf("--spike-results");
const spikeResultsPath = spikeResultsFlag >= 0 ? process.argv[spikeResultsFlag + 1] : undefined;
if (!spikeResultsPath || spikeResultsPath.startsWith("--")) {
    throw new Error("--spike-results <path> is required; use the offline spike runner's results.json");
}
const archived = JSON.parse(
    readFileSync(spikeResultsPath, "utf8"),
) as {
	queries: {
		id: string;
		arms: { B: { source: string; id: string | number }[] };
		ranks: { C: number | null };
	}[];
};
const fixture = loadFixture(args.fixture);
const { SubcClient } = await import(
	import.meta.resolve(
		"@cortexkit/subc-client",
		new URL(
			"../packages/plugin/src/features/magic-context/search-rerank.ts",
			import.meta.url,
		).href,
	)
);
const liveClient = (await SubcClient.connect({
	connectionFile: args.connection,
})) as SynapseClientLike;
const db = openReadOnly(args.context, true);
const opencode = openReadOnly(args.opencode, true);
const scratch = createSpikeScratch();
runMigrations(scratch);
const rows: object[] = [];
const baselineTimes: number[] = [],
	generationTimes: number[] = [],
	totalTimes: number[] = [],
	callTimes: number[] = [];
const matrix = { trueProse: 0, missedProse: 0, falseProse: 0, trueLiteral: 0 };
try {
	const config = loadPluginConfig(process.cwd());
	for (const project of Object.values(fixture.projects)) {
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
			.get(project.projectPath) as { modelId: string; chunkModelId: string };
		if (
			snapshot.modelId !== stored.modelId ||
			snapshot.chunkModelId !== stored.chunkModelId
		)
			throw new Error(
				`Embedding space mismatch: ${snapshot.modelId} vs ${stored.modelId}`,
			);
	}
	const pinned = await prepareReranker(
		process.cwd(),
		"ctx-search-product-measurement",
		args.connection,
		liveClient,
	);
	if (!pinned)
		throw new Error("Real Synapse unavailable; refusing quality measurement");
	for (const query of [
		...fixture.queries,
		...(fixture.rerankSupplementQueries ?? []),
	]) {
		const prose = isProseQuery(query.query);
		if (query.shape === "prose") matrix[prose ? "trueProse" : "missedProse"]++;
		else matrix[prose ? "falseProse" : "trueLiteral"]++;
		const project = fixture.projects[query.project];
		const validation = validatedGolds(db, opencode, fixture, query);
		if (!validation.gold.length) {
			rows.push({ id: query.id, excluded: validation.invalidGolds });
			continue;
		}
		const captured = await embedTextForProject(
			project.projectPath,
			query.query,
			undefined,
			"query",
		);
		if (!captured) throw new Error(`Missing real query embedding: ${query.id}`);
		const shared: UnifiedSearchOptions = {
			limit: 10,
			explicitSearch: true,
			countRetrievals: false,
			measurementDisabled: true,
			backfillMemoryEmbeddings: false,
			memoryEnabled: true,
			embeddingEnabled: true,
			embedQuery: async () => captured,
			isEmbeddingRuntimeEnabled: () => true,
			gitCommitsEnabled: true,
			maxMessageOrdinal: getLastCompartmentEndMessage(db, project.sessionId),
			visibleMemoryIds: getVisibleMemoryIds(db, project.sessionId),
		};
		const aStart = performance.now();
		const baseline = await beforeSearch(
			db,
			project.sessionId,
			project.projectPath,
			query.query,
			{ ...shared, rerank: false },
		);
		const aMs = performance.now() - aStart;
		const absent = await unifiedSearch(
			db,
			project.sessionId,
			project.projectPath,
			query.query,
			{ ...shared, rerankClient: null },
		);
		if (JSON.stringify(absent) !== JSON.stringify(baseline))
			throw new Error(`Standalone differential: ${query.id}`);
		let lanes: SearchLanes | undefined;
		let scores: number[] | undefined;
		let serviceMs = 0,
			discoveryMs = 0;
		let scoredTexts: string[] = [];
		const instrumented: SynapseClientLike = {
			close() {},
			async call<T>(
				module: string,
				method: string,
				params?: unknown,
				options?: Parameters<SynapseClientLike["call"]>[3],
			) {
				const start = performance.now();
				const result = await liveClient.call<T>(
					module,
					method,
					params,
					options,
				);
				const elapsed = performance.now() - start;
				if (method === "models.list") discoveryMs += elapsed;
				else if (method === "rerank.score") {
					serviceMs += elapsed;
					scoredTexts = (params as { candidates: string[] }).candidates;
					const value = result as {
						result?: { scores: number[] };
						scores?: number[];
					};
					scores = value.result?.scores ?? value.scores;
				}
				return result;
			},
		};
		const start = performance.now();
		const actual = await unifiedSearch(
			db,
			project.sessionId,
			project.projectPath,
			query.query,
			{
				...shared,
				rerankClient: instrumented,
				captureRerankLanes: (value) => {
					lanes = value;
				},
			},
		);
		const productMs = performance.now() - start;
		if (!lanes) throw new Error(`No captured lanes: ${query.id}`);
		const pool = fuseSearchLanes(lanes);
		const expected = archived.queries.find((row) => row.id === query.id);
		if (!expected) throw new Error(`Missing archive: ${query.id}`);
		const keys = (hits: { source: string; id: string | number }[]) =>
			hits.map((hit) => `${hit.source}:${hit.id}`);
		const safePool = pool.map(safeResult);
		const archivedPoolOrderMatch =
			JSON.stringify(keys(safePool)) === JSON.stringify(keys(expected.arms.B));
		if (!archivedPoolOrderMatch) {
			const currentHarness = (await collectLanes(
				db,
				project,
				query.query,
				{ ...shared, rerank: false },
				captured.vector,
				captured.modelId,
				captured.chunkModelId,
			)) as SearchLanes;
			if (
				JSON.stringify(
					fuseSearchLanes(currentHarness)
						.map(safeResult)
						.map((hit) => `${hit.source}:${hit.id}`),
				) !== JSON.stringify(keys(safePool))
			)
				throw new Error(`Current harness pool mismatch: ${query.id}`);
		}
		const productTexts = candidateTexts(
			db,
			project.sessionId,
			project.projectPath,
			pool,
		);
		const harnessTexts = pool.map(
			(hit) => fullCandidate(db, project, hit).text,
		);
		if (JSON.stringify(productTexts) !== JSON.stringify(harnessTexts))
			throw new Error(`Candidate text mismatch: ${query.id}`);
		// The tool keeps literal queries' original ranking. Invoke only the product
		// scorer here to compare the reranked experimental ordering for those queries.
		let c: UnifiedSearchResult[];
		if (!prose) {
			c = await rerankSearchResults(
				{ ...pinned, client: instrumented },
				query.query,
				baseline,
				pool,
				productTexts,
				20,
			);
		} else {
			if (!scores) throw new Error(`Product fell back: ${query.id}`);
			const replay = {
				...pinned,
				client: {
					...instrumented,
					call: async <T>() =>
						({
							fingerprint: pinned.lane.fingerprint,
							table_epoch: pinned.lane.tableEpoch,
							scores,
						}) as T,
				},
			};
			c = await rerankSearchResults(
				replay,
				query.query,
				baseline,
				pool,
				scoredTexts,
				20,
			);
			if (JSON.stringify(c.slice(0, 10)) !== JSON.stringify(actual))
				throw new Error(`Product ordering mismatch: ${query.id}`);
		}
		const cRank = rank(c.map(safeResult), validation.gold);
		if (cRank !== expected.ranks.C)
			throw new Error(
				`C rank mismatch: ${query.id}: ${cRank} vs ${expected.ranks.C}`,
			);
		baselineTimes.push(aMs);
		if (prose) {
			generationTimes.push(productMs - serviceMs);
			totalTimes.push(productMs);
			callTimes.push(serviceMs);
		}
		rows.push({
			id: query.id,
			shape: query.shape,
			prose,
			aRank: rank(baseline.map(safeResult), validation.gold),
			cRank,
			harnessRank: expected.ranks.C,
			poolMatch: true,
			archivedPoolOrderMatch,
			textMatch: true,
			standaloneByteIdentical: true,
			aMs,
			productMs,
			serviceMs,
			discoveryMs,
		});
		console.log(
			`${query.id}: C=${cRank ?? "miss"} matches; A=${aMs.toFixed(1)}ms product=${productMs.toFixed(1)}ms score=${serviceMs.toFixed(1)}ms`,
		);
	}
	const summary = (times: number[]) => ({
		n: times.length,
		p50: percentile(times, 0.5),
		p95: percentile(times, 0.95),
	});
	const evidence = {
		schemaVersion: 1,
		baseline: baselinePath ? "base-commit module" : "product opt-out",
		finishedAt: new Date().toISOString(),
		matrix,
		pinned: pinned.lane,
		latency: {
			baseline: summary(baselineTimes),
			candidateGenerationIncludingDiscovery: summary(generationTimes),
			product: summary(totalTimes),
			rerankCall: summary(callTimes),
		},
		queries: rows,
	};
	mkdirSync(dirname(args.out), { recursive: true });
	writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(JSON.stringify({ matrix, latency: evidence.latency }));
} finally {
	db.close();
	opencode.close();
	scratch.close();
	liveClient.close();
}
