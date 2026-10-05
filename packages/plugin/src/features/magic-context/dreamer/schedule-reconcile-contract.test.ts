/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

/**
 * Contract tests for reconciling one shared task_schedule_state row across
 * several worktrees (processes) that register the same project identity with
 * different Dreamer schedules. The row lives in the shared context.db, so every
 * worktree's scheduler pass reconciles it against that worktree's own config.
 *
 * The contract:
 *  1. On a schedule change the next slot is the earlier of the slot already
 *     armed and the new schedule's next occurrence after now — never later than
 *     the armed slot, and never a time in the past.
 *  2. When the armed slot is kept, its retry count is kept too.
 *  3. A worktree with the task disabled leaves the shared row untouched and
 *     never runs the task.
 *  4. A failing task under conflicting schedules runs only at legitimate slots
 *     (plus its bounded retries); it must not re-arm to past times and loop.
 *
 * Every simulation drives the real scheduler with a fake clock: `setSystemTime`
 * pins `Date.now()` (used for run start/finish and lease expiry) to the same
 * instant passed as `now` to the planner.
 */

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    getTaskScheduleState,
    type TaskScheduleStateRow,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import {
    type DreamTaskRuntimeConfig,
    MAX_TASK_RETRIES,
    planDueTasks,
    runDueTasksForProject,
    type TaskExecOutcome,
} from "./task-scheduler";

const PROJECT = "git:shared-by-several-worktrees";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Scheduler tick cadence used by the simulations. */
const TICK = 5 * MINUTE;
/** Monday 2026-01-05 00:00 UTC: a plain day, no DST anywhere near it. */
const START = Date.UTC(2026, 0, 5, 0, 0);

let db: Database | null = null;
let tempDir: string | null = null;
let peer: Database | null = null;
afterEach(() => {
    setSystemTime();
    if (db) closeQuietly(db);
    if (peer) closeQuietly(peer);
    db = peer = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
});

function freshDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    // An active memory makes the verify task's activity gate pass; a failing
    // run never advances last_run_at, so the gate keeps passing.
    insertMemory(d, { projectPath: PROJECT, category: "PROJECT_RULES", content: "shared rule" });
    return d;
}

function sharedDb(): Database {
    tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-schedule-reconcile-"));
    const file = join(tempDir, "context.db");
    const first = new Database(file);
    initializeDatabase(first);
    runMigrations(first);
    insertMemory(first, {
        projectPath: PROJECT,
        category: "PROJECT_RULES",
        content: "shared rule",
    });
    peer = new Database(file);
    peer.exec("PRAGMA busy_timeout=0");
    db = first;
    return first;
}

function verify(schedule: string): DreamTaskRuntimeConfig {
    return { task: "verify", schedule, timeoutMinutes: 20 };
}

function row(d: Database): TaskScheduleStateRow {
    const state = getTaskScheduleState(d, PROJECT, "verify");
    if (!state) throw new Error("missing verify schedule row");
    return state;
}

function hhmm(ms: number): string {
    const offset = ms - START;
    const h = Math.floor(offset / HOUR);
    const m = Math.floor((offset % HOUR) / MINUTE);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface Worktree {
    name: string;
    config: DreamTaskRuntimeConfig;
}

interface Execution {
    at: string;
    worktree: string;
}

/**
 * Tick every worktree in order at each TICK from `from` (inclusive) to `to`
 * (exclusive), recording every executor call and every reconcile that moved the
 * shared slot into the past.
 */
async function simulate(
    d: Database,
    worktrees: readonly Worktree[],
    outcome: () => TaskExecOutcome,
    from: number,
    to: number,
): Promise<{ executions: Execution[]; pastReArms: string[] }> {
    const executions: Execution[] = [];
    const pastReArms: string[] = [];
    for (let now = from; now < to; now += TICK) {
        setSystemTime(new Date(now));
        for (const worktree of worktrees) {
            const before = getTaskScheduleState(d, PROJECT, "verify")?.nextDueAt ?? null;
            // Reconcile alone first, so a slot moved by reconciliation (rather
            // than by a run) is observable before the run consumes it.
            planDueTasks(d, PROJECT, [worktree.config], now);
            const after = getTaskScheduleState(d, PROJECT, "verify")?.nextDueAt ?? null;
            if (after !== null && after !== before && after < now) {
                pastReArms.push(`${hhmm(now)} ${worktree.name} -> ${hhmm(after)}`);
            }
            await runDueTasksForProject({
                db: d,
                projectIdentity: PROJECT,
                tasks: [worktree.config],
                now,
                executor: async () => {
                    executions.push({ at: hhmm(now), worktree: worktree.name });
                    return outcome();
                },
            });
        }
    }
    return { executions, pastReArms };
}

const transientFailure = (): TaskExecOutcome => ({
    status: "failed",
    transient: true,
    error: "rate limit",
});
const permanentFailure = (): TaskExecOutcome => ({ status: "failed", error: "bad output" });

describe("shared schedule reconciliation contract", () => {
    it("re-reads the row under a write lock before reconciling across connections", () => {
        const first = sharedDb();
        planDueTasks(first, PROJECT, [verify("0 */6 * * *")], START);
        const consumed = START + 6 * HOUR;
        const now = consumed + MINUTE;
        let reads = 0;
        let interleaved = false;
        const instrumented = new Proxy(first, {
            get(target, key) {
                if (key === "prepare")
                    return (sql: string) => {
                        const statement = target.prepare(sql);
                        if (
                            !sql.includes(
                                "FROM task_schedule_state WHERE project_path = ? AND task = ?",
                            )
                        )
                            return statement;
                        return new Proxy(statement, {
                            get(stmt, method) {
                                if (method === "get")
                                    return (...args: string[]) => {
                                        const result = stmt.get(...args);
                                        if (++reads === 2) {
                                            interleaved = true;
                                            writeTaskScheduleState(peer!, {
                                                ...row(peer!),
                                                nextDueAt: START + 12 * HOUR,
                                                lastRunAt: consumed,
                                                lastStatus: "completed",
                                            });
                                        }
                                        return result;
                                    };
                                const value = Reflect.get(stmt, method);
                                return typeof value === "function" ? value.bind(stmt) : value;
                            },
                        });
                    };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        planDueTasks(instrumented, PROJECT, [verify("0 3 * * *")], now);
        expect(interleaved).toBe(true);
        expect(row(first)).toMatchObject({
            nextDueAt: START + 12 * HOUR,
            lastRunAt: consumed,
            lastStatus: "completed",
        });
    });

    it("keeps a second writer out between the locked read and update", () => {
        const first = sharedDb();
        planDueTasks(first, PROJECT, [verify("0 */6 * * *")], START);
        let reads = 0;
        let locked = false;
        let blocked = false;
        const instrumented = new Proxy(first, {
            get(target, key) {
                if (key === "exec")
                    return (sql: string) => {
                        if (sql === "BEGIN IMMEDIATE") locked = true;
                        const result = target.exec(sql);
                        if (sql === "COMMIT" || sql === "ROLLBACK") locked = false;
                        return result;
                    };
                if (key === "prepare")
                    return (sql: string) => {
                        const statement = target.prepare(sql);
                        if (
                            !sql.includes(
                                "FROM task_schedule_state WHERE project_path = ? AND task = ?",
                            )
                        )
                            return statement;
                        return new Proxy(statement, {
                            get(stmt, method) {
                                if (method === "get")
                                    return (...args: string[]) => {
                                        const result = stmt.get(...args);
                                        reads++;
                                        if (locked) {
                                            try {
                                                writeTaskScheduleState(peer!, {
                                                    ...row(peer!),
                                                    lastStatus: "completed",
                                                });
                                            } catch (error) {
                                                blocked =
                                                    (error as { code?: string }).code ===
                                                    "SQLITE_BUSY";
                                            }
                                        }
                                        return result;
                                    };
                                const value = Reflect.get(stmt, method);
                                return typeof value === "function" ? value.bind(stmt) : value;
                            },
                        });
                    };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        planDueTasks(instrumented, PROJECT, [verify("0 3 * * *")], START + HOUR);
        expect(reads).toBeGreaterThan(1);
        expect(blocked).toBe(true);
        expect(row(first).lastStatus).toBeNull();
    });

    it("does not re-arm a consumed civil minute in Madrid's repeated hour", async () => {
        if (process.env.MC_DREAMER_DST_CHILD !== "1") {
            // Bun does not restore its default timezone after changing TZ in-process.
            // A child isolates Madrid without changing the rest of the test suite.
            const child = spawnSync(
                process.execPath,
                [
                    "test",
                    import.meta.path,
                    "--test-name-pattern",
                    "does not re-arm a consumed civil minute",
                ],
                {
                    windowsHide: true,
                    env: { ...process.env, TZ: "Europe/Madrid", MC_DREAMER_DST_CHILD: "1" },
                    encoding: "utf8",
                    timeout: 20_000,
                },
            );
            expect(child.error).toBeUndefined();
            expect(child.status, child.stderr).toBe(0);
            return;
        }
        expect(process.env.TZ).toBe("Europe/Madrid");
        db = freshDb();
        const first = Date.parse("2026-10-25T00:30:00Z");
        const repeated = Date.parse("2026-10-25T01:30:00Z");
        const a = verify("30 2 * * *");
        const b = verify("30 2 * * 0");
        setSystemTime(new Date(first - MINUTE));
        planDueTasks(db, PROJECT, [a], first - MINUTE);
        expect(row(db).nextDueAt).toBe(first);
        const executions: number[] = [];
        for (const now of [first, first + MINUTE, repeated - MINUTE, repeated, repeated + MINUTE]) {
            setSystemTime(new Date(now));
            for (const config of [a, b]) {
                await runDueTasksForProject({
                    db,
                    projectIdentity: PROJECT,
                    tasks: [config],
                    now,
                    executor: async () => {
                        executions.push(now);
                        return { status: "completed" };
                    },
                });
            }
        }
        expect(executions).toEqual([first]);
        expect(row(db).nextDueAt).toBeGreaterThan(repeated);
    });
    it("a schedule change arms the earlier of the armed slot and the next slot after now", () => {
        db = freshDb();
        // Worktree A (every 6 hours) seeds the row at 00:00: armed for 06:00.
        planDueTasks(db, PROJECT, [verify("0 */6 * * *")], START);
        expect(row(db).nextDueAt).toBe(START + 6 * HOUR);

        // At 01:00 worktree B (daily 03:00) brings the slot forward to 03:00.
        planDueTasks(db, PROJECT, [verify("0 3 * * *")], START + HOUR);
        expect(row(db).nextDueAt).toBe(START + 3 * HOUR);

        // At 02:00 worktree C (daily 12:00) must not postpone the armed 03:00.
        planDueTasks(db, PROJECT, [verify("0 12 * * *")], START + 2 * HOUR);
        expect(row(db).nextDueAt).toBe(START + 3 * HOUR);
    });

    it("a schedule edit never arms a slot in the past, even with an old successful run", () => {
        db = freshDb();
        // Daily 03:00 schedule, last succeeded a day ago, armed for 03:00 today.
        planDueTasks(db, PROJECT, [verify("0 3 * * *")], START);
        writeTaskScheduleState(db, { ...row(db), lastRunAt: START - DAY });

        // At 02:00 the schedule is edited to 01:00, a time between the last run
        // and now. The 01:00 occurrence today has already passed, so the next
        // one is tomorrow; the armed 03:00 today is earlier and is kept.
        const now = START + 2 * HOUR;
        expect(planDueTasks(db, PROJECT, [verify("0 1 * * *")], now)).toHaveLength(0);
        expect(row(db).nextDueAt).toBe(START + 3 * HOUR);

        // A row with no armed slot takes the next occurrence after now.
        writeTaskScheduleState(db, { ...row(db), nextDueAt: null, schedule: "0 3 * * *" });
        expect(planDueTasks(db, PROJECT, [verify("0 1 * * *")], now)).toHaveLength(0);
        expect(row(db).nextDueAt).toBe(START + DAY + HOUR);
    });

    it("keeps the retry count while conflicting worktrees keep the armed slot", () => {
        db = freshDb();
        planDueTasks(db, PROJECT, [verify("0 */6 * * *")], START);
        const armed = START + 6 * HOUR;
        // The armed 06:00 slot has failed twice and is waiting to hot-retry.
        writeTaskScheduleState(db, { ...row(db), retryCount: 2, lastStatus: "failed" });

        for (let i = 0; i < 6; i++) {
            const schedule = i % 2 === 0 ? "0 9 * * *" : "0 */6 * * *";
            planDueTasks(db, PROJECT, [verify(schedule)], START + HOUR + i * TICK);
            expect(row(db)).toMatchObject({ nextDueAt: armed, retryCount: 2 });
        }
    });

    it("over 24 hours, alternating worktrees cannot reset the retry cap", async () => {
        db = freshDb();
        const worktrees = [
            { name: "A", config: verify("0 */6 * * *") },
            { name: "B", config: verify("0 3 * * *") },
        ];
        const { executions } = await simulate(db, worktrees, transientFailure, START, START + DAY);
        const perSlot = new Map<string, number>();
        for (const { at } of executions) {
            const slot = `${at.slice(0, 2)}:00`;
            perSlot.set(slot, (perSlot.get(slot) ?? 0) + 1);
        }
        // Each legitimate slot gets the first attempt plus MAX_TASK_RETRIES.
        expect(Object.fromEntries(perSlot)).toEqual({
            "03:00": MAX_TASK_RETRIES + 1,
            "06:00": MAX_TASK_RETRIES + 1,
            "12:00": MAX_TASK_RETRIES + 1,
            "18:00": MAX_TASK_RETRIES + 1,
        });
    });

    it("a worktree with the task disabled leaves the shared row untouched and never runs it", async () => {
        db = freshDb();
        const enabled = { name: "enabled", config: verify("0 */6 * * *") };
        const disabled = { name: "disabled", config: verify("") };
        // Seed from the enabled worktree so there is a shared row to protect.
        planDueTasks(db, PROJECT, [enabled.config], START);

        // The disabled worktree's full pass writes nothing, even when the
        // shared slot is due.
        for (const now of [START + HOUR, START + 6 * HOUR]) {
            setSystemTime(new Date(now));
            const before = row(db);
            expect(planDueTasks(db, PROJECT, [disabled.config], now)).toHaveLength(0);
            let ran = 0;
            await runDueTasksForProject({
                db,
                projectIdentity: PROJECT,
                tasks: [disabled.config],
                now,
                executor: async () => {
                    ran += 1;
                    return { status: "completed" };
                },
            });
            expect(ran).toBe(0);
            expect(row(db)).toEqual(before);
        }

        // Over a day with the disabled worktree ticking FIRST at every tick, the
        // enabled worktree still runs every one of its own slots, and only it.
        const { executions } = await simulate(
            db,
            [disabled, enabled],
            permanentFailure,
            START,
            START + DAY,
        );
        expect(executions).toEqual([
            { at: "06:00", worktree: "enabled" },
            { at: "12:00", worktree: "enabled" },
            { at: "18:00", worktree: "enabled" },
        ]);
    });

    it("a failing task under conflicting schedules does not loop on past slots", async () => {
        db = freshDb();
        // An old successful run: the anchor that once re-armed consumed slots.
        planDueTasks(db, PROJECT, [verify("0 */6 * * *")], START);
        writeTaskScheduleState(db, { ...row(db), lastRunAt: START - 2 * DAY });
        const worktrees = [
            { name: "A", config: verify("0 */6 * * *") },
            { name: "B", config: verify("0 3 * * *") },
        ];
        const { executions, pastReArms } = await simulate(
            db,
            worktrees,
            permanentFailure,
            START,
            START + DAY,
        );
        // Reconciliation never moves the shared slot into the past, and a task
        // that fails every time runs exactly once per legitimate slot.
        expect(pastReArms).toEqual([]);
        expect(executions.map(({ at }) => at)).toEqual(["03:00", "06:00", "12:00", "18:00"]);
    });

    it("a schedule change made while a run is in flight does not replay the consumed slot", async () => {
        db = freshDb();
        const a = verify("0 */6 * * *");
        const b = verify("0 3 * * *");
        planDueTasks(db, PROJECT, [a], START);
        const slot = START + 6 * HOUR;
        const now = slot + MINUTE;
        setSystemTime(new Date(now));

        let executions = 0;
        let bExecutions = 0;
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [a],
            now,
            executor: async () => {
                executions += 1;
                // While A holds the domain lease, worktree B reconciles and
                // ticks. It sees the slot being run as due, but the busy lease
                // defers it without running.
                await runDueTasksForProject({
                    db: db as Database,
                    projectIdentity: PROJECT,
                    tasks: [b],
                    now,
                    executor: async () => {
                        bExecutions += 1;
                        return { status: "completed" };
                    },
                });
                return { status: "failed", error: "bad output" };
            },
        });
        expect(executions).toBe(1);
        expect(bExecutions).toBe(0);
        // A's completion advanced past the consumed slot; neither worktree
        // re-arms it afterwards (B's own next slot, tomorrow 03:00, is later).
        expect(row(db).nextDueAt).toBe(START + 12 * HOUR);
        for (const config of [b, a, b]) {
            expect(planDueTasks(db, PROJECT, [config], now)).toHaveLength(0);
            expect(row(db).nextDueAt).toBe(START + 12 * HOUR);
        }
    });
});
