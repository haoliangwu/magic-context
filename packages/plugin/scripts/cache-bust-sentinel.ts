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
 * | usage_missing | yes | provider cache read and direct input are both 0 or usage is absent; in-flight/unmetered pass is never a bust baseline |
 * | provider_full_miss | yes | provider cache read is exactly 0 with prevTotal ≥ 10,000; ordinary short reads stay unaccounted; show wire model prev → cur when it changes |
 * | unaccounted_defer_pass | no | matched canonical defer pass, including a tiny mid-history first_render seam, diverges |
 * | accounted_provider_system_prompt_change | yes | matched non-defer pass has a user-visible provider change |
 * | unaccounted_double_bust | no | matched otherwise-unattributed pass repeats the previous divergence offset |
 * | unaccounted_tail_rewrite | no | matched otherwise-unattributed pass rewrites the previous request tail |
 * | unaccounted_rewrite | no | matched pass has no accounted attribution |
 *
 * By default the process stays alive and scans every 60 seconds. Use --once from
 * launchd/cron or for a manual pass. --send is the only switch that opens subc;
 * without it, each new event is printed as one JSON line. Sending delivers a
 * high-urgency registry peer message through prefrontal-core's agent.deliver op.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ManagedCallOptions, SubcClient } from "@cortexkit/subc-client";

import { loadPluginConfig } from "../src/config";
import { getDataDir, getMagicContextStorageDir } from "../src/shared/data-path";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../src/shared/storage-permissions";
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
const DEFAULT_WAKE_MODULE_ID = "prefrontal-core";
const DEFAULT_WAKE_AGENT_ID = "agent_b613e5cf2ee55b8c";
const DEFAULT_WAKE_FROM_AGENT = "mc-cache-bust-sentinel";
const SENTINEL_FROM_SESSION_ID = "health-sentinel-mc";
const SENTINEL_FROM_HARNESS = "magic-context";
const AGENT_DELIVER_METHOD = "agent.deliver";
const PI_ANALYZER_MODULE = "../../pi-plugin/scripts/analyze-pi-cache-busts";

export type CacheBustHarness = "opencode" | "pi";

export interface CacheBustSentinelOptions {
    once: boolean;
    send: boolean;
    intervalMs: number;
    lookbackMs: number;
    maxRunMs?: number;
    stateFile: string;
    databasePath: string;
    rustStorePath: string;
    connectionFile: string;
    wakeModuleId: string;
    wakeAgentId: string;
    wakeFromAgent: string;
    mcLogPath?: string;
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
        /** Render-identity components the matched pass changed, when it logged them. */
        identity_delta?: string[];
    };
}

export interface AgentDeliverRequest {
    agent_id: string;
    delivery_id: string;
    body: {
        kind: "peer_message";
        from_agent: string;
        from_session_id: "health-sentinel-mc";
        from_harness: "magic-context";
        content: string;
        /** The sender is a script with no session, so replies cannot reach it. */
        one_way: true;
    };
    urgency: "high";
    expected_residence_epoch?: number;
}

export interface AgentDeliverReply {
    disposition: "delivered" | "queued";
    committed_order: number;
}

export type AgentDeliverOutcome =
    | (AgentDeliverReply & { accepted: true; contractViolation?: true })
    | (AgentDeliverReply & { accepted: false; reason: "dedup" });

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
    scanCursor?: string;
}

interface SentWindowState {
    divergenceClass: string;
    lastEventId: string;
    eventIds: string[];
}

interface SentDeliveryState {
    disposition: AgentDeliverReply["disposition"];
    committedOrder: number;
}

export interface CacheBustSentinelState {
    version: 1;
    sessions: Record<string, SessionWatermarkState>;
    windows: Record<string, SentWindowState>;
    deliveries: Record<string, SentDeliveryState>;
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
    dedup: number;
    sendRefused: number;
    filesExamined: number;
    bounded: boolean;
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
    ) => Promise<CacheBustSessionAnalysis & { filesExamined?: number; scanBounded?: boolean; scanCursor?: string }>;
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
    return { version: STATE_VERSION, sessions: {}, windows: {}, deliveries: {} };
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
    const deliveries = root?.deliveries === undefined ? {} : recordValue(root.deliveries);
    if (root?.version !== STATE_VERSION || !sessions || !windows || !deliveries) {
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
            ...(typeof row?.scanCursor === "string" ? { scanCursor: row.scanCursor } : {}),
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
    for (const [deliveryId, raw] of Object.entries(deliveries)) {
        const row = recordValue(raw);
        const committedOrder = finiteNonnegative(row?.committedOrder);
        if (
            (row?.disposition !== "delivered" && row?.disposition !== "queued") ||
            committedOrder === undefined ||
            !Number.isSafeInteger(committedOrder)
        ) {
            throw new CacheBustSentinelInputError(
                `invalid delivery state ${deliveryId} in ${path}`,
            );
        }
        state.deliveries[deliveryId] = {
            disposition: row.disposition,
            committedOrder,
        };
    }
    return state;
}

export function saveSentinelState(path: string, state: CacheBustSentinelState): void {
    writeStorageFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
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
        "--max-run-ms",
        "--state-file",
        "--db",
        "--rust-store",
        "--connection-file",
        "--wake-module-id",
        "--wake-agent-id",
        "--wake-from-agent",
        "--anthropic-dir",
        "--mc-log",
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
        maxRunMs: values.has("--max-run-ms")
            ? parsePositiveInteger(values.get("--max-run-ms"), "--max-run-ms")
            : 30_000,
        stateFile: values.get("--state-file") ?? join(storageDir, "cache-bust-sentinel-state.json"),
        databasePath: values.get("--db") ?? join(storageDir, "context.db"),
        rustStorePath: values.get("--rust-store") ?? join(storageDir, "store.db"),
        connectionFile:
            values.get("--connection-file") ??
            join(getDataDir(), "cortexkit", "run", "subc-connection.json"),
        wakeModuleId: values.get("--wake-module-id") ?? DEFAULT_WAKE_MODULE_ID,
        wakeAgentId: values.get("--wake-agent-id") ?? DEFAULT_WAKE_AGENT_ID,
        wakeFromAgent: values.get("--wake-from-agent") ?? DEFAULT_WAKE_FROM_AGENT,
        anthropicDir: values.get("--anthropic-dir"),
        mcLogPath: values.get("--mc-log"),
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
            return activityMs > since || state.sessions[sessionId]?.scanCursor
                ? [{ sessionId, harness, projectPath, activityMs }] : [];
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
    const stringListField = (
        row: Record<string, unknown>,
        ...keys: string[]
    ): string[] | undefined => {
        for (const key of keys) {
            const value = row[key];
            if (Array.isArray(value)) {
                const strings = value.filter(
                    (entry): entry is string => typeof entry === "string" && entry.length > 0,
                );
                if (strings.length > 0) return strings;
            }
            if (typeof value !== "string" || value.length === 0) continue;
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                    const strings = parsed.filter(
                        (entry): entry is string =>
                            typeof entry === "string" && entry.length > 0,
                    );
                    if (strings.length > 0) return strings;
                }
            } catch {
                const strings = value.split(",").filter(Boolean);
                if (strings.length > 0) return strings;
            }
        }
        return undefined;
    };
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
            appliedRide: stringField(row, "applied_ride", "reclaim_ride"),
            materialized:
                booleanField(row, "materialized", "m0_materialized", "fold_applied") ||
                materializeReason !== null,
            materializeReason,
            emergency: booleanField(row, "emergency", "drain_latch_active", "force_band"),
            droppedTokens: numberField(row, "dropped_tokens", "applied_drop_tokens") ?? 0,
            droppedCount: appliedDrops ?? 0,
            inputTokens: numberField(row, "input_tokens", "prompt_tokens") ?? 0,
            inputCount: numberField(row, "oc_input", "input_count"),
            externalEpoch: booleanField(
                row,
                "restart_epoch",
                "deploy_epoch",
                "config_epoch",
                "external_epoch",
            ),
            identityDelta: stringListField(row, "identity_delta", "render_identity_delta"),
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
        if (rows.length === 0) return;
        // Store migration 63 moved the histories into ring rows and dropped the array columns;
        // its read-only view rebuilds each session's arrays in sequence order. Older stores
        // still carry the columns on the trace row itself.
        const ringView = Boolean(
            db
                .query(
                    "SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'mc_pass_trace_history_arrays'",
                )
                .get(),
        );
        const histories = ringView
            ? (db
                  .query(
                      "SELECT scheduler_history, scheduler_interesting_history FROM mc_pass_trace_history_arrays WHERE session_id = ?",
                  )
                  .all(session.sessionId) as Array<Record<string, unknown>>)
            : rows.filter(
                  (row) =>
                      typeof row.scheduler_history === "string" ||
                      typeof row.scheduler_interesting_history === "string",
              );
        if (histories.length === 0) {
            // Reading zero decisions here would look like a quiet session, not a schema the
            // sentinel no longer understands.
            throw new CacheBustSentinelInputError(
                `${source} has a trace row for ${session.sessionId} but neither ring-row histories nor history columns`,
            );
        }
        for (const row of histories) {
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
            prior.appliedRide ??= record.appliedRide;
            prior.materialized ||= record.materialized;
            prior.materializeReason ??= record.materializeReason;
            prior.emergency ||= record.emergency;
            prior.droppedTokens = Math.max(prior.droppedTokens, record.droppedTokens);
            prior.droppedCount = Math.max(prior.droppedCount, record.droppedCount);
            prior.inputTokens = Math.max(prior.inputTokens, record.inputTokens);
            prior.inputCount ??= record.inputCount;
            prior.externalEpoch ||= record.externalEpoch;
            prior.identityDelta ??= record.identityDelta;
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
    options: CacheBustSentinelOptions & { scanCursor?: string; scanDeadlineMs?: number; scanNow?: () => number },
): Promise<CacheBustSessionAnalysis & { filesExamined?: number; scanBounded?: boolean; scanCursor?: string }> {
    if (session.harness === "opencode") {
        const analysis = analyzeOpenCodeCacheBustSession({
            sessionId: session.sessionId,
            sinceExclusiveMs,
            untilInclusiveMs: Date.now(),
            scanCursor: options.scanCursor,
            scanDeadlineMs: options.scanDeadlineMs,
            scanNow: options.scanNow,
            anthropicDir: options.anthropicDir,
            mcLogPath: options.mcLogPath,
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
        if (request.divergenceClass === "usage_missing") {
            // When the newest request is still in flight, do not start or continue
            // a window; keep its watermark at the most recent request that reported usage.
            current = undefined;
            previousWasBust = false;
            continue;
        }
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
            ...(representative.identityDelta?.length
                ? { identity_delta: representative.identityDelta }
                : {}),
        },
    };
    state.windows[key] = {
        divergenceClass,
        lastEventId: eventId,
        eventIds: [...(prior?.eventIds ?? []), eventId],
    };
    return event;
}

export function agentDeliverRequest(
    event: CacheBustEvent,
    agentId: string,
    fromAgent: string,
): AgentDeliverRequest {
    return {
        agent_id: agentId,
        delivery_id: event.vendor_event_id,
        body: {
            kind: "peer_message",
            from_agent: fromAgent,
            from_session_id: SENTINEL_FROM_SESSION_ID,
            from_harness: SENTINEL_FROM_HARNESS,
            content: `${event.session_id}: cache bust detected in directory ${event.directory} at ${event.payload.at}; rewritten_tokens=${event.payload.rewritten_tokens}; divergence_class=${event.payload.divergence_class}; first_divergence=${event.payload.first_divergence}${event.payload.identity_delta ? `; identity_delta=${event.payload.identity_delta.join(",")}` : ""}; analyzer_cmd=${event.payload.analyzer_cmd}`,
            one_way: true,
        },
        urgency: "high",
    };
}

export function parseAgentDeliverReply(
    value: unknown,
    previous?: AgentDeliverReply,
): AgentDeliverOutcome {
    const envelope = recordValue(value);
    const result = recordValue(envelope?.result);
    if (result && envelope && Object.keys(envelope).length !== 1) {
        throw new CacheBustSentinelInputError(
            `malformed ${AGENT_DELIVER_METHOD} reply: ${JSON.stringify(value)}`,
        );
    }
    const row = result ?? envelope;
    const keys = row ? Object.keys(row).sort() : [];
    if (
        !row ||
        keys.length !== 2 ||
        keys[0] !== "committed_order" ||
        keys[1] !== "disposition" ||
        !Number.isSafeInteger(row.committed_order) ||
        (row.committed_order as number) < 0
    ) {
        throw new CacheBustSentinelInputError(
            `malformed ${AGENT_DELIVER_METHOD} reply: ${JSON.stringify(value)}`,
        );
    }
    if (row.disposition === "idempotency_conflict") {
        throw new CacheBustSentinelInputError(
            `${AGENT_DELIVER_METHOD} idempotency_conflict: a delivery id was reused with different content`,
        );
    }
    if (row.disposition !== "delivered" && row.disposition !== "queued") {
        throw new CacheBustSentinelInputError(
            `malformed ${AGENT_DELIVER_METHOD} reply: ${JSON.stringify(value)}`,
        );
    }
    const reply: AgentDeliverReply = {
        disposition: row.disposition,
        committed_order: row.committed_order as number,
    };
    if (!previous) return { ...reply, accepted: true };
    if (reply.committed_order < previous.committed_order) {
        throw new CacheBustSentinelInputError(
            `${AGENT_DELIVER_METHOD} committed_order regressed from ${previous.committed_order} to ${reply.committed_order}`,
        );
    }
    if (reply.committed_order === previous.committed_order) {
        return { ...reply, accepted: false, reason: "dedup" };
    }
    return { ...reply, accepted: true, contractViolation: true };
}

export interface SubcWakeClient {
    call(
        moduleId: string,
        method: string,
        params?: unknown,
        options?: ManagedCallOptions,
    ): Promise<unknown>;
    close(): void;
}

export type SubcWakeClientFactory = (options: {
    connectionFile: string;
    handshakeTimeoutMs: number;
}) => Promise<SubcWakeClient>;

const connectSubcWakeClient: SubcWakeClientFactory = async (options) =>
    await SubcClient.connect(options);

function errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SubcWakeEventTransport implements CacheBustTransport {
    private clientPromise: Promise<SubcWakeClient> | null = null;

    constructor(
        private readonly connectionFile: string,
        private readonly moduleId = DEFAULT_WAKE_MODULE_ID,
        private readonly agentId = DEFAULT_WAKE_AGENT_ID,
        private readonly fromAgent = DEFAULT_WAKE_FROM_AGENT,
        private readonly connect: SubcWakeClientFactory = connectSubcWakeClient,
    ) {}

    private client(): Promise<SubcWakeClient> {
        this.clientPromise ??= this.connect({
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
        try {
            return await client.call(
                this.moduleId,
                AGENT_DELIVER_METHOD,
                agentDeliverRequest(event, this.agentId, this.fromAgent),
                {
                    identity: {
                        project_root: projectRoot,
                        harness: "magic-context",
                        session: event.session_id,
                    },
                    consumerIdentity: null,
                    timeoutMs: 15_000,
                },
            );
        } catch (error) {
            if (errorCode(error) === "idempotency_conflict") {
                throw new CacheBustSentinelInputError(
                    `${AGENT_DELIVER_METHOD} idempotency_conflict for delivery_id=${event.vendor_event_id}: the same cache-bust window produced different content`,
                );
            }
            throw error;
        }
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
        dedup: 0,
        sendRefused: 0,
        filesExamined: 0,
        bounded: false,
    };
}

function recordReply(counters: SentinelCounters, reply: AgentDeliverOutcome): void {
    if (reply.accepted) counters.accepted += 1;
    else counters.dedup += 1;
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
    const clock = deps.now ?? Date.now;
    const nowMs = clock();
    const deadlineMs = nowMs + (options.maxRunMs ?? 30_000);
    const stdout = deps.stdout ?? console.log;
    const stderr = deps.stderr ?? console.error;
    const state = loadSentinelState(options.stateFile);
    const listSessions = deps.listActiveSessions ?? enumerateActiveSessions;
    const sessions = listSessions(state, nowMs, options);
    const counters = emptyCounters();
    counters.sessions = sessions.length;
    stderr(JSON.stringify({ kind: "cache_bust_sentinel_start", at: new Date(nowMs).toISOString() }));
    const transport = options.send
        ? (deps.transport ??
          new SubcWakeEventTransport(
              options.connectionFile,
              options.wakeModuleId,
              options.wakeAgentId,
              options.wakeFromAgent,
          ))
        : null;

    try {
        for (const session of sessions) {
            if (clock() >= deadlineMs) {
                counters.bounded = true;
                break;
            }
            const priorSession = state.sessions[session.sessionId];
            const sinceExclusiveMs =
                priorSession?.lastAnalyzedRequestTimestampMs ?? nowMs - options.lookbackMs;
            const decisions = (deps.loadDecisions ?? loadSessionDecisions)(session, options);
            const analysis = await (deps.analyzeSession ?? analyzeActiveSession)(
                session,
                sinceExclusiveMs,
                decisions,
                { ...options, scanCursor: priorSession?.scanCursor, scanDeadlineMs: deadlineMs, scanNow: clock },
            );
            counters.filesExamined += analysis.filesExamined ?? 0;
            counters.bounded ||= analysis.scanBounded ?? false;
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
                for (const row of window.rows) {
                    if (row.divergenceClass !== "tail_shrink_no_rewrite") continue;
                    stderr(
                        JSON.stringify({
                            kind: "cache_bust_sentinel_observation",
                            session_id: row.session,
                            at: row.at,
                            divergence_class: row.divergenceClass,
                            rewritten_tokens: Math.max(0, row.rewrittenTokens ?? 0),
                            first_divergence: row.firstDivergence,
                        }),
                    );
                }
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
                let wireReply: unknown;
                try {
                    wireReply = await transport.record(event);
                } catch (error) {
                    const code = errorCode(error);
                    if (code !== "peer_delivery_refused") throw error;
                    counters.sendRefused += 1;
                    stderr(
                        JSON.stringify({
                            event_id: event.vendor_event_id,
                            outcome: `send_refused:${code}`,
                            error: errorMessage(error),
                            counters,
                        }),
                    );
                    continue;
                }
                const priorDelivery = state.deliveries[event.vendor_event_id];
                const reply = parseAgentDeliverReply(
                    wireReply,
                    priorDelivery
                        ? {
                              disposition: priorDelivery.disposition,
                              committed_order: priorDelivery.committedOrder,
                          }
                        : undefined,
                );
                recordReply(counters, reply);
                if (reply.accepted) {
                    state.deliveries[event.vendor_event_id] = {
                        disposition: reply.disposition,
                        committedOrder: reply.committed_order,
                    };
                    saveSentinelState(options.stateFile, state);
                }
                if (reply.accepted && reply.contractViolation) {
                    stderr(
                        JSON.stringify({
                            kind: "agent_deliver_contract_violation",
                            delivery_id: event.vendor_event_id,
                            previous_committed_order: priorDelivery?.committedOrder,
                            reply: wireReply,
                        }),
                    );
                }
                stderr(
                    JSON.stringify({
                        event_id: event.vendor_event_id,
                        reply: wireReply,
                        outcome: reply,
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
            if (analysis.scanCursor) sessionState.scanCursor = analysis.scanCursor;
            else delete sessionState.scanCursor;
            if (!analysis.scanBounded && highWater !== null && highWater > sessionState.lastAnalyzedRequestTimestampMs) {
                sessionState.lastAnalyzedRequestTimestampMs = highWater;
            }
            updateOpenWindowState(sessionState, requests, windows);
            state.sessions[session.sessionId] = sessionState;
            saveSentinelState(options.stateFile, state);
            if (analysis.scanBounded || clock() >= deadlineMs) {
                counters.bounded = true;
                break;
            }
        }
    } finally {
        await transport?.close?.();
    }
    saveSentinelState(options.stateFile, state);
    stderr(JSON.stringify({ kind: "cache_bust_sentinel_summary", at: new Date(clock()).toISOString(), elapsedMs: clock() - nowMs, counters }));
    return counters;
}

async function main(): Promise<void> {
    setStoragePrivatePermissionEnforcement(
        loadPluginConfig(process.cwd()).storage.enforce_private_permissions,
    );
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
