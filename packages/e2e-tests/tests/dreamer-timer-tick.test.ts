/// <reference types="bun-types" />

/**
 * Issue 496 — the background maintenance timer on a Pi-family host.
 *
 * The timer runs one global message-history maintenance stage before its
 * per-project loop. That stage's OpenCode orphan sweep asserted its
 * precondition with a throw, and Pi and OMP keep their sessions outside the
 * OpenCode store, so every tick on those hosts ended at that assertion — before
 * a single scheduled task could be dispatched. Nothing failed visibly: task
 * rows simply stayed untouched forever, which is what the reporter saw as 605
 * of 637 rows past due with no status at all.
 *
 * This boots a real host, makes one scheduled task due, and waits for the
 * timer's own startup tick to pick it up. The task chosen needs no model, so a
 * dispatch here is a statement about the timer and nothing else.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { CANONICAL_DREAM_TASKS } from "../../plugin/src/features/magic-context/dreamer/task-registry";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { createScenarioHarness, forEachHost, type ScenarioHarness } from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

let h: ScenarioHarness;

/**
 * The only task left on a schedule. It is the host-only one: it runs entirely
 * inside the plugin with no model call, so this scenario proves the timer
 * reached per-project work without depending on a provider round trip.
 */
const SCHEDULED_TASK = "promote-primers";

/**
 * The timer's first pass waits out the boot-quiet period before it runs, so the
 * poll budget has to outlast it comfortably.
 */
const TICK_WAIT_MS = 240_000;

function dreamerConfig(): Record<string, unknown> {
    const tasks: Record<string, unknown> = {};
    for (const task of CANONICAL_DREAM_TASKS) {
        tasks[task] = { schedule: task === SCHEDULED_TASK ? "0 3 * * *" : "" };
    }
    return { disable: false, tasks };
}

function contextDbPath(): string {
    return join(h.dataDir, "cortexkit", "magic-context", "context.db");
}

function projectIdentity(): string {
    // OMP reports its working directory as given; Pi resolves symlinks first.
    return resolveProjectIdentity(
        h.host === "omp" ? h.workdir : realpathSync(pathResolve(h.workdir)),
    );
}

/** Make the scheduled task overdue, with nothing recorded against it yet. */
function seedOverdueTask(identity: string, now: number): void {
    const db = openTestDb(contextDbPath());
    try {
        db.prepare(
            `INSERT INTO task_schedule_state
                 (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count)
             VALUES (?, ?, NULL, ?, NULL, NULL, NULL, 0)
             ON CONFLICT(project_path, task) DO UPDATE SET
                 last_run_at = NULL,
                 next_due_at = excluded.next_due_at,
                 schedule = NULL,
                 last_status = NULL,
                 last_error = NULL,
                 retry_count = 0`,
        ).run(identity, SCHEDULED_TASK, now - 60_000);
    } finally {
        db.close();
    }
}

interface TaskRow {
    last_status: string | null;
    last_run_at: number | null;
    next_due_at: number | null;
}

function readTaskRow(identity: string): TaskRow | null {
    const db = openTestDb(contextDbPath());
    try {
        return (
            (db
                .prepare(
                    "SELECT last_status, last_run_at, next_due_at FROM task_schedule_state WHERE project_path = ? AND task = ?",
                )
                .get(identity, SCHEDULED_TASK) as TaskRow | undefined) ?? null
        );
    } catch {
        return null;
    } finally {
        db.close();
    }
}

forEachHost(import.meta.url, "dreamer timer tick (issue 496)", (host) => {
    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            magicContextConfig: { dreamer: dreamerConfig() },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

    it(
        "dispatches a due task on this host",
        async () => {
            h.mock.reset();
            h.mock.setDefault({
                text: "ack",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 0,
                },
            });

            // One turn so the plugin creates and migrates the shared store.
            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "bootstrap turn for the dreamer timer");
            await h.waitFor(() => h.hasContextDb(), {
                timeoutMs: 30_000,
                label: "plugin initialized",
            });

            const identity = projectIdentity();
            seedOverdueTask(identity, Date.now());
            expect(readTaskRow(identity)?.last_status).toBeNull();

            // Now wait for the timer's own pass. Before the fix this waited
            // forever on Pi and OMP: every tick died in the stage ahead of the
            // per-project loop and the row below never moved.
            const deadline = Date.now() + TICK_WAIT_MS;
            let row = readTaskRow(identity);
            while (Date.now() < deadline && row?.last_status == null) {
                await Bun.sleep(1_000);
                row = readTaskRow(identity);
            }

            expect(row).not.toBeNull();
            // Whatever the task's own gate decided, the scheduler reached it and
            // recorded an outcome — which is the difference between a dreamer
            // with nothing to do and a dreamer that never runs.
            expect(row?.last_status).not.toBeNull();
            expect(row?.next_due_at).toBeGreaterThan(Date.now());
        },
        TICK_WAIT_MS + 120_000,
    );
});
