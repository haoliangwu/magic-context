import { describe, expect, test } from "bun:test";
import { batches, cohort, metrics, parseDraft, prompt, revisionCandidate, safeRepoPath, sample, validateOperations, type Memory } from "./core";

const memory = (id: number, content = "Synthetic durable rule", category = "PROJECT_RULES"): Memory => ({ id, content, category, source: "test", createdAt: 0, importance: 50, retrievalCount: 0, seenCount: 1, mappedFiles: [], hasNoFileSentinel: false });

describe("curate stale retirement trial", () => {
    test("sampling is deterministic, order-independent and excludes targeted strata", () => {
        const rows = [memory(21814), memory(18939), memory(1, "CortexKit extensibility r6.7 scope primitive"), ...Array.from({ length: 90 }, (_, i) => memory(i + 2))];
        const chosen = cohort(rows);
        expect(chosen.revisions.map(m => m.id)).toEqual([1]);
        expect(chosen.random).toHaveLength(80);
        expect(chosen.random.some(m => [1, 21814, 18939].includes(m.id))).toBe(false);
        expect(sample(rows, 10, "seed")).toEqual(sample([...rows].reverse(), 10, "seed"));
        expect(() => sample(rows, 1000, "seed")).toThrow();
    });
    test("design selector includes superseded citations, not a current design's older scope note", () => {
        for (const content of ["In CortexKit extensibility r3, x", "ck-extensibility-design-r6.6.md", "Extensibility policies superseding r5's x", "extensibility specification r7 (renamed from r6.7)"]) expect(revisionCandidate({ content })).toBe(true);
        for (const content of ["CortexKit Extensibility r7 (scope note r5)", "CortexKit extensibility r7.3", "unrelated cache design r6"]) expect(revisionCandidate({ content })).toBe(false);
    });
    test("batches retain every active id once and never mix categories", () => {
        const rows = [memory(1), memory(2, "A", "ARCHITECTURE"), memory(3, "B", "NAMING")];
        expect(batches(rows).map(b => [b.category, b.memories.map(m => m.id)])).toEqual([["PROJECT_RULES", [1]], ["ARCHITECTURE", [2]], ["NAMING", [3]]]);
    });
    test("all arms share retirement rules; only evidence arm gets repository excerpts", () => {
        const batch = batches([memory(1)])[0]!;
        expect(prompt(batch, "text")).toContain("no repository access");
        expect(prompt(batch, "text")).not.toContain('"reads"');
        expect(prompt(batch, "evidence")).toContain("REAL read-only git grep excerpts");
        for (const arm of ["text", "evidence", "topic"] as const) expect(prompt(batch, arm)).toContain("Low value alone is not a retirement reason");
    });
    test("terminal parsing refuses mixed operations and source requests", () => {
        expect(parseDraft('```json\n{"operations":[]}\n```')).toEqual({ operations: [] });
        expect(parseDraft('{"reads":[{"path":"a"}]}').reads).toHaveLength(1);
        expect(() => parseDraft('{"operations":[],"reads":[{"path":"a"}]}')).toThrow();
        expect(() => parseDraft("{}")).toThrow();
    });
    test("retirement validation rejects missing evidence, foreign ids and duplicate actions", () => {
        const valid = { action: "retire" as const, ids: [1], reason: "Explicit contradiction", replacement: "Current source" };
        expect(() => validateOperations([valid], new Set([1]))).not.toThrow();
        expect(() => validateOperations([{ ...valid, replacement: "" }], new Set([1]))).toThrow();
        expect(() => validateOperations([valid], new Set([2]))).toThrow();
        expect(() => validateOperations([valid, valid], new Set([1]))).toThrow();
    });
    test("metrics count unsure separately and exclude duplicate pool decisions", () => {
        const labels = [{ id: 1, label: "stale" as const, reason: "x" }, { id: 2, label: "stale" as const, reason: "x" }, { id: 3, label: "true" as const, reason: "x" }, { id: 4, label: "unsure" as const, reason: "x" }];
        const result = metrics(labels, new Set([1, 3, 4, 100]));
        expect(result.precision).toBe(0.5);
        expect(result.recall).toBe(0.5);
        expect(result.conservativePrecision).toBe(1 / 3);
        expect(result.trueRetired).toEqual([3]);
        expect(result.unsureRetired).toEqual([4]);
        expect(metrics(labels, new Set()).precision).toBeNull();
    });
    test("topic batches cannot consolidate across categories", () => {
        expect(() => validateOperations([{action: "merge", ids: [1, 2]}], new Set([1, 2]), new Map([[1, "NAMING"], [2, "ARCHITECTURE"]]))).toThrow("Cross-category");
        expect(() => validateOperations([{action: "archive", ids: [1], superseded_by: 2}], new Set([1, 2]), new Map([[1, "NAMING"], [2, "ARCHITECTURE"]]))).toThrow("Cross-category");
    });
    test("repository read fence rejects traversal, trial artifacts and credentials", () => {
        expect(safeRepoPath("/repo", "packages/a.ts")).toBe("/repo/packages/a.ts");
        for (const path of ["../outside", "/etc/passwd", ".env", "a/credentials.json", ".git/config", ".curate-trial/pool.json", "packages/plugin/scripts/curate-stale-retirement-trial/evaluation.json", ".cortexkit/magic-context.jsonc", "docs/reports/curate-stale-retirement-trial.md", "node_modules/a"]) expect(() => safeRepoPath("/repo", path)).toThrow();
    });
});
