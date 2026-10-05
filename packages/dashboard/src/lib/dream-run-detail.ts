import type { DreamRunFailureDetail, DreamRunTask } from "./types";

export type DreamRunTaskDetailTone = "error" | "neutral";

export interface DreamRunTaskDetail {
  text: string | undefined;
  tone: DreamRunTaskDetailTone;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

export function formatDreamRunFailureDetail(failure: DreamRunFailureDetail): string {
  const parts: string[] = [failure.failure_class];
  if (failure.refusal_reason)
    parts.push(`refused before reaching the model: ${failure.refusal_reason}`);
  if (failure.model_attempted) parts.push(`model: ${failure.model_attempted}`);
  if (failure.provider_error) {
    parts.push(failure.provider_error.split(/\r?\n/, 1)[0]?.trim() ?? "");
  } else if (failure.timeout_ms !== null) {
    parts.push(`timeout: ${failure.timeout_ms}ms`);
  }
  return parts.filter(Boolean).join(" · ");
}

/**
 * Select the detail shown for a task while keeping legacy successful rows safe.
 * Old rows stored successful verify-broad progress in `error`; a run with no
 * failed tasks therefore renders that legacy value neutrally.
 */
export function getDreamRunTaskDetail(task: DreamRunTask, tasksFailed: number): DreamRunTaskDetail {
  if (task.status === "skipped")
    return { text: `Skipped: ${task.skipReason ?? "unavailable"}`, tone: "neutral" };
  const error = nonEmpty(task.error);
  if (tasksFailed > 0 && task.failure) {
    return { text: formatDreamRunFailureDetail(task.failure), tone: "error" };
  }
  if (tasksFailed > 0 && error !== undefined) {
    return { text: error, tone: "error" };
  }
  return {
    text: nonEmpty(task.progress) ?? error,
    tone: "neutral",
  };
}

/** The run fields `latestTaskFailureText` reads. */
export interface DreamRunForTask {
  project_path: string;
  finished_at: number;
  tasks_failed: number;
  tasks_json: DreamRunTask[];
}

/**
 * The failure text a task card shows: the outcome of the task's newest run only.
 * An older failure must not outlive a later success, because it would name a
 * model or provider that is no longer in play and read as the current state.
 * Returns null when the newest run succeeded or the task has no run here.
 */
export function latestTaskFailureText(
  runs: readonly DreamRunForTask[],
  projectPath: string,
  taskName: string,
): string | null {
  const newestFirst = [...runs].sort((a, b) => b.finished_at - a.finished_at);
  for (const run of newestFirst) {
    if (run.project_path !== projectPath) continue;
    const task = run.tasks_json.find((candidate) => candidate.name === taskName);
    if (!task) continue;
    if (run.tasks_failed <= 0) return null;
    return getDreamRunTaskDetail(task, run.tasks_failed).text ?? null;
  }
  return null;
}
