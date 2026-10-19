import { describe, expect, test } from "bun:test";
import { formatCompartmentDateSpan } from "./session-dates";

describe("compartment date span", () => {
  test("formats resolved boundaries as an OpenCode-style date range", () => {
    const start = new Date(2026, 9, 10, 11, 21).getTime();
    const end = new Date(2026, 9, 10, 12, 30).getTime();

    expect(formatCompartmentDateSpan(start, end, 0)).toBe("Oct 10 11:21 → Oct 10 12:30");
  });

  test("uses the stored creation time when a boundary is unavailable", () => {
    const createdAt = new Date(2026, 9, 10, 11, 21).getTime();

    expect(formatCompartmentDateSpan(undefined, undefined, createdAt)).toBe("created Oct 10 11:21");
  });

  test("shows no date when neither boundaries nor creation time are available", () => {
    expect(formatCompartmentDateSpan(undefined, undefined, 0)).toBeUndefined();
  });
});
