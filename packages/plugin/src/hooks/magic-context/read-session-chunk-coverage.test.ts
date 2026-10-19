import { describe, expect, test } from "bun:test";
import { validateChunkCoverage, validateHistorianOutput } from "./compartment-runner-validation";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import { buildToolArcs, fenceBoundaryForCompletedToolArcs } from "./read-session-true-raw-tokens";

const pair: RawMessage[] = [
    {
        ordinal: 1,
        id: "invocation",
        role: "assistant",
        parts: [
            { type: "text", text: "Updating tasks." },
            {
                type: "tool",
                tool: "todowrite",
                callID: "tasks",
                state: { input: { todos: [{ content: "Investigate", status: "in_progress" }] } },
            },
        ],
    },
    {
        ordinal: 2,
        id: "result",
        role: "user",
        parts: [
            {
                type: "tool",
                tool: "todowrite",
                callID: "tasks",
                state: { output: '[{"content":"Investigate","status":"in_progress"}]' },
            },
        ],
    },
];

function read(messages: RawMessage[], expand = true, budget = 32_000) {
    return withRawMessageProvider(
        "chunk-coverage",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => readSessionChunk("chunk-coverage", budget, 1, undefined, { expand }),
    );
}

describe("trailing filtered chunk coverage", () => {
    test.each([
        { name: "expanded result-only tail", messages: pair, expand: true, end: 2 },
        { name: "expansion disabled", messages: pair, expand: false, end: 2 },
        {
            name: "visible successor",
            messages: [
                ...pair,
                {
                    ordinal: 3,
                    id: "next",
                    role: "user",
                    parts: [{ type: "text", text: "Continue." }],
                },
            ],
            expand: true,
            end: 3,
        },
    ])("$name preserves coverage and maps the healed terminal endpoint", ({
        messages,
        expand,
        end,
    }) => {
        const original = JSON.stringify(messages);
        const chunk = read(messages, expand);
        expect(chunk.endIndex).toBe(end);
        expect(chunk.endMessageId).toBe(messages[end - 1]?.id ?? "");
        expect(chunk.startMessageId).toBe("invocation");
        expect(chunk.messageCount).toBe(end);
        expect(chunk.lines).toEqual(messages.map((m) => ({ ordinal: m.ordinal, messageId: m.id })));
        expect(chunk.hasMore).toBe(false);
        expect(chunk.completedToolArcs).toEqual([{ start: 1, end: 2 }]);
        expect(validateChunkCoverage(chunk)).toBeNull();
        const result = validateHistorianOutput(
            `<output><compartment start="1" end="${end === 2 ? 1 : end}" title="Tasks"><p1>Updated tasks.</p1></compartment></output>`,
            "chunk-coverage",
            chunk,
            [],
            0,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.compartments[0]?.endMessage).toBe(end);
            expect(result.compartments[0]?.endMessageId).toBe(messages[end - 1]?.id);
        }
        if (expand) expect(chunk.text.match(/Investigate/g)?.length).toBe(1);
        expect(JSON.stringify(messages)).toBe(original);
    });

    test.each([
        { role: "user", parts: [{ type: "text", text: "## Magic Status", ignored: true }] },
        {
            role: "user",
            parts: [{ type: "text", text: "<system-reminder>finished</system-reminder>" }],
        },
        {
            role: "user",
            parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: MAGIC-CONTEXT internal]" }],
        },
        { role: "user", parts: [{ type: "text", text: "<!-- OMO_INTERNAL_INITIATOR -->" }] },
        { role: "assistant", parts: [] },
        { role: "assistant", parts: [{ type: "text", text: "" }] },
    ])("counts trailing filtered row $role $parts without rendering it", (noise) => {
        const visible: RawMessage = {
            ordinal: 1,
            id: "visible",
            role: "user",
            parts: [{ type: "text", text: "Work." }],
        };
        const chunk = read([visible, { ...noise, ordinal: 2, id: "noise" }]);
        expect(chunk.text).toBe("[1] U: Work.");
        expect(chunk.endIndex).toBe(2);
        expect(chunk.endMessageId).toBe("noise");
        expect(chunk.messageCount).toBe(2);
        expect(chunk.lines).toEqual([
            { ordinal: 1, messageId: "visible" },
            { ordinal: 2, messageId: "noise" },
        ]);
        expect(validateChunkCoverage(chunk)).toBeNull();
    });

    test("does not absorb filtered rows past a rejected visible block", () => {
        const chunk = read(
            [
                {
                    ordinal: 1,
                    id: "first",
                    role: "user",
                    parts: [{ type: "text", text: "First." }],
                },
                {
                    ordinal: 2,
                    id: "blocked",
                    role: "assistant",
                    parts: [{ type: "text", text: "Beyond budget." }],
                },
                { ordinal: 3, id: "noise", role: "assistant", parts: [] },
            ],
            true,
            1,
        );
        expect(chunk.endIndex).toBe(1);
        expect(chunk.messageCount).toBe(1);
        expect(chunk.hasMore).toBe(true);
        expect(validateChunkCoverage(chunk)).toBeNull();
    });

    test("keeps all-noise chunks on the explicit filtered-noise path", () => {
        const chunk = read([{ ordinal: 1, id: "noise", role: "assistant", parts: [] }]);
        expect(chunk.text).toBe("");
        expect(chunk.messageCount).toBe(0);
        expect(chunk.lines).toEqual([]);
        expect(chunk.filteredNoiseLines).toEqual([{ ordinal: 1, messageId: "noise" }]);
    });

    test("an eligible end fenced before an unavailable result excludes its invocation", () => {
        const messages: RawMessage[] = [
            {
                ordinal: 1,
                id: "prefix",
                role: "user",
                parts: [{ type: "text", text: "Earlier work." }],
            },
            ...pair.map((message) => ({ ...message, ordinal: message.ordinal + 1 })),
        ];
        const eligibleEnd = fenceBoundaryForCompletedToolArcs(3, buildToolArcs(messages), 1);
        expect(eligibleEnd).toBe(2);
        const chunk = withRawMessageProvider(
            "fenced-coverage",
            { readMessages: () => messages, getMessageCount: () => messages.length },
            () => readSessionChunk("fenced-coverage", 32_000, 1, eligibleEnd),
        );
        expect(chunk.endIndex).toBe(1);
        expect(chunk.endMessageId).toBe("prefix");
        expect(chunk.messageCount).toBe(1);
        expect(chunk.completedToolArcs).toEqual([]);
        expect(chunk.text).not.toContain("Updating tasks.");
    });
});
