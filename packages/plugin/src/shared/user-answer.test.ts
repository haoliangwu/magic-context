import { expect, it } from "bun:test";
import cases from "../../../../tests/fixtures/user-answer-metadata.json";
import { hasUserAnswerMetadata, toolPartHasUserAnswer } from "./user-answer";

it("TS/Rust parity recognizes structural host answer metadata", () => {
    for (const test of cases) {
        expect(hasUserAnswerMetadata(test.metadata)).toBe(test.protected);
        expect(toolPartHasUserAnswer({ state: { metadata: test.metadata } })).toBe(test.protected);
        expect(toolPartHasUserAnswer({ details: test.metadata })).toBe(test.protected);
    }
    expect(toolPartHasUserAnswer({ tool: "question", state: { output: "no marker" } })).toBe(false);
});

it("OpenCode CK sidecars preserve answer provenance without changing block identities", async () => {
    const { encodeOpenCodeMessagesToCk } = await import("../hooks/magic-context/module-wire");
    const message = {
        info: { id: "m", role: "assistant" },
        parts: [
            {
                type: "tool",
                tool: "renamed-question",
                callID: "q",
                state: {
                    status: "completed",
                    input: {},
                    output: "answer",
                    metadata: { answers: [["yes"]] },
                },
            },
        ],
    };
    const answered = encodeOpenCodeMessagesToCk([message]);
    const plain = structuredClone(message);
    Reflect.deleteProperty(plain.parts[0].state, "metadata");
    const ordinary = encodeOpenCodeMessagesToCk([plain]);
    expect(answered[0].ck.content).toEqual(ordinary[0].ck.content);
    expect(answered[0].ck.provider_extras).toEqual({
        opencode: { user_answer_block_indices: [1] },
    });
});
