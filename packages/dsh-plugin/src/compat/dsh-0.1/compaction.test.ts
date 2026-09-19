/**
 * compat/dsh-0.1/compaction — Magic compaction engine seam tests.
 *
 * The engine loads wherever the patched shipped preset row points (ADR 0001),
 * including sibling profiles that share the global-store preset copy without
 * mounting Magic Context. The summarize() contract under test:
 *  - host service present + hook wired → the Magic hook runs;
 *  - host present, hook not wired (MC composition, agent plane late) → loud throw;
 *  - host ABSENT (non-MC composition) → degrade to the stock engine behavior.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { MagicCompactionEngine } from "./compaction";

interface StubCtx {
  on: () => () => void;
  get: (name: string) => unknown;
}

function makeCtx(host: unknown): StubCtx {
  return {
    on: () => () => {},
    get: (name: string) => (name === "magicContextHost" ? host : undefined),
    // Service-constructor seam: the engine's prototype chain registers itself.
    reflect: { provide: () => {} },
  } as unknown as StubCtx;
}

/** Replace the stock engine's summarize with a spy; returns (calls, restore). */
function spyStockSummarize(): { calls: number[]; restore: () => void } {
  const original = BasicCompactionEngine.prototype.summarize;
  const calls: number[] = [];
  BasicCompactionEngine.prototype.summarize = async function (
    this: BasicCompactionEngine,
    input: { i?: number },
  ): Promise<never> {
    calls.push(input.i ?? -1);
    throw new Error(`stock-summarize-${calls.length}`);
  };
  return { calls, restore: () => { BasicCompactionEngine.prototype.summarize = original; } };
}

describe("MagicCompactionEngine.summarize wiring", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });

  it("runs the Magic hook when the host service exposes one", async () => {
    const seen: unknown[] = [];
    const hook = (input: unknown) => {
      seen.push(input);
      return { summary: [], provider: "p", model: "m" } as never;
    };
    const engine = new MagicCompactionEngine(
      makeCtx({ summarizeHook: () => hook }) as never,
      {},
    );
    const input = { i: 1 };
    await engine.summarize(input as never, {} as never);
    expect(seen).toEqual([input]);
  });

  it("prefers a config-supplied hook (test seam) over the host service", async () => {
    const configSeen: unknown[] = [];
    const engine = new MagicCompactionEngine(makeCtx({ summarizeHook: () => () => {} }) as never, {
      summarize: (input: unknown) => {
        configSeen.push(input);
        return { summary: [], provider: "p", model: "m" } as never;
      },
    });
    await engine.summarize({ i: 2 } as never, {} as never);
    expect(configSeen).toEqual([{ i: 2 }]);
  });

  it("throws loudly when the host is present but the hook is not wired (fail closed)", async () => {
    const engine = new MagicCompactionEngine(makeCtx({}) as never, {});
    await expect(
      engine.summarize({} as never, {} as never),
    ).rejects.toThrow("agent plane not wired");
  });

  it("degrades to the stock engine when the host service is absent (non-MC profile)", async () => {
    const spy = spyStockSummarize();
    restores.push(spy.restore);
    const engine = new MagicCompactionEngine(makeCtx(undefined) as never, {});
    await expect(
      engine.summarize({ i: 3 } as never, {} as never),
    ).rejects.toThrow("stock-summarize-1");
    expect(spy.calls).toEqual([3]);
  });
});
