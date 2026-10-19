import { isDreamerRunnable } from "../../../config/agent-disable";
import type { DreamerConfig } from "../../../config/schema/magic-context";
import { type ModelHarness, resolveDreamerTaskModel } from "../../../shared/model-resolution";
import {
    availableDreamTasks,
    DREAM_TOOL_LOOP_TOKEN_BUDGETS,
    type DreamTaskName,
} from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

/**
 * Resolve the full per-task runtime config the scheduler consumes from the
 * validated dreamer config: each task's schedule + its effective model chain
 * (task override → dreamer-level default), thinking level, timeout, and
 * task-specific params. One place owns the inheritance rule.
 */
export function buildDreamTaskRuntimeConfigs(
    dreamer: unknown,
    harness: ModelHarness,
    language?: string,
    smartNotesEnabled = true,
): DreamTaskRuntimeConfig[] {
    return availableDreamTasks(smartNotesEnabled).map((task) => {
        const resolved = resolveDreamerTaskModel({
            config: { dreamer },
            harness,
            task,
        });
        return {
            task,
            // Scheduling is intentionally outside the harness block. An omitted
            // schedule stays disabled until the schema supplies its default.
            schedule: resolved.schedule ?? "",
            model: resolved.primary,
            fallbackModels: resolved.fallbacks,
            thinkingLevel:
                harness === "pi"
                    ? (resolved.primary?.qualifier as DreamTaskRuntimeConfig["thinkingLevel"])
                    : undefined,
            language,
            timeoutMinutes: resolved.timeoutMinutes ?? 20,
            tokenBudget:
                task in DREAM_TOOL_LOOP_TOKEN_BUDGETS
                    ? ((dreamer as DreamerConfig | undefined)?.tasks?.[task]?.token_budget ??
                      DREAM_TOOL_LOOP_TOKEN_BUDGETS[
                          task as keyof typeof DREAM_TOOL_LOOP_TOKEN_BUDGETS
                      ])
                    : undefined,
            promotionThreshold: resolved.promotionThreshold,
            docsMaxTokens:
                task === "maintain-docs"
                    ? ((dreamer as DreamerConfig | undefined)?.tasks?.["maintain-docs"]
                          ?.max_tokens ?? 12000)
                    : undefined,
            retrospectiveRecencyDays:
                task === "retrospective"
                    ? ((dreamer as DreamerConfig | undefined)?.tasks?.retrospective?.recency_days ??
                      30)
                    : undefined,
        };
    });
}

/**
 * The user-memory privacy gate: the review-user-memories task is scheduled
 * (schedule != ""). Replaces the v1 `user_memories.enabled` flag,
 * which both gated collection AND review. The `<user-profile>` system-prompt
 * block keys on this alone; historian collection uses
 * `userObservationCollectionEnabled`, which also needs a runnable dreamer.
 */
export function userMemoryCollectionEnabled(dreamer: DreamerConfig | undefined): boolean {
    const schedule = dreamer?.tasks?.["review-user-memories"]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/**
 * Whether historian runs store user-behavior observations as review
 * candidates: the review-user-memories task is scheduled AND the dreamer that
 * runs it is runnable. With the dreamer disabled the default schedule is still
 * non-empty, so the schedule check alone kept storing candidates that no
 * review would ever read.
 */
export function userObservationCollectionEnabled(dreamer: DreamerConfig | undefined): boolean {
    return userObservationsRequested(dreamer) && userMemoryCollectionEnabled(dreamer);
}

/**
 * Whether the historian is asked for `<user_observations>` at all. It is false
 * only when the dreamer is not runnable (no dreamer block, or
 * `dreamer.disable: true`): then no review-user-memories run can ever read the
 * observations, so the historian's per-run prompt tells it to skip them. With a
 * runnable dreamer the prompt is unchanged even when the review task is
 * unscheduled; observations are then parsed and discarded, as before.
 */
export function userObservationsRequested(dreamer: DreamerConfig | undefined): boolean {
    return isDreamerRunnable({ dreamer });
}

/** The promotion threshold for user-memory review (collection + review share it). */
export function userMemoryPromotionThreshold(dreamer: DreamerConfig | undefined): number {
    return dreamer?.tasks?.["review-user-memories"]?.promotion_threshold ?? 3;
}

/** True when a task is scheduled (schedule != ""). Generic enable check. */
export function dreamTaskScheduled(
    dreamer: DreamerConfig | undefined,
    task: keyof NonNullable<DreamerConfig["tasks"]>,
): boolean {
    const schedule = dreamer?.tasks?.[task]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/** Names of the tasks the user has scheduled (schedule != ""), in canonical order. */
export function enabledDreamTasks(
    dreamer: DreamerConfig | undefined,
    smartNotesEnabled = true,
): DreamTaskName[] {
    if (!dreamer?.tasks) return [];
    return availableDreamTasks(smartNotesEnabled).filter((t) => dreamer.tasks[t]?.schedule?.trim());
}

/** A compact `/ctx-status`-style schedule summary, e.g.
 *  "verify 0 3 * * *, curate 0 4 * * 0" — or "manual-only" when nothing is
 *  scheduled. */
export function summarizeDreamSchedule(
    dreamer: DreamerConfig | undefined,
    smartNotesEnabled = true,
): string {
    const enabled = enabledDreamTasks(dreamer, smartNotesEnabled);
    if (enabled.length === 0) return "manual-only";
    return enabled.map((t) => `${t} ${dreamer?.tasks[t]?.schedule}`).join(", ");
}
