import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SynapseClientLike } from "../packages/plugin/src/features/magic-context/memory/embedding-synapse";
import { Database } from "../packages/plugin/src/shared/sqlite";
import {
	loadFixture,
	openReadOnly,
	resultMatchesGold,
} from "./ctx-search-benchmark";
import { createSpikeScratch, spikeArgs } from "./ctx-search-rerank";
import {
	assertOfflinePath,
	boostFactors,
	type Candidate,
	candidateText,
	contribution,
	metrics,
	orderLogits,
	pairedBootstrap,
	pinReranker,
	type RankRow,
	RERANK_MODEL,
	rrf,
	scorePool,
	summarizeArms,
} from "./lib/ctx-search-rerank";

const candidate = (key: string, extra: Partial<Candidate> = {}): Candidate => ({
	key,
	text: key,
	value: key,
	...extra,
});
const lane = {
	model: RERANK_MODEL,
	fingerprint: "discovered-full-fingerprint",
	tableEpoch: 2,
};
function client(response: unknown, failure?: unknown): SynapseClientLike {
	return {
		call: async <T>() => {
			if (failure) throw failure;
			return response as T;
		},
		close() {},
	};
}

describe("paired benchmark ranking", () => {
	test("RRF uses ranks, rewards cross-lane evidence and deduplicates within a lane", () => {
		const fused = rrf([
			[candidate("memory:a"), candidate("memory:b"), candidate("memory:a")],
			[candidate("memory:b"), candidate("note:c")],
		]);
		expect(fused.map((row) => row.key)).toEqual([
			"memory:b",
			"memory:a",
			"note:c",
		]);
	});
	test("RRF keeps all lanes and deterministically breaks tied ranks", () => {
		expect(
			rrf(
				[
					[candidate("message:a")],
					[candidate("primer:b")],
					[candidate("git_commit:c")],
				],
				2,
			).map((row) => row.key),
		).toEqual(["message:a", "primer:b"]);
	});
	test("raw negative logits order without thresholding", () => {
		expect(
			orderLogits([candidate("a"), candidate("b")], [-4, -2]).map(
				(row) => row.key,
			),
		).toEqual(["b", "a"]);
		expect(() => orderLogits([candidate("a")], [NaN])).toThrow(
			"Invalid rerank scores",
		);
	});
	test("bounded boosts improve negative logits without reversing the sign of a boost", () => {
		const old = candidate("memory:old", { createdAt: 0 });
		const recent = candidate("memory:new", {
			createdAt: 864000000,
			verified: true,
			seenCount: 10000,
		});
		expect(
			orderLogits([old, recent], [-2, -2.01], 864000000).map((row) => row.key),
		).toEqual(["memory:new", "memory:old"]);
		expect(boostFactors(recent, 864000000)).toEqual({
			recency: 1.05,
			memoryTrust: 1.05,
		});
		expect(
			boostFactors(
				candidate("memory:ancient", { createdAt: 0, seenCount: -10 }),
				864000000000,
			).recency,
		).toBeCloseTo(0.95);
		expect(
			boostFactors(
				candidate("note:a", { verified: true, seenCount: 10000 }),
				0,
			),
		).toEqual({ recency: 1, memoryTrust: 1 });
	});
	test("candidate text preserves location and name under byte caps", () => {
		const text = candidateText(
			"memory 12\nproject",
			"é".repeat(100),
			"😀".repeat(1000),
		);
		const lines = text.split("\n");
		expect(lines[0]).toBe("memory 12 project");
		expect(Buffer.byteLength(lines[1])).toBe(120);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
		expect(text).not.toContain("�");
	});
});

describe("Synapse rerank protocol (unit doubles only; measurements use the daemon)", () => {
	test("catalog pins the full discovered fingerprint rather than a prefix constant", () => {
		expect(
			pinReranker({
				result: {
					models: [
						{
							model_id: RERANK_MODEL,
							certified: true,
							fingerprints: [lane.fingerprint],
						},
					],
					table_epoch: 2,
				},
			}),
		).toEqual(lane);
		expect(() =>
			pinReranker({
				models: [
					{
						model_id: RERANK_MODEL,
						certified: false,
						fingerprints: [lane.fingerprint],
					},
				],
				table_epoch: 2,
			}),
		).toThrow("certified fingerprint");
	});
	test("rerank request is pinned, capped and uses management surface", async () => {
		let request: unknown;
		const service: SynapseClientLike = {
			call: async <T>(
				module: string,
				method: string,
				params?: unknown,
				options?: unknown,
			) => {
				request = { module, method, params, options };
				return {
					result: {
						fingerprint: lane.fingerprint,
						table_epoch: 2,
						scores: [-2, 4],
					},
				} as T;
			},
			close() {},
		};
		const result = await scorePool(
			service,
			lane,
			"query",
			[candidate("a"), candidate("b")],
			50,
			"/fixture",
		);
		expect(result.scores).toEqual([-2, 4]);
		expect(request).toMatchObject({
			module: "synapse",
			method: "rerank.score",
			params: {
				model: lane.model,
				candidates: ["a", "b"],
				required_fingerprint: lane.fingerprint,
				allow_equivalent: false,
				max_queue_ms: 50,
				deadline_ms: 50,
			},
			options: { targetKind: "management_surface" },
		});
		await expect(
			scorePool(
				service,
				lane,
				"q",
				Array.from({ length: 21 }, (_, i) => candidate(String(i))),
				50,
				"/fixture",
			),
		).rejects.toThrow("1-20 candidates");
	});
	for (const code of [
		"deadline_exceeded",
		"shape_compiling",
		"queue_full",
		"model_loading",
	])
		test(`${code} records a fused-order fallback without invented scores`, async () => {
			expect(
				await scorePool(
					client(null, { code }),
					lane,
					"q",
					[candidate("a")],
					1000,
					"/fixture",
				),
			).toMatchObject({ fallback: code, scores: null });
		});
	test("fingerprint drift is fatal, not a measured or silent fallback", async () => {
		await expect(
			scorePool(
				client({
					result: { fingerprint: "wrong", table_epoch: 2, scores: [1] },
				}),
				lane,
				"q",
				[candidate("a")],
				1000,
				"/fixture",
			),
		).rejects.toThrow("fingerprint mismatch");
	});
	test("transport refusal is fatal, not a mocked rerank", async () => {
		await expect(
			scorePool(
				client(null, new Error("socket unavailable")),
				lane,
				"q",
				[candidate("a")],
				1000,
				"/fixture",
			),
		).rejects.toThrow("socket unavailable");
	});
	test("malformed score length and nonfinite scores are fatal", async () => {
		for (const scores of [[], [Infinity]])
			await expect(
				scorePool(
					client({
						result: { fingerprint: lane.fingerprint, table_epoch: 2, scores },
					}),
					lane,
					"q",
					[candidate("a")],
					1000,
					"/fixture",
				),
			).rejects.toThrow("malformed rerank scores");
	});
});

describe("metric and uncertainty definitions", () => {
	const rows: RankRow[] = [
		{ id: "p", shape: "prose", ranks: { A: 2, B: 1, C: 1, D: 1 } },
		{ id: "i", shape: "identifier", ranks: { A: 1, B: 11, C: 20, D: null } },
	];
	test("recall and MRR share the same rank-10 horizon as the production baseline", () => {
		expect(metrics(rows, "A")).toEqual({
			recall1: 0.5,
			recall5: 1,
			recall10: 1,
			mrr: 0.75,
		});
		expect(metrics(rows, "C")).toEqual({
			recall1: 0.5,
			recall5: 0.5,
			recall10: 0.5,
			mrr: 0.5,
		});
		expect(contribution(11, "mrr")).toBe(0);
	});
	test("paired bootstrap uses query differences and deterministic resampling", () => {
		const paired = pairedBootstrap(rows, "B", "mrr", 10000);
		expect(paired).toEqual({ delta: -0.25, low: -1, high: 0.5 });
		expect(pairedBootstrap(rows, "A", "mrr")).toEqual({
			delta: 0,
			low: 0,
			high: 0,
		});
		expect(pairedBootstrap([], "C", "mrr")).toEqual({
			delta: 0,
			low: null,
			high: null,
		});
	});
	test("shape stratification does not let prose gains hide literal losses", () => {
		const summary = summarizeArms(rows);
		expect(summary.prose.arms.C.differencesFromA.mrr.delta).toBe(0.5);
		expect(summary.literal.arms.C.differencesFromA.mrr.delta).toBe(-1);
		expect(summary.path.count).toBe(0);
	});
	test("known-answer identity and ordinal containment are preserved", () => {
		expect(
			resultMatchesGold(
				{
					source: "compartment",
					id: 9,
					score: 1,
					label: "title",
					startOrdinal: 10,
					endOrdinal: 20,
				},
				[{ source: "message", id: "m", label: "gold", ordinal: 15 }],
			),
		).toBe(true);
		expect(
			resultMatchesGold(
				{
					source: "message",
					id: "other",
					score: 1,
					label: "title",
					ordinal: 21,
				},
				[
					{
						source: "compartment",
						id: 9,
						label: "gold",
						startOrdinal: 10,
						endOrdinal: 20,
					},
				],
			),
		).toBe(false);
	});
});

describe("offline-only measurement fence", () => {
	test("registration scratch has no filesystem side effects", () => {
		const originalCwd = process.cwd();
		const root = mkdtempSync(join(tmpdir(), "ctx-rerank-scratch-"));
		const executable = join(root, "executable");
		writeFileSync(executable, "fixture", { mode: 0o755 });
		process.chdir(root);
		let scratch: Database | undefined;
		try {
			scratch = createSpikeScratch();
			const databases = scratch.prepare("PRAGMA database_list").all() as {
				file: string;
			}[];
			expect(databases.every((row) => row.file === "")).toBe(true);
			expect(readdirSync(root)).toEqual(["executable"]);
			expect(statSync(executable).mode & 0o111).toBe(0o111);
			expect(
				scratch
					.prepare("SELECT count(*) AS n FROM embedding_registrations")
					.get(),
			).toEqual({ n: 0 });
		} finally {
			scratch?.close();
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("spike requires both explicit store paths and validates the deadline", () => {
		expect(() => spikeArgs([])).toThrow("--context-db requires a value");
		expect(() => spikeArgs(["--context-db", "snapshot"])).toThrow(
			"--opencode-db requires a value",
		);
		expect(() =>
			spikeArgs([
				"--context-db",
				"snapshot",
				"--opencode-db",
				"snapshot",
				"--deadline-ms",
				"0",
			]),
		).toThrow("1..120000");
	});
	test("offline fence rejects sibling and symlink paths to live stores", () => {
		const root = mkdtempSync(join(tmpdir(), "ctx-rerank-fence-"));
		try {
			const snapshots = join(root, "snapshots");
			mkdirSync(snapshots);
			const offline = join(snapshots, "context.db");
			writeFileSync(offline, "snapshot");
			const live = join(root, "live.db");
			writeFileSync(live, "live");
			const link = join(snapshots, "symlink.db");
			symlinkSync(live, link);
			expect(() => assertOfflinePath(offline, snapshots)).not.toThrow();
			expect(() => assertOfflinePath(live, snapshots)).toThrow(
				"Offline store must be below",
			);
			expect(() => assertOfflinePath(link, snapshots)).toThrow(
				"Offline store must be below",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("immutable snapshot rejects writes and supports WAL-mode offline backups", () => {
		const root = mkdtempSync(join(tmpdir(), "ctx-rerank-readonly-"));
		const path = join(root, "context.db");
		try {
			const writer = new Database(path);
			writer.exec(
				"PRAGMA journal_mode=WAL; CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES(7)",
			);
			writer.close();
			const reader = openReadOnly(path, true);
			try {
				expect(reader.prepare("SELECT value FROM sample").get()).toEqual({
					value: 7,
				});
				expect(() => reader.exec("INSERT INTO sample VALUES(8)")).toThrow();
			} finally {
				reader.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("fixture explicitly labels each shape and preserves the 50 study queries", () => {
		const fixture = loadFixture(
			resolve(import.meta.dir, "fixtures/ctx-search-known-answers.json"),
		);
		expect(fixture.queries.length).toBe(50);
		const queries = [
			...fixture.queries,
			...(fixture.rerankSupplementQueries ?? []),
		];
		expect(
			queries.every((query) =>
				["prose", "identifier", "path", "exact"].includes(query.shape ?? ""),
			),
		).toBe(true);
		expect(
			fixture.rerankSupplementQueries?.filter((query) => query.shape === "path")
				.length,
		).toBe(2);
	});
});
