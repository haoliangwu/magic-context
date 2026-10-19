import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { DreamerConfigSchema } from "../../config/schema/magic-context";
import * as executors from "../../features/magic-context/dreamer/task-executor";
import * as scheduler from "../../features/magic-context/dreamer/task-scheduler";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { startDreamTrigger } from "./dream-trigger";

let captured: Parameters<typeof executors.createDreamTaskExecutor>[0];
const create = spyOn(executors, "createDreamTaskExecutor").mockImplementation((args) => {
    captured = args;
    return {} as ReturnType<typeof executors.createDreamTaskExecutor>;
});
const due = spyOn(scheduler, "runDueTasksForProject").mockResolvedValue(undefined as never);
let trigger: ReturnType<typeof startDreamTrigger>;
const moduleClient = { call: async () => ({}) } as unknown as NonNullable<
    typeof captured
>["moduleClient"];
beforeAll(async () => {
    if (!openDatabase()) throw new Error("throwaway store unavailable");
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
        complete = resolve;
    });
    trigger = startDreamTrigger(
        {
            location: { directory: "/throwaway/issue709" },
            session: { get: async () => ({ location: { directory: "/throwaway/issue709" } }) },
            event: {
                subscribe: async function* () {
                    yield {
                        type: "session.execution.succeeded",
                        data: { sessionID: "ses709dream" },
                    };
                    complete();
                },
            },
        } as never,
        {
            config: DreamerConfigSchema.parse({}),
            executor: { capabilities: { tools: true } } as never,
            projectIdentity: () => "dir:issue709",
            memoryInjectionBudgetTokens: 1234,
            retinaHandoff: true,
            transformMode: "rust",
            moduleClient,
            openReader: () => ({ rootSessionActivity: () => new Map(), close() {} }),
        },
    );
    await done;
    expect(due).toHaveBeenCalledTimes(1);
});
afterAll(async () => {
    await trigger?.dispose();
    create.mockRestore();
    due.mockRestore();
    closeDatabase();
});
test("v2 dream trigger wires memoryInjectionBudgetTokens", () =>
    expect(captured.memoryInjectionBudgetTokens).toBe(1234));
test("v2 dream trigger wires retinaHandoff", () => expect(captured.retinaHandoff).toBe(true));
test("v2 dream trigger wires transformMode", () => expect(captured.transformMode).toBe("rust"));
test("v2 dream trigger wires moduleClient", () => expect(captured.moduleClient).toBe(moduleClient));
