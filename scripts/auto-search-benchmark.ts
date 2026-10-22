import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_getCompartmentChunkSearchCacheStatsForTests,
	_resetCompartmentChunkSearchCacheForTests,
	loadCompartmentChunkEmbeddingsForSearch,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { cosineSimilarity } from "../packages/plugin/src/features/magic-context/memory/embedding";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { searchAutoHint } from "../packages/plugin/src/hooks/magic-context/auto-search-worker-client";
import { Database } from "../packages/plugin/src/shared/sqlite";

if (process.env.OPENCODE_DB) throw new Error("OPENCODE_DB must not be set");
const dir = mkdtempSync(join(tmpdir(), "auto-search-bench-"));
const db = new Database(join(dir, "context.db"));
initializeDatabase(db);
runMigrations(db);
const session = "auto-search-synthetic";
const vector = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i));
const insertC = db.prepare(
	`INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
);
const insertE = db.prepare(
	`INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, harness, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1024, ?, 'opencode', 1)`,
);
db.transaction(() => {
	for (let i = 1; i <= 2200; i++) {
		const id = Number(
			insertC.run(
				session,
				i,
				i * 2,
				i * 2 + 1,
				`u${i}`,
				`a${i}`,
				`Historian cache wiring ${i}`,
				"stored",
				"stored",
			).lastInsertRowid,
		);
		insertE.run(
			id,
			session,
			"/synthetic",
			i * 2,
			i * 2 + 1,
			`hash${i}`,
			"model",
			new Uint8Array(vector.buffer),
		);
	}
	db.prepare(
		"INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES (?,1,'old','assistant','Historian cache wiring details')",
	).run(session);
}).immediate();
function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const q = (p: number) =>
		Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(2));
	return {
		n: values.length,
		p50: q(0.5),
		p90: q(0.9),
		p95: q(0.95),
		max: q(1),
	};
}
const decode: number[] = [];
const warm: number[] = [];
const scan: number[] = [];
for (let i = 0; i < 20; i++) {
	_resetCompartmentChunkSearchCacheForTests();
	let start = performance.now();
	const rows = await loadCompartmentChunkEmbeddingsForSearch(
		db,
		session,
		"/synthetic",
		"model",
	);
	decode.push(performance.now() - start);
	start = performance.now();
	await loadCompartmentChunkEmbeddingsForSearch(
		db,
		session,
		"/synthetic",
		"model",
	);
	warm.push(performance.now() - start);
	start = performance.now();
	for (const row of rows) cosineSimilarity(vector, row.vector);
	scan.push(performance.now() - start);
}
const network = [
	265, 270, 274, 278, 282, 285, 288, 290, 291, 293, 293, 300, 315, 350, 400,
	500, 600, 675, 700, 732,
];
const totals: number[] = [];
const provider: number[] = [];
const dispatch: number[] = [];
try {
	for (const delay of network) {
		const start = performance.now();
		let called = 0;
		const results = await searchAutoHint(
			db,
			session,
			"/synthetic",
			"historian cache wiring",
			{
				sources: ["message"],
				countRetrievals: false,
				measurementDisabled: true,
				embeddingEnabled: true,
				chunkModelIdOverride: "model",
				maxMessageOrdinal: 4401,
				isEmbeddingRuntimeEnabled: () => true,
				embedQuery: async (_text, signal) => {
					called = performance.now();
					dispatch.push(called - start);
					return await new Promise<Float32Array | null>((resolve) => {
						const timer = setTimeout(() => {
							provider.push(performance.now() - called);
							resolve(vector);
						}, delay);
						signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								provider.push(performance.now() - called);
								resolve(null);
							},
							{ once: true },
						);
					});
				},
			},
		);
		if (!results.length) throw new Error("benchmark returned no results");
		totals.push(performance.now() - start);
	}
	console.log(
		JSON.stringify(
			{
				runtime: Bun.version,
				compartments: 2200,
				dims: 1024,
				networkModel:
					"synthetic delays matching measured Mac Voyage voyage-4 query quantiles (20 calls); not raw samples",
				networkMs: stats(network),
				poolColdMs: stats(decode),
				poolWarmMs: stats(warm),
				scanMs: stats(scan),
				dispatchMs: stats(dispatch),
				providerObservedMs: stats(provider),
				hintSearchMs: stats(totals),
				cacheStats: _getCompartmentChunkSearchCacheStatsForTests(),
			},
			null,
			2,
		),
	);
} finally {
	db.close();
	rmSync(dir, { recursive: true, force: true });
}
