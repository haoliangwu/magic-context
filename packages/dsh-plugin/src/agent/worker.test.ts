import { describe, expect, it } from "bun:test";
import { isMagicChildSession, runMagicWorker } from "./worker";

/** Fake subagents service capturing the activation spec. */
function fakeSubagents(runResult?: { ok: true; output: { type: "text"; text: string }[] }) {
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    startActivation: async (spec: Record<string, unknown>) => {
      calls.push(spec);
      const id = `child-${calls.length}`;
      return {
        childId: id,
        result: Promise.resolve(
          runResult ?? { ok: true, output: [{ type: "text", text: "worker output" }] },
        ),
        dispose: () => {},
      };
    },
  };
  return { service, calls };
}

function makeCtx(subagents: unknown) {
  return {
    get: (name: string) => (name === "subagents" ? subagents : undefined),
  };
}

describe("magic worker (PLAN §5.13 minimal worker)", () => {
  it("spawns with depth 0 and caller delivery and returns the text", async () => {
    const { service, calls } = fakeSubagents();
    const ctx = makeCtx(service);
    const parent = {
      session: { header: {} },
    } as never;
    const result = await runMagicWorker(ctx as never, {
      parent,
      label: "magic-worker-test",
      prompt: "do the thing",
      allow: ["read", "ctx_search"],
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(result?.text).toBe("worker output");
    expect(calls).toHaveLength(1);
    const spec = calls[0] as {
      provider?: string;
      label?: string;
      delivery?: string;
      request?: { maxDepth?: number; prompt?: { text?: string }[] };
    };
    expect(spec.provider).toBe("spawn");
    expect(spec.label).toBe("magic-worker-test");
    expect(spec.delivery).toBe("caller");
    expect(spec.request?.maxDepth).toBe(0);
    // DSH 0.2.1 composes children from their preset: the tool allowlist is
    // advisory only and no per-request toolFilter is sent.
    expect(spec.request?.prompt?.[0]?.text).toBe("do the thing");
  });

  it("returns null on failure / missing service (never throws)", async () => {
    // No subagents service.
    const noService = await runMagicWorker(makeCtx(undefined) as never, {
      parent: { session: { header: {} } } as never,
      label: "x",
      prompt: "x",
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(noService).toBeNull();
    // Failed run.
    const failing = fakeSubagents();
    failing.service.startActivation = async () => ({
      childId: "child-f",
      result: Promise.resolve({ ok: false, reason: "model_failed", error: "boom" }),
      dispose: () => {},
    });
    const failed = await runMagicWorker(makeCtx(failing.service) as never, {
      parent: { session: { header: {} } } as never,
      label: "x",
      prompt: "x",
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(failed).toBeNull();
  });
});

describe("recursion isolation (PLAN §9)", () => {
  it("identifies child sessions by origin or delegation depth", () => {
    const base = { session: { header: {} } };
    expect(isMagicChildSession(base as never)).toBe(false);
    expect(isMagicChildSession({ session: { header: { origin: "subagent" } } } as never)).toBe(
      true,
    );
    expect(isMagicChildSession({ session: { header: { delegationDepth: 1 } } } as never)).toBe(
      true,
    );
    expect(isMagicChildSession({ session: { header: { delegationDepth: 3 } } } as never)).toBe(
      true,
    );
    expect(isMagicChildSession({ session: { header: { delegationDepth: 0 } } } as never)).toBe(
      false,
    );
  });
});
