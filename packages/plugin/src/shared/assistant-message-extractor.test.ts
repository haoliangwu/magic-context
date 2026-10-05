import { describe, expect, test } from "bun:test";
import {
    describeAssistantSettlement,
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "./assistant-message-extractor";

test("reasoning-only and tool-only turns stay out of manifest text and retain finish diagnostics", () => {
    for (const [type, finish] of [
        ["reasoning", "stop"],
        ["tool", "tool-calls"],
    ]) {
        const messages = [
            {
                info: { role: "assistant", finish },
                parts: [{ type, text: "private or tool data" }],
            },
        ];
        expect(extractLatestAssistantText(messages)).toBeNull();
        expect(describeAssistantSettlement(messages)).toContain(`finish=${finish}`);
    }
    expect(
        describeAssistantSettlement({
            tokenLog: { finish_reason: "length" },
            reasoning: "private",
        }),
    ).toBe("finish=length, reasoning=true");
});

describe("hasLengthCappedOutput", () => {
    test("detects OpenCode assistant info.finish", () => {
        expect(hasLengthCappedOutput([{ info: { role: "assistant", finish: "length" } }])).toBe(
            true,
        );
    });

    test("detects OpenCode step-finish reason", () => {
        expect(
            hasLengthCappedOutput([{ parts: [{ type: "step-finish", reason: "length" }] }]),
        ).toBe(true);
        expect(hasLengthCappedOutput({ type: "text", reason: "length" })).toBe(false);
    });

    test("detects Pi stopReason length", () => {
        expect(hasLengthCappedOutput({ role: "assistant", stopReason: "length" })).toBe(true);
    });
});
