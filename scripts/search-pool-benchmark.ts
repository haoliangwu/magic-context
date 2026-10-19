import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	_getCompartmentChunkSearchCacheStatsForTests,
	_resetCompartmentChunkSearchCacheForTests,
	loadCompartmentChunkEmbeddingsForSearch,
	type StoredCompartmentChunkEmbedding,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { cosineSimilarity } from "../packages/plugin/src/features/magic-context/memory/embedding";
import {
	baseSearchPool,
	measureSearchBlock,
	type SearchHeartbeatOutlier,
	searchPoolFixture,
} from "../packages/plugin/src/features/magic-context/search-pool-fixture";
import type { Database } from "../packages/plugin/src/shared/sqlite";

// This benchmark creates its own synthetic database; it accepts no store path.
const fixture = searchPoolFixture(15000, 4096);
fixture.db.exec("CREATE TABLE unrelated_activity (value INTEGER)");
let scopeProbePlan: unknown[] = [];
const prepare = fixture.db.prepare.bind(fixture.db);
Object.defineProperty(fixture.db, "prepare", {
	value: (sql: string) => {
		if (sql.includes("length(e.vector) AS vectorBytes")) {
			scopeProbePlan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
				"session",
				"/project",
				"model",
				0,
			);
		}
		return prepare(sql);
	},
});
const scopes = [
	["session", "/project"],
	["session-b", "/project"],
	["session-c", "/project-b"],
	["session-d", "/project-c"],
] as const;
fixture.db
	.transaction(() => {
		for (let scope = 1; scope < scopes.length; scope++) {
			const [session, project] = scopes[scope];
			const from = 14001 + (scope - 1) * 333;
			const to = scope === 3 ? 15000 : from + 332;
			fixture.db
				.prepare(
					"UPDATE compartment_chunk_embeddings SET session_id = ?, project_path = ? WHERE id BETWEEN ? AND ?",
				)
				.run(session, project, from, to);
			fixture.db
				.prepare(
					"UPDATE compartments SET session_id = ? WHERE id BETWEEN ? AND ?",
				)
				.run(session, from, to);
		}
	})
	.immediate();

function baseLoader(db: Database) {
	const cache = new Map<
		string,
		{ count: number; max: number; rows: StoredCompartmentChunkEmbedding[] }
	>();
	return (session: string, project: string) => {
		const key = JSON.stringify([session, project, "model"]);
		const probe = db
			.prepare(`SELECT COUNT(*) AS count, MAX(id) AS max FROM compartment_chunk_embeddings
            WHERE session_id = ? AND project_path = ? AND model_id = 'model'`)
			.get(session, project) as { count: number; max: number };
		const cached = cache.get(key);
		if (cached && cached.count === probe.count && cached.max === probe.max) {
			const current = new Map(
				(
					db
						.prepare(`SELECT id, title, start_message AS startOrdinal, end_message AS endOrdinal
                FROM compartments WHERE id IN (SELECT compartment_id FROM compartment_chunk_embeddings
                WHERE session_id = ? AND project_path = ? AND model_id = 'model')`)
						.all(session, project) as {
						id: number;
						title: string;
						startOrdinal: number;
						endOrdinal: number;
					}[]
				).map((row) => [row.id, row]),
			);
			for (const row of cached.rows)
				Object.assign(row, current.get(row.compartmentId));
			return cached.rows;
		}
		const rows = baseSearchPool(db, session, project);
		cache.set(key, { ...probe, rows });
		return rows;
	};
}

const append = () =>
	fixture.db
		.transaction(() => {
			for (let id = 15001; id <= 15050; id++) fixture.add(id);
		})
		.immediate();
const payload = (pools: StoredCompartmentChunkEmbedding[][]) =>
	pools.reduce(
		(sum, rows) =>
			sum + rows.reduce((bytes, row) => bytes + row.vector.byteLength, 0),
		0,
	);
const estimatedPoolBytes = (
	pools: StoredCompartmentChunkEmbedding[][],
	overhead: number,
) =>
	pools.reduce(
		(sum, rows) =>
			sum +
			rows.reduce(
				(bytes, row) =>
					bytes +
					row.vector.byteLength +
					overhead +
					2 *
						(row.sessionId.length +
							row.title.length +
							row.chunkHash.length +
							row.modelId.length),
				0,
			),
		0,
	);
const query = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.1));

async function scorePool(
	rows: StoredCompartmentChunkEmbedding[],
	cooperative: boolean,
) {
	const winners = new Map<
		number,
		{ id: number; ordinal: number; score: number }
	>();
	let started = performance.now();
	for (const row of rows) {
		if (cooperative && performance.now() - started >= 4) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			started = performance.now();
		}
		const score = Math.min(1, Math.max(0, cosineSimilarity(query, row.vector)));
		const prior = winners.get(row.compartmentId);
		if (score > 0 && (!prior || score > prior.score)) {
			winners.set(row.compartmentId, {
				id: row.compartmentId,
				ordinal: row.startOrdinal,
				score,
			});
		}
	}
	return [...winners.values()]
		.sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
		.slice(0, 25)
		.map(({ id, score }) => ({ id, score: score * 0.8 }));
}

const answers: string[] = [];
let tipCpuBoundFailures = 0;

function timing(result: {
	maximum: number;
	elapsed: number;
	totalCpuMs: number;
	cpuMsAtMaximum: number;
	maximumCpuMs: number;
	cpuSource: string;
}) {
	return {
		blockMs: result.maximum,
		elapsedMs: result.elapsed,
		cpuMs: result.totalCpuMs,
		cpuMsAtMaximum: result.cpuMsAtMaximum,
		maximumCpuMs: result.maximumCpuMs,
		cpuSource: result.cpuSource,
	};
}

function reportOutliers(
	implementation: "base" | "tip",
	outliers: readonly SearchHeartbeatOutlier[],
) {
	for (const outlier of outliers) {
		console.log(
			JSON.stringify({
				heartbeatOutlier: {
					implementation,
					runtime: process.versions.bun
						? `Bun ${process.versions.bun}`
						: `Node ${process.version}`,
					...outlier,
				},
			}),
		);
		if (implementation === "tip" && outlier.cpuMs >= 50) tipCpuBoundFailures++;
	}
}

async function backgroundSearches(
	search: () => Promise<{ rows: StoredCompartmentChunkEmbedding[] }>,
	previous: StoredCompartmentChunkEmbedding[],
	implementation: "base" | "tip",
) {
	const writer = spawn(
		process.execPath,
		[
			"-e",
			`
        const sqlite = require(process.versions.bun ? 'bun:sqlite' : 'node:sqlite');
        const db = new (sqlite.Database || sqlite.DatabaseSync)(process.env.MC_SEARCH_POOL_FIXTURE_PATH);
        db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0');
        const write = db.prepare('INSERT INTO unrelated_activity VALUES (?)');
        let commits = 0;
        let maxCommitGapMs = 0;
        let writeMs = 0;
        let previousCommit = performance.now();
        const timer = setInterval(() => {
            const started = performance.now(); write.run(++commits);
            const ended = performance.now(); writeMs += ended - started;
            maxCommitGapMs = Math.max(maxCommitGapMs, ended - previousCommit); previousCommit = ended;
        }, 100);
        process.on('message', () => { clearInterval(timer); db.close(); process.send({commits, maxCommitGapMs, writeMs}, () => process.disconnect()); });
        process.send('ready');
    `,
		],
		{
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: { ...process.env, MC_SEARCH_POOL_FIXTURE_PATH: fixture.path },
		},
	);
	let stderr = "";
	writer.stderr?.on("data", (data) => {
		stderr += data.toString();
	});
	const exited = once(writer, "exit");
	const earlyExit = exited.then(() => {
		throw new Error(`Background writer exited before finishing: ${stderr}`);
	});
	let fullRebuilds = 0;
	let maximumBlockMs = 0;
	let maximumCpuMs = 0;
	const outliers: SearchHeartbeatOutlier[] = [];
	const initialWrites = (
		fixture.db
			.prepare("SELECT count(*) AS n FROM unrelated_activity")
			.get() as { n: number }
	).n;
	try {
		await Promise.race([once(writer, "message"), earlyExit]);
		const started = performance.now();
		for (let i = 0; i < 50; i++) {
			const measured = await measureSearchBlock(
				search,
				`${implementation}: background search ${i + 1}/50`,
			);
			if (measured.value.rows[0].vector !== previous[0].vector) fullRebuilds++;
			previous = measured.value.rows;
			maximumBlockMs = Math.max(maximumBlockMs, measured.maximum);
			maximumCpuMs = Math.max(maximumCpuMs, measured.maximumCpuMs);
			outliers.push(...measured.outliers);
		}
		const stopped = once(writer, "message").then(
			([message]) =>
				message as {
					commits: number;
					maxCommitGapMs: number;
					writeMs: number;
				},
		);
		writer.send("stop");
		const committed = await Promise.race([stopped, earlyExit]);
		const observedWrites =
			(
				fixture.db
					.prepare("SELECT count(*) AS n FROM unrelated_activity")
					.get() as { n: number }
			).n - initialWrites;
		if (observedWrites !== committed.commits || observedWrites < 2)
			throw new Error("Background commits were not observed");
		return {
			searches: 50,
			fullRebuilds,
			maximumBlockMs,
			maximumCpuMs,
			outliers,
			wallMs: performance.now() - started,
			...committed,
			observedWrites,
		};
	} finally {
		if (writer.exitCode === null) writer.kill();
		await exited;
	}
}

try {
	const calibration = await measureSearchBlock(() => {
		let value = 1;
		for (let i = 0; i < 20_000_000; i++)
			value = (Math.imul(value, 1664525) + 1013904223) | 0;
		return value;
	}, "CPU counter calibration");
	if (calibration.totalCpuMs <= 1 || calibration.maximumCpuMs <= 1)
		throw new Error("CPU counter did not observe busy work");
	console.log(JSON.stringify({ cpuCalibration: timing(calibration) }));
	for (const outlier of calibration.outliers)
		console.log(
			JSON.stringify({
				heartbeatOutlier: {
					implementation: "calibration",
					runtime: process.versions.bun
						? `Bun ${process.versions.bun}`
						: `Node ${process.version}`,
					...outlier,
				},
			}),
		);
	for (const implementation of ["base", "tip"] as const) {
		fixture.db
			.transaction(() => {
				fixture.db.exec(
					"DELETE FROM compartment_chunk_embeddings WHERE compartment_id > 15000",
				);
				fixture.db.exec("DELETE FROM compartments WHERE id > 15000");
				fixture.db.exec(
					"DELETE FROM message_fts_rowid_map WHERE message_ordinal > 30001",
				);
			})
			.immediate();
		_resetCompartmentChunkSearchCacheForTests();
		const base = baseLoader(fixture.db);
		const loader = (session: string, project: string) =>
			implementation === "base"
				? base(session, project)
				: loadCompartmentChunkEmbeddingsForSearch(
						fixture.db,
						session,
						project,
						"model",
					);
		const search = async () => {
			const rows = await loader(...scopes[0]);
			return { rows, hits: await scorePool(rows, implementation === "tip") };
		};
		const cold = await measureSearchBlock(
			search,
			`${implementation}: cold pool + cosine`,
		);
		const pools = [cold.value.rows];
		for (const [session, project] of scopes.slice(1))
			pools.push(await loader(session, project));
		const warm = await measureSearchBlock(
			search,
			`${implementation}: warm pool + cosine`,
		);
		const probeBefore = _getCompartmentChunkSearchCacheStatsForTests();
		const warmProbe = await measureSearchBlock(
			() => loader(...scopes[0]),
			`${implementation}: scope metadata probe`,
		);
		const probeAfter = _getCompartmentChunkSearchCacheStatsForTests();
		const { outliers: backgroundOutliers, ...background } =
			await backgroundSearches(search, warm.value.rows, implementation);
		const before = payload(pools);
		const estimatedBefore =
			implementation === "base"
				? estimatedPoolBytes(pools, 256)
				: _getCompartmentChunkSearchCacheStatsForTests().bytes;
		append();
		const added = await measureSearchBlock(
			search,
			`${implementation}: append50 pool + cosine`,
		);
		pools[0] = added.value.rows;
		answers.push(
			JSON.stringify([cold.value.hits, warm.value.hits, added.value.hits]),
		);
		reportOutliers(implementation, [
			...cold.outliers,
			...warm.outliers,
			...warmProbe.outliers,
			...backgroundOutliers,
			...added.outliers,
		]);
		console.log(
			JSON.stringify({
				implementation,
				runtime: process.version,
				rows: 15000,
				dims: 4096,
				pools: scopes.length,
				cold: timing(cold),
				warm: timing(warm),
				append50: {
					...timing(added),
					fullRebuilds: Number(
						added.value.rows[0].vector !== warm.value.rows[0].vector,
					),
				},
				warmProbe: {
					...timing(warmProbe),
					pages: probeAfter.probePages - probeBefore.probePages,
					probes: probeAfter.probes - probeBefore.probes,
				},
				background,
				scopeProbePlan: implementation === "tip" ? scopeProbePlan : [],
				vectorBytesBefore: before,
				vectorBytesAfter: payload(pools),
				estimatedPoolBytesBefore: estimatedBefore,
				estimatedPoolBytesAfter:
					implementation === "base"
						? estimatedPoolBytes(pools, 256)
						: _getCompartmentChunkSearchCacheStatsForTests().bytes,
			}),
		);
	}
	if (answers[0] !== answers[1])
		throw new Error("Base and tip ranking differs");
	fixture.db
		.transaction(() => {
			fixture.db.exec(
				"DELETE FROM compartment_chunk_embeddings WHERE compartment_id > 15000",
			);
			fixture.db.exec(
				"UPDATE compartment_chunk_embeddings SET session_id = 'session', project_path = '/project'",
			);
			fixture.db.exec("UPDATE compartments SET session_id = 'session'");
		})
		.immediate();
	_resetCompartmentChunkSearchCacheForTests();
	await loadCompartmentChunkEmbeddingsForSearch(
		fixture.db,
		"session",
		"/project",
		"model",
	);
	const before = _getCompartmentChunkSearchCacheStatsForTests();
	const measured = await measureSearchBlock(
		() =>
			loadCompartmentChunkEmbeddingsForSearch(
				fixture.db,
				"session",
				"/project",
				"model",
			),
		"tip: 15000-row scope metadata probe",
	);
	const after = _getCompartmentChunkSearchCacheStatsForTests();
	reportOutliers("tip", measured.outliers);
	console.log(
		JSON.stringify({
			scopeProbe15000: {
				rows: measured.value.length,
				...timing(measured),
				probes: after.probes - before.probes,
				pages: after.probePages - before.probePages,
				fullRebuilds: after.fullRebuilds - before.fullRebuilds,
				estimatedPoolBytes: after.bytes,
			},
		}),
	);
	console.log(JSON.stringify({ tipCpuBoundFailures }));
	if (tipCpuBoundFailures > 0)
		throw new Error(
			`TIP_CPU_BOUND_FAILURE: ${tipCpuBoundFailures} wall gaps had CPU >=50ms`,
		);
} finally {
	fixture.close();
	_resetCompartmentChunkSearchCacheForTests();
}
