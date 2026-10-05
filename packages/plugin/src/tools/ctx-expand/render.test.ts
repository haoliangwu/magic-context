import { describe, expect, test } from "bun:test";

import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { renderMessageByOrdinal, renderVerboseRange } from "./render";

const SESSION = "ses-render-test";

function provide(messages: RawMessage[]): () => void {
    return setRawMessageProvider(SESSION, {
        readMessages: () => messages,
        readMessageById: (id) => messages.find((m) => m.id === id) ?? null,
    });
}

// OpenCode-shaped tool part: { type:"tool", tool, callID, state:{input,output} }
function ocTool(tool: string, callID: string, input: unknown, output: unknown): unknown {
    return { type: "tool", tool, callID, state: { input, output } };
}

describe("renderVerboseRange", () => {
    test("lists each message separately with id + per-part preview", () => {
        const cleanup = provide([
            {
                ordinal: 10,
                id: "msg_a",
                role: "user",
                parts: [{ type: "text", text: "please read the config" }],
            },
            {
                ordinal: 11,
                id: "msg_b",
                role: "assistant",
                parts: [
                    { type: "text", text: "Reading it now." },
                    ocTool("read", "read:1", { filePath: "config.ts" }, "line1\nline2\nline3"),
                ],
            },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 10, 11, 15_000);
            // Each message rendered separately, addressed by ordinal in the header.
            expect(out.text).toContain("[10] U (user)");
            expect(out.text).toContain("[11] A (assistant)");
            // Tool call shown with its name+arg and output size, not raw output.
            expect(out.text).toContain("tool read(config.ts)");
            expect(out.text).toMatch(/→ output ~\d+ tok/);
            // Preview is a preview — the raw multi-line output isn't dumped here.
            expect(out.text).not.toContain("line2");
            expect(out.lastOrdinal).toBe(11);
            expect(out.truncated).toBe(false);
        } finally {
            cleanup();
        }
    });

    test("labels tool-result-only user turns without changing real user or assistant turns", () => {
        const cleanup = provide([
            {
                ordinal: 2,
                id: "prompt",
                role: "user",
                parts: [{ type: "text", text: "Read PLAN.md" }],
            },
            {
                ordinal: 3,
                id: "call",
                role: "assistant",
                parts: [ocTool("read", "read:1", { filePath: "PLAN.md" }, undefined)],
            },
            {
                ordinal: 4,
                id: "results",
                role: "user",
                parts: [ocTool("read", "read:1", null, "file contents")],
            },
            {
                ordinal: 5,
                id: "mixed",
                role: "user",
                parts: [
                    { type: "tool_result", tool_use_id: "read:2", content: "more contents" },
                    { type: "text", text: "Continue" },
                ],
            },
            {
                ordinal: 6,
                id: "anthropic",
                role: "user",
                parts: [{ type: "tool_result", tool_use_id: "read:3", content: "output" }],
            },
            {
                ordinal: 7,
                id: "oc",
                role: "assistant",
                parts: [ocTool("read", "read:4", {}, "output")],
            },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 2, 7, 15_000);
            expect(out.text).toMatch(/^\[2\] U \(user\)\n {4}• Read PLAN.md/m);
            expect(out.text).toMatch(/^\[3\] A \(assistant\)\n {4}• tool read\(PLAN.md\)/m);
            expect(out.text).toMatch(/^\[4\] tool results\n {4}• tool read → output ~\d+ tok/m);
            expect(out.text).toMatch(
                /^\[5\] U \(user\)\n {4}• tool tool_result → output ~\d+ tok\n {4}• Continue/m,
            );
            expect(out.text).toMatch(/^\[6\] tool results/m);
            expect(out.text).toMatch(/^\[7\] A \(assistant\)/m);
            expect(out.lastOrdinal).toBe(7);
        } finally {
            cleanup();
        }
    });

    test("keeps ranges without tool-result-only messages byte-identical", () => {
        const cleanup = provide([
            {
                ordinal: 2,
                id: "prompt",
                role: "user",
                parts: [{ type: "text", text: "Read PLAN.md" }],
            },
            {
                ordinal: 3,
                id: "reply",
                role: "assistant",
                parts: [{ type: "text", text: "Reading" }],
            },
        ]);
        try {
            expect(renderVerboseRange(SESSION, 2, 3, 15_000).text).toBe(
                "[2] U (user)\n    • Read PLAN.md\n\n[3] A (assistant)\n    • Reading",
            );
        } finally {
            cleanup();
        }
    });

    test("only includes messages within [start,end]", () => {
        const cleanup = provide([
            { ordinal: 5, id: "msg_before", role: "user", parts: [{ type: "text", text: "x" }] },
            { ordinal: 10, id: "msg_in", role: "user", parts: [{ type: "text", text: "y" }] },
            { ordinal: 99, id: "msg_after", role: "user", parts: [{ type: "text", text: "z" }] },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 10, 20, 15_000);
            expect(out.text).toContain("[10] U (user)");
            expect(out.text).not.toContain("[5] U (user)");
            expect(out.text).not.toContain("[99] U (user)");
        } finally {
            cleanup();
        }
    });

    test("token budget truncates across many messages and reports continuation", () => {
        // Verbose previews are capped per-part, so truncation is driven by the
        // NUMBER of messages, not one giant message. Each block here is ~tens of
        // tokens; a tight budget fits the first but not the second.
        const text = "word ".repeat(40);
        const cleanup = provide([
            { ordinal: 1, id: "m1", role: "user", parts: [{ type: "text", text }] },
            { ordinal: 2, id: "m2", role: "user", parts: [{ type: "text", text }] },
            { ordinal: 3, id: "m3", role: "user", parts: [{ type: "text", text }] },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 1, 3, 30);
            // First block always emitted (never an empty result), then truncates.
            expect(out.text).toContain("[1] U (user)");
            expect(out.truncated).toBe(true);
            expect(out.lastOrdinal).toBe(1);
        } finally {
            cleanup();
        }
    });
});

describe("renderMessageByOrdinal", () => {
    test("recovers the FULL untruncated tool output (the ctx_reduce way-back)", () => {
        const fullOutput = "ERROR at line 42\n".repeat(50);
        const cleanup = provide([
            {
                ordinal: 7,
                id: "msg_tool",
                role: "assistant",
                parts: [ocTool("bash", "bash:9", { description: "run tests" }, fullOutput)],
            },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 7);
            expect(out).toContain("[7] A (assistant)");
            expect(out).toContain("[tool: bash #bash:9]");
            // FULL output present, not a preview/size.
            expect(out).toContain(fullOutput.trim().slice(0, 30));
            expect(out).toContain("input:");
        } finally {
            cleanup();
        }
    });

    test("strips step-start/step-finish/reasoning noise — only tool input+output remain", () => {
        const cleanup = provide([
            {
                ordinal: 9,
                id: "msg_noisy",
                role: "assistant",
                parts: [
                    { type: "step-start" },
                    { type: "reasoning", text: "thinking about which file to read" },
                    {
                        type: "tool",
                        tool: "read",
                        callID: "read:3",
                        state: {
                            status: "completed",
                            input: { filePath: "a.ts" },
                            output: "the recovered output",
                            title: "Read a.ts",
                        },
                    },
                    {
                        type: "step-finish",
                        reason: "tool-calls",
                        tokens: { total: 1234, cache: { read: 999 } },
                    },
                ],
            },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 9);
            // Tool data present, incl. the non-empty description line.
            expect(out).toContain("[tool: read #read:3]");
            expect(out).toContain("description: Read a.ts");
            expect(out).toContain("the recovered output");
            // Noise stripped.
            expect(out).not.toContain("step-start");
            expect(out).not.toContain("step-finish");
            expect(out).not.toContain("reasoning");
            expect(out).not.toContain("thinking about which file");
            expect(out).not.toContain("1234");
        } finally {
            cleanup();
        }
    });

    test("recovers a non-tool user message in full (any role)", () => {
        const paste = "a very long pasted log\n".repeat(20);
        const cleanup = provide([
            { ordinal: 3, id: "msg_paste", role: "user", parts: [{ type: "text", text: paste }] },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 3);
            expect(out).toContain("[3] U (user)");
            expect(out).toContain("[text]");
            expect(out).toContain(paste.trim().slice(0, 30));
        } finally {
            cleanup();
        }
    });

    test("missing ordinal reports deleted, does not throw", () => {
        const cleanup = provide([
            { ordinal: 1, id: "exists", role: "user", parts: [{ type: "text", text: "hi" }] },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 999);
            expect(out).toContain("No message at ordinal 999");
            expect(out).toContain("deleted");
        } finally {
            cleanup();
        }
    });
});
