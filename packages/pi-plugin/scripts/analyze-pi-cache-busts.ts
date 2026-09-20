#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getOmpSessionsRoot, getPiSessionsRoot } from "../../cli/src/lib/paths";
import {
	type AnalyzedCacheRequest,
	type CacheBustDecisionAttribution,
	type CacheBustDivergenceClass,
	type CacheBustSessionAnalysis,
	classifyCacheBust,
	nearestCacheBustDecision,
} from "../../plugin/scripts/cache-bust-attribution";
import {
	clippedBodyPairVersions,
	describeBodyPair,
	loadPiBodySnapshots,
	type PiBodySnapshot,
	resolvePiBodiesDirectory,
} from "../../plugin/scripts/cache-bust-body-sources";
import { loadSessionDecisions } from "../../plugin/scripts/cache-bust-sentinel";
import { getMagicContextStorageDir } from "../../plugin/src/shared/data-path";
import {
	getPiServedArrayLedgerPath,
	type PiServedArrayDigestRecord,
} from "../src/served-array-ledger";

type Json = Record<string, unknown>;
type Verdict = "BASE" | "BUST" | "STABLE";

interface Args {
	sessionPrefix: string;
	piDir?: string;
	ompDir?: string;
	ledgerDir: string;
	db?: string;
	since?: string;
	until?: string;
	limit?: number;
	bodiesDir?: string;
	showDiff: boolean;
	allRows: boolean;
	help: boolean;
}

interface SessionEntryMarker {
	ordinal: number;
	line: number;
	type: string;
	toolName?: string;
}

interface PiUsageRow {
	timestamp: number;
	createdAt: string;
	line: number;
	ordinal: number;
	messageId: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface PiSessionFile {
	sessionId: string;
	path: string;
	cwd?: string;
	entries: SessionEntryMarker[];
	usage: PiUsageRow[];
}

interface JoinedPass {
	ledger: PiServedArrayDigestRecord;
	usage: PiUsageRow;
	intervening: SessionEntryMarker[];
}

export interface AnalysisRow {
	current: JoinedPass;
	previous?: JoinedPass;
	verdict: Verdict;
	prevTotal?: number;
	meterFloor?: number;
	comparableRead?: number;
	rewrittenTokens?: number;
	attribution: string;
	divergenceIndex: number;
	divergenceClass?: CacheBustDivergenceClass;
	decision?: CacheBustDecisionAttribution;
}

export interface PiCacheBustAnalysisOptions {
	sessionId: string;
	sinceExclusiveMs?: number;
	untilInclusiveMs?: number;
	piDir?: string;
	ompDir?: string;
	ledgerDir?: string;
	db?: string;
	bodiesDir?: string;
	decisions?: readonly CacheBustDecisionAttribution[];
}

function asJson(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function getAnyNumber(value: unknown, keys: readonly string[]): number {
	const record = asJson(value);
	if (!record) return 0;
	for (const key of keys) {
		const candidate = finiteNonnegative(record[key]);
		if (candidate !== undefined) return candidate;
	}
	return 0;
}

function parseTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return 0;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function entryToolName(entry: Json): string | undefined {
	const message = asJson(entry.message);
	const content = Array.isArray(message?.content) ? message.content : [];
	for (const part of content) {
		const record = asJson(part);
		for (const key of ["name", "toolName", "tool_name"] as const) {
			if (typeof record?.[key] === "string") return record[key] as string;
		}
	}
	for (const key of ["name", "command", "toolName", "tool_name"] as const) {
		if (typeof entry[key] === "string") return entry[key] as string;
	}
	return undefined;
}

function resolveTimeBound(
	value: string | undefined,
	nowMs = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const duration = /^(\d+)(ms|s|m|h|d)$/.exec(value);
	if (duration) {
		const unitMs = {
			ms: 1,
			s: 1_000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
		}[duration[2] as "ms" | "s" | "m" | "h" | "d"];
		return nowMs - Number(duration[1]) * unitMs;
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid time bound: ${value}`);
	return parsed;
}

function parseArgs(argv: string[]): Args {
	const args = argv.slice(2);
	const getOpt = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
	};
	const valueOptions = new Set([
		"--session",
		"--pi-dir",
		"--omp-dir",
		"--ledger-dir",
		"--db",
		"--since",
		"--until",
		"--limit",
		"--bodies-dir",
	]);
	let positionalSession = "";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (valueOptions.has(arg)) {
			index += 1;
			continue;
		}
		if (!arg.startsWith("--")) {
			positionalSession = arg;
			break;
		}
	}
	const limitRaw = getOpt("--limit");
	return {
		sessionPrefix: getOpt("--session") ?? positionalSession,
		piDir: getOpt("--pi-dir"),
		ompDir: getOpt("--omp-dir"),
		ledgerDir: getOpt("--ledger-dir") ?? getMagicContextStorageDir(),
		db: getOpt("--db"),
		since: getOpt("--since"),
		until: getOpt("--until"),
		limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
		bodiesDir: getOpt("--bodies-dir"),
		showDiff: args.includes("--show-diff"),
		allRows: args.includes("--all-rows"),
		help: args.includes("--help") || args.includes("-h"),
	};
}

function parsePiSessionFile(filePath: string): PiSessionFile | undefined {
	let lines: string[];
	try {
		lines = readFileSync(filePath, "utf8").split("\n");
	} catch {
		return undefined;
	}
	let sessionId = "";
	let cwd: string | undefined;
	const entries: SessionEntryMarker[] = [];
	const usage: PiUsageRow[] = [];
	let ordinal = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const raw = lines[lineIndex].trim();
		if (!raw) continue;
		let entry: Json;
		try {
			entry = JSON.parse(raw) as Json;
		} catch {
			continue;
		}
		const type = typeof entry.type === "string" ? entry.type : "unknown";
		const marker = {
			ordinal,
			line: lineIndex + 1,
			type,
			toolName: entryToolName(entry),
		};
		entries.push(marker);
		ordinal += 1;
		if (type === "session" && typeof entry.id === "string") {
			sessionId = entry.id;
			cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
			continue;
		}
		if (type !== "message") continue;
		const message = asJson(entry.message);
		if (message?.role !== "assistant") continue;
		const usageValue = message.usage ?? message.tokens;
		const usageRecord = asJson(usageValue);
		if (!usageRecord) continue;
		const cache = asJson(usageRecord.cache);
		const input = getAnyNumber(usageRecord, ["input", "inputTokens"]);
		const cacheRead = cache
			? getAnyNumber(cache, ["read", "cacheRead", "cache_read"])
			: getAnyNumber(usageRecord, ["cache_read", "cacheRead"]);
		const cacheWrite = cache
			? getAnyNumber(cache, ["write", "cacheWrite", "cache_write"])
			: getAnyNumber(usageRecord, ["cache_write", "cacheWrite"]);
		const timestamp =
			parseTimestamp(message.timestamp) || parseTimestamp(entry.timestamp);
		if (timestamp === 0) continue;
		usage.push({
			timestamp,
			createdAt: new Date(timestamp).toISOString(),
			line: lineIndex + 1,
			ordinal: marker.ordinal,
			messageId:
				typeof entry.id === "string" ? entry.id : `line-${lineIndex + 1}`,
			input,
			cacheRead,
			cacheWrite,
			total: input + cacheRead + cacheWrite,
		});
	}
	if (!sessionId) return undefined;
	usage.sort(
		(left, right) =>
			left.timestamp - right.timestamp || left.ordinal - right.ordinal,
	);
	return { sessionId, path: filePath, cwd, entries, usage };
}

async function discoverPiSessionFiles(
	roots: readonly string[],
): Promise<PiSessionFile[]> {
	const files: PiSessionFile[] = [];
	const seenPaths = new Set<string>();
	for (const root of roots) {
		if (!root || !existsSync(root)) continue;
		const glob = new Bun.Glob("**/*.jsonl");
		for await (const relativePath of glob.scan({
			cwd: root,
			onlyFiles: true,
		})) {
			const filePath = join(root, relativePath);
			if (seenPaths.has(filePath)) continue;
			seenPaths.add(filePath);
			const parsed = parsePiSessionFile(filePath);
			if (parsed) files.push(parsed);
		}
	}
	return files;
}

function validLedgerRecord(value: unknown): value is PiServedArrayDigestRecord {
	const record = asJson(value);
	return (
		record?.version === 1 &&
		typeof record.session_id === "string" &&
		typeof record.pass_ts === "string" &&
		typeof record.sequence === "number" &&
		typeof record.message_count === "number" &&
		typeof record.sha256 === "string" &&
		Array.isArray(record.block_vectors)
	);
}

function loadLedger(
	sessionId: string,
	storageDir: string,
	since?: number,
	until?: number,
): PiServedArrayDigestRecord[] {
	const ledgerPath = getPiServedArrayLedgerPath(sessionId, storageDir);
	if (!existsSync(ledgerPath)) return [];
	const records: PiServedArrayDigestRecord[] = [];
	for (const raw of readFileSync(ledgerPath, "utf8").split("\n")) {
		if (!raw.trim()) continue;
		try {
			const value = JSON.parse(raw);
			if (!validLedgerRecord(value) || value.session_id !== sessionId) continue;
			const timestamp = Date.parse(value.pass_ts);
			if (!Number.isFinite(timestamp)) continue;
			if (since !== undefined && timestamp < since) continue;
			if (until !== undefined && timestamp > until) continue;
			records.push(value);
		} catch {
			// A partial final append must not hide earlier complete observations.
		}
	}
	records.sort(
		(left, right) =>
			Date.parse(left.pass_ts) - Date.parse(right.pass_ts) ||
			left.sequence - right.sequence,
	);
	return records;
}

function entriesBetween(
	entries: readonly SessionEntryMarker[],
	previous: PiUsageRow | undefined,
	current: PiUsageRow,
): SessionEntryMarker[] {
	if (!previous) return [];
	return entries.filter(
		(entry) =>
			entry.ordinal > previous.ordinal && entry.ordinal < current.ordinal,
	);
}

/** Match each assistant usage row to the latest context-pass ledger written before it. */
function joinPasses(
	ledgers: readonly PiServedArrayDigestRecord[],
	session: PiSessionFile,
): JoinedPass[] {
	const joined: JoinedPass[] = [];
	let ledgerIndex = 0;
	let previousUsage: PiUsageRow | undefined;
	for (const usage of session.usage) {
		let candidate: PiServedArrayDigestRecord | undefined;
		while (
			ledgerIndex < ledgers.length &&
			Date.parse(ledgers[ledgerIndex].pass_ts) <= usage.timestamp
		) {
			candidate = ledgers[ledgerIndex];
			ledgerIndex += 1;
		}
		if (!candidate) {
			previousUsage = usage;
			continue;
		}
		joined.push({
			ledger: candidate,
			usage,
			intervening: entriesBetween(session.entries, previousUsage, usage),
		});
		previousUsage = usage;
	}
	return joined;
}

function vectorAt(
	record: PiServedArrayDigestRecord,
	index: number,
): string | undefined {
	const offset = index - record.block_vector_start;
	return offset >= 0 ? record.block_vectors[offset] : undefined;
}

function digestAttribution(previous: JoinedPass, current: JoinedPass): string {
	if (current.ledger.sha256 === previous.ledger.sha256)
		return "identical digest";
	const divergence = current.ledger.first_divergence_message_index;
	if (divergence === null)
		return "digest changed; divergence unavailable after restart";
	if (divergence < 0) return "digest changed; divergence index unavailable";
	const seam = current.intervening.some((entry) => entry.type === "compaction")
		? " (compaction seam)"
		: "";
	const previousVector = vectorAt(previous.ledger, divergence) ?? "before-tail";
	const currentVector = vectorAt(current.ledger, divergence) ?? "before-tail";
	return `message[${divergence}]${seam}: ${previousVector} -> ${currentVector}`;
}

export function loadPiCacheBustDecisions(
	sessionId: string,
	storageDir: string,
	dbPathOverride?: string,
): CacheBustDecisionAttribution[] {
	const dbPath = dbPathOverride ?? join(storageDir, "context.db");
	if (!existsSync(dbPath)) return [];
	return loadSessionDecisions(
		{ sessionId, harness: "pi", projectPath: "" },
		{
			databasePath: dbPath,
			rustStorePath: join(storageDir, "store.db"),
			lookbackMs: 86_400_000,
		},
	);
}

export function nearestPiPassDecision(
	decisions: readonly CacheBustDecisionAttribution[],
	requestTimestampMs: number,
	options: {
		previousTimestampMs?: number;
		messageId?: string;
	} = {},
): CacheBustDecisionAttribution | undefined {
	if (decisions.length === 0) return undefined;

	const minTs = Math.max(
		options.previousTimestampMs !== undefined
			? options.previousTimestampMs - 1_000
			: 0,
		requestTimestampMs - 30_000,
	);
	const maxTs = requestTimestampMs + 5_000;

	const inWindow = decisions.filter(
		(d) => d.timestampMs >= minTs && d.timestampMs <= maxTs,
	);
	if (inWindow.length === 0) return undefined;

	if (options.messageId) {
		const exact = inWindow.find((d) => d.messageId === options.messageId);
		if (exact) return exact;
	}

	const preceding = inWindow
		.filter((d) => d.timestampMs <= requestTimestampMs + 1_000)
		.sort((a, b) => b.timestampMs - a.timestampMs);
	if (preceding.length > 0) return preceding[0];

	return inWindow.sort(
		(a, b) =>
			Math.abs(a.timestampMs - requestTimestampMs) -
			Math.abs(b.timestampMs - requestTimestampMs),
	)[0];
}

export function analyzeJoinedPasses(
	joined: readonly JoinedPass[],
	options: {
		bodies?: ReadonlyMap<number, PiBodySnapshot>;
		decisions?: readonly CacheBustDecisionAttribution[];
	} = {},
): AnalysisRow[] {
	let previousBust = false;
	let previousBustDivergenceIndex: number | undefined;
	return joined.map((current, index) => {
		const divergenceIndex = current.ledger.first_divergence_message_index ?? -1;
		if (index === 0) {
			return {
				current,
				verdict: "BASE",
				attribution: "first joined pass",
				divergenceIndex,
			};
		}
		const previous = joined[index - 1];
		const prevTotal = previous.usage.total;
		const meterFloor = prevTotal - Math.max(64, previous.usage.input);
		const comparableRead = current.usage.cacheRead + current.usage.input;
		// A bust's large direct input cannot forgive another rewrite at the
		// same cache floor. Cache reads must recover before forgiveness resumes.
		const rebust =
			previousBust && current.usage.cacheRead <= previous.usage.cacheRead;
		const bust = rebust || comparableRead < meterFloor;
		previousBust = bust;
		const previousBody = options.bodies?.get(previous.ledger.sequence);
		const currentBody = options.bodies?.get(current.ledger.sequence);
		const bodyDivergence =
			previousBody && currentBody
				? describeBodyPair(previousBody.messages, currentBody.messages)
				: undefined;
		const compactionSeam = current.intervening.some(
			(entry) => entry.type === "compaction",
		);
		const seam = compactionSeam ? " (compaction seam)" : "";
		const attribution = bodyDivergence
			? `${bodyDivergence.description}${seam}`
			: digestAttribution(previous, current);
		const decision = nearestPiPassDecision(
			options.decisions ?? [],
			current.usage.timestamp,
			{
				previousTimestampMs: previous?.usage.timestamp,
				messageId: current.usage.messageId,
			},
		);
		const previousDecision = previous
			? nearestPiPassDecision(
					options.decisions ?? [],
					previous.usage.timestamp,
					{
						messageId: previous.usage.messageId,
					},
				)
			: undefined;
		const attributionDecision =
			rebust && bodyDivergence === undefined && previousDecision?.materialized
				? previousDecision
				: decision;
		const rewrittenTokens = rebust
			? current.usage.input
			: bust
				? prevTotal - current.usage.cacheRead
				: undefined;
		const firstDivergenceRole = bodyDivergence
			? (
					currentBody?.messages[bodyDivergence.index] ??
					previousBody?.messages[bodyDivergence.index]
				)?.role
			: undefined;
		const evidenceIndex = bodyDivergence?.index ?? divergenceIndex;
		const contentEvidence = [
			...([previousBody, currentBody] as const).flatMap(
				(body) =>
					body?.messages
						.slice(
							Math.max(0, evidenceIndex - 2),
							Math.max(0, evidenceIndex + 4),
						)
						.map((message) => message.canonical) ?? [],
			),
			...current.intervening.map((entry) => entry.toolName ?? entry.type),
		].join("\n");
		const divergenceClass = bust
			? classifyCacheBust({
					divergenceIndex,
					previousMessageCount:
						previousBody?.messages.length ?? previous.ledger.message_count,
					previousBustDivergenceIndex,
					currentProvider: "pi",
					previousProvider: "pi",
					firstDivergenceRole,
					firstDivergenceSize: bodyDivergence
						? (
								currentBody?.messages[bodyDivergence.index] ??
								previousBody?.messages[bodyDivergence.index]
							)?.bytes
						: undefined,
					rewrittenTokens,
					promptTokens: prevTotal,
					contentEvidence,
					compactionSeam,
					inheritedFold: attributionDecision !== decision,
					decision: attributionDecision,
				})
			: undefined;
		previousBustDivergenceIndex = bust ? divergenceIndex : undefined;
		return {
			current,
			previous,
			verdict: bust ? "BUST" : "STABLE",
			prevTotal,
			meterFloor,
			comparableRead,
			rewrittenTokens,
			attribution,
			divergenceIndex,
			divergenceClass,
			decision: attributionDecision,
		};
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function piAnalyzerCommand(
	row: AnalysisRow,
	options: PiCacheBustAnalysisOptions,
): string {
	const args = [
		"cd packages/pi-plugin && bun scripts/analyze-pi-cache-busts.ts",
		"--session",
		shellQuote(options.sessionId),
		"--since",
		shellQuote(row.previous?.usage.createdAt ?? row.current.usage.createdAt),
		"--until",
		shellQuote(row.current.usage.createdAt),
		"--show-diff",
		"--all-rows",
	];
	if (options.piDir) args.push("--pi-dir", shellQuote(options.piDir));
	if (options.ompDir) args.push("--omp-dir", shellQuote(options.ompDir));
	if (options.ledgerDir)
		args.push("--ledger-dir", shellQuote(options.ledgerDir));
	if (options.bodiesDir)
		args.push("--bodies-dir", shellQuote(options.bodiesDir));
	return args.join(" ");
}

/** Analyze one exact Pi/OMP session without printing or mutating any source store. */
export async function analyzePiCacheBustSession(
	options: PiCacheBustAnalysisOptions,
): Promise<CacheBustSessionAnalysis> {
	const roots = [
		options.piDir ?? getPiSessionsRoot(),
		options.ompDir ?? getOmpSessionsRoot(),
	].filter((root, index, all) => all.indexOf(root) === index);
	const candidates = (await discoverPiSessionFiles(roots))
		.filter((session) => session.sessionId === options.sessionId)
		.map((session) => {
			const stat = statSync(session.path);
			return { session, mtimeMs: stat.mtimeMs, size: stat.size };
		})
		.sort(
			(left, right) =>
				right.mtimeMs - left.mtimeMs ||
				right.size - left.size ||
				left.session.path.localeCompare(right.session.path),
		);
	const selected = candidates[0]?.session;
	if (!selected) return { requests: [], highWaterMarkMs: null };
	const ledgerDir = options.ledgerDir ?? getMagicContextStorageDir();
	const ledgers = loadLedger(selected.sessionId, ledgerDir);
	const bodiesDirectory = resolvePiBodiesDirectory(
		selected.sessionId,
		selected.path,
		options.bodiesDir,
	);
	const bodies = loadPiBodySnapshots(bodiesDirectory);
	const decisions =
		options.decisions ??
		loadPiCacheBustDecisions(selected.sessionId, ledgerDir, options.db);
	const inWindow = (timestampMs: number): boolean =>
		(options.sinceExclusiveMs === undefined ||
			timestampMs > options.sinceExclusiveMs) &&
		(options.untilInclusiveMs === undefined ||
			timestampMs <= options.untilInclusiveMs);
	const boundedJoined = joinPasses(ledgers, selected).filter(
		(pass) =>
			options.untilInclusiveMs === undefined ||
			pass.usage.timestamp <= options.untilInclusiveMs,
	);
	const firstNewIndex = boundedJoined.findIndex((pass) =>
		inWindow(pass.usage.timestamp),
	);
	const analysisJoined =
		firstNewIndex < 0
			? []
			: boundedJoined.slice(
					options.sinceExclusiveMs === undefined
						? 0
						: Math.max(0, firstNewIndex - 2),
				);
	const rows = analyzeJoinedPasses(analysisJoined, {
		bodies,
		decisions,
	});
	const requests: AnalyzedCacheRequest[] = rows.flatMap((row) => {
		const timestampMs = row.current.usage.timestamp;
		if (!inWindow(timestampMs)) return [];
		return [
			{
				session: selected.sessionId,
				at: row.current.usage.createdAt,
				timestampMs,
				verdict: row.verdict,
				rewrittenTokens: row.rewrittenTokens,
				divergenceClass: row.divergenceClass,
				firstDivergence: row.attribution,
				analyzerCmd: piAnalyzerCommand(row, options),
			},
		];
	});
	const analyzedRequestTimestamps = selected.usage
		.map((usage) => usage.timestamp)
		.filter(inWindow);
	return {
		requests,
		highWaterMarkMs:
			analyzedRequestTimestamps.length > 0
				? Math.max(...analyzedRequestTimestamps)
				: null,
		directory: selected.cwd,
	};
}

function fmtTime(iso: string): string {
	return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function meterCell(row: AnalysisRow): string {
	if (row.verdict === "BASE") return "(first joined pass)";
	const rewritten =
		row.rewrittenTokens === undefined
			? ""
			: `; rewritten≈${row.rewrittenTokens.toLocaleString()}`;
	return `read=${row.current.usage.cacheRead.toLocaleString()} + input=${row.current.usage.input.toLocaleString()} = ${row.comparableRead?.toLocaleString()}; floor=${row.meterFloor?.toLocaleString()} (prevTotal=${row.prevTotal?.toLocaleString()})${rewritten}`;
}

const HELP = `usage: bun scripts/analyze-pi-cache-busts.ts --session <prefix> [options]

Sources:
  Sessions: Pi and OMP JSONL roots (--pi-dir / --omp-dir).
  Bodies:   <session cwd>/.pi/pi-llm-debugging/<sessionId>/<seq>-req.json
            OpenAI Responses input[] requests; -res.json may be absent for
            WebSocket providers such as openai-codex. The cwd comes from the
            JSONL session header, with its encoded --Users-…-- directory as fallback.

Options:
  --ledger-dir <path>  Magic Context data directory
  --bodies-dir <path>  override the body session directory (or its parent)
  --since/--until <t>  ISO timestamp or duration ago (for example 4h)
  --limit <N>          keep the last N digest records in range
  --show-diff          print both versions of the first-diverging real message
  --all-rows           also print BASE and STABLE rows`;

async function main(): Promise<void> {
	const options = parseArgs(process.argv);
	if (options.help) {
		console.log(HELP);
		return;
	}
	if (!options.sessionPrefix) {
		console.error(HELP);
		process.exit(1);
	}
	const roots = [
		options.piDir ?? getPiSessionsRoot(),
		options.ompDir ?? getOmpSessionsRoot(),
	].filter((root, index, all) => all.indexOf(root) === index);
	const sessions = (await discoverPiSessionFiles(roots)).filter((session) =>
		session.sessionId.startsWith(options.sessionPrefix),
	);
	if (sessions.length === 0) {
		console.error(
			`No Pi/OMP JSONL session found for prefix "${options.sessionPrefix}" in ${roots.join(", ")}`,
		);
		process.exit(1);
	}
	const candidates = sessions
		.map((candidate) => {
			const stat = statSync(candidate.path);
			return { candidate, mtimeMs: stat.mtimeMs, size: stat.size };
		})
		.sort(
			(left, right) =>
				right.mtimeMs - left.mtimeMs ||
				right.size - left.size ||
				left.candidate.path.localeCompare(right.candidate.path),
		);
	if (candidates.length > 1) {
		console.log(
			`Ambiguous session prefix "${options.sessionPrefix}"; candidates:`,
		);
		for (const { candidate, mtimeMs, size } of candidates) {
			console.log(
				`  ${candidate.sessionId} mtime=${new Date(mtimeMs).toISOString()} size=${size.toLocaleString()}B path=${candidate.path}`,
			);
		}
		console.log(`Using newest candidate ${candidates[0].candidate.path}.`);
		console.log("");
	}
	const session = candidates[0].candidate;
	const since = resolveTimeBound(options.since);
	const until = resolveTimeBound(options.until);
	let ledgers = loadLedger(session.sessionId, options.ledgerDir, since, until);
	if (options.limit && ledgers.length > options.limit) {
		ledgers = ledgers.slice(ledgers.length - options.limit);
	}
	if (ledgers.length === 0) {
		console.error(
			`No served-array digest records found for ${session.sessionId} at ${getPiServedArrayLedgerPath(session.sessionId, options.ledgerDir)}`,
		);
		process.exit(1);
	}
	const bodiesDirectory = resolvePiBodiesDirectory(
		session.sessionId,
		session.path,
		options.bodiesDir,
	);
	const bodies = loadPiBodySnapshots(bodiesDirectory);
	const decisions = loadPiCacheBustDecisions(
		session.sessionId,
		options.ledgerDir,
		options.db,
	);
	const rows = analyzeJoinedPasses(joinPasses(ledgers, session), {
		bodies,
		decisions,
	});
	console.log(`Session: ${session.sessionId}`);
	console.log(`JSONL:   ${session.path}`);
	console.log(
		`Bodies:  ${bodies.size}${bodiesDirectory ? ` (${bodiesDirectory})` : " (not found; using digest vectors)"}`,
	);
	console.log(`Digests: ${ledgers.length}`);
	console.log("");
	console.log(
		"Meter rule (Pi host): BUST when cacheRead + current input < prevTotal - ε, where prevTotal is prior input + cacheRead + cacheWrite and ε=max(64, prior input). After a bust, a read that does not grow past the prior read is another BUST (rewritten≈current input). The meter decides the verdict; normalized pi-llm-debugging request bodies attribute changed messages.",
	);
	console.log(
		"time(UTC)            | verdict | meter                                                                  | first divergence",
	);
	console.log(
		"---------------------|---------|------------------------------------------------------------------------|-----------------",
	);
	let busts = 0;
	for (const row of rows) {
		if (row.verdict === "BUST") busts += 1;
		if (!options.allRows && row.verdict !== "BUST") continue;
		let attribution = row.attribution;
		let bodyDivergence: ReturnType<typeof describeBodyPair>;
		if (row.previous) {
			const previousBody = bodies.get(row.previous.ledger.sequence);
			const currentBody = bodies.get(row.current.ledger.sequence);
			if (previousBody && currentBody) {
				bodyDivergence = describeBodyPair(
					previousBody.messages,
					currentBody.messages,
				);
				if (bodyDivergence) {
					const seam = row.current.intervening.some(
						(entry) => entry.type === "compaction",
					)
						? " (compaction seam)"
						: "";
					attribution = `${bodyDivergence.description}${seam}`;
				}
			}
		}
		console.log(
			`${fmtTime(row.current.usage.createdAt).padEnd(21)} | ${row.verdict.padEnd(7)} | ${meterCell(row).padEnd(70)} | ${attribution}`,
		);
		if (row.divergenceClass) {
			console.log(`          └─ divergence-class: ${row.divergenceClass}`);
		}
		if (options.showDiff && bodyDivergence) {
			const versions = clippedBodyPairVersions(bodyDivergence);
			console.log(`          └─ message diff @char ${versions.character}:`);
			console.log(`             prev: ${versions.previous}`);
			console.log(`             cur:  ${versions.current}`);
		}
	}
	console.log("");
	console.log(
		`${busts} metered bust(s) across ${rows.length} joined pass(es).${options.allRows ? "" : " (STABLE rows hidden; pass --all-rows to show them.)"}`,
	);
}

export const __test = {
	analyzeJoinedPasses,
	digestAttribution,
	discoverPiSessionFiles,
	joinPasses,
	loadLedger,
	loadPiCacheBustDecisions,
	nearestPiPassDecision,
	parseArgs,
	parsePiSessionFile,
	resolveTimeBound,
};

if (import.meta.main) await main();
