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
    PROFILE_WINDOW_MS,
    type ProfilerRuntimeDeps,
    parseEnableFile,
    SWITCH_POLL_MS,
    WATCHDOG_INTERVAL_MS,
} from "./host-stall-profiler-common";
import type { JscSampleFrame, JscSampleTrace } from "./host-stall-profiler-report";

export interface V8Profile {
    startTime: number;
    endTime: number;
    nodes: Array<{
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
        children?: number[];
    }>;
    samples?: number[];
    timeDeltas?: number[];
}

/** V8's timeDeltas are microseconds since the preceding sample, starting at startTime. */
export function v8ProfileTraces(profile: V8Profile, windowStartMs: number): JscSampleTrace[] {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parents = new Map<number, number>();
    for (const node of profile.nodes)
        for (const child of node.children ?? []) parents.set(child, node.id);
    const stacks = new Map<number, JscSampleFrame[]>();
    const stackFor = (id: number): JscSampleFrame[] => {
        const cached = stacks.get(id);
        if (cached) return cached;
        const frames: JscSampleFrame[] = [];
        const seen = new Set<number>();
        let next: number | undefined = id;
        while (next !== undefined && !seen.has(next)) {
            seen.add(next);
            const node = nodes.get(next);
            if (!node) break;
            const frame = node.callFrame;
            // Synthetic root/idle nodes are not JS stacks. Native leaves stay
            // in the stack so attribution can walk outward to the JS caller.
            if (frame.functionName !== "(root)" && frame.functionName !== "(idle)") {
                frames.push({
                    name: frame.functionName,
                    sourceURL: frame.url || undefined,
                    line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : undefined,
                    column: frame.columnNumber >= 0 ? frame.columnNumber + 1 : undefined,
                });
            }
            next = parents.get(next);
        }
        stacks.set(id, frames);
        return frames;
    };
    let elapsedMicros = 0;
    return (profile.samples ?? []).flatMap((id, index) => {
        const delta = profile.timeDeltas?.[index];
        if (typeof delta !== "number" || !Number.isFinite(delta)) return [];
        elapsedMicros += delta;
        return [{ timestamp: (windowStartMs + elapsedMicros / 1000) / 1000, frames: stackFor(id) }];
    });
}

export interface InspectorSession {
    connect(): void;
    disconnect(): void;
    post(
        method: string,
        params: Record<string, unknown>,
        callback: (error: Error | null, result?: { profile?: V8Profile }) => void,
    ): void;
}
export interface NodeProfilerDeps extends ProfilerRuntimeDeps {
    createSession(): Promise<InspectorSession>;
    memoryUsage(): { heapUsed: number; rss: number };
}

export function createNodeHostStallProfiler(deps: NodeProfilerDeps): HostStallProfilerHandle {
    let session: InspectorSession | null = null;
    let pollTimer: unknown = null;
    let watchdog: unknown = null;
    let stopped = false;
    let unavailable = false;
    let options: HostStallProfilerOptions = {
        thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    };
    let lastTickAt = 0;
    let windowStartMs = 0;
    let memoryBefore: MemorySnapshot | null = null;
    let work: Promise<void> = Promise.resolve();
    const logged = new Set<string>();
    const safeLog = (message: string) => {
        try {
            deps.log(message);
        } catch {
            /* A failed diagnostic log must not stop profiling or the host. */
        }
    };
    const fail = (key: string, error: unknown) => {
        if (logged.has(key)) return;
        logged.add(key);
        safeLog(
            `[magic-context] host stall profiler: ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
    };
    const post = (api: InspectorSession, method: string, params: Record<string, unknown> = {}) =>
        new Promise<{ profile?: V8Profile }>((resolve, reject) => {
            api.post(method, params, (error, result) =>
                error ? reject(error) : resolve(result ?? {}),
            );
        });
    const snapshot = (): MemorySnapshot => {
        const memory = deps.memoryUsage();
        return {
            at: new Date(deps.wallNow()).toISOString(),
            heap_size_bytes: memory.heapUsed,
            rss_bytes: memory.rss,
            jsc_memory: null,
            percent_available_memory_in_use: null,
        };
    };
    const disable = async (reason: string) => {
        if (watchdog !== null) deps.clearInterval(watchdog);
        watchdog = null;
        const api = session;
        session = null;
        memoryBefore = null;
        if (!api) return;
        try {
            await post(api, "Profiler.stop");
        } catch (error) {
            fail("stop failed", error);
        } finally {
            try {
                api.disconnect();
            } catch (error) {
                fail("disconnect failed", error);
            }
        }
        safeLog(`[magic-context] host stall profiler disabled: ${reason}`);
    };
    const startWindow = async (api: InspectorSession) => {
        windowStartMs = deps.now();
        await post(api, "Profiler.start");
    };
    const tick = async () => {
        const api = session;
        if (!api || watchdog === null) return;
        const now = deps.now();
        const startMs = lastTickAt;
        lastTickAt = now;
        const stall = now - startMs - WATCHDOG_INTERVAL_MS >= options.thresholdMs;
        if (!stall && now - windowStartMs < PROFILE_WINDOW_MS) return;
        try {
            const { profile } = await post(api, "Profiler.stop");
            const profileStartMs = windowStartMs;
            // Restart sampling before converting/writing the captured profile.
            // This watchdog both detects stalls and replaces expired profiles;
            // checking for a stall first prevents a late replacement from
            // discarding the window that contains the block.
            if (session !== api || stopped) return;
            await startWindow(api);
            const after = snapshot();
            if (stall && profile) {
                const traces = v8ProfileTraces(profile, profileStartMs);
                const slackMs = 2 * options.sampleIntervalMs + 20;
                const windowed = traces.filter((trace) => {
                    const at = (trace.timestamp ?? 0) * 1000;
                    return at >= startMs - slackMs && at <= now + slackMs;
                });
                try {
                    emitStallReport(deps, {
                        startMs,
                        endMs: now,
                        traces,
                        windowed,
                        windowFilter: "timestamp",
                        options,
                        before: memoryBefore,
                        after,
                        backend: "v8",
                    });
                } catch (error) {
                    fail("could not write a stall report", error);
                }
            }
            memoryBefore = after;
        } catch (error) {
            fail("watchdog tick failed", error);
            await disable("sampling failed");
        }
    };
    // Queue file checks and watchdog work so their awaited stop/start pairs run one at a time.
    const enqueue = (fn: () => Promise<void>) => {
        work = work.then(fn).catch((error) => fail("profiler operation failed", error));
        return work;
    };
    const runCheck = async () => {
        if (stopped || unavailable) return;
        const enablePath = path.join(deps.profilerDir(), HOST_PROFILER_ENABLE_FILENAME);
        if (!existsSync(enablePath)) {
            await disable("enable file removed");
            return;
        }
        const parsed = parseEnableFile(readFileSync(enablePath, "utf8"));
        if (parsed.error) fail("enable options", parsed.error);
        if (session && parsed.options.sampleIntervalMs === options.sampleIntervalMs) {
            options = parsed.options;
            return;
        }
        if (session) await disable("sample interval changed");
        options = parsed.options;
        try {
            const api = await deps.createSession();
            if (stopped || !existsSync(enablePath)) return;
            session = api;
            inRootAsyncContext(() => api.connect());
            await post(api, "Profiler.enable");
            await post(api, "Profiler.setSamplingInterval", {
                interval: Math.round(options.sampleIntervalMs * 1000),
            });
            await startWindow(api);
            if (stopped || !existsSync(enablePath)) {
                await disable("enable file removed");
                return;
            }
            lastTickAt = deps.now();
            memoryBefore = snapshot();
            watchdog = deps.setInterval(() => {
                void enqueue(tick);
            }, WATCHDOG_INTERVAL_MS);
            safeLog(
                `[magic-context] host stall profiler enabled: threshold ${options.thresholdMs}ms, sample interval ${options.sampleIntervalMs}ms, backend v8, rotation ${PROFILE_WINDOW_MS}ms, reports in ${deps.profilerDir()}`,
            );
        } catch (error) {
            fail("could not start inspector profiler", error);
            await disable("inspector unavailable");
            unavailable = true;
            if (pollTimer !== null) deps.clearInterval(pollTimer);
            pollTimer = null;
        }
    };
    return {
        start() {
            if (pollTimer !== null || unavailable) return;
            stopped = false;
            pollTimer = deps.setInterval(() => {
                void enqueue(runCheck);
            }, SWITCH_POLL_MS);
            void enqueue(runCheck);
        },
        checkNow: () => enqueue(runCheck),
        stop() {
            stopped = true;
            if (pollTimer !== null) deps.clearInterval(pollTimer);
            pollTimer = null;
            if (watchdog !== null) deps.clearInterval(watchdog);
            watchdog = null;
            void enqueue(() => disable("stopped"));
        },
        isActive: () => watchdog !== null,
        isUnavailable: () => unavailable,
    };
}

import { inRootAsyncContext } from "./sqlite";
