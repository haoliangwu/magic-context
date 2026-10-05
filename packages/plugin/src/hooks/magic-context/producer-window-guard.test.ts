import { expect, test } from "bun:test";
import {
    historianProducerReserve,
    producerInputTokenLimit,
    producerPromptFailureReason,
    producerWindowFailureReason,
} from "./producer-window-guard";

const maxOutputTokens = 1_000;
const usableInputTokens = 10_000;
const contextLimitTokens = usableInputTokens + maxOutputTokens;

test("producer source at 2x the usable window is refused with machine-readable numbers", () => {
    const reason = producerWindowFailureReason({
        producerSourceTokens: usableInputTokens * 2,
        contextLimitTokens,
        maxOutputTokens,
    });

    expect(reason).toContain("producer_source_tokens=20000");
    expect(reason).toContain("usable_input_tokens=10000");
    expect(reason).toContain("context_limit_tokens=11000");
    expect(reason).toContain("max_output_tokens=1000");
});

test("producer source at the nominal usable limit is refused for estimator margin", () => {
    expect(
        producerWindowFailureReason({
            producerSourceTokens: usableInputTokens,
            contextLimitTokens,
            maxOutputTokens,
        }),
    ).toBe(
        "producer_source_exceeds_window producer_source_tokens=10000 usable_input_tokens=10000 producer_input_limit_tokens=9700 context_limit_tokens=11000 max_output_tokens=1000 estimator_margin=0.03",
    );
});

test("producer source below the margined input limit is admitted", () => {
    expect(
        producerWindowFailureReason({
            producerSourceTokens: 9_699,
            contextLimitTokens,
            maxOutputTokens,
        }),
    ).toBeNull();
});

test("unknown producer windows do not refuse", () => {
    expect(
        producerWindowFailureReason({
            producerSourceTokens: 1_000_000,
            maxOutputTokens,
        }),
    ).toBeNull();
});

test("complete producer prompt uses producer calibration and refuses previously raw-fitting input", async () => {
    const { producerPromptFailureReason } = await import("./producer-window-guard");
    const input = {
        sourceLocal: 6000,
        systemLocal: 1000,
        toolsLocal: 0,
        modelKey: "anthropic/claude-fable-5-1",
        contextLimitTokens: 11000,
        maxOutputTokens: 1000,
    };
    expect(producerPromptFailureReason(input)).not.toBeNull();
    expect(producerPromptFailureReason({ ...input, contextLimitTokens: 20000 })).toBeNull();
    expect(producerPromptFailureReason({ ...input, contextLimitTokens: undefined })).toBeNull();
});

test("separate input cap and shared context constraints use the tighter allowance", () => {
    expect(producerInputTokenLimit(400_000, 100_000, 272_000)).toBe(263_840);
    expect(producerInputTokenLimit(400_000, 100_000)).toBe(291_000);
    expect(producerInputTokenLimit(undefined, 100_000, 272_000)).toBe(263_840);
    expect(producerInputTokenLimit(300_000, 100_000, 272_000)).toBe(194_000);
    expect(
        producerWindowFailureReason({
            producerSourceTokens: 264_000,
            contextLimitTokens: 400_000,
            inputLimitTokens: 272_000,
            maxOutputTokens: 100_000,
        }),
    ).toContain("producer_input_limit_tokens=263840");
});

test("32k historian with unconfigured output admits a real prompt and refuses an oversized one", () => {
    const reserve = historianProducerReserve(32_000, undefined, 32_000);
    expect(reserve).toBe(8_000);
    expect(producerInputTokenLimit(32_000, reserve)).toBe(23_280);
    const prompt = {
        sourceLocal: 1_000,
        systemLocal: 1_000,
        toolsLocal: 0,
        modelKey: undefined,
        contextLimitTokens: 32_000,
        maxOutputTokens: reserve,
    };
    expect(producerPromptFailureReason(prompt)).toBeNull();
    expect(producerPromptFailureReason({ ...prompt, sourceLocal: 50_000 })).toContain(
        "limit=23280",
    );
});

test("inconsistent configured output cannot turn every producer prompt into a refusal", () => {
    const reserve = historianProducerReserve(32_000, 40_000, 8_192);
    expect(producerInputTokenLimit(32_000, reserve)).toBeUndefined();
    expect(
        producerPromptFailureReason({
            sourceLocal: 50_000,
            systemLocal: 1_000,
            toolsLocal: 0,
            modelKey: undefined,
            contextLimitTokens: 32_000,
            maxOutputTokens: reserve,
        }),
    ).toBeNull();
});

test("Sol producer prompts use seeded fit while an unmeasured variant stays fail closed", () => {
    const prompt = {
        sourceLocal: 192000,
        systemLocal: 8000,
        toolsLocal: 0,
        contextLimitTokens: 400000,
        inputLimitTokens: 272000,
        maxOutputTokens: 128000,
    };
    for (const modelKey of ["openai/gpt-6-sol", "openai/gpt-6.1-sol", "openai/gpt-5.6-terra"])
        expect(producerPromptFailureReason({ ...prompt, modelKey })).toBeNull();
    expect(producerPromptFailureReason({ ...prompt, modelKey: "openai/gpt-6-madeup" })).toContain(
        "producer_prompt_exceeds_window",
    );
});
