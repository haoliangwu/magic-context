import { describe, expect, test } from "bun:test";
import { adjacency, agreement, batches, distribution, parseScores, prompt, rubric, sample, type Row } from "./core";

const row = (sequence: number, session = "a"): Row => ({ id: sequence + (session === "a" ? 0 : 3000), session_id: session, sequence, title: `title ${sequence}`, episode_type: "bug", importance: 73, p1: "Full narrative", p2: "Condensed narrative", created_at: sequence });
describe("compartment rescore trial", () => {
    test("triplets span both endpoints and preserve 200 immediate pairs", () => {
        const chosen = sample(Array.from({ length: 2188 }, (_, i) => row(i)));
        expect(chosen).toHaveLength(300);
        expect(chosen[0]!.sequence).toBe(0);
        expect(chosen.at(-1)!.sequence).toBe(2187);
        expect(new Set(chosen.map(r => r.id)).size).toBe(300);
        expect(adjacency(chosen, new Map(chosen.map(r => [r.id, 70])))).toEqual({ pairs: 200, near: 200, share: 1 });
    });
    test("shuffle batches retain every row and exclude chronological neighbours", () => {
        const rows = ["a", "b"].flatMap(s => sample(Array.from({ length: 2188 }, (_, i) => row(i, s))));
        const output = batches(rows, "rescore-triplets-v1");
        expect(output).toHaveLength(30);
        expect(output.flat().map(r => r.id).sort((a, b) => a - b)).toEqual(rows.map(r => r.id).sort((a, b) => a - b));
        for (const batch of output) {
            expect(batch).toHaveLength(20);
            for (const a of batch) for (const b of batch) if (a !== b && a.session_id === b.session_id) expect(Math.abs(a.sequence - b.sequence)).toBeGreaterThan(1);
        }
        expect(batches(rows, "rescore-triplets-v1")).toEqual(output);
    });
    test("candidate projection hides current score and chronology", () => {
        const p = prompt([row(42)], "scored calibration");
        const candidate = JSON.parse(p.split("<candidates>\n")[1]!.split("\n</candidates>")[0]!)[0];
        expect(candidate).toEqual({ id: 42, title: "title 42", episode_type: "bug", p1: "Full narrative" });
        expect(p).not.toContain("Condensed narrative");
        const variant = prompt([row(42)], "scored calibration", true, { a: ["recent title"] });
        expect(variant).toContain("Condensed narrative");
        expect(variant).toContain("recent title");
        expect(variant).not.toContain('"importance":73');
    });
    test("rubric preserves the revised procedure but removes immutability instruction", () => {
        const text = rubric("## Importance — decay rate, not a category score\nset once at creation and never updated. recall\n### Scoring procedure\nJudge it\n---\nprivate");
        expect(text).toContain("### Scoring procedure");
        expect(text).not.toContain("never updated");
        expect(text).not.toContain("private");
        expect(() => rubric("old prompt")).toThrow();
    });
    test("score parser rejects missing duplicate fractional and out-of-range scores", () => {
        const score = { id: 42, importance: 85, reason: "durable invariant" };
        expect(parseScores(`\`\`\`json\n${JSON.stringify([score])}\n\`\`\``, [42])).toEqual([score]);
        for (const bad of [[score, score], [{ ...score, id: 7 }], [{ ...score, importance: 0 }], [{ ...score, importance: 101 }], [{ ...score, importance: 70.5 }], [{ ...score, reason: "two\nlines" }], []]) expect(() => parseScores(JSON.stringify(bad), [42])).toThrow();
    });
    test("distribution uses population SD and rubric band edges", () => {
        expect(distribution([1, 9, 10, 29, 30, 59, 60, 84, 85, 100]).bands).toEqual([2, 2, 2, 2, 2]);
        expect(distribution([1, 3]).sd).toBe(1);
        expect(() => distribution([])).toThrow();
    });
    test("adjacency excludes sample gaps and other sessions", () => {
        const rows = [row(0), row(1), row(3), row(4, "b")];
        expect(adjacency(rows, new Map(rows.map(r => [r.id, r.sequence === 0 ? 10 : 13])))).toEqual({ pairs: 1, near: 0, share: 0 });
    });
    test("noise pairs by identity rather than response order", () => {
        const a = [{ id: 1, importance: 59, reason: "a" }, { id: 2, importance: 90, reason: "b" }];
        const b = [{ id: 2, importance: 88, reason: "b" }, { id: 1, importance: 60, reason: "a" }];
        expect(agreement(a, b)).toMatchObject({ n: 2, mae: 1.5, within2: 2, bandChanges: 1, mean: -0.5 });
        expect(() => agreement(a, [{ id: 3, importance: 60, reason: "x" }])).toThrow();
    });
});
