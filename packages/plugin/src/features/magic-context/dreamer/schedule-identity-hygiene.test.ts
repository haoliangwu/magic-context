/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { advanceSessionActivity } from "../session-activity";
import { initializeDatabase } from "../storage-db";
import {
    IDLE_SCHEDULE_PRUNE_AT_KEY,
    IDLE_SCHEDULE_PRUNE_INTERVAL_MS,
    pruneIdleScheduleIdentities,
} from "./idle-schedule-prune";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { CANONICAL_DREAM_TASKS, type DreamTaskName } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    planDueTasks,
    runDueTasksForProject,
    type TaskExecOutcome,
} from "./task-scheduler";

/**
 * Schedule rows used to be created for every canonical task of every directory
 * that ever hosted a session, and were never removed. These tests pin the rules
 * that replaced that: rows exist only for tasks that have input, idle identities
 * are pruned, and an identity with project memory disabled is never scheduled.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12, 0);

const MEMORY_TASKS: DreamTaskName[] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
];

const ALL_TASKS: DreamTaskRuntimeConfig[] = CANONICAL_DREAM_TASKS.map((task) => ({
    task,
    schedule: "0 3 * * *",
    timeoutMinutes: 20,
}));

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    return d;
}

function addMemory(d: Database, project: string): void {
    insertMemory(d, {
        projectPath: project,
        category: "PROJECT_RULES",
        content: `rule ${project}`,
    });
}

/** Bind a session to a project at `boundAt`, optionally with later recorded activity. */
function addSession(
    d: Database,
    project: string,
    sessionId: string,
    boundAt: number,
    activityAt?: number,
): void {
    d.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, ?)",
    ).run(sessionId, project, boundAt);
    if (activityAt !== undefined) advanceSessionActivity(d, sessionId, activityAt);
}

function addCompartment(d: Database, sessionId: string, createdAt: number): void {
    const sequence =
        d
            .prepare<[string], { n: number }>(
                "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
            )
            .get(sessionId)?.n ?? 0;
    d.prepare(
        "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at) VALUES (?, ?, 0, 1, 't', 'c', ?)",
    ).run(sessionId, sequence, createdAt);
}

/**
 * One overdue row per canonical task, the shape stores still hold for
 * identities that were seeded before rows depended on task input.
 */
function writeLegacyRows(d: Database, project: string, nextDueAt: number): void {
    for (const task of CANONICAL_DREAM_TASKS) {
        writeTaskScheduleState(d, {
            projectPath: project,
            task,
            lastRunAt: null,
            nextDueAt,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
    }
}

function scheduledTasks(d: Database, project: string): string[] {
    return d
        .prepare<[string], { task: string }>(
            "SELECT task FROM task_schedule_state WHERE project_path = ? ORDER BY task",
        )
        .all(project)
        .map((row) => row.task);
}

/** Let the next scheduler pass run the once-a-day idle prune. */
function makePruneDue(d: Database): void {
    setDreamState(d, IDLE_SCHEDULE_PRUNE_AT_KEY, String(NOW - IDLE_SCHEDULE_PRUNE_INTERVAL_MS - 1));
}

/** Mark the idle prune as just run, so a pass exercises only seeding. */
function makePruneFresh(d: Database): void {
    setDreamState(d, IDLE_SCHEDULE_PRUNE_AT_KEY, String(NOW));
}

describe("schedule rows are seeded only for tasks with input", () => {
    it("a chat-session dir: identity with no memories and only an old session gets no rows", () => {
        db = freshDb();
        const chat = "dir:chat-session";
        addSession(db, chat, "ses-chat", NOW - 40 * DAY_MS, NOW - 40 * DAY_MS);

        expect(planDueTasks(db, chat, ALL_TASKS, NOW)).toEqual([]);
        expect(scheduledTasks(db, chat)).toEqual([]);
    });

    it("a real git: project with memories gets every memory task, nothing session-driven", () => {
        db = freshDb();
        const project = "git:real-project";
        addMemory(db, project);

        planDueTasks(db, project, ALL_TASKS, NOW);
        expect(scheduledTasks(db, project)).toEqual([...MEMORY_TASKS].sort());
    });

    for (const shape of [
        {
            name: "bound yesterday, no live activity recorded (OpenCode 2)",
            boundAt: NOW - DAY_MS,
            activityAt: undefined,
        },
        {
            name: "bound long ago, active yesterday (OpenCode 1 and Pi)",
            boundAt: NOW - 90 * DAY_MS,
            activityAt: NOW - DAY_MS,
        },
    ]) {
        it(`a git: identity with zero memories and a session yesterday gets retrospective only: ${shape.name}`, () => {
            db = freshDb();
            const project = "git:no-memories-yet";
            addSession(db, project, "ses-yesterday", shape.boundAt, shape.activityAt);

            planDueTasks(db, project, ALL_TASKS, NOW);
            expect(scheduledTasks(db, project)).toEqual(["retrospective"]);

            // The recent session also keeps it through the daily idle prune.
            makePruneDue(db);
            planDueTasks(db, project, ALL_TASKS, NOW + 60_000);
            expect(getDreamState(db, IDLE_SCHEDULE_PRUNE_AT_KEY)).toBe(String(NOW + 60_000));
            expect(scheduledTasks(db, project)).toEqual(["retrospective"]);
        });
    }

    it("seeds maintain-docs only when a recent session produced a recent compartment", () => {
        db = freshDb();
        const project = "git:docs-input";
        addSession(db, project, "ses-old", NOW - 90 * DAY_MS);
        addCompartment(db, "ses-old", NOW - 60 * DAY_MS);
        addSession(db, project, "ses-new", NOW - DAY_MS);
        planDueTasks(db, project, ALL_TASKS, NOW);
        expect(scheduledTasks(db, project)).toEqual(["retrospective"]);

        addCompartment(db, "ses-new", NOW - 60_000);
        planDueTasks(db, project, ALL_TASKS, NOW + 60_000);
        expect(scheduledTasks(db, project)).toEqual(["maintain-docs", "retrospective"]);
    });

    it("seeds the global user-memory review only for an identity with input of its own", () => {
        db = freshDb();
        const chat = "dir:chat-session";
        const project = "git:real-project";
        addMemory(db, project);
        db.prepare(
            "INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES ('likes tabs', 'ses-x', ?)",
        ).run(NOW);

        planDueTasks(db, chat, ALL_TASKS, NOW);
        planDueTasks(db, project, ALL_TASKS, NOW);
        expect(scheduledTasks(db, chat)).toEqual([]);
        expect(scheduledTasks(db, project)).toContain("review-user-memories");
    });

    it("seeds a memory task on the first pass after the first memory appears", () => {
        db = freshDb();
        const project = "git:grows-a-memory";
        planDueTasks(db, project, ALL_TASKS, NOW);
        expect(scheduledTasks(db, project)).toEqual([]);

        addMemory(db, project);
        planDueTasks(db, project, ALL_TASKS, NOW + 60_000);
        expect(scheduledTasks(db, project)).toEqual([...MEMORY_TASKS].sort());
    });

    it("a pass for an identity without rows or input writes nothing", () => {
        db = freshDb();
        const chat = "dir:chat-session";
        const dead = "dir:dead-chat";
        writeLegacyRows(db, dead, NOW - 30 * DAY_MS);
        makePruneFresh(db);
        const changes = () =>
            db?.prepare<[], { n: number }>("SELECT total_changes() AS n").get()?.n ?? -1;

        const before = changes();
        planDueTasks(db, chat, ALL_TASKS, NOW);
        expect(changes()).toBe(before);
        // Other identities' rows are not visited by this identity's pass.
        expect(scheduledTasks(db, dead)).toHaveLength(CANONICAL_DREAM_TASKS.length);
    });
});

describe("idle identities are pruned", () => {
    it("removes a memory-less identity with no recent session and keeps the others", () => {
        db = freshDb();
        const deadChat = "dir:old-chat";
        const withMemories = "git:with-memories";
        const recentSession = "git:recent-session";
        const live = "git:live";
        for (const project of [deadChat, withMemories, recentSession]) {
            writeLegacyRows(db, project, NOW - 60 * DAY_MS);
        }
        addSession(db, deadChat, "ses-old", NOW - 45 * DAY_MS, NOW - 45 * DAY_MS);
        addMemory(db, withMemories);
        addSession(db, recentSession, "ses-new", NOW - 90 * DAY_MS, NOW - DAY_MS);
        addMemory(db, live);
        makePruneDue(db);

        // The prune runs inside an ordinary pass for an unrelated live project.
        planDueTasks(db, live, ALL_TASKS, NOW);

        expect(scheduledTasks(db, deadChat)).toEqual([]);
        expect(scheduledTasks(db, withMemories)).toHaveLength(CANONICAL_DREAM_TASKS.length);
        expect(scheduledTasks(db, recentSession)).toHaveLength(CANONICAL_DREAM_TASKS.length);
    });

    it("global user-memory candidates do not keep an idle identity scheduled", () => {
        db = freshDb();
        const deadChat = "dir:old-chat";
        writeLegacyRows(db, deadChat, NOW - 60 * DAY_MS);
        db.prepare(
            "INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES ('likes tabs', 'ses-x', ?)",
        ).run(NOW);
        makePruneDue(db);

        expect(pruneIdleScheduleIdentities(db, NOW)).toEqual([deadChat]);
    });

    it("a pruned identity is not seeded back by the next reconcile", () => {
        db = freshDb();
        const deadChat = "dir:old-chat";
        writeLegacyRows(db, deadChat, NOW - 60 * DAY_MS);
        addSession(db, deadChat, "ses-old", NOW - 45 * DAY_MS, NOW - 45 * DAY_MS);
        makePruneDue(db);

        planDueTasks(db, deadChat, ALL_TASKS, NOW);
        expect(scheduledTasks(db, deadChat)).toEqual([]);
        planDueTasks(db, deadChat, ALL_TASKS, NOW + 60_000);
        expect(scheduledTasks(db, deadChat)).toEqual([]);
    });

    it("runs at most once per interval, not on every scheduler pass", () => {
        db = freshDb();
        const live = "git:live";
        const deadChat = "dir:old-chat";
        addMemory(db, live);
        makePruneDue(db);
        planDueTasks(db, live, ALL_TASKS, NOW);
        expect(getDreamState(db, IDLE_SCHEDULE_PRUNE_AT_KEY)).toBe(String(NOW));

        // An idle identity appearing after today's prune survives later passes today...
        writeLegacyRows(db, deadChat, NOW - 60 * DAY_MS);
        planDueTasks(db, live, ALL_TASKS, NOW + 60 * 60_000);
        expect(scheduledTasks(db, deadChat)).toHaveLength(CANONICAL_DREAM_TASKS.length);

        // ...and is pruned by the first pass once the interval has elapsed.
        planDueTasks(db, live, ALL_TASKS, NOW + IDLE_SCHEDULE_PRUNE_INTERVAL_MS);
        expect(scheduledTasks(db, deadChat)).toEqual([]);
    });
});

describe("a caller with project memory disabled schedules nothing", () => {
    function countingExecutor() {
        const calls = { count: 0 };
        const executor = async (): Promise<TaskExecOutcome> => {
            calls.count += 1;
            return { status: "completed" };
        };
        return { calls, executor };
    }

    function allRows(d: Database, project: string): unknown[] {
        return d
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM task_schedule_state WHERE project_path = ? ORDER BY task",
            )
            .all(project);
    }

    it("a home directory with memory disabled gets no new rows and runs nothing", async () => {
        db = freshDb();
        const home = "dir:home-directory";
        // Even with memories and a fresh session nothing may be seeded.
        addMemory(db, home);
        addSession(db, home, "ses-home", NOW - DAY_MS, NOW - DAY_MS);
        makePruneFresh(db);
        const { calls, executor } = countingExecutor();

        for (const now of [NOW, NOW + 60_000]) {
            const ran = await runDueTasksForProject({
                db,
                projectIdentity: home,
                tasks: ALL_TASKS,
                executor,
                now,
                projectMemoryEnabled: false,
            });
            expect(ran).toBe(0);
            expect(scheduledTasks(db, home)).toEqual([]);
        }
        expect(calls.count).toBe(0);
    });

    it("existing rows are left intact and are not run", async () => {
        db = freshDb();
        const project = "git:memory-off-here";
        // Overdue rows for a project with memories: a caller with memory on
        // would run them now.
        writeLegacyRows(db, project, NOW - DAY_MS);
        addMemory(db, project);
        makePruneFresh(db);
        const before = allRows(db, project);
        const { calls, executor } = countingExecutor();

        await runDueTasksForProject({
            db,
            projectIdentity: project,
            tasks: ALL_TASKS,
            executor,
            now: NOW,
            projectMemoryEnabled: false,
        });
        expect(calls.count).toBe(0);
        expect(allRows(db, project)).toEqual(before);
    });

    it("a shared identity keeps its watermarks when one caller has memory off and another on", async () => {
        db = freshDb();
        // Two worktrees (or hosts) of one repository share this identity.
        const shared = "git:shared-repository";
        addMemory(db, shared);
        addSession(db, shared, "ses-shared", NOW - DAY_MS, NOW - DAY_MS);
        makePruneFresh(db);
        const notDue = NOW + DAY_MS;
        const base = {
            projectPath: shared,
            lastRunAt: NOW - 2 * DAY_MS,
            nextDueAt: notDue,
            schedule: "0 3 * * *",
            lastStatus: "completed" as const,
            lastError: null,
            retryCount: 0,
        };
        writeTaskScheduleState(db, {
            ...base,
            task: "retrospective",
            retrospectiveWatermarkMs: NOW - 3 * DAY_MS,
        });
        writeTaskScheduleState(db, { ...base, task: "verify-broad", lastBroadRunAt: NOW - DAY_MS });
        writeTaskScheduleState(db, {
            ...base,
            task: "curate",
            taskStateJson: '{"next":"PROJECT_RULES"}',
        });
        const { calls, executor } = countingExecutor();

        for (let pass = 0; pass < 3; pass += 1) {
            for (const projectMemoryEnabled of [false, true]) {
                await runDueTasksForProject({
                    db,
                    projectIdentity: shared,
                    tasks: ALL_TASKS,
                    executor,
                    now: NOW + pass * 60_000,
                    projectMemoryEnabled,
                });
            }
        }

        expect(calls.count).toBe(0);
        expect(getTaskScheduleState(db, shared, "retrospective")?.retrospectiveWatermarkMs).toBe(
            NOW - 3 * DAY_MS,
        );
        expect(getTaskScheduleState(db, shared, "verify-broad")?.lastBroadRunAt).toBe(NOW - DAY_MS);
        expect(getTaskScheduleState(db, shared, "curate")?.taskStateJson).toBe(
            '{"next":"PROJECT_RULES"}',
        );
        // The memory-on caller still seeds missing memory tasks such as map-memories.
        expect(scheduledTasks(db, shared)).toContain("map-memories");
    });
});
