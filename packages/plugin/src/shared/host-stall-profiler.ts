import * as path from "node:path";
import { getMagicContextStorageDir } from "./data-path";
import { createHostStallProfiler } from "./host-stall-profiler-bun";
import {
    HOST_PROFILER_DIRNAME,
    type HostStallProfilerHandle,
    type ProfilerRuntimeDeps,
} from "./host-stall-profiler-common";
import { createNodeHostStallProfiler, type InspectorSession } from "./host-stall-profiler-node";
import { log } from "./logger";

export * from "./host-stall-profiler-common";

export function hostStallProfilerDir(): string {
    return path.join(getMagicContextStorageDir(), HOST_PROFILER_DIRNAME);
}

const PROCESS_PROFILER_KEY = Symbol.for("cortexkit.magic-context.host-stall-profiler");
// Resolve at runtime: Node-only consumers do not install Bun's type declarations.
const jscModule: string = "bun:jsc";

/** All plugin/project instances watch the same main thread and share one sampler. */
export function startHostStallProfilerSwitch(): void {
    try {
        const holder = globalThis as unknown as Record<symbol, HostStallProfilerHandle | undefined>;
        if (holder[PROCESS_PROFILER_KEY]) return;
        const deps: ProfilerRuntimeDeps = {
            profilerDir: hostStallProfilerDir,
            now: () => performance.now(),
            wallNow: () => Date.now(),
            setInterval: (callback, ms) => {
                const handle = inRootAsyncContext(() => setInterval(callback, ms));
                (handle as { unref?: () => void }).unref?.();
                return handle;
            },
            clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
            rss: () => process.memoryUsage.rss(),
            log,
            pid: process.pid,
            bunVersion: process.versions.bun ?? null,
        };
        const handle = process.versions.bun
            ? createHostStallProfiler({ ...deps, loadJsc: () => import(jscModule) })
            : createNodeHostStallProfiler({
                  ...deps,
                  createSession: async () => {
                      const { Session } = await import("node:inspector");
                      return new Session() as unknown as InspectorSession;
                  },
                  memoryUsage: () => process.memoryUsage(),
              });
        holder[PROCESS_PROFILER_KEY] = handle;
        handle.start();
    } catch (error) {
        log("[magic-context] host stall profiler: could not start the enable-file switch", error);
    }
}

import { inRootAsyncContext } from "./sqlite";
