import { describe, expect, it } from "bun:test";
import { loadCachedModelCatalogs, retainLoadedCatalogs } from "./model-catalog-cache";

describe("model catalog cache", () => {
  it("does not persist an empty discovery as final", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    const empty = { opencode: [], pi: [], omp: [] };
    expect(retainLoadedCatalogs(empty, empty, storage)).toEqual(empty);
    expect(entries.size).toBe(0);
    const warm = { opencode: ["opencode/big-pickle"], pi: ["anthropic/claude"], omp: [] };
    retainLoadedCatalogs(empty, warm, storage);
    expect(loadCachedModelCatalogs(storage).opencode).toEqual(["opencode/big-pickle"]);
    const retained = retainLoadedCatalogs(warm, empty, storage);
    expect(retained).toEqual(warm);
    expect(loadCachedModelCatalogs(storage)).toEqual(warm);
  });
});
