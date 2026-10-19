import { chmodSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { aggregateTraces, type JscSampleTrace } from "./host-stall-profiler-report";
import { ensureStorageDirectorySync, writeStorageFileAtomicSync } from "./storage-permissions";

export const HOST_PROFILER_DIRNAME = "host-profiler";
export const HOST_PROFILER_ENABLE_FILENAME = "enable";
export const SWITCH_POLL_MS = 5_000;
export const WATCHDOG_INTERVAL_MS = 250;
export const DEFAULT_STALL_THRESHOLD_MS = 3_000;
export const DEFAULT_SAMPLE_INTERVAL_MS = 10;
export const MAX_REPORT_FILES = 50;
export const MAX_SAMPLES_PER_WINDOW = 20_000;
export const PROFILE_WINDOW_MS = 10_000;

export interface HostStallProfilerOptions {
    thresholdMs: number;
    sampleIntervalMs: number;
}
export interface HostStallProfilerHandle {
    start(): void;
    checkNow(): Promise<void>;
    stop(): void;
    isActive(): boolean;
    isUnavailable(): boolean;
}
export interface MemorySnapshot {
    at: string;
    heap_size_bytes: number | null;
    jsc_memory: unknown;
    rss_bytes: number | null;
    percent_available_memory_in_use: number | null;
}
export interface ProfilerRuntimeDeps {
    profilerDir(): string;
    now(): number;
    wallNow(): number;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    rss(): number;
    log(message: string): void;
    pid: number;
    bunVersion: string | null;
}

/** An empty enable file uses defaults; JSON allows bounded diagnostic tuning. */
export function parseEnableFile(content: string): {
    options: HostStallProfilerOptions;
    error: string | null;
} {
    const options = {
        thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    };
    if (!content.trim()) return { options, error: null };
    try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { options, error: "enable file is not a JSON object" };
        }
        if (typeof parsed.threshold_ms === "number" && Number.isFinite(parsed.threshold_ms)) {
            options.thresholdMs = Math.min(600_000, Math.max(500, parsed.threshold_ms));
        }
        if (
            typeof parsed.sample_interval_ms === "number" &&
            Number.isFinite(parsed.sample_interval_ms)
        ) {
            options.sampleIntervalMs = Math.min(100, Math.max(1, parsed.sample_interval_ms));
        }
        return { options, error: null };
    } catch (error) {
        return {
            options,
            error: `enable file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        };
    }
}

export interface StallReportInput {
    startMs: number;
    endMs: number;
    traces: JscSampleTrace[];
    windowed: JscSampleTrace[];
    windowFilter: string;
    options: HostStallProfilerOptions;
    before: MemorySnapshot | null;
    after: MemorySnapshot;
    backend: "jsc" | "v8";
}

/** Write the same report schema and rank code owners by sampled stacks on every runtime. */
export function emitStallReport(deps: ProfilerRuntimeDeps, input: StallReportInput): void {
    const { traces, windowed, options, startMs, endMs } = input;
    const stride = windowed.length / MAX_SAMPLES_PER_WINDOW;
    const kept =
        windowed.length <= MAX_SAMPLES_PER_WINDOW
            ? windowed
            : Array.from(
                  { length: MAX_SAMPLES_PER_WINDOW },
                  (_, i) => windowed[Math.floor(i * stride)],
              );
    const aggregate = aggregateTraces(kept);
    const gapMs = endMs - startMs;
    const endWallMs = deps.wallNow();
    const report = {
        kind: "magic-context-host-stall",
        schema_version: 1,
        pid: deps.pid,
        bun_version: deps.bunVersion,
        node_version: input.backend === "v8" ? process.versions.node : undefined,
        backend: input.backend,
        platform: process.platform,
        window: {
            start: new Date(endWallMs - gapMs).toISOString(),
            end: new Date(endWallMs).toISOString(),
            duration_ms: Math.round(gapMs),
            lag_ms: Math.round(gapMs - WATCHDOG_INTERVAL_MS),
            threshold_ms: options.thresholdMs,
        },
        sampling: {
            interval_ms: options.sampleIntervalMs,
            samples_collected: traces.length,
            samples_in_window: windowed.length,
            samples_aggregated: kept.length,
            window_filter: input.windowFilter,
            note:
                aggregate.samples === 0
                    ? "No JavaScript samples in the window: the main thread was not executing inside the JavaScript VM (idle wait, process suspension, or native work outside any JS call)."
                    : undefined,
        },
        memory: { before: input.before, after: input.after },
        owners: aggregate.owners,
        top_frames: aggregate.top_frames,
        top_js_frames: aggregate.top_js_frames,
        top_stacks: aggregate.top_stacks,
    };
    const dir = deps.profilerDir();
    ensureStorageDirectorySync(dir, true);
    chmodSync(dir, 0o700);
    const stamp = new Date(endWallMs).toISOString().replaceAll(":", "-");
    let name = `stall-${stamp}.json`;
    for (let n = 1; existsSync(path.join(dir, name)); n++) name = `stall-${stamp}-${n}.json`;
    const file = path.join(dir, name);
    writeStorageFileAtomicSync(file, `${JSON.stringify(report, null, 2)}\n`, true);
    const reports = readdirSync(dir)
        .filter((entry) => /^stall-.*\.json$/.test(entry))
        .sort();
    for (const stale of reports.slice(0, Math.max(0, reports.length - MAX_REPORT_FILES))) {
        try {
            unlinkSync(path.join(dir, stale));
        } catch {
            /* Pruning must not suppress a captured report. */
        }
    }
    const top = aggregate.owners[0];
    deps.log(
        `[magic-context] host stall profiler: ${Math.round(gapMs)}ms main-thread stall, ${aggregate.samples} samples, top owner ${top ? `${top.owner} (${top.percent}%)` : "none"} → ${file}`,
    );
}
