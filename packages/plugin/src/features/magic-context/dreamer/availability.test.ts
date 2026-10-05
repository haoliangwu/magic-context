import { expect, test } from "bun:test";
import { HiddenCompletionRefusal } from "../../../hooks/magic-context/compartment-runner-types";
import { executeStatus } from "../../../hooks/magic-context/execute-status";
import {
    getPromptFailureDetail,
    promptSyncWithValidatedOutputRetry,
} from "../../../shared/model-suggestion-retry";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { summarizeManualDream } from "./manual-summary";
import { getDreamRuns } from "./storage-dream-runs";
import { getSkippedDreamTasks, getTaskScheduleState } from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { runManualDream } from "./task-scheduler";

test.each([
    ["compress-cues", "mural is not enabled", false],
    ["retrospective", "no raw-history provider is available", false],
    ["classify-memories", "Pi model chain is empty", true],
] as const)("%s unavailable runs are skipped, not successful", async (task, reason, modelChainUnavailable) => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        const summary = await runManualDream({
            db,
            projectIdentity: "/fixture",
            task,
            tasks: [{ task, schedule: "", timeoutMinutes: 1, modelChainUnavailable }],
            executor: createDreamTaskExecutor({
                parentSessionId: "root",
                sessionDirectory: "/fixture",
                openOpenCodeDb: () => null,
            }),
        });
        expect(summary.ran).toEqual([]);
        expect(summary.failed).toEqual([]);
        expect(summarizeManualDream(summary)).toContain(`Skipped: ${task}: ${reason}`);
        const state = getTaskScheduleState(db, "/fixture", task);
        expect(state?.lastStatus).toBe("skipped");
        expect(state?.lastError).toContain(reason);
        expect(state?.lastRunAt).toBeNull();
        expect(state?.retrospectiveWatermarkMs).toBeNull();
        const run = getDreamRuns(db, "/fixture")[0]!;
        expect(run.tasks_succeeded).toBe(0);
        expect(run.tasks_failed).toBe(0);
        expect(JSON.parse(run.tasks_json)[0]).toMatchObject({
            status: "skipped",
            skipReason: expect.stringContaining(reason),
        });
        expect(
            executeStatus(
                db,
                "root",
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { skipped: getSkippedDreamTasks(db, "/fixture") },
            ),
        ).toContain(`Skipped: ${task}: ${reason}`);
    } finally {
        db.close();
    }
});

test("prompt retry classifies local refusals and does not try another model", async () => {
    const refusal = new HiddenCompletionRefusal(
        "hidden_prompt_unrecognized",
        "registered marker was not recognized",
        true,
    );
    let attempts = 0;
    let caught: unknown;
    try {
        await promptSyncWithValidatedOutputRetry(
            undefined,
            { path: { id: "child" }, body: { model: { providerID: "mock", modelID: "first" } } },
            {
                transport: async () => {
                    attempts++;
                    throw refusal;
                },
                fallbackModels: ["mock/second"],
                fetchOutput: async () => "never",
                validateOutput: (value) => value,
            },
        );
    } catch (error) {
        caught = error;
    }
    expect(caught).toBe(refusal);
    expect(attempts).toBe(1);
    expect(getPromptFailureDetail(caught)).toMatchObject({
        failureClass: "local_refusal",
        providerError: null,
        refusalReason: expect.stringContaining("hidden_prompt_unrecognized"),
    });
});

test("direct hidden refusal has local failure detail and no connection advice", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        const summary = await runManualDream({
            db,
            projectIdentity: "/fixture",
            task: "curate",
            tasks: [{ task: "curate", schedule: "", timeoutMinutes: 1 }],
            executor: createDreamTaskExecutor({
                parentSessionId: "root",
                sessionDirectory: "/fixture",
                openOpenCodeDb: () => null,
                hiddenCompletionExecutor: { capabilities: { tools: false } } as never,
            }),
        });
        const failure = JSON.parse(getDreamRuns(db, "/fixture")[0]!.tasks_json)[0].failure;
        expect(failure.failure_class).toBe("local_refusal");
        expect(failure.refusal_reason).toContain("hidden_tools_unsupported");
        const text = summarizeManualDream(summary);
        expect(text).toContain("refused before reaching the model");
        expect(text).toContain("hidden_tools_unsupported");
        expect(text).toContain("MC-D12");
        expect(text).not.toContain("Check the model connection");
        expect(failure.provider_error).toBeNull();
    } finally {
        db.close();
    }
});
