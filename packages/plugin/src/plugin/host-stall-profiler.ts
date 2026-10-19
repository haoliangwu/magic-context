// Compatibility entry for OpenCode and existing profiler consumers.
export * from "../shared/host-stall-profiler";
export {
    createHostStallProfiler,
    type HostStallProfilerDeps,
    type JscProfilerApi,
} from "../shared/host-stall-profiler-bun";
