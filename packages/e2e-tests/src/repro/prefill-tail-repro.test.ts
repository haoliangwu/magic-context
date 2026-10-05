import { expect, test } from "bun:test";
import { rejectionReason } from "./prefill-tail-repro";

const user = { role: "user", content: [{ type: "text", text: "Continue" }] };

test("rejects Gemini-invalid model turns and empty content", () => {
    expect(
        rejectionReason([
            user,
            { role: "assistant", content: [{ type: "text", text: "Partial" }] },
        ]),
    ).toBe("model-tail");
    for (const content of [[], "", [{ type: "text", text: "" }]]) {
        expect(rejectionReason([{ role: "assistant", content }, user])).toBe("empty-assistant");
    }
});

test("accepts a completed tool round and nonempty assistant history", () => {
    expect(
        rejectionReason([
            user,
            { role: "assistant", content: [{ type: "tool_use", name: "read" }] },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "call-1" }],
            },
        ]),
    ).toBeUndefined();
    expect(rejectionReason([{ role: "assistant", content: "Done" }, user])).toBeUndefined();
});
