import { describe, expect, it } from "bun:test";
import resolverCases from "../../../../../tests/fixtures/calibration-resolver.json";
import fixture from "../../../../../tests/fixtures/decision-calibration.json";
import {
    calibrationForModelKey,
    localBudget,
    providerMass,
    resolveDecisionCalibration,
} from "./decision-calibration";
import seeds from "./tokenizer-calibration-seeds.json";

describe("static decision calibration", () => {
    it("resolves the shared model and provider cases", () => {
        for (const testCase of resolverCases) {
            const result = resolveDecisionCalibration(testCase.provider, testCase.model);
            expect(result.matchedPrefix).toBe(testCase.prefix ?? undefined);
            expect(result.source).toBe(testCase.source);
            const row = seeds.find((seed) => seed.prefix === testCase.prefix);
            expect([result.systemRatio, result.toolsRatio, result.proseRatio]).toEqual(
                row ? [row.systemRatio, row.toolsRatio, row.proseRatio ?? 1] : [1, 1, 1],
            );
            expect(result.seeded).toBe(row !== undefined);
        }
    });
    it("seeds both Sol models and prices the reported prompt without unknown fit inflation", () => {
        for (const key of ["openai/gpt-6-sol", "openai/gpt-6.1-sol"]) {
            const seed = calibrationForModelKey(key);
            expect(seed.seeded).toBe(true);
            expect(seed.source).toBe("seed");
            expect(seed.matchedPrefix).toBe(key);
            expect(providerMass({ system: 8000, prose: 192000 }, seed, true)).toBe(200006);
        }
        const unknown = calibrationForModelKey("openai/gpt-6-madeup");
        expect(unknown.seeded).toBe(false);
        expect(providerMass({ system: 8000, prose: 192000 }, unknown, true)).toBe(400000);
    });
    it("calibrates the supplied Fable section fixture independently with one final ceil", () => {
        const seed = resolveDecisionCalibration("anthropic", "claude-fable-5-1");
        expect(
            providerMass(
                { system: fixture.rawSystem, tools: fixture.rawTools, prose: fixture.rawProse },
                seed,
            ),
        ).toBe(fixture.providerMass);
        expect(localBudget(fixture.providerBudget, seed.proseRatio)).toBe(fixture.localBudget);
        expect(seed.source).toBe("seed");
    });
    it("keeps family fallback seeded, not subject to unknown-model fit inflation", () => {
        const seed = resolveDecisionCalibration("anthropic", "claude-fable-5-2");
        expect(seed.source).toBe("family-fallback");
        expect(providerMass({ prose: 1000 }, seed, true)).toBe(1572);
    });
    it("inflates unknown fit mass while keeping eviction budgets neutral", () => {
        const seed = resolveDecisionCalibration("unmeasured", "new-1");
        expect(providerMass({ prose: 1000 }, seed)).toBe(1000);
        expect(providerMass({ prose: 1000 }, seed, true)).toBeGreaterThanOrEqual(2000);
        expect(localBudget(60000, seed.proseRatio)).toBe(60000);
    });
    it("fails closed for invalid component counts and invalid budget ratios", () => {
        const seed = resolveDecisionCalibration("anthropic", "claude-fable-5-1");
        expect(providerMass({ prose: Number.NaN }, seed, true)).toBe(Number.POSITIVE_INFINITY);
        expect(providerMass({ tools: -1 }, seed, true)).toBe(Number.POSITIVE_INFINITY);
        expect(localBudget(100, 0)).toBe(0);
        expect(localBudget(Number.POSITIVE_INFINITY, 1)).toBe(0);
    });
});
