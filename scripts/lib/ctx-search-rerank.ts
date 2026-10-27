import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SynapseClientLike } from "../../packages/plugin/src/features/magic-context/memory/embedding-synapse";

export type Shape = "prose" | "identifier" | "path" | "exact";
export type Arm = "A" | "B" | "C" | "D";
export const ARMS: Arm[] = ["A", "B", "C", "D"];
export const RERANK_MODEL = "gte-reranker-modernbert-base-f32";
export const TRANSIENT_ERRORS = new Set([
	"deadline_exceeded",
	"shape_compiling",
	"queue_full",
	"model_loading",
]);

export interface Candidate<T = unknown> {
	key: string;
	value: T;
	text: string;
	createdAt?: number;
	verified?: boolean;
	seenCount?: number;
}

// Resolve symlinks as well as lexical paths: a snapshot flag must not point back to a live store.
export function assertOfflinePath(path: string, root: string): void {
	const parent = realpathSync(root);
	const child = realpathSync(path);
	const rel = relative(parent, child);
	if (
		!rel ||
		rel === ".." ||
		rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(rel)
	) {
		throw new Error(`Offline store must be below ${resolve(root)}: ${path}`);
	}
}

export function truncateUtf8(text: string, bytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

export function candidateText(
	location: string,
	title: string,
	body: string,
): string {
	const header = `${truncateUtf8(location.replaceAll("\n", " "), 200)}\n${truncateUtf8(title.replaceAll("\n", " "), 120)}\n`;
	return header + truncateUtf8(body, 1024 - Buffer.byteLength(header));
}

export function rrf<T>(
	lanes: readonly (readonly Candidate<T>[])[],
	limit = 20,
): Candidate<T>[] {
	const fused = new Map<
		string,
		{ candidate: Candidate<T>; score: number; order: number }
	>();
	for (const lane of lanes) {
		const seen = new Set<string>();
		lane.forEach((candidate, index) => {
			if (seen.has(candidate.key)) return;
			seen.add(candidate.key);
			const prior = fused.get(candidate.key);
			const score = 1 / (60 + index + 1);
			if (prior) prior.score += score;
			else fused.set(candidate.key, { candidate, score, order: fused.size });
		});
	}
	return [...fused.values()]
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, limit)
		.map((row) => row.candidate);
}

export function boostFactors(
	candidate: Candidate,
	asOf: number,
): { recency: number; memoryTrust: number } {
	const ageDays =
		candidate.createdAt === undefined
			? null
			: Math.max(0, asOf - candidate.createdAt) / 86_400_000;
	const recency = ageDays === null ? 1 : 0.95 + 0.1 * Math.exp(-ageDays / 90);
	const memoryTrust = candidate.key.startsWith("memory:")
		? 1 +
			Math.min(
				0.05,
				(candidate.verified ? 0.025 : 0) +
					0.025 *
						Math.min(
							1,
							Math.log1p(Math.max(0, candidate.seenCount ?? 0)) / Math.log(11),
						),
			)
		: 1;
	return { recency, memoryTrust };
}

export function orderLogits<T>(
	pool: readonly Candidate<T>[],
	scores: readonly number[],
	asOf?: number,
): Candidate<T>[] {
	if (
		scores.length !== pool.length ||
		scores.some((score) => !Number.isFinite(score))
	)
		throw new Error("Invalid rerank scores");
	return pool
		.map((candidate, index) => {
			const factors =
				asOf === undefined
					? { recency: 1, memoryTrust: 1 }
					: boostFactors(candidate, asOf);
			// Multiplying negative logits would penalize a boost; bounded evidence factors are additive in log space.
			return {
				candidate,
				index,
				score:
					scores[index] +
					Math.log(factors.recency) +
					Math.log(factors.memoryTrust),
			};
		})
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((row) => row.candidate);
}

function unwrap(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object")
		throw new Error("Synapse returned a non-object response");
	const body = value as Record<string, unknown>;
	return body.result && typeof body.result === "object"
		? (body.result as Record<string, unknown>)
		: body;
}

export interface PinnedLane {
	model: string;
	fingerprint: string;
	tableEpoch: number;
	moduleGeneration?: number;
}
export function pinReranker(catalog: unknown): PinnedLane {
	const body = unwrap(catalog);
	if (!Array.isArray(body.models))
		throw new Error("Synapse models.list omitted models");
	const lane = body.models.find((row) => row.model_id === RERANK_MODEL);
	if (
		lane?.certified !== true ||
		!Array.isArray(lane.fingerprints) ||
		lane.fingerprints.length !== 1 ||
		typeof lane.fingerprints[0] !== "string"
	) {
		throw new Error(
			`Synapse models.list did not return one certified fingerprint for ${RERANK_MODEL}`,
		);
	}
	if (typeof body.table_epoch !== "number")
		throw new Error("Synapse models.list omitted table_epoch");
	return {
		model: lane.model_id,
		fingerprint: lane.fingerprints[0],
		tableEpoch: body.table_epoch,
		moduleGeneration: body.module_generation as number | undefined,
	};
}

export interface RerankSample {
	elapsedMs: number;
	fallback: string | null;
	scores: number[] | null;
}
export async function scorePool(
	client: SynapseClientLike,
	lane: PinnedLane,
	query: string,
	pool: readonly Candidate[],
	deadlineMs: number,
	projectRoot: string,
): Promise<RerankSample> {
	if (pool.length > 20 || pool.length === 0)
		throw new Error("rerank.score needs 1-20 candidates");
	const start = performance.now();
	try {
		const response = await client.call(
			"synapse",
			"rerank.score",
			{
				model: lane.model,
				query,
				candidates: pool.map((row) => row.text),
				required_fingerprint: lane.fingerprint,
				allow_equivalent: false,
				max_queue_ms: Math.min(100, deadlineMs),
				deadline_ms: deadlineMs,
			},
			{
				timeoutMs: deadlineMs + 2000,
				targetKind: "management_surface",
				identity: {
					project_root: projectRoot,
					harness: "mason",
					session: "ctx-search-rerank-spike",
				},
			},
		);
		const body = unwrap(response);
		if (body.error) throw body.error;
		if (body.fingerprint !== lane.fingerprint)
			throw new Error(
				`Synapse rerank fingerprint mismatch: ${body.fingerprint}`,
			);
		if (body.table_epoch !== lane.tableEpoch)
			throw new Error(
				`Synapse rerank table epoch changed: ${body.table_epoch}`,
			);
		if (
			!Array.isArray(body.scores) ||
			body.scores.length !== pool.length ||
			body.scores.some(
				(score) => typeof score !== "number" || !Number.isFinite(score),
			)
		)
			throw new Error("Synapse returned malformed rerank scores");
		return {
			elapsedMs: performance.now() - start,
			fallback: null,
			scores: body.scores,
		};
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		if (!TRANSIENT_ERRORS.has(code)) throw error;
		return {
			elapsedMs: performance.now() - start,
			fallback: code,
			scores: null,
		};
	}
}

export interface RankRow {
	id: string;
	shape: Shape;
	ranks: Record<Arm, number | null>;
}
export const METRICS = ["recall1", "recall5", "recall10", "mrr"] as const;
export type Metric = (typeof METRICS)[number];
export function contribution(rank: number | null, metric: Metric): number {
	if (rank === null || rank > 10) return 0;
	return metric === "mrr" ? 1 / rank : Number(rank <= Number(metric.slice(6)));
}
export function metrics(
	rows: readonly RankRow[],
	arm: Arm,
): Record<Metric, number> {
	return Object.fromEntries(
		METRICS.map((metric) => [
			metric,
			rows.length
				? rows.reduce(
						(sum, row) => sum + contribution(row.ranks[arm], metric),
						0,
					) / rows.length
				: 0,
		]),
	) as Record<Metric, number>;
}
export function percentile(
	values: readonly number[],
	p: number,
): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function pairedBootstrap(
	rows: readonly RankRow[],
	arm: Arm,
	metric: Metric,
	iterations = 10000,
	seed = 0x435458,
): { delta: number; low: number | null; high: number | null } {
	if (!rows.length) return { delta: 0, low: null, high: null };
	const differences = rows.map(
		(row) =>
			contribution(row.ranks[arm], metric) - contribution(row.ranks.A, metric),
	);
	let state = seed >>> 0;
	const samples: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		let sum = 0;
		for (let i = 0; i < rows.length; i++) {
			state = (Math.imul(1664525, state) + 1013904223) >>> 0;
			sum += differences[Math.floor((state / 0x100000000) * rows.length)];
		}
		samples.push(sum / rows.length);
	}
	return {
		delta: differences.reduce((sum, value) => sum + value, 0) / rows.length,
		low: percentile(samples, 0.025),
		high: percentile(samples, 0.975),
	};
}

export function summarizeArms(rows: readonly RankRow[]) {
	const cohorts = [
		"overall",
		"prose",
		"literal",
		"identifier",
		"path",
		"exact",
	] as const;
	return Object.fromEntries(
		cohorts.map((cohort) => {
			const selected = rows.filter(
				(row) =>
					cohort === "overall" ||
					(cohort === "literal" ? row.shape !== "prose" : row.shape === cohort),
			);
			return [
				cohort,
				{
					count: selected.length,
					arms: Object.fromEntries(
						ARMS.map((arm) => [
							arm,
							{
								metrics: metrics(selected, arm),
								differencesFromA: Object.fromEntries(
									METRICS.map((metric) => [
										metric,
										pairedBootstrap(selected, arm, metric),
									]),
								),
							},
						]),
					),
				},
			];
		}),
	);
}
