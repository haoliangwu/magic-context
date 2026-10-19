import { expect, test } from "bun:test";
import { createProcessedImageEligibility } from "./processed-image-eligibility";

const messages = ["old", "image", "answer", "tail"];

test("image position age inherits its next positive tag, never zero or an earlier tag", () => {
    const policy = createProcessedImageEligibility(
        messages,
        new Map([
            ["old", 1],
            ["answer", 6],
        ]),
        { watermark: 1 },
    );
    expect(policy.ageTags.get("image")).toBe(6);
    expect(policy.mayStrip("image")).toBe(false);
    expect(policy.ageTags.has("tail")).toBe(false);
    expect(policy.mayStrip("tail")).toBe(false);
    const own = createProcessedImageEligibility(
        messages,
        new Map([
            ["image", 3],
            ["answer", 6],
        ]),
        { watermark: 4 },
    );
    expect(own.ageTags.get("image")).toBe(3);
    expect(own.mayStrip("image")).toBe(true);
});

test("answered image-only positions outside the protected window are eligible", () => {
    const policy = createProcessedImageEligibility(
        messages,
        new Map([
            ["answer", 3],
            ["tail", 5],
        ]),
        { watermark: 4, protectedCutoff: 5, contextPercentage: 94.99 },
    );
    expect(policy.ageTags.get("image")).toBe(3);
    expect(policy.mayStrip("image")).toBe(true);
});

test("image positions inside the protected window stay below the 95 percent emergency", () => {
    const policy = createProcessedImageEligibility(messages, new Map([["answer", 6]]), {
        watermark: 10,
        protectedCutoff: 5,
        contextPercentage: 94.99,
    });
    expect(policy.mayStrip("image")).toBe(false);
});

test("image positions follow emergency drops when the newest window yields at 95 percent", () => {
    for (const contextPercentage of [95, 99]) {
        const policy = createProcessedImageEligibility(messages, new Map([["answer", 6]]), {
            watermark: 10,
            protectedCutoff: 5,
            contextPercentage,
        });
        expect(policy.mayStrip("image")).toBe(true);
        const notDroppedYet = createProcessedImageEligibility(messages, new Map([["answer", 11]]), {
            watermark: 10,
            protectedCutoff: 5,
            contextPercentage,
        });
        expect(notDroppedYet.mayStrip("image")).toBe(false);
    }
});
