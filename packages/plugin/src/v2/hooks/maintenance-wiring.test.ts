import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import type { HiddenCompletionExecutor } from "../../hooks/magic-context/compartment-runner-types";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import * as timer from "../../plugin/dream-timer";
import { registerV2DreamScheduleTimer } from "./dream-timer";

let registration: Parameters<typeof timer.startDreamScheduleTimer>[0];
let stop: ReturnType<typeof registerV2DreamScheduleTimer>;
const boot = MagicContextConfigSchema.parse({ transform_mode: "rust", dreamer: { disable: true } });
let live = MagicContextConfigSchema.parse({
    ...boot,
    memory: {
        ...boot.memory,
        git_commit_indexing: { enabled: true, since_days: 19, max_commits: 171 },
    },
});
const moduleClient = {
    call() {
        return Promise.resolve(this === moduleClient ? "routed" : "lost receiver");
    },
};
const spy = spyOn(timer, "startDreamScheduleTimer").mockImplementation(async (args) => {
    registration = args;
    return () => {};
});
beforeAll(() => {
    stop = registerV2DreamScheduleTimer({
        directory: "/throwaway/issue709",
        projectIdentity: "dir:issue709",
        config: boot,
        dreamer: boot.dreamer,
        liveConfig: () => live,
        executor: { capabilities: { tools: true } } as HiddenCompletionExecutor,
        openReader: () => ({ latestRootSessionInDirectory: () => undefined, close() {} }),
        rustModeModuleClient: moduleClient as unknown as TransformDeps["rustModeModuleClient"],
    });
});
afterAll(async () => {
    await stop.dispose();
    spy.mockRestore();
});

test("v2 timer samples live git indexing independently", () => {
    expect(registration.sampleDreamRun?.().gitCommitIndexing).toEqual({
        enabled: true,
        since_days: 19,
        max_commits: 171,
    });
    live = MagicContextConfigSchema.parse({
        ...live,
        memory: { ...live.memory, git_commit_indexing: { enabled: false } },
    });
    expect(registration.sampleDreamRun?.().gitCommitIndexing?.enabled).toBe(false);
    expect(registration.sampleDreamRun?.().dreamerConfig?.disable).toBe(true);
});
test("v2 timer wires transformMode", () => expect(registration.transformMode).toBe("rust"));
test("v2 timer wires moduleClient", async () => {
    expect(await registration.moduleClient?.call({} as never)).toBe("routed");
});
