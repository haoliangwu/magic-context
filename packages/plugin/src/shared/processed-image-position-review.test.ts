import { expect, test } from "bun:test";
import { createProcessedImageEligibility } from "./processed-image-eligibility";
import cases from "./processed-image-position-review.json";

// OpenCode, Rust and Pi can reuse these cases: each row supplies per-message
// tag numbers rather than provider-specific message objects or image encodings.
for (const row of cases) {
    test(`independent image position table: ${row.name}`, () => {
        const messages = row.tags.map((_, i) => `message-${i}`);
        const tags = new Map(messages.map((message, i) => [message, Math.max(0, ...row.tags[i])]));
        const policy = createProcessedImageEligibility(messages, tags, {
            watermark: row.watermark,
            protectedCutoff: row.cutoff,
            contextPercentage: row.percentage,
        });
        expect(policy.ageTags.get(messages[row.target]) ?? null).toBe(row.age);
        expect(policy.mayStrip(messages[row.target])).toBe(row.eligible);
    });
}
