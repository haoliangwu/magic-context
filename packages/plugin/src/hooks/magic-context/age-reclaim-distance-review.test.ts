import { expect, test } from "bun:test";
import { farBehindToolBookmark } from "../../shared/reclaim-distance";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import type { MessageLike, TagTarget } from "./tag-messages";
import { toolReclaimDistanceEntries } from "./tool-reclaim";

function oldOutput() {
    const message = {
        info: { id: "old", role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { input: {}, output: "used result" } }],
    } as unknown as MessageLike;
    const target: TagTarget = {
        setContent: () => false,
        mutationParts: [{ message, part: message.parts[0] }],
    };
    return { message, targets: new Map([[1, target]]) };
}

for (const host of ["OpenCode 1", "OpenCode 2"]) {
    test(`${host}: synthetic wake messages must not age the active task`, () => {
        const { message, targets } = oldOutput();
        const wakes = Array.from({ length: 3 }, (_, index) => ({
            info: { id: `wake-${index}`, role: "user" },
            parts: [
                {
                    type: "text",
                    synthetic: true,
                    text: "<system-reminder>Background task finished.</system-reminder>",
                },
            ],
        })) as unknown as MessageLike[];
        expect(
            farBehindToolBookmark(
                toolReclaimDistanceEntries([message, ...wakes], targets),
                200_000,
            ),
        ).toBe(0);
    });

    test(`${host}: newer image mass must age an output at a quarter window`, () => {
        const { message, targets } = oldOutput();
        const images = Array.from({ length: 21 }, (_, index) => ({
            info: { id: `image-${index}`, role: "assistant" },
            parts: [{ type: "file", mime: "image/png", url: "https://example.invalid/image.png" }],
        })) as unknown as MessageLike[];
        // The normal request estimator already prices these images at 25,200 tokens.
        expect(
            images.reduce((sum, image) => sum + estimateMessageTokens(image).conversation, 0),
        ).toBe(25_200);
        expect(
            farBehindToolBookmark(
                toolReclaimDistanceEntries([message, ...images], targets),
                100_000,
            ),
        ).toBe(1);
    });
}

test("distance adapter controls: heads, reminders and tool-only users are not turns; image-only users are", () => {
    const { message, targets } = oldOutput();
    const controls = [
        {
            info: { id: "head", role: "user", syntheticHead: true },
            parts: [{ type: "text", text: "history" }],
        },
        {
            info: { id: "nudge", role: "user" },
            parts: [
                {
                    type: "text",
                    text: '<instruction name="deferred_notes">remember</instruction>',
                },
            ],
        },
        {
            info: { id: "result", role: "user" },
            parts: [{ type: "tool_result", content: "only a result" }],
        },
    ] as unknown as MessageLike[];
    expect(
        farBehindToolBookmark(toolReclaimDistanceEntries([message, ...controls], targets), 0),
    ).toBe(0);
    const users = Array.from({ length: 3 }, (_, i) => ({
        info: { id: `u${i}`, role: "user" },
        parts: [{ type: "file", mime: "image/png", url: "https://example.invalid/image.png" }],
    })) as unknown as MessageLike[];
    expect(farBehindToolBookmark(toolReclaimDistanceEntries([message, ...users], targets), 0)).toBe(
        1,
    );
});
