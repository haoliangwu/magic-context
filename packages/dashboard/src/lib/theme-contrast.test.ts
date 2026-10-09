import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluatePairs, readThemeTokens, resolveToken } from "../../scripts/theme-contrast";

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

  it("light neutrals are subtly warm: never cool blue-grey, never beige", () => {
    // Surfaces, borders and greys lean warm (red channel above blue) so the
    // page is not a stark cool white, but only slightly, so it does not read
    // as yellow or beige. Body text stays near-neutral dark.
    const tokens = readThemeTokens("light", css);
    const warmth = (name: string) => {
      const [r, , b] = resolveToken(tokens, name);
      return r - b;
    };
    const neutrals = [
      "bg-base",
      "bg-panel",
      "bg-card",
      "bg-hover",
      "bg-input",
      "border",
      "border-light",
      "border-control",
      "text-secondary",
      "text-muted",
      "chart-track",
      "chart-neutral",
    ];
    const off = neutrals
      .map((name) => ({ name, warmth: warmth(name) }))
      .filter((row) => row.warmth < 2 || row.warmth > 24)
      .map((row) => `${row.name}: red-blue ${row.warmth} outside 2..24`);
    expect(off).toEqual([]);
    expect(Math.abs(warmth("text-primary"))).toBeLessThanOrEqual(8);
  });
});
