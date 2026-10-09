import { describe, expect, test } from "bun:test";
import { runNameLabel, sessionLabel } from "./session-label";

describe("runNameLabel", () => {
  test("an Alfonso background task reads as a Mason task with its copyable id", () => {
    expect(runNameLabel("alfonso:bg_c6f3cef176d331b2")).toEqual({
      name: "Mason task",
      owner: "alfonso",
      id: "bg_c6f3cef176d331b2",
      tooltip: "alfonso:bg_c6f3cef176d331b2",
    });
  });

  test("a consult names its role and keeps the run id apart", () => {
    const label = runNameLabel("alfonso:consult-ct_00000000-0000-4046-98dd-0710b450edf8-gather-a1");
    expect(label.name).toBe("Consult · gather-a1");
    expect(label.owner).toBe("alfonso");
    expect(label.id).toBe("ct_00000000-0000-4046-98dd-0710b450edf8");
  });

  test("a sidekick without a role is just the kind and its id", () => {
    const label = runNameLabel("alfonso:sidekick-00000000-0000-4048-98dd-07150ea7a2c0");
    expect(label).toMatchObject({
      name: "Sidekick",
      owner: "alfonso",
      id: "00000000-0000-4048-98dd-07150ea7a2c0",
    });
  });

  test("names outside the run pattern are shown whole, never guessed at", () => {
    for (const raw of ["mc-historian:one", "Fix the parser", "alfonso:something-else"]) {
      expect(runNameLabel(raw)).toEqual({ name: raw, owner: null, id: null, tooltip: raw });
    }
  });
});

describe("sessionLabel", () => {
  test("a Broca identity is named from its session field, with project in the tooltip", () => {
    const id = JSON.stringify({
      project_root: "/work/app",
      harness: "broca",
      session: "alfonso:bg_b1b7fea62af10d66",
    });
    const label = sessionLabel("broca", id, "alfonso:bg_b1b7fea62af10d66");
    expect(label.name).toBe("Mason task");
    expect(label.id).toBe("bg_b1b7fea62af10d66");
    expect(label.tooltip).toContain("alfonso:bg_b1b7fea62af10d66");
    expect(label.tooltip).toContain("project: /work/app");
  });

  test("a titled session shows its title and keeps the id quiet", () => {
    expect(sessionLabel("opencode", "ses_123", "Fix the parser")).toEqual({
      name: "Fix the parser",
      owner: null,
      id: "ses_123",
      tooltip: "Fix the parser\nses_123",
    });
  });

  test("an untitled session has only its id", () => {
    expect(sessionLabel("pi", "abc", null)).toEqual({
      name: null,
      owner: null,
      id: "abc",
      tooltip: "abc",
    });
  });
});
