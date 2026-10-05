import { beforeAll, describe, expect, test } from "bun:test";
import { estimateTokens, preloadTokenizer } from "../../src/hooks/magic-context/read-session-formatting";
import { estimatePair, oc1Content, piContent, total, type Usage } from "./analyze";
import { exampleIndices, fit, fitLag, quantile } from "./math";

beforeAll(async () => { expect(await preloadTokenizer()).toBe(true); });
const usage = (input: number, output = 100, reasoning: number | null = 60, read = 0, write = 0): Usage => ({ input, output, reasoning, read, write });

describe("reasoning resend offline accounting", () => {
    test("total adds uncached input, read and write exactly once", () => {
        expect(total(usage(7, 100, 60, 11, 13))).toBe(31);
    });
    test("reported reasoning is removed from generated output, not added to input", () => {
        const c = oc1Content([{ type: "reasoning", text: "Private thought" }], true);
        const e = estimatePair(usage(1000), usage(1200), c, 1);
        expect(e.x).toBe(60);
        expect(e.y).toBe(160); // 200 growth less 40 visible tokens, no new content.
        expect(e.basis).toBe("reported");
    });
    test("OpenCode visible-only output does not subtract reasoning twice", () => {
        const e = estimatePair(usage(1000, 40, 600), usage(1700), oc1Content([], true), 1, false);
        expect(e.x).toBe(600);
        expect(e.y).toBe(660); // 700 growth minus 40 visible; R can exceed O.
    });
    test("negative residuals survive instead of manufacturing positive replay", () => {
        const e = estimatePair(usage(1000), usage(900), oc1Content([], true), 1);
        expect(e.y).toBe(-140);
    });
    test("OC1 tool result belongs to producer while tool arguments are visible output", () => {
        const c = oc1Content([{ type: "tool", tool: "read", state: { status: "completed", input: { path: "x" }, output: "new result" } }], true);
        const e = estimatePair(usage(1000), usage(1200), c, 1.5);
        expect(c.tools).toBe(1);
        expect(c.visible).toEqual(['read {"path":"x"}']);
        expect(e.body).toBe(estimateTokens("new result") * 1.5);
        expect(e.y).toBe(160 - e.body - 12);
    });
    test("text basis independently tokenizes visible output when reasoning count is missing or zero", () => {
        const c = oc1Content([{ type: "reasoning", text: "Stored reasoning" }, { type: "text", text: "Visible answer" }], true);
        for (const r of [0, null]) {
            const e = estimatePair(usage(1000, 9999, r), usage(1200), c, 1);
            expect(e.x).toBe(estimateTokens("Stored reasoning"));
            expect(e.y).toBe(200 - estimateTokens("Visible answer"));
            expect(e.basis).toBe("text");
        }
    });
    test("Pi keeps encrypted signatures separate from reasoning text", () => {
        const c = piContent({ role: "assistant", content: [{ type: "thinking", thinking: "summary", thinkingSignature: "opaque-payload" }] });
        expect(c.reasoning).toEqual(["summary"]);
        expect(c.replayChars).toBe(14);
    });
    test("images and unfinished tools cannot be estimated as free text", () => {
        expect(piContent({ role: "toolResult", content: [{ type: "image", data: "x" }] }).unsupported).toBe(true);
        expect(oc1Content([{ type: "tool", state: { status: "running" } }], true).unsupported).toBe(true);
    });
});
describe("regression does not build its answer from reported reasoning", () => {
    test("example selection covers small samples without inventing empty rows", () => {
        expect(exampleIndices(0)).toEqual([]);
        expect(exampleIndices(1)).toEqual([0]);
        expect(exampleIndices(2)).toEqual([0, 1]);
        expect(exampleIndices(3)).toEqual([0, 1, 2]);
    });
    test("recovers known slope and intercept with independent sessions", () => {
        const result = fit([10, 30, 60, 120].map((x, i) => ({ session: String(i), x, y: 2 * x + 7, body: 0, wrappers: 0 })));
        expect(result?.k).toBeCloseTo(2, 10);
        expect(result?.c).toBeCloseTo(7, 10);
        expect(result?.cluster95?.[0]).toBeCloseTo(2, 10);
    });
    test("latest-only replay gives a negative lag coefficient", () => {
        const rows = [[10, 1], [30, 7], [15, 40], [80, 10], [9, 50], [120, 60]].map(([x, previous]) => ({ session: "s", x, previous, y: 2 * x - 2 * previous + 9, body: 0, wrappers: 0 }));
        expect(fitLag(rows)?.k).toBeCloseTo(2, 10);
        expect(fitLag(rows)?.h).toBeCloseTo(-2, 10);
    });
    test("body estimation error can alter the fitted slope", () => {
        const rows = [10, 30, 60, 120].map((x, i) => ({ session: String(i), x, y: x, body: x, wrappers: 0 }));
        expect(fit(rows)?.uniform20PercentBodyShift).toBeCloseTo(0.2, 10);
        expect(fit(rows)?.adversarial20PercentBodyAndWrappersShift).toBeGreaterThanOrEqual(0.2);
    });
    test("quantiles interpolate and unidentifiable slopes stay null", () => {
        expect(quantile([10, 0], 0.5)).toBe(5);
        expect(quantile([], 0.5)).toBeNull();
        expect(fit([1, 1, 1].map((x) => ({ session: "s", x, y: 7, body: 0, wrappers: 0 })))).toBeNull();
    });
});
