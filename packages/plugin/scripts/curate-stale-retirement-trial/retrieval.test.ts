import { expect, test } from "bun:test";
import { bm25, frequencies, identifiers, normalizeVector, rankEvidence, tokens, topicBatches } from "./retrieval";
import type { Memory } from "./core";
const memory = (id: number, content: string): Memory => ({ id, content, category: "ARCHITECTURE", source: "test", createdAt: 0, importance: 40, seenCount: 1, retrievalCount: 0, mappedFiles: [], hasNoFileSentinel: false });

test("identifier extraction retains paths, config keys and old design names without labels", () => {
    const terms = identifiers(memory(1, "Synthetic design r6 invokes `alpha.beta` in src/a.ts"), new Map());
    expect(terms).toContain("r6"); expect(terms).toContain("alpha.beta"); expect(terms).toContain("src/a.ts");
});
test("real evidence ranking caps at 15 and preserves current-design quota", () => {
    const rows = Array.from({length: 30}, (_, i) => ({path: "src/fixture.ts", line: i + 1, text: "alpha.beta"}));
    const design = rows.map(r => ({...r, path: "design.md"}));
    const evidence = rankEvidence(memory(1, "alpha.beta"), ["alpha.beta"], design, rows);
    expect(evidence).toHaveLength(15); expect(evidence.filter(e => e.path === "design.md")).toHaveLength(8);
    expect(evidence[0]).toEqual(design[0]!);
});
test("vector decoding normalizes copied float32 bytes and rejects corrupt vectors", () => {
    const bytes = new Uint8Array(new Float32Array([3, 4]).buffer);
    expect(Array.from(normalizeVector(bytes)!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(normalizeVector(new Uint8Array(3))).toBeUndefined();
    expect(normalizeVector(new Uint8Array(new Float32Array([NaN]).buffer))).toBeUndefined();
});
test("BM25 fallback ranks a shared identifier above an unrelated document", () => {
    const docs = [tokens("alpha.beta rotates"), tokens("gamma.delta waits")], df = frequencies(docs);
    expect(bm25(["alpha.beta"], docs[0]!, df, 2, 2)).toBeGreaterThan(bm25(["alpha.beta"], docs[1]!, df, 2, 2));
});
test("topics put cosine neighbors together and cover every id exactly once", () => {
    const rows = [memory(1, "alpha"), memory(2, "gamma"), memory(3, "alpha"), memory(4, "gamma")];
    const vectors = new Map([[1, new Float32Array([1, 0])], [2, new Float32Array([0, 1])], [3, new Float32Array([1, 0])], [4, new Float32Array([0, 1])]]);
    expect(topicBatches(rows, vectors, 2).map(b => b.memories.map(m => m.id))).toEqual([[1, 3], [2, 4]]);
    expect(topicBatches(rows, new Map(), 2).map(b => b.memories.map(m => m.id))).toEqual([[1, 3], [2, 4]]);
});
