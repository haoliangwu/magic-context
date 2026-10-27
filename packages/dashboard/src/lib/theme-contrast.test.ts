import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluatePairs, readThemeTokens } from "../../scripts/theme-contrast";

const css = readFileSync(resolve(import.meta.dir, "../styles.css"), "utf8");

describe("theme token contrast", () => {
  it("every light-theme text and control pair meets its WCAG AA minimum", () => {
    const failing = evaluatePairs("light", css)
      .filter((row) => !row.pass)
      .map((row) => `${row.label}: ${row.ratio.toFixed(2)} < ${row.min}`);
    expect(failing).toEqual([]);
  });

  it("the light theme overrides every colour token the dark theme defines", () => {
    // A token left out of the light block silently inherits its dark value
    // (dark text on light surfaces, or the reverse).
    const dark = readThemeTokens("dark", css);
    const light = readThemeTokens("light", css);
    const missing = [...dark.keys()].filter((name) => !light.has(name));
    expect(missing).toEqual([]);
  });
});
