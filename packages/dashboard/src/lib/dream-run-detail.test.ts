import { describe, expect, test } from "bun:test";
import {
  type DreamRunForTask,
  getDreamRunTaskDetail,
  latestTaskFailureText,
} from "./dream-run-detail";
import type { DreamRunTask } from "./types";

const task = (overrides: Partial<DreamRunTask> = {}): DreamRunTask => ({
  name: "verify-broad",
  durationMs: 1,
  resultChars: 0,
  ...overrides,
});

describe("getDreamRunTaskDetail", () => {
  test("renders a disabled task as skipped with its reason, not successful output", () => {
    expect(
      getDreamRunTaskDetail(task({ status: "skipped", skipReason: "mural is not enabled" }), 0),
    ).toEqual({ text: "Skipped: mural is not enabled", tone: "neutral" });
  });
  test("renders new progress neutrally", () => {
    expect(getDreamRunTaskDetail(task({ progress: "verified 33, 0 remain" }), 0)).toEqual({
      text: "verified 33, 0 remain",
      tone: "neutral",
    });
  });

  test("keeps legacy progress-in-error readable without marking success red", () => {
    expect(
      getDreamRunTaskDetail(task({ error: "verify-broad cycle: verified 33, 0 remain" }), 0),
    ).toEqual({ text: "verify-broad cycle: verified 33, 0 remain", tone: "neutral" });
  });

  test("renders structured failure detail for new rows", () => {
    expect(
      getDreamRunTaskDetail(
        task({
          error: "classify returned no output",
          failure: {
            failure_class: "provider_error",
            model_attempted: "anthropic/claude-sonnet",
            models_tried: ["primary", "anthropic/claude-sonnet"],
            provider_error: "HTTP 429 rate limited\nrequest id: hidden",
            timeout_ms: null,
            child_session_id: "child-123",
          },
        }),
        1,
      ),
    ).toEqual({
      text: "provider_error · model: anthropic/claude-sonnet · HTTP 429 rate limited",
      tone: "error",
    });
  });

  test("keeps the legacy error string for old failed rows", () => {
    expect(getDreamRunTaskDetail(task({ error: "provider unavailable" }), 1)).toEqual({
      text: "provider unavailable",
      tone: "error",
    });
  });

  test("treats empty detail values as absent", () => {
    expect(getDreamRunTaskDetail(task({ error: "", progress: "" }), 0)).toEqual({
      text: undefined,
      tone: "neutral",
    });
  });
});

describe("latestTaskFailureText", () => {
  const failed = (finished_at: number, name: string, model: string): DreamRunForTask => ({
    project_path: "p",
    finished_at,
    tasks_failed: 1,
    tasks_json: [
      task({
        name,
        error: "no output",
        failure: {
          failure_class: "provider_error",
          model_attempted: model,
          models_tried: [model],
          provider_error: "HiddenProviderError",
          timeout_ms: null,
          child_session_id: null,
        },
      }),
    ],
  });
  const succeeded = (finished_at: number, name: string): DreamRunForTask => ({
    project_path: "p",
    finished_at,
    tasks_failed: 0,
    tasks_json: [task({ name, progress: "processed 7" })],
  });

  test("a newer success clears an older failure", () => {
    const runs = [failed(100, "verify", "omniroute/scout"), succeeded(200, "verify")];
    expect(latestTaskFailureText(runs, "p", "verify")).toBeNull();
  });

  test("shows the failure when it is the task's newest run", () => {
    const runs = [succeeded(100, "verify-broad"), failed(200, "verify-broad", "omniroute/scout")];
    expect(latestTaskFailureText(runs, "p", "verify-broad")).toBe(
      "provider_error · model: omniroute/scout · HiddenProviderError",
    );
  });

  test("other tasks' and other projects' runs do not count", () => {
    const runs = [
      failed(100, "verify", "omniroute/scout"),
      succeeded(300, "curate"),
      { ...succeeded(400, "verify"), project_path: "q" },
    ];
    expect(latestTaskFailureText(runs, "p", "verify")).toBe(
      "provider_error · model: omniroute/scout · HiddenProviderError",
    );
  });

  test("does not depend on the input order", () => {
    const runs = [succeeded(200, "verify"), failed(100, "verify", "omniroute/scout")];
    expect(latestTaskFailureText(runs, "p", "verify")).toBeNull();
  });
});
