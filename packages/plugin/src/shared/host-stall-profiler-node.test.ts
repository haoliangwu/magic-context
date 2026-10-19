import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
    PROFILE_WINDOW_MS,
    SWITCH_POLL_MS,
    WATCHDOG_INTERVAL_MS,
} from "./host-stall-profiler-common";
import {
    createNodeHostStallProfiler,
    type InspectorSession,
    type V8Profile,
    v8ProfileTraces,
} from "./host-stall-profiler-node";
import { aggregateTraces, sourceOwner } from "./host-stall-profiler-report";
import { createTestTempDir } from "./test-temp-dir";

const profile: V8Profile = {
    startTime: 500_000,
    endTime: 530_000,
    nodes: [
        {
            id: 1,
            callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 },
            children: [2],
        },
        {
            id: 2,
            callFrame: {
                functionName: "sqliteCaller",
                url: "/home/test/.pi/agent/npm/node_modules/stall-package/index.js",
                lineNumber: 9,
                columnNumber: 0,
            },
            children: [3],
        },
        { id: 3, callFrame: { functionName: "get", url: "", lineNumber: -1, columnNumber: -1 } },
    ],
    samples: [2, 3, 3],
    timeDeltas: [10_000, 10_000, 10_000],
};

test("V8 profile conversion reconstructs native callers and cumulative sample times", () => {
    const traces = v8ProfileTraces(profile, 1000);
    expect(traces.map((trace) => trace.timestamp)).toEqual([1.01, 1.02, 1.03]);
    const aggregate = aggregateTraces(traces);
    expect(aggregate.owners).toEqual([{ owner: "npm:stall-package", samples: 3, percent: 100 }]);
    expect(aggregate.top_frames[0].frame).toBe("get [native]");
    expect(aggregate.top_js_frames[0].frame).toContain("sqliteCaller");
    expect(aggregate.top_js_frames[0].frame).toContain(":10");
});

test("Pi and OMP paths distinguish extensions, npm packages and host core", () => {
    expect(sourceOwner("file:///home/test/.pi/agent/extensions/busy.ts")).toBe("extension:busy.ts");
    expect(sourceOwner("/home/test/.omp/agent/extensions/busy/index.ts")).toBe("extension:busy");
    expect(sourceOwner("/home/test/.pi/agent/npm/node_modules/@scope/plugin/index.js")).toBe(
        "npm:@scope/plugin",
    );
    expect(sourceOwner("/tmp/node_modules/@earendil-works/pi-coding-agent/dist/main.js")).toBe(
        "pi",
    );
    expect(sourceOwner("/tmp/node_modules/@oh-my-pi/pi-coding-agent/dist/main.js")).toBe("omp");
    expect(sourceOwner("/tmp/node_modules/@cortexkit/pi-magic-context/dist/index.js")).toBe(
        "pkg:@cortexkit/pi-magic-context",
    );
    const root = createTestTempDir("mc-profiler-owner-").dir;
    mkdirSync(path.join(root, ".pi/agent/extensions/local"), { recursive: true });
    writeFileSync(
        path.join(root, ".pi/agent/extensions/local/package.json"),
        '{"name":"test-extension"}',
    );
    expect(sourceOwner(path.join(root, ".pi/agent/extensions/local/index.js"))).toBe(
        "pkg:test-extension",
    );
    expect(sourceOwner(path.join(import.meta.dir, "../../../pi-plugin/src/index.ts"))).toBe(
        "pkg:@cortexkit/pi-magic-context",
    );
});

const handles: Array<ReturnType<typeof createNodeHostStallProfiler>> = [];
afterEach(async () => {
    for (const handle of handles.splice(0)) {
        handle.stop();
        await handle.checkNow();
    }
});

function setup(loadGate?: Promise<void>) {
    const root = createTestTempDir("mc-node-profiler-").dir;
    let now = 0;
    let startedAt = 0;
    let stackId = 2;
    const calls: string[] = [];
    const timers = new Map<number, () => void>();
    const api: InspectorSession = {
        connect() {
            calls.push("connect");
        },
        disconnect() {
            calls.push("disconnect");
        },
        post(method, _params, callback) {
            calls.push(method);
            if (method === "Profiler.start") startedAt = now;
            const samples = Array.from(
                { length: Math.floor((now - startedAt) / 10) },
                () => stackId,
            );
            callback(
                null,
                method === "Profiler.stop"
                    ? { profile: { ...profile, samples, timeDeltas: samples.map(() => 10_000) } }
                    : {},
            );
        },
    };
    const handle = createNodeHostStallProfiler({
        profilerDir: () => root,
        now: () => now,
        wallNow: () => Date.UTC(2026, 9, 10) + now,
        setInterval: (fn, ms) => {
            timers.set(ms, fn);
            return ms;
        },
        clearInterval: (id) => {
            timers.delete(id as number);
        },
        rss: () => 123,
        memoryUsage: () => ({ heapUsed: 42, rss: 123 }),
        log: () => {},
        pid: 10,
        bunVersion: null,
        createSession: async () => {
            calls.push("createSession");
            await loadGate;
            return api;
        },
    });
    handles.push(handle);
    const reports = () => readdirSync(root).filter((entry) => entry.startsWith("stall-"));
    const advance = async (ms: number) => {
        now += ms;
        timers.get(WATCHDOG_INTERVAL_MS)?.();
        await handle.checkNow();
    };
    return {
        root,
        handle,
        calls,
        timers,
        reports,
        advance,
        enable: () => writeFileSync(path.join(root, "enable"), ""),
        native: () => {
            stackId = 3;
        },
    };
}

test("Node switch absent creates no inspector; on/off/on disconnects without restart", async () => {
    const host = setup();
    host.handle.start();
    await host.handle.checkNow();
    expect(host.calls).toEqual([]);
    expect([...host.timers.keys()]).toEqual([SWITCH_POLL_MS]);
    host.enable();
    await host.handle.checkNow();
    expect(host.calls).toEqual([
        "createSession",
        "connect",
        "Profiler.enable",
        "Profiler.setSamplingInterval",
        "Profiler.start",
    ]);
    expect(host.handle.isActive()).toBe(true);
    rmSync(path.join(host.root, "enable"));
    await host.handle.checkNow();
    expect(host.calls.slice(-2)).toEqual(["Profiler.stop", "disconnect"]);
    expect(host.handle.isActive()).toBe(false);
    expect([...host.timers.keys()]).toEqual([SWITCH_POLL_MS]);
    host.enable();
    await host.handle.checkNow();
    expect(host.calls.filter((call) => call === "connect")).toHaveLength(2);
});

test("Node rotation discards ordinary windows and retains only samples inside the detected stall", async () => {
    const host = setup();
    host.enable();
    host.handle.start();
    await host.handle.checkNow();
    for (let i = 0; i < PROFILE_WINDOW_MS / WATCHDOG_INTERVAL_MS; i++)
        await host.advance(WATCHDOG_INTERVAL_MS);
    expect(host.reports()).toEqual([]);
    expect(host.calls.filter((call) => call === "Profiler.stop")).toHaveLength(1);
    for (let i = 0; i < 35; i++) await host.advance(WATCHDOG_INTERVAL_MS);
    host.native();
    await host.advance(6250);
    expect(host.reports()).toHaveLength(1);
    const report = JSON.parse(readFileSync(path.join(host.root, host.reports()[0]), "utf8"));
    expect(report.backend).toBe("v8");
    expect(report.sampling.samples_collected).toBe(1500);
    expect(report.sampling.samples_in_window).toBeLessThan(640);
    expect(report.sampling.samples_in_window).toBeGreaterThan(620);
    expect(report.owners[0].owner).toBe("npm:stall-package");
    expect(report.top_js_frames[0].frame).toContain("sqliteCaller");
    expect(report.memory.before.heap_size_bytes).toBe(42);
    expect(report.memory.after.rss_bytes).toBe(123);
});

test("Node watchdog applies threshold to lateness rather than the whole tick gap", async () => {
    const host = setup();
    host.enable();
    host.handle.start();
    await host.handle.checkNow();
    await host.advance(3249);
    expect(host.reports()).toEqual([]);
    await host.advance(3250);
    expect(host.reports()).toHaveLength(1);
});

test("Node stop during inspector loading cannot resurrect a watchdog", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const host = setup(promise);
    host.enable();
    host.handle.start();
    await Promise.resolve();
    expect(host.calls).toEqual(["createSession"]);
    host.handle.stop();
    resolve();
    await host.handle.checkNow();
    expect(host.handle.isActive()).toBe(false);
    expect(host.timers.size).toBe(0);
    expect(host.calls).toEqual(["createSession"]);
});
