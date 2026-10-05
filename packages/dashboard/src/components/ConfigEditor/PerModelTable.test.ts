import { describe, expect, it } from "bun:test";
import {
  addModelRow,
  editModelCell,
  modelValues,
  overrideModels,
  removeModelRow,
} from "./per-model-overrides";

describe("per-model override table", () => {
  it("adds one blank draft row without fabricating a config value", () => {
    const values = { cache_ttl: "5m", execute_threshold_percentage: 65 };
    const rows = addModelRow(overrideModels(values), "provider/model");
    expect(rows).toEqual(["provider/model"]);
    expect(addModelRow(rows, "provider/model")).toEqual(rows);
    expect(addModelRow(rows, "default")).toEqual(rows);
    expect(values).toEqual({ cache_ttl: "5m", execute_threshold_percentage: 65 });
  });

  it("edits table cells and retains independent column defaults", () => {
    expect(editModelCell("1h", "cache_ttl", "provider/model", "never")).toEqual({
      default: "1h",
      "provider/model": "never",
    });
    expect(
      editModelCell(undefined, "execute_threshold_percentage", "provider/model", "75"),
    ).toEqual({ default: 65, "provider/model": 75 });
    expect(
      editModelCell(undefined, "execute_threshold_tokens", "provider/model", "150000"),
    ).toEqual({ "provider/model": 150000 });
    expect(editModelCell({ default: 10000 }, "output_reserve", "provider/model", "0")).toEqual({
      default: 10000,
      "provider/model": 0,
    });
  });

  it("clears a cell to its inherited default instead of retaining the override", () => {
    expect(
      editModelCell({ default: "5m", "provider/model": "1h" }, "cache_ttl", "provider/model", ""),
    ).toBe("5m");
    expect(
      editModelCell({ "provider/model": 5000 }, "execute_threshold_tokens", "provider/model", ""),
    ).toBeUndefined();
    expect(
      editModelCell({ default: 5000 }, "execute_threshold_tokens", "default", ""),
    ).toBeUndefined();
    expect(editModelCell("1h", "cache_ttl", "default", "")).toBeUndefined();
  });

  it("removes a model row across all columns without affecting other models", () => {
    const result = removeModelRow(
      {
        cache_ttl: { default: "5m", "provider/model": "1h", "other/model": "never" },
        execute_threshold_percentage: { default: 65, "provider/model": 75 },
        execute_threshold_tokens: { "provider/model": 150000 },
        output_reserve: { default: 10000, "provider/model": 0 },
      },
      "provider/model",
    );
    expect(result).toEqual({
      cache_ttl: { default: "5m", "other/model": "never" },
      execute_threshold_percentage: 65,
      execute_threshold_tokens: undefined,
      output_reserve: 10000,
    });
    expect(overrideModels(result)).toEqual(["other/model"]);
  });

  it("unions all configured models and never treats default as a model", () => {
    expect(
      overrideModels({
        cache_ttl: { default: "5m", "a/model": "1h" },
        output_reserve: { default: 0, "b/model": 2000 },
      }),
    ).toEqual(["a/model", "b/model"]);
    expect(modelValues(undefined)).toEqual({});
  });
});
