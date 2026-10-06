/**
 * Phase 4 slice P1 — dreamer wiring tests.
 *
 * Covers: project discovery (session_projects dedupe + harness filter), the
 * DreamTimerClient-shaped facade (stub LLM: create/prompt/messages/delete,
 * model override, abort; tool agents via the borrowed-parent worker: transient
 * no-live-agent failure, spawn allowlist/persona, synthetic tool parts,
 * transient worker errors), the /ctx-dream seam shape (tasks/executor/runnable/
 * scheduleSummary; executor no-LLM path with telemetry), and the
 * schedule-timer registration (injectable interval factory; tick runs the
 * core scheduler pass against the test DB).
 *
 * No network calls: the LLM is a stub stream, the timer factory is a capture.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, LlmRuntime, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getDreamRuns } from "@magic-context/core/features/magic-context/dreamer/storage-dream-runs";
import {
  getTaskScheduleStatesForProject,
} from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { CANONICAL_DREAM_TASKS } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import { setBootQuietPeriodForTests } from "@magic-context/core/plugin/boot-quiet";
import { extractLatestAssistantText } from "@magic-context/core/shared/assistant-message-extractor";
import { createTestDb, createTestStorageDir } from "../test-utils";
import {
  __test,
  createDshDreamClient,
  DEFAULT_DREAM_TICK_MS,
  discoverDreamProjects,
  dshDreamSeams,
  registerDshDreamer,
} from "./dreamer";

const PROJECT_A = "git:/tmp/dsh-proj-a";
const PROJECT_B = "dir:/tmp/dsh-proj-b";

async function cleanupDir(dir: string): Promise<void> {
  // Windows WAL: the DB handle's close is not immediately reflected in file
  // locks; retry like the other dsh-plugin suites do.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function openDb(): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  const dir = createTestStorageDir();
  const db = await createTestDb(join(dir, "context.db"));
  return { db, cleanup: () => cleanupDir(dir) };
}

function insertSessionProject(
  db: Database,
  sessionId: string,
  harness: string,
  projectPath: string,
): void {
  db.prepare(
    "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
  ).run(sessionId, harness, projectPath, Date.now());
}

/** Stub LLM runtime: a single-turn text stream, with optional terminal
 *  finish and per-call options capture. */
function stubLlm(
  opts: { text?: string; finish?: StreamChunk["reason"]; calls?: GenerateOptions[] } = {},
): LlmRuntime {
  const text = opts.text ?? "stub dreamer answer";
  const calls = opts.calls ?? [];
  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls.push(options);
    if (opts.finish) {
      yield { type: "finish", reason: opts.finish };
      return;
    }
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  return { stream } as unknown as LlmRuntime;
}

interface FakeCtx {
  ctx: Context;
  /** Disposers returned by the stubbed ctx.effect (fiber disposal simulation). */
  disposers: Array<() => void>;
  /** Event listeners registered via ctx.on, by event name. */
  listeners: Map<string, Array<(payload: unknown) => void | Promise<void>>>;
  /** Fire all handlers registered for one event, in order. */
  fire(event: string, payload: unknown): Promise<void>;
  /** Register an extra service in the ctx.get map. */
  service(name: string, value: unknown): void;
}

function makeFakeCtx(
  opts: { llm?: LlmRuntime; config?: unknown; agentDefaultModel?: unknown } = {},
): FakeCtx {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
  const services = new Map<string, unknown>();
  const ctx = {
    get: (name: string) => {
      if (name === "llm") return opts.llm;
      if (name === "agentDefaultModel") return opts.agentDefaultModel;
      return services.get(name);
    },
    on: (event: string, handler: (payload: unknown) => void | Promise<void>) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect: (execute: () => () => void) => {
      disposers.push(execute());
      return () => {};
    },
    config: opts.config,
  };
  return {
    ctx: ctx as unknown as Context,
    disposers,
    listeners,
    fire: async (event: string, payload: unknown) => {
      for (const handler of listeners.get(event) ?? []) await handler(payload);
    },
    service: (name: string, value: unknown) => {
      services.set(name, value);
    },
  };
}

interface CapturedInterval {
  fn: () => void;
  ms: number;
  disposed: boolean;
}

/** Replace the interval factory with a capture (fake timers). */
function captureIntervals(): { set: CapturedInterval[] } {
  const set: CapturedInterval[] = [];
  __test.setIntervalFactory((fn, ms) => {
    const record: CapturedInterval = { fn, ms, disposed: false };
    set.push(record);
    return () => {
      record.disposed = true;
    };
  });
  return { set };
}

/** Let host.ready continuation + initial tick passes settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

afterEach(() => {
  __test.reset();
});

describe("discoverDreamProjects", () => {
  it("returns deduped dsh-harness project identities in stable order", async () => {
    const { db, cleanup } = await openDb();
    try {
      insertSessionProject(db, "s1", "dsh", PROJECT_A);
      insertSessionProject(db, "s2", "dsh", PROJECT_B);
      insertSessionProject(db, "s3", "dsh", PROJECT_A); // duplicate identity
      insertSessionProject(db, "s4", "opencode", "git:/tmp/oc-proj");
      insertSessionProject(db, "s5", "pi", "git:/tmp/pi-proj");
      // ORDER BY project_path: "dir:…" sorts before "git:…".
      expect(discoverDreamProjects(db)).toEqual([PROJECT_B, PROJECT_A]);
    } finally {
      db.close();
      await cleanup();
    }
  });
});

describe("createDshDreamClient (DreamTimerClient-shaped facade)", () => {
  it("creates a session and serves the direct-LLM turn via prompt + messages + delete", async () => {
    const { db, cleanup } = await openDb();
    try {
      const calls: GenerateOptions[] = [];
      const { ctx } = makeFakeCtx({ llm: stubLlm({ text: "dreamer answer", calls }) });
      const facade = createDshDreamClient(ctx, { db });

      const created = await facade.session.create({
        body: { title: "dream" },
        query: { directory: "/workspace" },
      });
      expect(typeof created.id).toBe("string");

      await facade.session.prompt({
        path: { id: created.id },
        query: { directory: "/workspace" },
        body: {
          agent: "dreamer-classifier",
          system: "classify now",
          parts: [{ type: "text", text: "memory content" }],
        },
      });

      expect(calls).toHaveLength(1);
      const options = calls[0]!;
      expect(options.provider).toBe("deepseek"); // fallback current route
      expect(options.model).toBe("deepseek-chat");
      expect(options.system).toBe("classify now");
      expect(options.purpose).toBeUndefined(); // ordinary auxiliary call
      const userMessage = options.messages[0] as unknown as {
        role: string;
        content: Array<{ type: string; text: string }>;
      };
      expect(userMessage.role).toBe("user");
      expect(userMessage.content[0]?.text).toContain("memory content");

      const response = await facade.session.messages({
        path: { id: created.id },
        query: { limit: 50 },
      });
      expect(response.data).toHaveLength(2);
      expect(extractLatestAssistantText(response.data)).toBe("dreamer answer");

      await facade.session.delete({ path: { id: created.id } });
      expect((await facade.session.messages({ path: { id: created.id } })).data).toEqual([]);
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("fails transiently for tool-requiring agents when no live agent is present", async () => {
    const { db, cleanup } = await openDb();
    try {
      const { ctx } = makeFakeCtx({ llm: stubLlm() });
      const facade = createDshDreamClient(ctx, { db });
      for (const agent of [
        "dreamer", // curate
        "dreamer-docs", // maintain-docs
        "dreamer-primer-investigator", // refresh-primers
        "dreamer-memory-mapper", // map-memories / verify / verify-broad
      ]) {
        const { id } = await facade.session.create({});
        const failure = facade.session.prompt({
          path: { id },
          body: { agent, parts: [{ type: "text", text: "x" }] },
        });
        await expect(failure).rejects.toThrow(/no live Magic agent available/);
        await failure.catch((error: Error & { transient?: boolean }) => {
          expect(error.transient).toBe(true); // hot-retry classification
        });
      }
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("runs tool-requiring agents through a borrowed-parent worker and serves synthetic tool parts", async () => {
    const { db, cleanup } = await openDb();
    try {
      const starts: Array<{ provider: string; request: Record<string, unknown> }> = [];
      // Fake top-level parent agent (workspace matches the dream session).
      const parentAgent = {
        id: "parent-session-1",
        session: { header: { cwd: "/workspace" } },
        options: {},
      };
      // Fake child: its session log carries one ctx_memory call + a completed
      // result, plus one failed call (no pairing) for count realism.
      const childAgent = {
        id: "child-session-1",
        session: {
          header: { origin: "subagent", delegationDepth: 1 },
          events: [
            {
              type: "tool/call",
              data: {
                callId: "c1",
                name: "ctx_memory",
                arguments: JSON.stringify({ action: "update", id: 7, content: "rewritten" }),
              },
            },
            { type: "tool/result", data: { callId: "c1", message: { content: [] } } },
            {
              type: "tool/call",
              data: { callId: "c2", name: "read", arguments: JSON.stringify({ path: "/x" }) },
            },
            {
              type: "tool/result",
              data: { callId: "c2", message: { content: [] }, error: { name: "E", code: "X" } },
            },
          ],
        },
      };
      const { ctx, fire, service } = makeFakeCtx({ llm: stubLlm() });
      service("subagents", {
        start: async (provider: string, request: Record<string, unknown>) => {
          starts.push({ provider, request });
          return {
            id: "child-session-1",
            localAgent: childAgent,
            result: Promise.resolve({
              output: [{ type: "text", text: "curated" }],
              stopReason: "completed",
            }),
            dispose: async () => {},
          };
        },
      });
      const facade = createDshDreamClient(ctx, { db });
      // Feed the presence registry (the agent/created subscription inside the facade).
      await fire("agent/created", { agent: parentAgent });

      const { id } = await facade.session.create({ query: { directory: "/workspace" } });
      await facade.session.prompt({
        path: { id },
        query: { directory: "/workspace" },
        body: {
          agent: "dreamer",
          system: "curate memories",
          parts: [{ type: "text", text: "curate this" }],
        },
      });

      // Spawn: one-shot worker with the curate tool profile and persona.
      expect(starts).toHaveLength(1);
      expect(starts[0]!.provider).toBe("spawn");
      const request = starts[0]!.request;
      expect(request.label).toBe("magic-dream-dreamer");
      expect(request.maxDepth).toBe(0);
      expect(request.toolFilter).toEqual({ allow: ["ctx_memory", "ctx_memory_list"] });
      expect(request.persona).toBe("curate memories");
      const promptBlocks = request.prompt as Array<{ type: string; text?: string }>;
      expect(promptBlocks[0]?.text).toBe("curate this");

      // messages: user + assistant(text + completed ctx_memory tool part).
      const response = await facade.session.messages({ path: { id } });
      expect(response.data).toHaveLength(2);
      expect(extractLatestAssistantText(response.data)).toBe("curated");
      const assistant = response.data[1] as {
        parts: Array<{ type: string; tool?: string; state?: Record<string, unknown> }>;
      };
      const toolParts = assistant.parts.filter((part) => part.type === "tool");
      // 1 completed-call part + 1 count-only filler part (toolCallCount 2 − 1).
      expect(toolParts).toHaveLength(2);
      expect(toolParts[0]!.tool).toBe("ctx_memory");
      expect(toolParts[0]!.state).toEqual({
        status: "completed",
        input: { action: "update", id: 7, content: "rewritten" },
        output: "completed",
      });
      expect(toolParts[1]!.tool).toBe("investigation");
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("marks a failed dream worker run as transient", async () => {
    const { db, cleanup } = await openDb();
    try {
      const parentAgent = {
        id: "parent-session-2",
        session: { header: { cwd: "/workspace" } },
        options: {},
      };
      const { ctx, fire, service } = makeFakeCtx({ llm: stubLlm() });
      service("subagents", {
        start: async () => ({
          id: "child-session-2",
          localAgent: { id: "child-session-2", session: { header: {}, events: [] } },
          result: Promise.resolve({
            output: [],
            stopReason: "error",
            diagnostic: "model exploded",
          }),
          dispose: async () => {},
        }),
      });
      const facade = createDshDreamClient(ctx, { db });
      await fire("agent/created", { agent: parentAgent });
      const { id } = await facade.session.create({ query: { directory: "/workspace" } });
      const failure = facade.session.prompt({
        path: { id },
        body: { agent: "dreamer-docs", parts: [{ type: "text", text: "x" }] },
      });
      await expect(failure).rejects.toThrow(/dream tool worker ended \(error\)/);
      await failure.catch((error: Error & { transient?: boolean }) => {
        expect(error.transient).toBe(true);
      });
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("propagates LLM error / abort / empty output as rejected prompts", async () => {
    const { db, cleanup } = await openDb();
    try {
      const { ctx } = makeFakeCtx({
        llm: stubLlm({ finish: { kind: "error", failure: { message: "boom", code: "X" } } }),
      });
      const facade = createDshDreamClient(ctx, { db });
      const { id } = await facade.session.create({});
      await expect(
        facade.session.prompt({ path: { id }, body: { parts: [{ type: "text", text: "x" }] } }),
      ).rejects.toThrow(/LLM stream failed \(boom\)/);

      const { ctx: abortedCtx } = makeFakeCtx({
        llm: stubLlm({ finish: { kind: "aborted", failure: { message: "gone", code: "X" } } }),
      });
      const abortedFacade = createDshDreamClient(abortedCtx, { db });
      const { id: abortedId } = await abortedFacade.session.create({});
      await expect(
        abortedFacade.session.prompt({ path: { id: abortedId }, body: { parts: [{ type: "text", text: "x" }] } }),
      ).rejects.toThrow(/LLM stream failed \(aborted\)/);

      const { ctx: emptyCtx } = makeFakeCtx({ llm: stubLlm({ text: "" }) });
      const emptyFacade = createDshDreamClient(emptyCtx, { db });
      const { id: emptyId } = await emptyFacade.session.create({});
      await expect(
        emptyFacade.session.prompt({ path: { id: emptyId }, body: { parts: [{ type: "text", text: "x" }] } }),
      ).rejects.toThrow(/returned no text/);
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("honors the per-attempt body.model override and an already-aborted signal", async () => {
    const { db, cleanup } = await openDb();
    try {
      const calls: GenerateOptions[] = [];
      const { ctx } = makeFakeCtx({ llm: stubLlm({ calls }) });
      const facade = createDshDreamClient(ctx, { db });
      const { id } = await facade.session.create({});
      await facade.session.prompt({
        path: { id },
        body: {
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          parts: [{ type: "text", text: "x" }],
        },
      });
      expect(calls[0]?.provider).toBe("anthropic");
      expect(calls[0]?.model).toBe("claude-sonnet-4-6");

      const aborted = new AbortController();
      aborted.abort();
      await expect(
        facade.session.prompt({ path: { id }, signal: aborted.signal, body: { parts: [{ type: "text", text: "x" }] } }),
      ).rejects.toThrow("prompt aborted by external signal");
    } finally {
      db.close();
      await cleanup();
    }
  });
});

describe("dshDreamSeams (/ctx-dream seam)", () => {
  it("returns tasks/executor/runnable/scheduleSummary for the default enabled config", async () => {
    const { db, cleanup } = await openDb();
    try {
      const { ctx } = makeFakeCtx({ llm: stubLlm() });
      const seam = dshDreamSeams(ctx, { db });
      // Default config enables every canonical task EXCEPT maintain-docs
      // (core DEFAULT_TASK_SCHEDULES leaves it "" — disabled).
      const enabledTasks = CANONICAL_DREAM_TASKS.filter((task) => task !== "maintain-docs");
      expect(seam.tasks.map((task) => task.task)).toEqual([...enabledTasks]);
      expect(seam.tasks.every((task) => task.schedule.trim() !== "")).toBe(true);
      expect(seam.runnable).toBe(true);
      expect(typeof seam.scheduleSummary).toBe("string");
      expect(seam.scheduleSummary).toContain("map-memories 0 2 * * *");
      expect(typeof seam.executor).toBe("function");
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("reports runnable=false when compaction-off is configured", async () => {
    const { db, cleanup } = await openDb();
    try {
      const { ctx } = makeFakeCtx({ llm: stubLlm() });
      const seam = dshDreamSeams(ctx, { db, compactionOff: true });
      expect(seam.runnable).toBe(false);
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("seam runnable reflects registerDshDreamer's disabled config", async () => {
    const { db, cleanup } = await openDb();
    try {
      const { ctx } = makeFakeCtx({ llm: stubLlm() });
      registerDshDreamer(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: "/tmp", livenessPath: "/tmp/l" }),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
        config: { enabled: false },
        log: () => {},
      });
      const seam = dshDreamSeams(ctx, { db });
      expect(seam.runnable).toBe(false);
    } finally {
      db.close();
      await cleanup();
    }
  });

  it("executor records a mural-disabled compress-cues as skipped with telemetry", async () => {
    const { db, cleanup } = await openDb();
    try {
      const { ctx } = makeFakeCtx({ llm: stubLlm() });
      const seam = dshDreamSeams(ctx, { db });
      // Upstream v0.43+: an unavailable task is accounted as skipped (with a
      // reason), never as success — mural is disabled by default, so
      // compress-cues has nothing to work on.
      const outcome = await seam.executor(
        { task: "compress-cues", schedule: "", timeoutMinutes: 20 },
        { db, projectIdentity: PROJECT_A, holderId: "test-holder", leaseKey: `memory:${PROJECT_A}` },
      );
      expect(outcome.status).toBe("skipped");
      const runs = getDreamRuns(db, PROJECT_A);
      expect(runs.some((run) => run.tasks_json.includes("compress-cues"))).toBe(true);
    } finally {
      db.close();
      await cleanup();
    }
  });
});

describe("registerDshDreamer (schedule timer)", () => {
  it("registers one interval per discovered project; ticks seed the scheduler state", async () => {
    const { db, cleanup } = await openDb();
    const captured = captureIntervals();
    try {
      insertSessionProject(db, "s1", "dsh", PROJECT_A);
      insertSessionProject(db, "s2", "dsh", PROJECT_B);
      insertSessionProject(db, "s3", "opencode", "git:/tmp/oc-proj"); // excluded
      // Upstream v0.43+ seeds a task row only once the identity has the input
      // the task works on: an active memory for the memory tasks, a bound
      // session for retrospective. Tasks without input get no row.
      insertMemory(db, { projectPath: PROJECT_A, category: "PROJECT_RULES", content: "mem-a" });
      insertMemory(db, { projectPath: PROJECT_B, category: "PROJECT_RULES", content: "mem-b" });
      const expectedSeeded = [...CANONICAL_DREAM_TASKS].filter((task) =>
        task === "retrospective" ||
        ["map-memories", "verify", "verify-broad", "curate", "compress-cues", "classify-memories"].includes(task),
      );
      const logs: string[] = [];
      const { ctx, disposers } = makeFakeCtx({});
      // Initial passes now wait out the shared boot quiet period + stagger
      // (opencode mirror): zero both for determinism (quiet already elapsed,
      // jitter slot 0 → immediate).
      setBootQuietPeriodForTests(Date.now() - 240_000);
      __test.setStartupJitterSlotMs(0);
      registerDshDreamer(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: "/tmp", livenessPath: "/tmp/l" }),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
        directory: "/workspace",
        config: { enabled: true, tickMs: 1000 },
        log: (message) => logs.push(message),
      });
      await flush();
      await flush();

      // ONE shared interval over the discovered project set (ticks union in
      // live-observed identities from the presence map).
      expect(captured.set).toHaveLength(1);
      expect(captured.set.map((interval) => interval.ms)).toEqual([1000]);
      expect(logs.some((m) => m.includes("registered schedule timer"))).toBe(true);

      // The immediate initial pass already ran the core scheduler: every task
      // that has input has a seeded row with a future next_due_at and no run
      // (the memory tasks via the seeded memories, retrospective via the bound
      // session). Tasks without input (maintain-docs, smart notes, primers,
      // user-memory review) get no row at all.
      for (const project of [PROJECT_A, PROJECT_B]) {
        const states = getTaskScheduleStatesForProject(db, project);
        expect(states.map((state) => state.task).sort()).toEqual(
          [...expectedSeeded].sort(),
        );
        for (const state of states) {
          expect(state.nextDueAt).toBeGreaterThan(Date.now() - 60_000);
          expect(state.lastStatus).toBeNull();
        }
      }

      // Firing a captured tick is safe with nothing due (no LLM) and keeps the
      // state stable.
      captured.set[0]!.fn();
      await flush();
      expect(getTaskScheduleStatesForProject(db, PROJECT_A)).toHaveLength(expectedSeeded.length);

      // Fiber disposal stops every interval.
      for (const dispose of disposers) dispose();
      expect(captured.set.every((interval) => interval.disposed)).toBe(true);
    } finally {
      __test.reset();
      db.close();
      await cleanup();
    }
  });

  it("does not register intervals when dreamer is disabled", async () => {
    const { db, cleanup } = await openDb();
    const captured = captureIntervals();
    try {
      insertSessionProject(db, "s1", "dsh", PROJECT_A);
      const logs: string[] = [];
      const { ctx } = makeFakeCtx({});
      registerDshDreamer(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: "/tmp", livenessPath: "/tmp/l" }),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
        config: { enabled: false },
        log: (message) => logs.push(message),
      });
      await flush();
      expect(captured.set).toHaveLength(0);
      expect(logs.some((m) => m.includes("disabled"))).toBe(true);
    } finally {
      __test.reset();
      db.close();
      await cleanup();
    }
  });

  it("does not register intervals when the host bootstrap is refused", async () => {
    const { db, cleanup } = await openDb();
    const captured = captureIntervals();
    try {
      const logs: string[] = [];
      const { ctx } = makeFakeCtx({});
      registerDshDreamer(ctx, {
        host: {
          ready: Promise.resolve({ kind: "refused", reason: "schema-fence", detail: null }),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
        log: (message) => logs.push(message),
      });
      await flush();
      expect(captured.set).toHaveLength(0);
      expect(logs.some((m) => m.includes("schema-fence"))).toBe(true);
    } finally {
      __test.reset();
      db.close();
      await cleanup();
    }
  });

  it("defaults tickMs to 15 minutes", async () => {
    const { db, cleanup } = await openDb();
    const captured = captureIntervals();
    try {
      insertSessionProject(db, "s1", "dsh", PROJECT_A);
      const { ctx } = makeFakeCtx({});
      registerDshDreamer(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: "/tmp", livenessPath: "/tmp/l" }),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
        log: () => {},
      });
      await flush();
      expect(captured.set).toHaveLength(1);
      expect(captured.set[0]?.ms).toBe(DEFAULT_DREAM_TICK_MS);
    } finally {
      __test.reset();
      db.close();
      await cleanup();
    }
  });
});
