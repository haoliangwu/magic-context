/**
 * Host stall profiler: an off-by-default diagnostic that names the JavaScript
 * blocking OpenCode's main thread during multi-second host stalls.
 *
 * Why it exists: OpenCode runs every plugin in one Bun runtime. When that
 * runtime stops processing for seconds, native stack samples show only the
 * native side (for example a synchronous SQLite step) and never which plugin's
 * JavaScript made the call. JavaScriptCore's sampling profiler samples the
 * main thread from its own thread, so it records stacks *during* the block,
 * while a main-thread timer can only measure the lag afterwards. This module
 * pairs the two: a 250 ms watchdog measures the lag, and when a gap exceeds
 * the threshold it drains the sampler, keeps the samples inside the stall
 * window, attributes each one to the plugin whose code owns it, and writes one
 * JSON report per stall.
 *
 * Control is a file switch, not a config key: the profiler runs only while
 * `<magic-context storage>/host-profiler/enable` exists. The switch is checked
 * every 5 s, so creating or deleting the file turns the profiler on or off
 * without restarting the host. With the file absent the only work is one
 * `existsSync` per 5 s: `bun:jsc` is never imported and no watchdog runs.
 *
 * Every path fails open: a failure is logged once and never reaches a turn.
 * If `bun:jsc` cannot be loaded (not running under Bun), the profiler
 * disables itself for the rest of the process.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
    DEFAULT_SAMPLE_INTERVAL_MS,
    DEFAULT_STALL_THRESHOLD_MS,
    emitStallReport,
    HOST_PROFILER_ENABLE_FILENAME,
    type HostStallProfilerHandle,
    type HostStallProfilerOptions,
    type MemorySnapshot,
    type ProfilerRuntimeDeps,
    parseEnableFile,
    SWITCH_POLL_MS,
    WATCHDOG_INTERVAL_MS,
} from "./host-stall-profiler-common";
import type { JscSampleTrace } from "./host-stall-profiler-report";

const MEMORY_SNAPSHOT_EVERY_TICKS = 4;
const CALIBRATION_CHUNK_MS = 3;
const CALIBRATION_MAX_CHUNKS = 30;

/** The subset of `bun:jsc` the profiler uses. */
export interface JscProfilerApi {
    startSamplingProfiler(directory?: string): void;
    samplingProfilerStackTraces(): unknown;
    /**
     * Runs a callback under the sampler at the given interval (microseconds)
     * and leaves the sampler PAUSED afterwards. `bun:jsc` exposes no stop or
     * interval setter, so this is how the profiler sets its sampling interval
     * and how it stops sampling when the switch is turned off.
     */
    profile(callback: () => unknown, sampleIntervalMicros?: number): unknown;
    heapSize?(): number;
    memoryUsage?(): unknown;
    percentAvailableMemoryInUse?(): number | null;
}

export interface HostStallProfilerDeps extends ProfilerRuntimeDeps {
    loadJsc(): Promise<unknown>;
}

function asJscApi(module: unknown): JscProfilerApi | null {
    const candidate = (module as { default?: unknown } | null) ?? null;
    for (const value of [candidate, candidate?.default]) {
        const api = value as Partial<JscProfilerApi> | null | undefined;
        if (
            api &&
            typeof api.startSamplingProfiler === "function" &&
            typeof api.samplingProfilerStackTraces === "function" &&
            typeof api.profile === "function"
        ) {
            return api as JscProfilerApi;
        }
    }
    return null;
}

export function createHostStallProfiler(deps: HostStallProfilerDeps): HostStallProfilerHandle {
    let jsc: JscProfilerApi | null = null;
    let unavailable = false;
    let pollTimer: unknown = null;
    let watchdog: unknown = null;
    let options: HostStallProfilerOptions = {
        thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    };
    let lastTickAt = 0;
    let tickCount = 0;
    let memoryBefore: MemorySnapshot | null = null;
    /** JSC sample timestamp (ms) minus `deps.now()` for the same instant; null when unknown. */
    let clockOffsetMs: number | null = null;
    let checking: Promise<void> | null = null;
    const loggedOnce = new Set<string>();

    const safeLog = (message: string): void => {
        try {
            deps.log(message);
        } catch {
            // Logging must never take the profiler, or a turn, down with it.
        }
    };
    const logOnce = (key: string, message: string, error?: unknown): void => {
        if (loggedOnce.has(key)) return;
        loggedOnce.add(key);
        const detail =
            error === undefined
                ? ""
                : `: ${error instanceof Error ? error.message : String(error)}`;
        safeLog(`[magic-context] host stall profiler: ${message}${detail}`);
    };

    const drain = (api: JscProfilerApi): JscSampleTrace[] => {
        const raw = api.samplingProfilerStackTraces() as { traces?: unknown } | null;
        return Array.isArray(raw?.traces) ? (raw.traces as JscSampleTrace[]) : [];
    };

    /** Pause the sampler (see `JscProfilerApi.profile`), discarding what it held. */
    const pauseSampler = (api: JscProfilerApi, intervalMs: number): void => {
        // Drain first so `profile` has little to process. Before the sampler
        // has ever run, `samplingProfilerStackTraces` throws ("never
        // started"); `profile` itself creates the sampler, so that is benign.
        try {
            drain(api);
        } catch {
            // Nothing buffered yet.
        }
        api.profile(() => undefined, Math.round(intervalMs * 1000));
        drain(api);
    };

    /**
     * Relate JSC's sample clock to `deps.now()`. Sample timestamps come from
     * JavaScriptCore's monotonic clock, whose origin differs from
     * `performance.now()`. Short busy-waits at a 1 ms interval bracket a
     * handful of samples between two known `now()` readings; the midpoint of
     * the feasible offsets is accurate to a few milliseconds, far below any
     * stall threshold. A restarted sampler thread can take one old interval
     * to wake, so the busy-wait repeats in short chunks until a chunk yields
     * samples, bounded by `CALIBRATION_MAX_CHUNKS`.
     */
    const calibrate = (api: JscProfilerApi): number | null => {
        pauseSampler(api, 1);
        api.startSamplingProfiler();
        let offset: number | null = null;
        for (let chunk = 0; chunk < CALIBRATION_MAX_CHUNKS && offset === null; chunk++) {
            const start = deps.now();
            let end = start;
            for (let i = 0; i < 50_000_000 && end - start < CALIBRATION_CHUNK_MS; i++) {
                end = deps.now();
            }
            const stamps = drain(api)
                .map((trace) => trace.timestamp)
                .filter(
                    (value): value is number => typeof value === "number" && Number.isFinite(value),
                )
                .map((seconds) => seconds * 1000);
            if (stamps.length >= 2) {
                offset = (Math.max(...stamps) - end + (Math.min(...stamps) - start)) / 2;
            }
        }
        pauseSampler(api, 1);
        return offset;
    };

    const snapshot = (api: JscProfilerApi): MemorySnapshot => {
        const read = <T>(fn: () => T): T | null => {
            try {
                return fn();
            } catch {
                return null;
            }
        };
        return {
            at: new Date(deps.wallNow()).toISOString(),
            heap_size_bytes: read(() => api.heapSize?.() ?? null),
            jsc_memory: read(() => api.memoryUsage?.() ?? null),
            rss_bytes: read(() => deps.rss()),
            percent_available_memory_in_use: read(
                () => api.percentAvailableMemoryInUse?.() ?? null,
            ),
        };
    };

    const recordStall = (
        api: JscProfilerApi,
        startMs: number,
        endMs: number,
        traces: JscSampleTrace[],
    ): void => {
        const after = snapshot(api);
        let windowed = traces;
        let windowFilter = "since-last-collection";
        if (clockOffsetMs !== null) {
            const slackMs = 2 * options.sampleIntervalMs + 20;
            const lo = startMs + clockOffsetMs - slackMs;
            const hi = endMs + clockOffsetMs + slackMs;
            const inWindow = traces.filter((trace) => {
                const at =
                    typeof trace.timestamp === "number" ? trace.timestamp * 1000 : Number.NaN;
                return at >= lo && at <= hi;
            });
            if (inWindow.length > 0 || traces.length === 0) {
                windowed = inWindow;
                windowFilter = "timestamp";
            } else {
                // A calibration that no longer matches (for example after the
                // machine slept) must not silently empty the report.
                windowFilter = "since-last-collection (timestamp filter matched no sample)";
            }
        }
        emitStallReport(deps, {
            startMs,
            endMs,
            traces,
            windowed,
            windowFilter,
            options,
            before: memoryBefore,
            after,
            backend: "jsc",
        });
        memoryBefore = after;
    };

    const tick = (): void => {
        const api = jsc;
        if (!api || watchdog === null) return;
        try {
            const now = deps.now();
            const startMs = lastTickAt;
            lastTickAt = now;
            const traces = drain(api);
            if (now - startMs - WATCHDOG_INTERVAL_MS >= options.thresholdMs) {
                try {
                    recordStall(api, startMs, now, traces);
                } catch (error) {
                    logOnce("report", "could not write a stall report", error);
                }
            }
            tickCount += 1;
            if (tickCount % MEMORY_SNAPSHOT_EVERY_TICKS === 0) memoryBefore = snapshot(api);
        } catch (error) {
            logOnce("tick", "watchdog tick failed", error);
        }
    };

    const enable = (api: JscProfilerApi, next: HostStallProfilerOptions): void => {
        const startedAt = deps.now();
        try {
            options = next;
            clockOffsetMs = calibrate(api);
            pauseSampler(api, options.sampleIntervalMs);
            api.startSamplingProfiler();
            lastTickAt = deps.now();
            tickCount = 0;
            memoryBefore = snapshot(api);
            watchdog = deps.setInterval(tick, WATCHDOG_INTERVAL_MS);
            safeLog(
                `[magic-context] host stall profiler enabled: threshold ${options.thresholdMs}ms, sample interval ${options.sampleIntervalMs}ms, clock calibration ${clockOffsetMs === null ? "unavailable" : "ok"}, setup ${Math.round(deps.now() - startedAt)}ms, reports in ${deps.profilerDir()}`,
            );
        } catch (error) {
            watchdog = null;
            try {
                pauseSampler(api, options.sampleIntervalMs);
            } catch {
                // Already failing open; the enable error below is the one worth logging.
            }
            logOnce("enable", "could not start", error);
        }
    };

    const disable = (reason: string): void => {
        if (watchdog !== null) deps.clearInterval(watchdog);
        watchdog = null;
        memoryBefore = null;
        if (jsc) {
            try {
                pauseSampler(jsc, options.sampleIntervalMs);
            } catch (error) {
                logOnce("disable", "could not pause the sampler", error);
            }
        }
        safeLog(`[magic-context] host stall profiler disabled: ${reason}`);
    };

    const ensureJsc = async (): Promise<JscProfilerApi | null> => {
        if (jsc) return jsc;
        try {
            const api = asJscApi(await deps.loadJsc());
            if (!api) throw new Error("bun:jsc lacks the sampling profiler API");
            jsc = api;
            return api;
        } catch (error) {
            unavailable = true;
            if (pollTimer !== null) deps.clearInterval(pollTimer);
            pollTimer = null;
            logOnce("jsc", "bun:jsc is unavailable, profiler disabled for this process", error);
            return null;
        }
    };

    const runCheck = async (): Promise<void> => {
        if (unavailable) return;
        try {
            const enablePath = path.join(deps.profilerDir(), HOST_PROFILER_ENABLE_FILENAME);
            if (!existsSync(enablePath)) {
                if (watchdog !== null) disable("enable file removed");
                return;
            }
            const parsed = parseEnableFile(readFileSync(enablePath, "utf8"));
            if (parsed.error) logOnce(`options:${parsed.error}`, parsed.error);
            if (watchdog !== null) {
                if (jsc && parsed.options.sampleIntervalMs !== options.sampleIntervalMs) {
                    pauseSampler(jsc, parsed.options.sampleIntervalMs);
                    jsc.startSamplingProfiler();
                }
                options = parsed.options;
                return;
            }
            const api = await ensureJsc();
            if (!api || watchdog !== null || !existsSync(enablePath)) return;
            enable(api, parsed.options);
        } catch (error) {
            logOnce("check", "enable-file check failed", error);
        }
    };

    const checkNow = (): Promise<void> => {
        if (!checking) {
            checking = runCheck().finally(() => {
                checking = null;
            });
        }
        return checking;
    };

    return {
        start() {
            if (pollTimer !== null || unavailable) return;
            pollTimer = deps.setInterval(() => void checkNow(), SWITCH_POLL_MS);
            void checkNow();
        },
        checkNow,
        stop() {
            if (pollTimer !== null) deps.clearInterval(pollTimer);
            pollTimer = null;
            if (watchdog !== null) disable("stopped");
        },
        isActive: () => watchdog !== null,
        isUnavailable: () => unavailable,
    };
}
