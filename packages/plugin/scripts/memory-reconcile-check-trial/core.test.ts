import { expect, test } from "bun:test";
import { gateDecision, evaluate, newerNeighbors, reconcilePrompt, sample, smallBatches, type Decision, type Memory, type Target } from "./core";

const memory = (id: number, content: string, createdAt = id): Memory => ({ id, content, createdAt, category: "CONSTRAINTS", source: "historian", importance: 5, retrievalCount: 0, seenCount: 0, mappedFiles: [], hasNoFileSentinel: false });
const target: Target = { memory: memory(7, "Paging keeps a 64 KiB frame bound. Refuse with MC-H06 and use `paging.limit` in src/wire.ts."), newer: [{ memory: memory(8, "The frame bound is now 128 KiB."), lane: "semantic", score: 0.9 }], evidence: [{ path: "src/wire.ts", line: 4, text: "const FRAME_LIMIT = 128 * 1024;" }] };
const partial = (text: string): Decision => ({ id: 7, verdict: "partly_replaced", text, reason: "Bound changed", claims: [{ quote: "Paging keeps a 64 KiB frame bound.", status: "replaced", source: "memory:8", evidence: "The frame bound is now 128 KiB.", reason: "Increased" }, { quote: "Refuse with MC-H06 and use `paging.limit` in src/wire.ts.", status: "keep" }] });

test("partial gate rejects a dropped refusal code and retains original memory", () => {
    const g = gateDecision(partial("Paging keeps a 128 KiB frame bound; use `paging.limit` in src/wire.ts."), target);
    expect(g.rejected).toBe(true);
    expect(g.violations).toContain("Dropped concrete token: MC-H06");
    expect(g.effective.verdict).toBe("still_true");
    expect(g.effective.text).toBeUndefined();
});
test("partial gate rejects a dropped bound without an evidenced claim waiver", () => {
    const d = partial("Refuse with MC-H06 and use `paging.limit` in src/wire.ts.");
    d.claims[0] = { quote: "Paging keeps a 64 KiB frame bound.", status: "keep" };
    d.claims.push({ quote: "use `paging.limit`", status: "replaced", source: "src/wire.ts:4", evidence: "const FRAME_LIMIT = 128 * 1024;", reason: "Changed" });
    expect(gateDecision(d, target).violations).toContain("Dropped concrete token: 64 KiB");
});
test("partial gate accepts preserved claims and scoped verbatim value changes", () => {
    expect(gateDecision(partial("Paging keeps a 128 KiB frame bound. Refuse with MC-H06 and use `paging.limit` in src/wire.ts."), target).rejected).toBe(false);
    const d = partial(target.memory.content);
    d.claims[0]!.quote = "Invented old claim";
    expect(gateDecision(d, target).rejected).toBe(true);
});
test("whole retirement requires a quote from the named provided source", () => {
    const t: Target = { ...target, memory: memory(7, "Paging keeps a 64 KiB frame bound.") };
    const d = { ...partial(""), verdict: "replaced" as const, claims: [partial("").claims[0]!] };
    expect(gateDecision(d, t).rejected).toBe(false);
    d.claims[0] = { ...d.claims[0]!, evidence: "The frame bound is now 256 KiB." };
    const g = gateDecision(d, t);
    expect(g.rejected).toBe(true);
    expect(g.effective.verdict).toBe("still_true");
    expect(g.violations).toContain("Replacement lacks a verbatim quote from its provided source");
});
test("evidence cannot be borrowed from another source or a target", () => {
    const d = partial(target.memory.content);
    d.claims[0] = { ...d.claims[0]!, source: "memory:7", evidence: target.memory.content };
    expect(gateDecision(d, target).rejected).toBe(true);
    d.claims[0] = { ...partial("").claims[0]!, source: "src/wire.ts:4" };
    expect(gateDecision(d, target).rejected).toBe(true);
});
test("whole retirement cannot delete inventoried surviving claims", () => {
    expect(gateDecision({ ...partial(""), verdict: "replaced" }, target).violations).toContain("Whole retirement has surviving claims");
});
test("malformed or wrong-order batches fall back without a retry", () => {
    for (const raw of ["not json", "[]", JSON.stringify([{ ...partial(target.memory.content), id: 8 }]), JSON.stringify([{ ...partial(target.memory.content), claims: null }])]) {
        const result = evaluate(raw, [target]);
        expect(result.schemaError).toBeDefined();
        expect(result.gates[0]!.effective.verdict).toBe("still_true");
    }
});
test("valid unsure remains unsure rather than a retirement", () => {
    const d: Decision = { id: 7, verdict: "unsure", reason: "Insufficient context", claims: [{ quote: target.memory.content, status: "keep" }] };
    const r = evaluate(JSON.stringify([d]), [target]);
    expect(r.schemaError).toBeUndefined();
    expect(r.gates[0]!.rejected).toBe(false);
    expect(r.gates[0]!.effective.verdict).toBe("unsure");
});
test("retrieval uses six semantic plus two disjoint BM25-only strictly newer slots", () => {
    const pool = [memory(1, "needle older", 1), memory(2, "needle target", 2), memory(3, "needle simultaneous", 2), ...Array.from({ length: 10 }, (_, i) => memory(i + 4, "needle newer", i + 4))];
    const vectors = new Map(pool.map(m => [m.id, new Float32Array([1, 0])]));
    const result = newerNeighbors(pool[1]!, pool, vectors);
    expect(result.filter(n => n.lane === "semantic").map(n => n.memory.id)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.filter(n => n.lane === "bm25").map(n => n.memory.id)).toEqual([10, 11]);
    expect(new Set(result.map(n => n.memory.id)).size).toBe(8);
    expect(result.every(n => n.memory.createdAt > 2)).toBe(true);
    expect(newerNeighbors(pool[1]!, pool, new Map()).every(n => n.lane === "bm25")).toBe(true);
    expect(newerNeighbors(pool.at(-1)!, pool, vectors)).toEqual([]);
});
test("readable prompts contain complete texts ages and path-line evidence", () => {
    const p = reconcilePrompt([target], 86400007);
    expect(p).toContain("age: 1.0 days · source: historian");
    expect(p).toContain(target.memory.content);
    expect(p).toContain(target.newer[0]!.memory.content);
    expect(p).toContain("src/wire.ts:4: const FRAME_LIMIT = 128 * 1024;");
    expect(p).not.toContain('"content":');
    const batches = smallBatches(Array.from({ length: 12 }, () => target), "test", 86400007);
    expect(batches.map(b => b.targets.length)).toEqual([5, 5, 2]);
});
test("extra sample is reproducible independent of pool order", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
    expect(sample(rows, 100, "seed")).toEqual(sample([...rows].reverse(), 100, "seed"));
    expect(new Set(sample(rows, 100, "seed").map(m => m.id)).size).toBe(100);
});
