#!/usr/bin/env bun
import { Database } from "bun:sqlite";
/**
 * Read-only cache-bust detector for the OpenCode and Pi/OMP harnesses.
 *
 * Classification rule table (first matching rule wins):
 * | divergence_class | accounted | rule |
 * | --- | --- | --- |
 * | system_row_shift | yes | message[0]/system divergence rewrites less than 5% of the prompt |
 * | no_mc_pass_row | no | no MC pass record in [request - 30 s, request + 5 s] |
 * | accounted_ctx_flush | yes | matched pass records an explicit /ctx-flush |
 * | accounted_force_band | yes | matched pass records a forced emergency drop batch |
 * | accounted_hard_marker_drain | yes | matched HARD/m0 pass records marker_drain or a compaction-marker seam |
 * | accounted_hard_model_change | yes | matched HARD/m0 pass records materialize_reason=model_change |
 * | accounted_hard_system_hash | yes | matched HARD/m0 pass records system_hash, or a large system-prompt replacement |
 * | accounted_hard_epoch | yes | matched HARD/m0 pass records a project, render, or session epoch change |
 * | accounted_hard_pressure_refold | yes | matched HARD/m0 pass records materialize_reason=pressure_refold |
 * | accounted_hard_fold | yes | matched pass records another materialized HARD/m0 fold; tiny mid-history defer/first_render seams are excluded |
 * | accounted_ctx_reduce | yes | matched pass applies drops at an agent ctx_reduce landing |
 * | accounted_drop_applied | yes | matched pass records applied drops |
 * | accounted_soft_m1_execute | yes | matched canonical execute pass refreshes m1 |
 * | unaccounted_defer_pass | no | matched canonical defer pass, including a tiny mid-history first_render seam, diverges |
 * | accounted_provider_system_prompt_change | yes | matched non-defer pass has a user-visible provider change |
 * | unaccounted_double_bust | no | matched otherwise-unattributed pass repeats the previous divergence offset |
 * | unaccounted_tail_rewrite | no | matched otherwise-unattributed pass rewrites the previous request tail |
 * | unaccounted_rewrite | no | matched pass has no accounted attribution |
 *
 * By default the process stays alive and scans every 60 seconds. Use --once from
 * launchd/cron or for a manual pass. --send is the only switch that opens subc;
 * without it, each new event is printed as one JSON line.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { SubcClient } from "@cortexkit/subc-client";

import { getDataDir, getMagicContextStorageDir } from "../src/shared/data-path";
import { resolveOpenCodeDbPath } from "../src/shared/opencode-db-path";
import { analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import {
    type AnalyzedCacheRequest,
    type CacheBustDecisionAttribution,
    type CacheBustSessionAnalysis,
    isUnaccountedCacheBustClass,
} from "./cache-bust-attribution";

const STATE_VERSION = 1;
const BUST_WINDOW_MS = 120_000;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LOOKBACK_MS = 5 * 60_000;
const DEFAULT_WAKE_MODULE_ID = "prefrontal";
const WAKE_EVENT_METHOD = "wake.event_record";
const PI_ANALYZER_MODULE = "../../pi-plugin/scripts/analyze-pi-cache-busts";

export type CacheBustHarness = "opencode" | "pi";

export interface CacheBustSentinelOptions {
    once: boolean;
    send: boolean;
    intervalMs: number;
    lookbackMs: number;
    stateFile: string;
    databasePath: string;
    rustStorePath: string;
    connectionFile: string;
    wakeModuleId: string;
    anthropicDir?: string;
    openaiDir?: string;
    piDir?: string;
    ompDir?: string;
    ledgerDir?: string;
    bodiesDir?: string;
}

export interface ActiveCacheBustSession {
    sessionId: string;
    harness: CacheBustHarness;
    projectPath: string;
    activityMs: number;
    directory?: string;
}

export interface CacheBustEvent {
    source_module: "magic-context";
    kind: "cache_bust";
    vendor_event_id: string;
    supersedes?: string;
    session_id: string;
    directory: string;
    occurred_at_ms: number;
    payload: {
        session: string;
        at: string;
        rewritten_tokens: number;
        divergence_class: string;
        first_divergence: string;
        analyzer_cmd: string;
    };
}

export type WakeEventRecordReply =
    | { accepted: true; fire_id: string }
    | {
          accepted: false;
          reason: "unowned_session" | "dedup" | "superseded";
      };

export interface CacheBustTransport {
    record(event: CacheBustEvent): Promise<unknown>;
    close?(): void | Promise<void>;
}

interface OpenBustWindowState {
    startMs: number;
    lastBustMs: number;
}

interface SessionWatermarkState {
    lastAnalyzedRequestTimestampMs: number;
    openWindow?: OpenBustWindowState;
}

interface SentWindowState {
    divergenceClass: string;
    lastEventId: string;
    eventIds: string[];
}

export interface CacheBustSentinelState {
    version: 1;
    sessions: Record<string, SessionWatermarkState>;
    windows: Record<string, SentWindowState>;
}

export interface BustWindow {
    sessionId: string;
    startMs: number;
    lastBustMs: number;
    rows: AnalyzedCacheRequest[];
}

export interface SentinelCounters {
    sessions: number;
    requests: number;
    bustWindows: number;
    accountedWindows: number;
    unaccountedWindows: number;
    skippedSeen: number;
    dryRun: number;
    accepted: number;
    unownedSession: number;
    dedup: number;
    superseded: number;
}

interface SentinelRunDeps {
    now?: () => number;
    listActiveSessions?: (
        state: CacheBustSentinelState,
        nowMs: number,
        options: CacheBustSentinelOptions,
    ) => ActiveCacheBustSession[];
    analyzeSession?: (
        session: ActiveCacheBustSession,
        sinceExclusiveMs: number,
        decisions: readonly CacheBustDecisionAttribution[],
        options: CacheBustSentinelOptions,
    ) => Promise<CacheBustSessionAnalysis>;
    loadDecisions?: (
        session: ActiveCacheBustSession,
        options: CacheBustSentinelOptions,
    ) => CacheBustDecisionAttribution[];
    transport?: CacheBustTransport;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
}

export class CacheBustSentinelInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CacheBustSentinelInputError";
    }
}

function defaultState(): CacheBustSentinelState {
    return { version: STATE_VERSION, sessions: {}, windows: {} };
}

function finiteNonnegative(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function loadSentinelState(path: string): CacheBustSentinelState {
    if (!existsSync(path)) return defaultState();
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new CacheBustSentinelInputError(`invalid sentinel state JSON at ${path}: ${error}`);
    }
    const root = recordValue(parsed);
    const sessions = recordValue(root?.sessions);
    const windows = recordValue(root?.windows);
    if (root?.version !== STATE_VERSION || !sessions || !windows) {
        throw new CacheBustSentinelInputError(`unsupported sentinel state at ${path}`);
    }

    const state = defaultState();
    for (const [sessionId, raw] of Object.entries(sessions)) {
        const row = recordValue(raw);
        const highWater = finiteNonnegative(row?.lastAnalyzedRequestTimestampMs);
        if (highWater === undefined) {
            throw new CacheBustSentinelInputError(
                `invalid high-water mark for session ${sessionId} in ${path}`,
            );
        }
        const open = recordValue(row?.openWindow);
        const startMs = finiteNonnegative(open?.startMs);
        const lastBustMs = finiteNonnegative(open?.lastBustMs);
        state.sessions[sessionId] = {
            lastAnalyzedRequestTimestampMs: highWater,
            ...(open && startMs !== undefined && lastBustMs !== undefined
                ? { openWindow: { startMs, lastBustMs } }
                : {}),
        };
    }
    for (const [key, raw] of Object.entries(windows)) {
        const row = recordValue(raw);
        if (
            typeof row?.divergenceClass !== "string" ||
            typeof row.lastEventId !== "string" ||
            !Array.isArray(row.eventIds) ||
            !row.eventIds.every((id) => typeof id === "string")
        ) {
            throw new CacheBustSentinelInputError(`invalid window state ${key} in ${path}`);
        }
        state.windows[key] = {
            divergenceClass: row.divergenceClass,
            lastEventId: row.lastEventId,
            eventIds: [...row.eventIds],
        };
    }
    return state;
}

export function saveSentinelState(path: string, state: CacheBustSentinelState): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
    const parsed = value === undefined ? Number.NaN : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new CacheBustSentinelInputError(`${flag} requires a positive integer`);
    }
    return parsed;
}

export function parseSentinelArgs(argv: string[]): CacheBustSentinelOptions {
    const args = argv.slice(2);
    const valueFlags = new Set([
        "--interval-ms",
        "--lookback-ms",
        "--state-file",
        "--db",
        "--rust-store",
        "--connection-file",
        "--wake-module-id",
        "--anthropic-dir",
        "--openai-dir",
        "--pi-dir",
        "--omp-dir",
        "--ledger-dir",
        "--bodies-dir",
    ]);
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--once" || arg === "--send") continue;
        if (!valueFlags.has(arg)) {
            throw new CacheBustSentinelInputError(`unknown argument: ${arg}`);
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
            throw new CacheBustSentinelInputError(`${arg} requires a value`);
        }
        values.set(arg, value);
        index += 1;
    }
    const storageDir = getMagicContextStorageDir();
    const intervalMs = values.has("--interval-ms")
        ? parsePositiveInteger(values.get("--interval-ms"), "--interval-ms")
        : DEFAULT_INTERVAL_MS;
    if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
        throw new CacheBustSentinelInputError(
            `--interval-ms must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
        );
    }
    const lookbackMs = values.has("--lookback-ms")
        ? parsePositiveInteger(values.get("--lookback-ms"), "--lookback-ms")
        : DEFAULT_LOOKBACK_MS;
    return {
        once: args.includes("--once"),
        send: args.includes("--send"),
        intervalMs,
        lookbackMs,
        stateFile: values.get("--state-file") ?? join(storageDir, "cache-bust-sentinel-state.json"),
        databasePath: values.get("--db") ?? join(storageDir, "context.db"),
        rustStorePath: values.get("--rust-store") ?? join(storageDir, "store.db"),
        connectionFile:
            values.get("--connection-file") ??
            join(getDataDir(), "cortexkit", "run", "subc-connection.json"),
        wakeModuleId: values.get("--wake-module-id") ?? DEFAULT_WAKE_MODULE_ID,
        anthropicDir: values.get("--anthropic-dir"),
        openaiDir: values.get("--openai-dir"),
        piDir: values.get("--pi-dir"),
        ompDir: values.get("--omp-dir"),
        ledgerDir: values.get("--ledger-dir"),
        bodiesDir: values.get("--bodies-dir"),
    };
}

function tableExists(db: Database, table: string): boolean {
    return Boolean(
        db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

export function enumerateActiveSessions(
    state: CacheBustSentinelState,
    nowMs: number,
    options: CacheBustSentinelOptions,
): ActiveCacheBustSession[] {
    if (!existsSync(options.databasePath)) return [];
    const db = new Database(options.databasePath, { readonly: true });
    try {
        if (!tableExists(db, "session_projects") || !tableExists(db, "session_meta")) return [];
        const rows = db
            .query(
                `SELECT sp.session_id, sp.harness, sp.project_path, sp.updated_at,
                        sm.last_response_time
                   FROM session_projects sp
                   JOIN session_meta sm
                     ON sm.session_id = sp.session_id AND sm.harness = sp.harness
                  WHERE sp.harness IN ('opencode', 'pi')`,
            )
            .all() as Array<Record<string, unknown>>;
        return rows.flatMap((row) => {
            const sessionId = typeof row.session_id === "string" ? row.session_id : "";
            const harness = row.harness === "opencode" || row.harness === "pi" ? row.harness : null;
            const projectPath = typeof row.project_path === "string" ? row.project_path : "";
            const activityMs = Math.max(
                finiteNonnegative(row.updated_at) ?? 0,
                finiteNonnegative(row.last_response_time) ?? 0,
            );
            if (!sessionId || !harness || !projectPath) return [];
            const since =
                state.sessions[sessionId]?.lastAnalyzedRequestTimestampMs ??
                nowMs - options.lookbackMs;
            return activityMs > since ? [{ sessionId, harness, projectPath, activityMs }] : [];
        });
    } finally {
        db.close(false);
    }
}

export function loadSessionDecisions(
    session: ActiveCacheBustSession,
    options: CacheBustSentinelOptions,
): CacheBustDecisionAttribution[] {
    const records: CacheBustDecisionAttribution[] = [];
    const stringField = (row: Record<string, unknown>, ...keys: string[]): string | undefined => {
        for (const key of keys) {
            if (typeof row[key] === "string" && row[key]) return row[key] as string;
        }
        return undefined;
    };
    const numberField = (row: Record<string, unknown>, ...keys: string[]): number | undefined => {
        for (const key of keys) {
            const value = finiteNonnegative(row[key]);
            if (value !== undefined) return value;
        }
        return undefined;
    };
    const booleanField = (row: Record<string, unknown>, ...keys: string[]): boolean =>
        keys.some((key) => row[key] === true || row[key] === 1 || row[key] === "true");
    const normalize = (
        row: Record<string, unknown>,
        source: string,
    ): CacheBustDecisionAttribution | undefined => {
        if (
            typeof row.harness === "string" &&
            row.harness !== session.harness &&
            !(
                session.harness === "pi" &&
                (row.harness === "omp" || row.harness === "opencode")
            )
        ) {
            return undefined;
        }
        const timestampMs = numberField(
            row,
            "pass_timestamp_ms",
            "timestamp_ms",
            "ts_ms",
            "last_received_at_ms",
        );
        if (timestampMs === undefined) return undefined;
        const materializeReason =
            stringField(
                row,
                "materialize_reason",
                "materialization_reason",
                "fold_reason",
                "hard_reason",
            ) ?? null;
        const appliedDrops = numberField(
            row,
            "applied_drop_count",
            "applied_drops",
            "applied_supersession_count",
            "dropped_count",
        );
        return {
            timestampMs,
            requestObservedAtMs: numberField(row, "request_observed_at_ms", "request_observed_at"),
            messageId: stringField(row, "message_id", "assistant_message_id"),
            decision:
                stringField(row, "decision", "scheduler_decision", "canonical_decision") ??
                "unknown",
            canonicalDecision: stringField(row, "canonical_decision"),
            deferReason: stringField(row, "defer_reason") ?? null,
            materialized:
                booleanField(row, "materialized", "m0_materialized", "fold_applied") ||
                materializeReason !== null,
            materializeReason,
            emergency: booleanField(row, "emergency", "drain_latch_active", "force_band"),
            droppedTokens: numberField(row, "dropped_tokens", "applied_drop_tokens") ?? 0,
            droppedCount: appliedDrops ?? 0,
            inputTokens: numberField(row, "input_tokens", "prompt_tokens") ?? 0,
            flush:
                booleanField(row, "flush", "flush_applied", "explicit_flush") ||
                materializeReason === "explicit_flush",
            source,
        };
    };
    const addRows = (rows: readonly Record<string, unknown>[], source: string): void => {
        for (const row of rows) {
            const normalized = normalize(row, source);
            if (normalized) records.push(normalized);
        }
    };
    const readTable = (db: Database, table: string, source: string): void => {
        if (!tableExists(db, table)) return;
        const columns = new Set(
            (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).flatMap(
                (row) => (typeof row.name === "string" ? [row.name] : []),
            ),
        );
        if (!columns.has("session_id")) return;
        addRows(
            db.query(`SELECT * FROM ${table} WHERE session_id = ?`).all(session.sessionId) as Array<
                Record<string, unknown>
            >,
            source,
        );
    };
    const readTraceHistory = (db: Database, source: string): void => {
        if (!tableExists(db, "mc_pass_trace")) return;
        const rows = db
            .query("SELECT * FROM mc_pass_trace WHERE session_id = ?")
            .all(session.sessionId) as Array<Record<string, unknown>>;
        addRows(rows, source);
        for (const row of rows) {
            for (const column of ["scheduler_history", "scheduler_interesting_history"] as const) {
                if (typeof row[column] !== "string") continue;
                try {
                    const history = JSON.parse(row[column] as string);
                    if (Array.isArray(history)) {
                        addRows(
                            history.filter((entry): entry is Record<string, unknown> =>
                                Boolean(recordValue(entry)),
                            ),
                            `${source}.${column}`,
                        );
                    }
                } catch {
                    // A malformed diagnostic history is ignored; the mirrored table can still join.
                }
            }
        }
    };
    const readStore = (path: string, source: string, includeTrace: boolean): void => {
        if (!existsSync(path)) return;
        const db = new Database(path, { readonly: true });
        try {
            readTable(db, "transform_decisions", `${source}.transform_decisions`);
            readTable(db, "scheduler_history", `${source}.scheduler_history`);
            if (includeTrace) readTraceHistory(db, `${source}.mc_pass_trace`);
        } finally {
            db.close(false);
        }
    };

    readStore(options.databasePath, "context.db", false);
    if (options.rustStorePath !== options.databasePath) {
        readStore(options.rustStorePath, "store.db", true);
    }

    records.sort((left, right) => left.timestampMs - right.timestampMs);
    const merged: CacheBustDecisionAttribution[] = [];
    for (const record of records) {
        const prior = merged.at(-1);
        if (prior && Math.abs(prior.timestampMs - record.timestampMs) <= 500) {
            prior.requestObservedAtMs ??= record.requestObservedAtMs;
            prior.messageId ??= record.messageId;
            prior.canonicalDecision ??= record.canonicalDecision;
            prior.deferReason ??= record.deferReason;
            prior.materialized ||= record.materialized;
            prior.materializeReason ??= record.materializeReason;
            prior.emergency ||= record.emergency;
            prior.droppedTokens = Math.max(prior.droppedTokens, record.droppedTokens);
            prior.droppedCount = Math.max(prior.droppedCount, record.droppedCount);
            prior.inputTokens = Math.max(prior.inputTokens, record.inputTokens);
            prior.flush ||= record.flush;
            prior.source = `${prior.source}+${record.source}`;
            continue;
        }
        merged.push({ ...record });
    }
    return merged;
}

function openCodeSessionDirectory(sessionId: string): string | undefined {
    const resolution = resolveOpenCodeDbPath();
    if (!existsSync(resolution.path)) return undefined;
    const db = new Database(resolution.path, { readonly: true });
    try {
        if (!tableExists(db, "session")) return undefined;
        const columns = new Set(
            (db.query("PRAGMA table_info(session)").all() as Array<{ name?: unknown }>).flatMap(
                (row) => (typeof row.name === "string" ? [row.name] : []),
            ),
        );
        if (columns.has("directory")) {
            const row = db
                .query("SELECT directory FROM session WHERE id = ?")
                .get(sessionId) as Record<string, unknown> | null;
            if (typeof row?.directory === "string" && row.directory) return row.directory;
        }
        if (columns.has("data")) {
            const row = db.query("SELECT data FROM session WHERE id = ?").get(sessionId) as Record<
                string,
                unknown
            > | null;
            if (typeof row?.data === "string") {
                const data = recordValue(JSON.parse(row.data));
                if (typeof data?.directory === "string" && data.directory) return data.directory;
            }
        }
        return undefined;
    } catch {
        return undefined;
    } finally {
        db.close(false);
    }
}

async function runPiAnalyzer(options: {
    sessionId: string;
    sinceExclusiveMs: number;
    untilInclusiveMs: number;
    piDir?: string;
    ompDir?: string;
    ledgerDir?: string;
    bodiesDir?: string;
    decisions: readonly CacheBustDecisionAttribution[];
}): Promise<CacheBustSessionAnalysis> {
    const module = (await import(PI_ANALYZER_MODULE)) as {
        analyzePiCacheBustSession(input: typeof options): Promise<CacheBustSessionAnalysis>;
    };
    return await module.analyzePiCacheBustSession(options);
}

async function analyzeActiveSession(
    session: ActiveCacheBustSession,
    sinceExclusiveMs: number,
    decisions: readonly CacheBustDecisionAttribution[],
    options: CacheBustSentinelOptions,
): Promise<CacheBustSessionAnalysis> {
    if (session.harness === "opencode") {
        const analysis = analyzeOpenCodeCacheBustSession({
            sessionId: session.sessionId,
            sinceExclusiveMs,
            untilInclusiveMs: Date.now(),
            anthropicDir: options.anthropicDir,
            openaiDir: options.openaiDir,
            decisions,
        });
        return {
            ...analysis,
            directory: session.directory ?? openCodeSessionDirectory(session.sessionId),
        };
    }
    return await runPiAnalyzer({
        sessionId: session.sessionId,
        sinceExclusiveMs,
        untilInclusiveMs: Date.now(),
        piDir: options.piDir,
        ompDir: options.ompDir,
        ledgerDir: options.ledgerDir,
        bodiesDir: options.bodiesDir,
        decisions,
    });
}

export function groupBustWindows(
    requests: readonly AnalyzedCacheRequest[],
    seed?: OpenBustWindowState,
): BustWindow[] {
    const ordered = [...requests].sort(
        (left, right) => left.timestampMs - right.timestampMs || left.at.localeCompare(right.at),
    );
    const windows: BustWindow[] = [];
    let current: BustWindow | undefined = seed
        ? {
              sessionId: ordered[0]?.session ?? "",
              startMs: seed.startMs,
              lastBustMs: seed.lastBustMs,
              rows: [],
          }
        : undefined;
    let previousWasBust = Boolean(seed);
    for (const request of ordered) {
        if (request.verdict !== "BUST") {
            if (current?.rows.length) windows.push(current);
            current = undefined;
            previousWasBust = false;
            continue;
        }
        if (!request.divergenceClass) {
            throw new CacheBustSentinelInputError(
                `analyzer returned BUST without divergence_class for ${request.session} at ${request.at}`,
            );
        }
        if (
            current &&
            previousWasBust &&
            request.timestampMs - current.lastBustMs <= BUST_WINDOW_MS
        ) {
            current.rows.push(request);
            current.lastBustMs = request.timestampMs;
        } else {
            if (current?.rows.length) windows.push(current);
            current = {
                sessionId: request.session,
                startMs: request.timestampMs,
                lastBustMs: request.timestampMs,
                rows: [request],
            };
        }
        previousWasBust = true;
    }
    if (current?.rows.length) windows.push(current);
    return windows;
}

export function cacheBustWindowId(sessionId: string, startMs: number): string {
    return createHash("sha256").update(`${sessionId}|${startMs}`).digest("hex");
}

function revisedCacheBustWindowId(
    sessionId: string,
    startMs: number,
    divergenceClass: string,
): string {
    return createHash("sha256").update(`${sessionId}|${startMs}|${divergenceClass}`).digest("hex");
}

function windowKey(sessionId: string, startMs: number): string {
    return `${sessionId}|${startMs}`;
}

export function eventForWindow(
    window: BustWindow,
    directory: string,
    state: CacheBustSentinelState,
): CacheBustEvent | null {
    const unaccounted = window.rows.filter((row) =>
        isUnaccountedCacheBustClass(row.divergenceClass as string),
    );
    if (unaccounted.length === 0) return null;
    const representative = unaccounted[0];
    const divergenceClass = representative.divergenceClass as string;
    const key = windowKey(window.sessionId, window.startMs);
    const prior = state.windows[key];
    if (prior?.divergenceClass === divergenceClass) return null;
    const baseId = cacheBustWindowId(window.sessionId, window.startMs);
    const eventId = prior
        ? revisedCacheBustWindowId(window.sessionId, window.startMs, divergenceClass)
        : baseId;
    if (prior?.eventIds.includes(eventId)) return null;
    const event: CacheBustEvent = {
        source_module: "magic-context",
        kind: "cache_bust",
        vendor_event_id: eventId,
        ...(prior ? { supersedes: prior.lastEventId } : {}),
        session_id: window.sessionId,
        directory,
        occurred_at_ms: window.startMs,
        payload: {
            session: window.sessionId,
            at: representative.at,
            rewritten_tokens: unaccounted.reduce(
                (total, row) => total + Math.max(0, row.rewrittenTokens ?? 0),
                0,
            ),
            divergence_class: divergenceClass,
            first_divergence: representative.firstDivergence,
            analyzer_cmd: representative.analyzerCmd,
        },
    };
    state.windows[key] = {
        divergenceClass,
        lastEventId: eventId,
        eventIds: [...(prior?.eventIds ?? []), eventId],
    };
    return event;
}

export function parseWakeEventRecordReply(value: unknown): WakeEventRecordReply {
    const row = recordValue(value);
    if (row?.accepted === true && typeof row.fire_id === "string" && row.fire_id.length > 0) {
        return { accepted: true, fire_id: row.fire_id };
    }
    if (
        row?.accepted === false &&
        (row.reason === "unowned_session" || row.reason === "dedup" || row.reason === "superseded")
    ) {
        return { accepted: false, reason: row.reason };
    }
    throw new CacheBustSentinelInputError(
        `malformed ${WAKE_EVENT_METHOD} reply: ${JSON.stringify(value)}`,
    );
}

export class SubcWakeEventTransport implements CacheBustTransport {
    private clientPromise: Promise<SubcClient> | null = null;

    constructor(
        private readonly connectionFile: string,
        private readonly moduleId = DEFAULT_WAKE_MODULE_ID,
    ) {}

    private client(): Promise<SubcClient> {
        this.clientPromise ??= SubcClient.connect({
            connectionFile: this.connectionFile,
            handshakeTimeoutMs: 2_000,
        });
        return this.clientPromise;
    }

    async record(event: CacheBustEvent): Promise<unknown> {
        const client = await this.client();
        const projectRoot =
            isAbsolute(event.directory) && existsSync(event.directory)
                ? event.directory
                : process.cwd();
        return await client.call(this.moduleId, WAKE_EVENT_METHOD, event, {
            identity: {
                project_root: projectRoot,
                harness: "magic-context",
                session: event.session_id,
            },
            consumerIdentity: null,
            timeoutMs: 15_000,
        });
    }

    async close(): Promise<void> {
        if (!this.clientPromise) return;
        const client = await this.clientPromise.catch(() => null);
        client?.close();
    }
}

function emptyCounters(): SentinelCounters {
    return {
        sessions: 0,
        requests: 0,
        bustWindows: 0,
        accountedWindows: 0,
        unaccountedWindows: 0,
        skippedSeen: 0,
        dryRun: 0,
        accepted: 0,
        unownedSession: 0,
        dedup: 0,
        superseded: 0,
    };
}

function recordReply(counters: SentinelCounters, reply: WakeEventRecordReply): void {
    if (reply.accepted) {
        counters.accepted += 1;
        return;
    }
    if (reply.reason === "unowned_session") counters.unownedSession += 1;
    else if (reply.reason === "dedup") counters.dedup += 1;
    else counters.superseded += 1;
}

function updateOpenWindowState(
    sessionState: SessionWatermarkState,
    requests: readonly AnalyzedCacheRequest[],
    windows: readonly BustWindow[],
): void {
    const latest = [...requests].sort((left, right) => right.timestampMs - left.timestampMs)[0];
    if (!latest) return;
    if (latest.verdict !== "BUST") {
        delete sessionState.openWindow;
        return;
    }
    const window = [...windows]
        .reverse()
        .find((candidate) => candidate.rows.some((row) => row.timestampMs === latest.timestampMs));
    if (window) {
        sessionState.openWindow = {
            startMs: window.startMs,
            lastBustMs: window.lastBustMs,
        };
    }
}

export async function runSentinelOnce(
    options: CacheBustSentinelOptions,
    deps: SentinelRunDeps = {},
): Promise<SentinelCounters> {
    const nowMs = (deps.now ?? Date.now)();
    const stdout = deps.stdout ?? console.log;
    const stderr = deps.stderr ?? console.error;
    const state = loadSentinelState(options.stateFile);
    const listSessions = deps.listActiveSessions ?? enumerateActiveSessions;
    const sessions = listSessions(state, nowMs, options);
    const counters = emptyCounters();
    counters.sessions = sessions.length;
    const transport = options.send
        ? (deps.transport ??
          new SubcWakeEventTransport(options.connectionFile, options.wakeModuleId))
        : null;

    try {
        for (const session of sessions) {
            const priorSession = state.sessions[session.sessionId];
            const sinceExclusiveMs =
                priorSession?.lastAnalyzedRequestTimestampMs ?? nowMs - options.lookbackMs;
            const decisions = (deps.loadDecisions ?? loadSessionDecisions)(session, options);
            const analysis = await (deps.analyzeSession ?? analyzeActiveSession)(
                session,
                sinceExclusiveMs,
                decisions,
                options,
            );
            const requests = analysis.requests.filter(
                (request) =>
                    request.session === session.sessionId &&
                    request.timestampMs > sinceExclusiveMs &&
                    request.timestampMs <= nowMs,
            );
            counters.requests += requests.length;
            const sessionState: SessionWatermarkState = priorSession ?? {
                lastAnalyzedRequestTimestampMs: sinceExclusiveMs,
            };
            const windows = groupBustWindows(requests, sessionState.openWindow);
            counters.bustWindows += windows.length;
            for (const window of windows) {
                const hasUnaccounted = window.rows.some((row) =>
                    isUnaccountedCacheBustClass(row.divergenceClass as string),
                );
                if (!hasUnaccounted) {
                    counters.accountedWindows += 1;
                    continue;
                }
                counters.unaccountedWindows += 1;
                const event = eventForWindow(
                    window,
                    analysis.directory ?? session.directory ?? session.projectPath,
                    state,
                );
                if (!event) {
                    counters.skippedSeen += 1;
                    continue;
                }
                // Persist the event id before any I/O so an ambiguous transport outcome
                // cannot cause the same vendor_event_id to be emitted twice.
                saveSentinelState(options.stateFile, state);
                if (!transport) {
                    stdout(JSON.stringify(event));
                    counters.dryRun += 1;
                    continue;
                }
                const reply = parseWakeEventRecordReply(await transport.record(event));
                recordReply(counters, reply);
                stderr(
                    JSON.stringify({
                        event_id: event.vendor_event_id,
                        reply,
                        counters,
                    }),
                );
            }
            const highWater =
                analysis.highWaterMarkMs !== null && analysis.highWaterMarkMs <= nowMs
                    ? analysis.highWaterMarkMs
                    : requests.length > 0
                      ? Math.max(...requests.map((request) => request.timestampMs))
                      : null;
            if (highWater !== null && highWater > sessionState.lastAnalyzedRequestTimestampMs) {
                sessionState.lastAnalyzedRequestTimestampMs = highWater;
            }
            updateOpenWindowState(sessionState, requests, windows);
            state.sessions[session.sessionId] = sessionState;
            saveSentinelState(options.stateFile, state);
        }
    } finally {
        await transport?.close?.();
    }
    saveSentinelState(options.stateFile, state);
    stderr(JSON.stringify({ kind: "cache_bust_sentinel_summary", counters }));
    return counters;
}

async function main(): Promise<void> {
    const options = parseSentinelArgs(process.argv);
    await runSentinelOnce(options);
    while (!options.once) {
        await Bun.sleep(options.intervalMs);
        await runSentinelOnce(options);
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

export const __test = {
    bustWindowMs: BUST_WINDOW_MS,
    defaultState,
    revisedCacheBustWindowId,
};
