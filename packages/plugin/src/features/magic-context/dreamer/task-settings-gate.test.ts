/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { parsePluginConfig } from "../../../config";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { buildDreamTaskRuntimeConfigs } from "./task-config";
import { CANONICAL_DREAM_TASKS, type DreamTaskName } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    runDueTasksForProject,
    runManualDream,
    type TaskExecOutcome,
} from "./task-scheduler";

/**
 * Each dreamer task runs on the setting of what it serves: the project-memory
 * tasks on memory.enabled, evaluate-smart-notes on smart_notes.enabled, and
 * review-user-memories and maintain-docs on their own schedule (with the
 * dreamer runnable, which every case here has). With memory off, the tasks that
 * do not touch project memory still run.
 */

const PROJECT = "git:task-settings-gate";
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const SCHEDULE = "0 3 * * *";

const MEMORY_TASKS: DreamTaskName[] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "promote-primers",
    "refresh-primers",
];

function expectedTasks(memory: boolean, smartNotes: boolean): DreamTaskName[] {
    return CANONICAL_DREAM_TASKS.filter((task) => {
        if (MEMORY_TASKS.includes(task)) return memory;
        if (task === "evaluate-smart-notes") return smartNotes;
        return true; // maintain-docs, review-user-memories
    });
}

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    insertMemory(d, { projectPath: PROJECT, category: "PROJECT_RULES", content: "rule" });
    // One overdue row per canonical task, so every task the settings allow is due.
    for (const task of CANONICAL_DREAM_TASKS) {
        writeTaskScheduleState(d, {
            projectPath: PROJECT,
            task,
            lastRunAt: null,
            nextDueAt: NOW - 60_000,
            schedule: SCHEDULE,
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
    }
    return d;
}

function configFor(memory: boolean, smartNotes: boolean) {
    // Dreamer on, every task scheduled (maintain-docs is off by default).
    const tasks = Object.fromEntries(
        CANONICAL_DREAM_TASKS.map((task) => [task, { schedule: SCHEDULE }]),
    );
    return parsePluginConfig({
        dreamer: { tasks },
        memory: { enabled: memory },
        smart_notes: { enabled: smartNotes },
    });
}

function recordingExecutor() {
    const ran: DreamTaskName[] = [];
    const executor = async (config: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
        ran.push(config.task);
        return { status: "completed" };
    };
    return { ran, executor };
}

/** Tasks the pass took up: each one either ran or, failing its gate, was advanced. */
function touchedTasks(d: Database): DreamTaskName[] {
    return CANONICAL_DREAM_TASKS.filter((task) => {
        const state = getTaskScheduleState(d, PROJECT, task);
        return state?.lastStatus !== null || state?.nextDueAt !== NOW - 60_000;
    });
}

describe("dreamer tasks follow the setting of what they serve", () => {
    for (const memory of [true, false])
        for (const smartNotes of [true, false]) {
            const label = `memory ${memory ? "on" : "off"}, smart notes ${smartNotes ? "on" : "off"}`;

            it(`schedules exactly the allowed tasks (${label})`, async () => {
                db = freshDb();
                const config = configFor(memory, smartNotes);
                const { ran, executor } = recordingExecutor();
                await runDueTasksForProject({
                    db,
                    projectIdentity: PROJECT,
                    // Built as production builds it: buildDreamTaskRuntimeConfigs
                    // drops evaluate-smart-notes when smart_notes.enabled is false,
                    // and the scheduler applies memory.enabled and smart_notes.enabled.
                    tasks: buildDreamTaskRuntimeConfigs(
                        config.dreamer,
                        "opencode",
                        undefined,
                        config.smart_notes.enabled,
                    ),
                    executor,
                    now: NOW,
                    projectMemoryEnabled: config.memory.enabled,
                    smartNotesEnabled: config.smart_notes.enabled,
                });
                const expected = expectedTasks(memory, smartNotes);
                expect(touchedTasks(db)).toEqual(expected);
                expect(ran.every((task) => expected.includes(task))).toBe(true);
                // A task the settings leave out keeps its row exactly as it was.
                for (const task of CANONICAL_DREAM_TASKS.filter((t) => !expected.includes(t))) {
                    expect(getTaskScheduleState(db, PROJECT, task)).toMatchObject({
                        nextDueAt: NOW - 60_000,
                        lastStatus: null,
                    });
                }
            });

            it(`the scheduler itself applies both switches to a full task list (${label})`, async () => {
                db = freshDb();
                const { executor } = recordingExecutor();
                await runDueTasksForProject({
                    db,
                    projectIdentity: PROJECT,
                    tasks: CANONICAL_DREAM_TASKS.map((task) => ({
                        task,
                        schedule: SCHEDULE,
                        timeoutMinutes: 20,
                    })),
                    executor,
                    now: NOW,
                    projectMemoryEnabled: memory,
                    smartNotesEnabled: smartNotes,
                });
                expect(touchedTasks(db)).toEqual(expectedTasks(memory, smartNotes));
            });

            it(`a forced /ctx-dream run follows the same gate (${label})`, async () => {
                db = freshDb();
                const allTasks = CANONICAL_DREAM_TASKS.map((task) => ({
                    task,
                    schedule: SCHEDULE,
                    timeoutMinutes: 20,
                }));
                const forced: DreamTaskName[] = [];
                for (const task of CANONICAL_DREAM_TASKS) {
                    const { ran, executor } = recordingExecutor();
                    await runManualDream({
                        db,
                        projectIdentity: PROJECT,
                        tasks: allTasks,
                        executor,
                        task,
                        projectMemoryEnabled: memory,
                        smartNotesEnabled: smartNotes,
                    });
                    forced.push(...ran);
                }
                expect(forced).toEqual(expectedTasks(memory, smartNotes));
            });
        }
});
