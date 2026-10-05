import { describe, expect, it } from "bun:test";
import {
    calibrateBuckets,
    type ModelCalibration,
    resolveModelCalibration,
} from "./tokenizer-calibration";

const NEUTRAL: ModelCalibration = { systemRatio: 1.0, toolsRatio: 1.0, proseRatio: 1.0 };

describe("resolveModelCalibration", () => {
    it("returns neutral ratios for unknown models", () => {
        const calib = resolveModelCalibration("brand-new-provider", "weird-model-99");
        expect(calib.systemRatio).toBe(1.0);
        expect(calib.toolsRatio).toBe(1.0);
    });

    it("returns neutral when provider or model is missing", () => {
        expect(resolveModelCalibration(undefined, "x")).toEqual(NEUTRAL);
        expect(resolveModelCalibration("y", undefined)).toEqual(NEUTRAL);
    });

    it("matches Anthropic Opus 4.7 outlier ratios", () => {
        const calib = resolveModelCalibration("anthropic", "claude-opus-4-7");
        expect(calib.systemRatio).toBeCloseTo(1.51, 2);
        expect(calib.toolsRatio).toBeCloseTo(1.57, 2);
    });

    it("carries the 2026-09-21 count-endpoint measurements for Moonshot, Z.ai GLM 4.7 and Meta Muse", () => {
        // Values are results.json rows (tokenizers/estimate-token-count,
        // paas/v4/tokenizer, responses/input_tokens). The Zen-routed Muse alias
        // and the OpenCode-Go Kimi alias mirror the same upstream model.
        const kimi = resolveModelCalibration("moonshot", "kimi-k2.6");
        expect(kimi.systemRatio).toBeCloseTo(0.872126, 5);
        expect(kimi.toolsRatio).toBeCloseTo(0.863853, 5);
        expect(kimi.proseRatio).toBeCloseTo(0.925501, 5);
        expect(resolveModelCalibration("opencode-go", "kimi-k2.6").proseRatio).toBeCloseTo(
            0.925501,
            5,
        );
        const glm = resolveModelCalibration("zai", "glm-4.7");
        expect(glm.systemRatio).toBeCloseTo(0.999721, 5);
        expect(glm.toolsRatio).toBeCloseTo(1.056823, 5);
        // glm-5* ids are deliberately absent from the table (the tokenizer endpoint
        // reports 0 for them); they inherit GLM 4.7 through the family fallback.
        expect(resolveModelCalibration("zai", "glm-5.1").derivedFrom).toBe("zai/glm-4.7");
        const muse = resolveModelCalibration("meta", "muse-spark-1.3-contributor");
        expect(muse.systemRatio).toBeCloseTo(0.865949, 5);
        expect(muse.toolsRatio).toBeCloseTo(1.024605, 5);
        expect(muse.proseRatio).toBeCloseTo(0.923366, 5);
        const zen = resolveModelCalibration("opencode", "muse-spark-1.3-contributor-free");
        expect([zen.systemRatio, zen.toolsRatio, zen.proseRatio]).toEqual([
            muse.systemRatio,
            muse.toolsRatio,
            muse.proseRatio,
        ]);
    });

    it("lets an unmeasured release inherit its nearest measured relative", () => {
        // The week a new version ships nobody has measured it yet; its predecessor's
        // tokenizer is the best available truth, and NEUTRAL is no tokenizer at all.
        const fable52 = resolveModelCalibration("anthropic", "claude-fable-5-2");
        const fable51 = resolveModelCalibration("anthropic", "claude-fable-5-1");
        expect(fable52.derivedFrom).toBe("anthropic/claude-fable-5-1");
        expect(fable52.proseRatio).toBe(fable51.proseRatio);
        expect(fable51.derivedFrom).toBeUndefined();
        // Newest version below wins over anything above.
        expect(resolveModelCalibration("anthropic", "claude-opus-4-9").derivedFrom).toBe(
            "anthropic/claude-opus-4-8",
        );
        // Variant words must match: an astra release follows astra, not plain gpt.
        expect(resolveModelCalibration("openai", "gpt-6.1-astra").derivedFrom).toBe(
            "openai/gpt-6-astra",
        );
        expect(resolveModelCalibration("openai", "gpt-7").derivedFrom).toBe("openai/gpt-5.5");
        expect(resolveModelCalibration("google", "gemini-3.9-flash").derivedFrom).toBe(
            "google/gemini-3.8-flash",
        );
        // Only above exists: the oldest above is used.
        expect(resolveModelCalibration("anthropic", "claude-opus-4-4").derivedFrom).toBe(
            "anthropic/claude-opus-4-5",
        );
        // Known providers stay provider-scoped; an unknown provider can use
        // canonical model-family inheritance rather than remaining neutral.
        expect(resolveModelCalibration("anthropic", "claude-muse-9")).toEqual(NEUTRAL);
        expect(resolveModelCalibration("moonshot", "kimi-k3")).toEqual(NEUTRAL);
        expect(resolveModelCalibration("brand-new", "claude-fable-5-2").derivedFrom).toBe(
            "anthropic/claude-fable-5-1",
        );
    });

    it("matches Claude 4.5/4.6 family within range", () => {
        const cases = [
            ["anthropic", "claude-opus-4-5"],
            ["anthropic", "claude-sonnet-4-5"],
            ["anthropic", "claude-haiku-4-5"],
            ["anthropic", "claude-sonnet-4-6"],
        ];
        for (const [provider, model] of cases) {
            const calib = resolveModelCalibration(provider, model);
            expect(calib.systemRatio).toBeCloseTo(1.02, 2);
            expect(calib.toolsRatio).toBeGreaterThanOrEqual(1.14);
            expect(calib.toolsRatio).toBeLessThanOrEqual(1.16);
        }
    });

    it("uses legacy GPT-5.x ratios for variants without API-key measurements", () => {
        const cases = ["gpt-5", "gpt-5.4", "gpt-5.4-codex", "gpt-5.3-codex"];
        for (const model of cases) {
            const calib = resolveModelCalibration("openai", model);
            expect(calib.systemRatio).toBe(1.0);
            expect(calib.toolsRatio).toBeCloseTo(0.84, 2);
        }
    });

    it("is case-insensitive", () => {
        const lower = resolveModelCalibration("anthropic", "claude-opus-4-7");
        const upper = resolveModelCalibration("Anthropic", "Claude-Opus-4-7");
        expect(upper).toEqual(lower);
    });

    it("uses longest prefix match", () => {
        // claude-opus-4-7 should win over a generic anthropic/claude prefix.
        const opus47 = resolveModelCalibration("anthropic", "claude-opus-4-7");
        const opus45 = resolveModelCalibration("anthropic", "claude-opus-4-5");
        expect(opus47.systemRatio).not.toBe(opus45.systemRatio);
    });

    it("matches Opus 4.7 routed via OpenRouter and GitHub Copilot (regression: A2)", () => {
        // Without explicit prefixes for these routes, the longest-prefix
        // matcher fell through to NEUTRAL and the sidebar misattributed
        // ~30K tokens from System+ToolDefs into Conversation/ToolCalls.
        const cases = [
            ["openrouter/anthropic", "claude-opus-4-7"],
            ["openrouter/anthropic", "claude-opus-4.7"],
            ["github-copilot", "claude-opus-4-7"],
            ["github-copilot", "claude-opus-4.7"],
        ];
        for (const [provider, model] of cases) {
            const calib = resolveModelCalibration(provider, model);
            expect(calib.systemRatio).toBeCloseTo(1.51, 2);
            expect(calib.toolsRatio).toBeCloseTo(1.57, 2);
        }
    });
});

describe("calibrateBuckets", () => {
    it("returns all zeros when inputTokens is 0", () => {
        const out = calibrateBuckets({
            inputTokens: 0,
            systemLocal: 1000,
            toolDefsLocal: 500,
            compartmentsLocal: 100,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 200,
            toolCallsLocal: 50,
            calibration: NEUTRAL,
        });
        expect(out.systemTokens).toBe(0);
        expect(out.toolDefinitionTokens).toBe(0);
        expect(out.compartmentTokens).toBe(0);
        expect(out.conversationTokens).toBe(0);
        expect(out.toolCallTokens).toBe(0);
    });

    it("sums to exactly inputTokens with neutral calibration", () => {
        const out = calibrateBuckets({
            inputTokens: 100_000,
            systemLocal: 16_000,
            toolDefsLocal: 21_000,
            compartmentsLocal: 80_000,
            factsLocal: 50,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 30_000,
            toolCallsLocal: 60_000,
            calibration: NEUTRAL,
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(100_000);
    });

    it("applies system_ratio and tools_ratio to calibrated buckets", () => {
        // 2x system multiplier doubles the system bucket; verbatim and residual
        // buckets are untouched. Local 10K system + 0 tools + 0 verbatim + 30K
        // conversation = 40K total raw. After 2x system: stable=20K, residual
        // target = 50K - 20K = 30K → conversation = 30K.
        const out = calibrateBuckets({
            inputTokens: 50_000,
            systemLocal: 10_000,
            toolDefsLocal: 0,
            compartmentsLocal: 0,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 30_000,
            toolCallsLocal: 0,
            calibration: { systemRatio: 2.0, toolsRatio: 1.0, proseRatio: 1.0 },
        });
        expect(out.systemTokens).toBe(20_000);
        expect(out.conversationTokens).toBe(30_000);
        expect(out.systemTokens + out.conversationTokens).toBe(50_000);
    });

    it("keeps unmeasured prose at local count and absorbs residual into conversation/tool calls", () => {
        // System=1000, tools=500 (calibrated, neutral so no scaling).
        // Verbatim: compartments=1000, facts=500, memories=0 → all stay at local count.
        // Stable + verbatim = 3000. Residual target = 10000 - 3000 = 7000.
        // Residual local = 2000 conv + 500 tool = 2500. Scale = 7000/2500 = 2.8x.
        const out = calibrateBuckets({
            inputTokens: 10_000,
            systemLocal: 1_000,
            toolDefsLocal: 500,
            compartmentsLocal: 1_000,
            factsLocal: 500,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 2_000,
            toolCallsLocal: 500,
            calibration: NEUTRAL,
        });
        // Calibrated stays at local raw count (neutral).
        expect(out.systemTokens).toBe(1_000);
        expect(out.toolDefinitionTokens).toBe(500);
        // Unmeasured prose keeps the local input exactly (neutral calibration).
        expect(out.compartmentTokens).toBe(1_000);
        expect(out.factTokens).toBe(500);
        expect(out.memoryTokens).toBe(0);
        // Residual buckets absorb the remainder proportionally.
        // Conv: 2000 * 2.8 = 5600, ToolCalls: 500 * 2.8 = 1400.
        expect(out.conversationTokens).toBeGreaterThanOrEqual(5_590);
        expect(out.conversationTokens).toBeLessThanOrEqual(5_610);
        expect(out.toolCallTokens).toBeGreaterThanOrEqual(1_390);
        expect(out.toolCallTokens).toBeLessThanOrEqual(1_410);
        // Sum still exactly equals inputTokens.
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(10_000);
    });

    it("parks the full remainder in conversation when residual local sum is 0", () => {
        // Brand-new session: only system+tools have local content.
        // Conversation has nothing yet, so it absorbs the entire remainder.
        const out = calibrateBuckets({
            inputTokens: 50_000,
            systemLocal: 16_000,
            toolDefsLocal: 21_000,
            compartmentsLocal: 0,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: NEUTRAL,
        });
        expect(out.systemTokens).toBe(16_000);
        expect(out.toolDefinitionTokens).toBe(21_000);
        expect(out.compartmentTokens).toBe(0);
        expect(out.factTokens).toBe(0);
        expect(out.memoryTokens).toBe(0);
        expect(out.conversationTokens).toBe(13_000);
        expect(out.toolCallTokens).toBe(0);
    });

    it("clamps non-residual buckets when calibrated + verbatim exceeds inputTokens", () => {
        // Pathological: large system+tools+compartments locally but tiny
        // inputTokens. System*5 + Tools*5 + Compartments(verbatim) far exceed
        // 1000 inputTokens, so they all scale down proportionally and residuals
        // stay 0.
        const out = calibrateBuckets({
            inputTokens: 1_000,
            systemLocal: 800,
            toolDefsLocal: 800,
            compartmentsLocal: 100,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 100,
            toolCallsLocal: 0,
            calibration: { systemRatio: 5.0, toolsRatio: 5.0, proseRatio: 1.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBeLessThanOrEqual(1_000);
        // After rounding correction, sum equals exactly 1000.
        expect(sum).toBe(1_000);
    });

    it("tiny inputTokens with clamp path: still sums exactly (regression: Oracle final review)", () => {
        // Oracle final-review reproducer: with very small inputTokens, the
        // single-bucket fix from the original A1 patch couldn't absorb a
        // residual overshoot that exceeded that bucket's value. The fix
        // loops through non-residual buckets descending until delta=0.
        const out = calibrateBuckets({
            inputTokens: 2,
            systemLocal: 1,
            toolDefsLocal: 1,
            compartmentsLocal: 2,
            factsLocal: 2,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 1,
            toolCallsLocal: 0,
            calibration: { systemRatio: 1.51, toolsRatio: 1.57, proseRatio: 1.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(2);
        // No bucket goes negative.
        for (const v of [
            out.systemTokens,
            out.toolDefinitionTokens,
            out.compartmentTokens,
            out.factTokens,
            out.memoryTokens,
            out.conversationTokens,
            out.toolCallTokens,
        ]) {
            expect(v).toBeGreaterThanOrEqual(0);
        }
    });

    it("clamp + zero residuals: rounding overshoot does NOT exceed inputTokens (regression: A1)", () => {
        // Council A1: with heavy calibration ratios AND zero conversation/tool-call
        // locals, the clamp path's `Math.round(x * ratio)` overshoots and the
        // residual buckets can't absorb the negative delta (Math.max clamps to 0).
        // Pre-fix, this produced sum=inputTokens+1 in pathological cases.
        // Reproducer from the audit:
        //   inputTokens=1000, system=500, toolDefs=500, compartments=500,
        //   conversation=0, toolCalls=0, ratio 5x → all rounded up by ~0.45 → 1001.
        const out = calibrateBuckets({
            inputTokens: 1_000,
            systemLocal: 500,
            toolDefsLocal: 500,
            compartmentsLocal: 500,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: { systemRatio: 5.0, toolsRatio: 5.0, proseRatio: 1.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        // Final sum must be EXACTLY inputTokens — never +1.
        expect(sum).toBe(1_000);
        // Residuals stay zero — they have no local content to scale from.
        expect(out.conversationTokens).toBe(0);
        expect(out.toolCallTokens).toBe(0);
        // No bucket goes negative.
        expect(out.systemTokens).toBeGreaterThanOrEqual(0);
        expect(out.toolDefinitionTokens).toBeGreaterThanOrEqual(0);
        expect(out.compartmentTokens).toBeGreaterThanOrEqual(0);
    });

    it("real-world Opus 4.7 example: verbatim history matches /ctx-status, residual absorbs drift", () => {
        // Live session symptom: System=16500 local, Tools=21400 local,
        // Compartments=89000 local, Conversation=40000 local, ToolCalls=68000
        // local. inputTokens=378000 (Anthropic's billed count). After fix:
        //   System (calibrated)         = 16500 * 1.51 ≈ 24915
        //   Tool Defs (calibrated)      = 21400 * 1.57 ≈ 33598
        //   Compartments (verbatim)     = 89000          ← unchanged
        //   Facts (verbatim)            = 50             ← unchanged
        //   Memories (verbatim)         = 8000           ← unchanged
        //   Residual target             = 378000 - 24915 - 33598 - 89000 - 50 - 8000 ≈ 222437
        //   Residual local              = 40000 + 68000 = 108000
        //   Conv = 40000 * (222437/108000) ≈ 82384
        //   Tool calls = 68000 * (222437/108000) ≈ 140053
        const out = calibrateBuckets({
            inputTokens: 378_000,
            systemLocal: 16_500,
            toolDefsLocal: 21_400,
            compartmentsLocal: 89_000,
            factsLocal: 50,
            memoriesLocal: 8_000,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 40_000,
            toolCallsLocal: 68_000,
            calibration: { systemRatio: 1.51, toolsRatio: 1.57, proseRatio: 1.0 },
        });
        // Calibrated buckets.
        expect(out.systemTokens).toBe(Math.round(16_500 * 1.51));
        expect(out.toolDefinitionTokens).toBe(Math.round(21_400 * 1.57));
        // Verbatim buckets — exact local count, NO scaling. This is the
        // property that fixes the sidebar-vs-/ctx-status mismatch.
        expect(out.compartmentTokens).toBe(89_000);
        expect(out.factTokens).toBe(50);
        expect(out.memoryTokens).toBe(8_000);
        // Residual absorbed by conversation + tool calls.
        expect(out.conversationTokens).toBeGreaterThan(70_000);
        expect(out.toolCallTokens).toBeGreaterThan(120_000);
        // Sum equals inputTokens.
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(378_000);
    });

    it("docs + profile are verbatim buckets that come OUT of the residual (not Conversation)", () => {
        // v2: <project-docs> and <user-profile> live in m[0]. They must surface
        // as their own buckets, not silently inflate Conversation.
        const base = {
            inputTokens: 200_000,
            systemLocal: 5_000,
            toolDefsLocal: 5_000,
            compartmentsLocal: 60_000,
            factsLocal: 0,
            memoriesLocal: 10_000,
            conversationLocal: 40_000,
            toolCallsLocal: 20_000,
            calibration: { systemRatio: 1, toolsRatio: 1, proseRatio: 1.0 },
        };
        const without = calibrateBuckets({ ...base, docsLocal: 0, profileLocal: 0 });
        const withDocs = calibrateBuckets({ ...base, docsLocal: 20_000, profileLocal: 2_000 });

        // Verbatim — exact local counts, no scaling.
        expect(withDocs.docsTokens).toBe(20_000);
        expect(withDocs.profileTokens).toBe(2_000);
        // The 22K of docs+profile is carved out of the residual, so Conversation
        // SHRINKS vs the run that attributed them to nothing.
        expect(withDocs.conversationTokens).toBeLessThan(without.conversationTokens);
        // Sum (including the two new buckets) is still EXACTLY inputTokens.
        const sum =
            withDocs.systemTokens +
            withDocs.toolDefinitionTokens +
            withDocs.compartmentTokens +
            withDocs.factTokens +
            withDocs.memoryTokens +
            withDocs.docsTokens +
            withDocs.profileTokens +
            withDocs.conversationTokens +
            withDocs.toolCallTokens;
        expect(sum).toBe(200_000);
    });
});

describe("measured Claude 5 prose calibration", () => {
    it("resolves measured aliases and lets unmeasured Fable 5.2 inherit 5.1", () => {
        for (const provider of ["anthropic", "openrouter/anthropic", "github-copilot"]) {
            for (const model of ["claude-fable-5-1", "claude-opus-5"]) {
                expect(resolveModelCalibration(provider, model)).toMatchObject({
                    systemRatio: 1.511497,
                    toolsRatio: 1.551639,
                    proseRatio: 1.571778,
                });
            }
        }
        // Unmeasured Fable 5.2 is not neutral: it inherits 5.1 until measured.
        expect(resolveModelCalibration("anthropic", "claude-fable-5-2").derivedFrom).toBe(
            "anthropic/claude-fable-5-1",
        );
        expect(resolveModelCalibration("anthropic", "claude-opus-4-8").proseRatio).toBe(1);
    });

    it("calibrates the real-session m0 shape without inflating residuals", () => {
        const input = {
            inputTokens: 530_000,
            systemLocal: 9_000,
            toolDefsLocal: 19_000,
            compartmentsLocal: 98_000,
            factsLocal: 0,
            docsLocal: 36_000,
            memoriesLocal: 15_000,
            profileLocal: 4_000,
            conversationLocal: 40_000,
            toolCallsLocal: 70_000,
            calibration: resolveModelCalibration("anthropic", "claude-fable-5-1"),
        };
        const out = calibrateBuckets(input);
        expect(out).toEqual({
            systemTokens: 13603,
            toolDefinitionTokens: 29481,
            compartmentTokens: 154034,
            factTokens: 0,
            docsTokens: 56584,
            memoryTokens: 23577,
            profileTokens: 6287,
            conversationTokens: 89612,
            toolCallTokens: 156822,
        });
        // References are count_tokens from one real session; local inputs are its
        // rounded sidebar readouts, so 5% avoids false precision. Synthetic memory
        // measured 1.79 versus 1.56 in that session: prose drift is content-dependent.
        for (const [actual, reference] of [
            [out.compartmentTokens, 146815],
            [out.docsTokens, 55220],
            [out.memoryTokens, 23462],
            [out.profileTokens, 6075],
        ])
            expect(Math.abs(actual - reference) / reference).toBeLessThan(0.05);
        expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(530_000);
        const before = calibrateBuckets({ ...input, calibration: NEUTRAL });
        expect(out.toolCallTokens).toBeLessThan(before.toolCallTokens - 60_000);
    });

    it("scales facts and preserves the sum through prose clamp rounding", () => {
        const out = calibrateBuckets({
            inputTokens: 7,
            systemLocal: 1,
            toolDefsLocal: 1,
            compartmentsLocal: 1,
            factsLocal: 1,
            docsLocal: 1,
            memoriesLocal: 1,
            profileLocal: 1,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: { systemRatio: 1, toolsRatio: 1, proseRatio: 1.5 },
        });
        expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(7);
        expect(Object.values(out).every((value) => value >= 0)).toBe(true);
    });
});

it("uses measured Responses ratios for OpenAI API models", () => {
    for (const model of ["gpt-5.5", "gpt-6-astra"]) {
        expect(resolveModelCalibration("openai", model)).toMatchObject({
            systemRatio: 1.000278,
            toolsRatio: 0.850953,
            proseRatio: 1.000017,
        });
    }
});
