/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { nextDueAtMs } from "./cron";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { type DreamTaskRuntimeConfig, planDueTasks } from "./task-scheduler";

function config(schedule: string): DreamTaskRuntimeConfig {
    return { task: "verify", schedule, timeoutMinutes: 20 };
}

test("conflicting worktree schedules cannot continually postpone a shared slot", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);

    const projectIdentity = "git:shared-by-two-live-worktrees";
    const worktreeA = config("0 * * * *");
    const worktreeB = config("30 * * * *");
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const due: Array<{ minute: number; worktree: "A" | "B" }> = [];
    // verify only gets a schedule row for a project with active memories, so
    // every project in this test gets one.
    for (const project of [projectIdentity, "git:control-a", "git:control-b"]) {
        insertMemory(db, { projectPath: project, category: "PROJECT_RULES", content: project });
    }

    try {
        // Distinct project identities retain the existing single-owner behavior.
        expect(planDueTasks(db, "git:control-a", [worktreeA], start)).toHaveLength(0);
        expect(planDueTasks(db, "git:control-a", [worktreeA], start + 60 * 60_000)).toHaveLength(1);
        expect(planDueTasks(db, "git:control-b", [worktreeB], start)).toHaveLength(0);
        expect(planDueTasks(db, "git:control-b", [worktreeB], start + 30 * 60_000)).toHaveLength(1);

        // dream-timer reconciles every live worktree against this shared row.
        for (let minute = 0; minute <= 180; minute += 15) {
            const now = start + minute * 60_000;
            for (const [worktree, task] of [
                ["A", worktreeA],
                ["B", worktreeB],
            ] as const) {
                const planned = planDueTasks(db, projectIdentity, [task], now);
                if (planned.length === 0) continue;
                due.push({ minute, worktree });
                const state = getTaskScheduleState(db, projectIdentity, task.task);
                if (!state) throw new Error("missing schedule row");
                // Model the durable advancement performed after a completed run.
                writeTaskScheduleState(db, {
                    ...state,
                    lastRunAt: now,
                    nextDueAt: nextDueAtMs(task.schedule, now, planned[0].scheduledAt),
                    lastStatus: "completed",
                });
            }
        }

        expect(due.map(({ minute }) => minute)).toEqual([30, 60, 90, 120, 150, 180]);
    } finally {
        db.close();
    }
});
