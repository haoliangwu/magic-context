import { createHash } from "node:crypto";

export interface TimingSample {
	stage: string;
	elapsedMs: number;
	extra?: string;
}

export interface PhaseTotals {
	prePipeline: number;
	pipeline: number;
	postPipeline: number;
	accounted: number;
	unaccounted: number;
	entryBranch: number;
	fallbackIdentity: number;
	tagIdentityCore: number;
	tagIdentity: number;
	tagPrefix: number;
	targets: number;
	tokenCountingBackfill: number;
	tagTokenCounting: number;
	tokenAccounting: number;
	tokenCacheValidation: number;
	tokenBpe: number;
	stripsReplay: number;
	processedImages: number;
	droppedPlaceholders: number;
	cavemanReplay: number;
	transcriptCommit: number;
	postCommitMaps: number;
	drops: number;
	boundaryTriggers: number;
	injection: number;
	decisionState: number;
	historianScheduling: number;
	noteIndexMaps: number;
	stickyReplay: number;
	autoSearch: number;
	todoCapture: number;
	channelAccounting: number;
	workMetrics: number;
	lkgCapture: number;
	dbIo: number;
	postTransform: number;
	total: number;
}

export interface DatabaseTiming {
	elapsedMs: number;
	operations: number;
	reads: number;
	writes: number;
}

export function createTimingCollector(): {
	observe(sample: TimingSample): void;
	reset(): void;
	samples(): TimingSample[];
} {
	let current: TimingSample[] = [];
	return {
		observe(sample) {
			current.push(sample);
		},
		reset() {
			current = [];
		},
		samples() {
			return current.slice();
		},
	};
}

export function createDatabaseTimer<T extends object>(
	database: T,
): {
	database: T;
	snapshot(): DatabaseTiming;
	reset(): void;
	queries(): { sql: string; elapsedMs: number; operations: number }[];
} {
	const queries = new Map<
		string,
		{ sql: string; elapsedMs: number; operations: number }
	>();
	let elapsedMs = 0;
	let operations = 0;
	let reads = 0;
	let writes = 0;
	const statementCache = new WeakMap<object, object>();

	const time = <R>(
		kind: "read" | "write",
		operation: () => R,
		sql?: string,
	): R => {
		const start = performance.now();
		try {
			return operation();
		} finally {
			const elapsed = performance.now() - start;
			elapsedMs += elapsed;
			if (sql) {
				const sample = queries.get(sql) ?? { sql, elapsedMs: 0, operations: 0 };
				sample.elapsedMs += elapsed;
				sample.operations++;
				queries.set(sql, sample);
			}
			operations += 1;
			if (kind === "read") reads += 1;
			else writes += 1;
		}
	};

	const wrapStatement = (statement: object, sql: string): object => {
		const cached = statementCache.get(statement);
		if (cached) return cached;
		const wrapped = new Proxy(statement, {
			get(target, property, _receiver) {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				if (property === "get" || property === "all" || property === "values") {
					return (...args: unknown[]) =>
						time("read", () => Reflect.apply(value, target, args), sql);
				}
				if (property === "run") {
					return (...args: unknown[]) =>
						time("write", () => Reflect.apply(value, target, args), sql);
				}
				return value.bind(target);
			},
		});
		statementCache.set(statement, wrapped);
		return wrapped;
	};

	const proxy = new Proxy(database, {
		get(target, property, _receiver) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "prepare" || property === "query") {
				return (...args: unknown[]) =>
					wrapStatement(Reflect.apply(value, target, args), String(args[0]));
			}
			if (property === "exec") {
				return (...args: unknown[]) =>
					time("write", () => Reflect.apply(value, target, args));
			}
			return value.bind(target);
		},
	});

	return {
		database: proxy,
		snapshot: () => ({ elapsedMs, operations, reads, writes }),
		queries: () =>
			[...queries.values()].sort((a, b) => b.elapsedMs - a.elapsedMs),
		reset() {
			queries.clear();
			elapsedMs = 0;
			operations = 0;
			reads = 0;
			writes = 0;
		},
	};
}

export function summarizePhases(
	samples: readonly TimingSample[],
	database: DatabaseTiming,
): PhaseTotals {
	const stage = (name: string): number =>
		samples
			.filter((sample) => sample.stage === name)
			.reduce((sum, sample) => sum + sample.elapsedMs, 0);
	const total = stage("total");
	const prePipeline = stage("prePipelineTotal");
	const pipeline = stage("runPipeline");
	const postPipeline = stage("postPipelineTotal");
	const accounted = prePipeline + pipeline + postPipeline;
	return {
		prePipeline,
		pipeline,
		postPipeline,
		accounted,
		unaccounted: Math.max(0, total - accounted),
		entryBranch: stage("entryParseAndBranchResolution"),
		fallbackIdentity: stage("fallbackIdentityAndAdoption"),
		tagIdentityCore: stage("tag:identity"),
		tagIdentity: stage("fallbackIdentityAndAdoption") + stage("tag:identity"),
		tagPrefix: stage("tag:prefix"),
		targets: stage("tag:targets"),
		tokenCountingBackfill:
			stage("tag:tokenCounting") + stage("tokenAccounting"),
		tagTokenCounting: stage("tag:tokenCounting"),
		tokenAccounting: stage("tokenAccounting"),
		tokenCacheValidation: stage("token:cacheValidation"),
		tokenBpe: stage("token:bpe"),
		stripsReplay:
			stage("applyFlushedStatuses") +
			stage("replayReasoningClearing") +
			stage("stripClearedReasoning"),
		processedImages: stage("stripProcessedImages"),
		droppedPlaceholders: stage("stripDroppedPlaceholders"),
		cavemanReplay: stage("cavemanReplay"),
		transcriptCommit: stage("transcriptCommit"),
		postCommitMaps: stage("postCommitStableIdMaps"),
		drops: stage("applyPendingOperations") + stage("applyHeuristicCleanup"),
		boundaryTriggers: stage("boundaryTriggerChecks"),
		injection: stage("prepareCompartmentInjection"),
		decisionState: stage("transformDecisionAndReuseState"),
		historianScheduling: stage("historianScheduling"),
		noteIndexMaps: stage("noteIndexMaps"),
		stickyReplay: stage("stickyReplayDecisions"),
		autoSearch: stage("autoSearch"),
		todoCapture: stage("todoCapture"),
		channelAccounting: stage("channelNudgeAccounting"),
		workMetrics: stage("workMetrics"),
		lkgCapture: stage("lkgCapture"),
		dbIo: database.elapsedMs,
		postTransform: stage("postTransformPhase"),
		total,
	};
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item !== undefined) output[key] = canonicalize(item);
	}
	return output;
}
