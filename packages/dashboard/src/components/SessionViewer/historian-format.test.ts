import { describe, expect, test } from "bun:test";
import {
  formatHistorianDuration,
  formatHistorianProviderModel,
  formatHistorianTokens,
} from "./historian-format";

describe("Historian row formatting", () => {
  test("shows a provider only when the stored row includes one", () => {
    expect(formatHistorianProviderModel("openai", "gpt-6.1-sol")).toBe("openai / gpt-6.1-sol");
    expect(formatHistorianProviderModel(null, "gpt-6.1-sol")).toBe("— / gpt-6.1-sol");
  });

  test("formats a duration in seconds", () => {
    expect(formatHistorianDuration(10, 74_393)).toBe("74.4 s");
    expect(formatHistorianDuration(10, null)).toBe("—");
  });

  test("compacts input and output token counts", () => {
    expect(formatHistorianTokens(40_200, 2_200)).toBe("40.2k in · 2.2k out");
    expect(formatHistorianTokens(420, 35)).toBe("420 in · 35 out");
  });
});
