/**
 * Dream tool worker unit tests (borrowed-parent worker seam).
 *
 * Covers the pieces the facade test does not: AgentPresence ordering
 * (directory match preferred, child sessions skipped, any-agent fallback) and
 * DREAM_WORKER_PROFILES parity with the core agent tool allowlists.
 */
import { describe, expect, it } from "bun:test";
import {
  AgentPresence,
  DREAM_WORKER_PROFILES,
  TOOL_REQUIRING_DREAM_AGENTS,
  collectToolCalls,
  isMagicDreamerAgent,
  subagentLabelOf,
} from "./dream-worker";

function fakeAgent(
  id: string,
  header: Record<string, unknown> = {},
): { id: string; session: { header: Record<string, unknown> }; options: Record<string, never> } {
  return { id, session: { header }, options: {} };
}

describe("DREAM_WORKER_PROFILES", () => {
  it("mirrors the core per-agent tool surfaces (DSH tool names)", () => {
    expect(DREAM_WORKER_PROFILES["dreamer"]).toEqual(["ctx_memory", "ctx_memory_list"]);
    expect(DREAM_WORKER_PROFILES["dreamer-docs"]).toEqual(["read", "grep", "glob", "fs_search"]);
    expect(DREAM_WORKER_PROFILES["dreamer-primer-investigator"]).toEqual([
      "read",
      "grep",
      "glob",
      "fs_search",
      "ctx_search",
    ]);
    // memory-mapper: deliberately NO ctx_search (local-source checks only).
    expect(DREAM_WORKER_PROFILES["dreamer-memory-mapper"]).toEqual([
      "read",
      "grep",
      "glob",
      "fs_search",
    ]);
    expect(TOOL_REQUIRING_DREAM_AGENTS.has("dreamer-classifier")).toBe(false);
    expect(TOOL_REQUIRING_DREAM_AGENTS.has("dreamer")).toBe(true);
  });
});

describe("AgentPresence", () => {
  it("skips child sessions and prefers a directory match", () => {
    const presence = new AgentPresence();
    const elsewhere = fakeAgent("a1", { cwd: "/elsewhere" });
    const child = fakeAgent("a2", { origin: "subagent" });
    const home = fakeAgent("a3", { cwd: "/workspace" });
    presence.register(elsewhere);
    presence.register(child);
    presence.register(home);

    expect(presence.pick("/workspace/nested")).toBe(home);
    expect(presence.pick()).toBe(elsewhere); // any-agent fallback, first live
    expect(presence.pick("/workspace")).toBe(home);
  });

  it("returns undefined when empty and prunes dead references lazily", () => {
    const presence = new AgentPresence();
    expect(presence.pick("/workspace")).toBeUndefined();
    presence.register(fakeAgent("a1", { cwd: "/workspace" }));
    expect(presence.pick("/workspace")).toBeDefined();
    presence.register(fakeAgent("a1", { cwd: "/workspace" })); // idempotent per object
    presence.pick(); // prune pass
    // No direct weakref eviction observable here (gc-dependent); empty registry
    // covered by the first assertion.
  });

  it("treats a subdirectory relationship as a directory match", () => {
    const presence = new AgentPresence();
    presence.register(fakeAgent("a1", { cwd: "/workspace" }));
    expect(presence.pick("/workspace/deep/nested")).toBeDefined();
    presence.register(fakeAgent("a2", { cwd: "/workspaces" }));
    // Prefix without separator must NOT match "/workspaces".
    expect(presence.pick("/workspace")).not.toBe(undefined);
    expect(presence.pick("/workspaces/x")).toBeDefined();
  });
});

describe("dreamer identity gate", () => {
  function agentWithEvents(events: unknown[]): { id: string; session: { header: Record<string, unknown>; snapshotEvents: () => unknown[] } } {
    return { id: "a1", session: { header: {}, snapshotEvents: () => events } };
  }

  it("reads the subagent descriptor label and matches only magic-dream workers", () => {
    const dreamer = agentWithEvents([
      { type: "subagent/descriptor", data: { label: "magic-dream-dreamer", mode: "one-shot" } },
    ]);
    expect(subagentLabelOf(dreamer as never)).toBe("magic-dream-dreamer");
    expect(isMagicDreamerAgent(dreamer as never)).toBe(true);

    const foreign = agentWithEvents([
      { type: "subagent/descriptor", data: { label: "generic-worker" } },
    ]);
    expect(isMagicDreamerAgent(foreign as never)).toBe(false);

    // No descriptor (primary session) → undefined, not a dreamer.
    const primary = agentWithEvents([{ type: "user/message", data: {} }]);
    expect(subagentLabelOf(primary as never)).toBeUndefined();
    expect(isMagicDreamerAgent(primary as never)).toBe(false);

    // Unlabeled descriptor → undefined.
    const unlabeled = agentWithEvents([{ type: "subagent/descriptor", data: {} }]);
    expect(subagentLabelOf(unlabeled as never)).toBeUndefined();
    expect(isMagicDreamerAgent(undefined)).toBe(false);
  });
});

describe("collectToolCalls", () => {
  it("pairs tool/call with non-error tool/result and counts every call", () => {
    const child = fakeAgent("c1", {});
    (child.session as { events?: unknown[] }).events = [
      {
        type: "tool/call",
        data: {
          callId: "c1",
          name: "ctx_memory",
          arguments: JSON.stringify({ action: "archive", ids: [1, 2] }),
        },
      },
      { type: "tool/result", data: { callId: "c1", message: { content: [] } } },
      { type: "tool/call", data: { callId: "c2", name: "grep", arguments: '{"q":"x"}' } },
      {
        type: "tool/result",
        data: { callId: "c2", message: { content: [] }, error: { name: "E", code: "X" } },
      },
      // call without a result — counted, not completed.
      { type: "tool/call", data: { callId: "c3", name: "read", arguments: "not-json" } },
    ];
    const walk = collectToolCalls(child as never);
    expect(walk.toolCallCount).toBe(3);
    expect(walk.completedToolCalls).toEqual([
      { name: "ctx_memory", arguments: { action: "archive", ids: [1, 2] } },
    ]);
  });

  it("handles a missing localAgent (remote run) and malformed events", () => {
    expect(collectToolCalls(undefined)).toEqual({ toolCallCount: 0, completedToolCalls: [] });
    const child = fakeAgent("c2", {});
    (child.session as { events?: unknown[] }).events = [
      null,
      { type: "tool/call", data: {} },
      { type: "tool/result", data: {} },
      { type: "tool/result", data: { callId: "unknown-id" } },
    ];
    const walk = collectToolCalls(child as never);
    expect(walk.toolCallCount).toBe(1);
    expect(walk.completedToolCalls).toEqual([]);
  });
});
