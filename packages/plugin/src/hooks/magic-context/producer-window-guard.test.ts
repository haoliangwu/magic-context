import { expect, test } from "bun:test";
import { producerWindowFailureReason } from "./producer-window-guard";

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
