import { expect, test } from "bun:test";
import { recoveryReasoningPrefixes } from "./recovery-reasoning-prefix";

for (const key of ["content", "parts"] as const) {
    test(`recovery reasoning ${key}: exact preceding messages and same-message parts`, () => {
        const messages = [
            { role: "user", [key]: [{ type: "text", text: "original" }] },
            {
                role: "assistant",
                [key]: [
                    { type: "text", text: "before" },
                    { type: "thinking", thinkingSignature: "first" },
                    { type: "text", text: "between" },
                    { type: "redacted_thinking", data: "opaque" },
                    { type: "text", text: "after" },
                ],
            },
        ];
        const original = recoveryReasoningPrefixes(messages, key);
        expect(original).toHaveLength(2);
        const edited = structuredClone(messages);
        edited[0]![key]![0]!.text = "changed";
        expect(recoveryReasoningPrefixes(edited, key)).not.toEqual(original);
        const parts = structuredClone(messages);
        parts[1]![key]![2]!.text = "changed";
        expect(recoveryReasoningPrefixes(parts, key)[0]).toBe(original[0]);
        expect(recoveryReasoningPrefixes(parts, key)[1]).not.toBe(original[1]);
        const suffix = structuredClone(messages);
        suffix[1]![key]![4]!.text = "changed";
        expect(recoveryReasoningPrefixes(suffix, key)).toEqual(original);
        suffix[1]![key]!.splice(3, 1);
        expect(recoveryReasoningPrefixes(suffix, key)).not.toEqual(original);
    });
}
