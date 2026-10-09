import { describe, expect, test } from "bun:test";
import { bm25, cosine, eligible, mergePrompt, parseDecisions, recordedMemoryFacts, removeMemory, retrieve, trialRoot, type Memory } from "./core";

const memory = (id: number, content: string, created_at = 1, status = "active"): Memory => ({ id, content, category: "ARCHITECTURE", created_at, updated_at: created_at, status, source_type: "historian" });
describe("merge-turn trial controls", () => {
    test("removes only the literal memory span preserving surrounding bytes", () => {
        const original = "α\r\n$&\n<project-memory>known\r\nfacts</project-memory>\r\n<new_messages>unchanged</new_messages>";
        expect(removeMemory(original)).toEqual({ prompt: "α\r\n$&\n\r\n<new_messages>unchanged</new_messages>", block: "<project-memory>known\r\nfacts</project-memory>" });
        expect(() => removeMemory("missing")).toThrow();
        expect(() => removeMemory("<project-memory>x</project-memory><project-memory>y</project-memory>")).toThrow();
    });
    test("time fence excludes equal-time, future and archived memories", () => {
        expect(eligible([memory(1, "old"), memory(2, "equal", 10), memory(3, "future", 11), memory(4, "archived", 1, "archived")], 10).map(m => m.id)).toEqual([1]);
    });
    test("recorded memory pool parses dash bullets and XML escapes", () => {
        expect(recordedMemoryFacts("<project-memory>\n<ARCHITECTURE>\n- ck-mc &lt; 2 &amp; store\n</ARCHITECTURE>\n<CONSTANTS>\n- default: 3\n</CONSTANTS>\n</project-memory>")).toEqual([
            { category: "ARCHITECTURE", content: "ck-mc < 2 & store" }, { category: "CONSTANTS", content: "default: 3" },
        ]);
    });
    test("BM25 ranks independent known passages", () => {
        expect(bm25("sqlite lock", [memory(1, "unrelated rendering"), memory(2, "sqlite busy lock timeout"), memory(3, "sqlite")])[0]!.id).toBe(2);
    });
    test("cosine rejects incompatible spaces and ranks semantic neighbours", () => {
        expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
        expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
        expect(() => cosine(new Float32Array([1]), new Float32Array([1, 0]))).toThrow();
        expect(() => cosine(new Float32Array([0]), new Float32Array([1]))).toThrow();
    });
    test("retrieval reserves lexical fallback without mixing score scales", () => {
        const pool = Array.from({ length: 30 }, (_, i) => memory(i + 1, i < 23 ? "covered fact" : "lexical needle"));
        const vectors = new Map(pool.slice(0, 23).map(m => [m.id, new Float32Array([1, m.id])]));
        const result = retrieve({ category: "ARCHITECTURE", content: "needle" }, pool, vectors, new Float32Array([1, 1]));
        expect(result.length).toBe(20);
        expect(result.filter(r => r.lane === "semantic").length).toBe(15);
        expect(result.filter(r => r.lane === "bm25").map(r => r.id)).toEqual([24, 25, 26, 27, 28]);
        expect(new Set(result.map(m => m.id)).size).toBe(20);
        expect(retrieve({ category: "ARCHITECTURE", content: "needle" }, pool, vectors)[0]!.id).toBe(24);
    });
    test("decision validator rejects omissions, duplicate indices, invented targets and missing rewrites", () => {
        const matches = [bm25("old", [memory(5, "old")])];
        expect(parseDecisions('[{"fact":1,"action":"skip","target":5,"reason":"covered"}]', matches)[0]!.target).toBe(5);
        expect(() => parseDecisions("[]", matches)).toThrow();
        expect(() => parseDecisions('[{"fact":1,"action":"skip","target":6,"reason":"covered"}]', matches)).toThrow();
        expect(() => parseDecisions('[{"fact":1,"action":"merge","target":5,"reason":"extra"}]', matches)).toThrow();
        expect(() => parseDecisions('[{"fact":1,"action":"delete","target":5,"reason":"bad"}]', matches)).toThrow();
        expect(() => parseDecisions('[{"fact":1,"action":"new","reason":"a"},{"fact":1,"action":"new","reason":"b"}]', [matches[0]!, matches[0]!])).toThrow();
        expect(parseDecisions("[]", [])).toEqual([]);
    });
    test("hybrid reuses lexical evidence even for embedded memories outside semantic top fifteen", () => {
        const pool = Array.from({ length: 25 }, (_, i) => memory(i + 1, i === 24 ? "unique constant needle" : "general topic"));
        const vectors = new Map(pool.map(m => [m.id, new Float32Array(m.id === 25 ? [0, 1] : [1, 0])]));
        const lexical = bm25("needle", pool).slice(0, 20);
        const result = retrieve({ category: "ARCHITECTURE", content: "needle" }, pool, vectors, new Float32Array([1, 0]), lexical);
        expect(result.find(m => m.id === 25)?.lane).toBe("bm25");
        expect(result.length).toBe(20);
    });
    test("merge prompt contains each fact and actual candidate ids", () => {
        const prompt = mergePrompt([{ category: "ARCHITECTURE", content: "new rule" }], [bm25("old", [memory(42, "old rule")])]);
        expect(prompt).toContain('"id":42');
        expect(prompt).toContain('"content":"new rule"');
        expect(prompt).toContain("preserve ALL still-valid information");
    });
    test("private root rejects a live store path", () => {
        expect(() => trialRoot("/tmp/live/store")).toThrow();
    });
});
