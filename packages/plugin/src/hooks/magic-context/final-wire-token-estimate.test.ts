import { afterEach, describe, expect, it } from "bun:test";
import {
    __resetToolDefinitionMeasurements,
    getLargestMeasuredToolDefinitionTokens,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import {
    describeFinalWireTail,
    estimateFinalWireInputTokens,
    type FinalWireTokenEstimate,
} from "./final-wire-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";

const MODEL = { providerID: "test-provider", modelID: "test-model", agentName: "build" };

afterEach(() => __resetToolDefinitionMeasurements());

function estimate(messages: MessageLike[]): FinalWireTokenEstimate {
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read a file", {
        type: "object",
        properties: { path: { type: "string" } },
    });
    return estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 10_000,
        ...MODEL,
    });
}

function toolMessage(output: string): MessageLike {
    return {
        info: { id: "tool-owner", role: "assistant" },
        parts: [
            {
                type: "tool",
                state: { input: { path: "large.log" }, output },
            },
        ],
    } as unknown as MessageLike;
}

describe("final outgoing-wire token estimate", () => {
    it("invalidates exact-content counts for in-place historical text and nested tool edits", () => {
        const row = toolMessage("cache original");
        const state = (row.parts[0] as { state: { input: { path: string }; output: string } })
            .state;
        const first = estimate([row]);
        expect(estimate(structuredClone([row]))).toEqual(first);
        state.input.path = "different/new/path.ts";
        state.output = "edited output with many additional words";
        expect(estimate([row]).messageTokens.toolCall).toBe(
            estimateTokens(JSON.stringify(state.input)) + estimateTokens(state.output),
        );
        state.output = "cache original";
        state.input.path = "large.log";
        expect(estimate([row])).toEqual(first);
    });

    it("counts attachments still sent with a legacy dropped skeleton", () => {
        const row = toolMessage("[dropped §7§]");
        const state = (row.parts[0] as { state: { attachments?: unknown[] } }).state;
        const without = estimate([row]).messageTokens.toolCall;
        state.attachments = [
            { type: "file", mime: "image/png", url: "https://example.com/image.png" },
        ];
        expect(estimate([row]).messageTokens.toolCall - without).toBe(1200);
        state.attachments = [];
        expect(estimate([row]).messageTokens.toolCall).toBe(without);
    });
    it("describes the final three post-transform message tails compactly", () => {
        const messages = [
            { info: { role: "assistant" }, parts: [{ type: "text" }] },
            { info: { role: "user" }, parts: [{ type: "tool" }] },
            { info: { role: "assistant" }, parts: [{ type: "tool" }, { type: "text" }] },
            { info: { role: "user" }, parts: [{ type: "tool_result" }] },
        ] as MessageLike[];

        expect(describeFinalWireTail(messages)).toBe(
            "[user:toolresult, assistant:tool+text, user:toolresult]",
        );
    });

    it("reflects a flushed pending drop in telemetry", () => {
        const largeOutput = Array.from({ length: 40_000 }, (_, index) => `token_${index}`).join(
            " ",
        );
        const message = toolMessage(largeOutput);
        const beforeDrop = estimate([message]);
        (message.parts[0] as { state: { output: string } }).state.output = "[dropped]";
        const afterDrop = estimate([message]);
        const inputLimit = Math.floor((beforeDrop.tokens + afterDrop.tokens) / 2.1);

        expect(beforeDrop.trusted).toBe(true);
        expect(afterDrop.tokens).toBeLessThan(inputLimit);
        expect(beforeDrop.tokens).toBeGreaterThan(inputLimit * 1.05);
    });

    it("reports telemetry for an unchanged rebuilt fold", () => {
        const unchanged = estimate([
            toolMessage(Array.from({ length: 20_000 }, (_, index) => `fold_${index}`).join(" ")),
        ]);
        const inputLimit = Math.floor(unchanged.tokens / 1.1);

        expect(unchanged.tokens).toBeGreaterThan(inputLimit);
    });

    it("counts every OpenCode 2 tool-part representation", () => {
        const convertedOutput = "converted-tool-output ".repeat(20_000);
        const result = estimate([
            {
                info: { id: "v2-parts", role: "assistant" },
                parts: [
                    { type: "tool-call", input: { path: "converted.log" } },
                    { type: "tool-result", result: { type: "text", value: convertedOutput } },
                    {
                        type: "tool-invocation",
                        args: { path: "legacy.log" },
                        result: convertedOutput,
                    },
                    { type: "tool_use", input: { path: "anthropic.log" } },
                    { type: "tool_result", content: convertedOutput },
                    {
                        type: "tool",
                        state: { input: { path: "native.log" }, output: convertedOutput },
                    },
                    {
                        type: "tool",
                        state: {
                            input: { path: "converted.log" },
                            content: [{ type: "text", text: convertedOutput }],
                        },
                    },
                ],
            } as unknown as MessageLike,
        ]);

        expect(result.trusted).toBe(true);
        expect(result.messageTokens.toolCall).toBeGreaterThan(100_000);
    });

    it("reports a compact completed recomp refresh", () => {
        const trimmed = estimate([
            {
                info: { id: "summary", role: "user" },
                parts: [
                    { type: "text", text: "<session-history>compact summary</session-history>" },
                ],
            } as MessageLike,
        ]);

        expect(trimmed.trusted).toBe(true);
        expect(trimmed.messageTokens.conversation).toBeGreaterThan(0);
    });
});

it("unknown-model fit inflates raw mass instead of admitting a locally-fitting request", () => {
    const result = estimate([
        {
            info: { id: "m", role: "user" },
            parts: [{ type: "text", text: "hello" }],
        } as MessageLike,
    ]);
    expect(result.tokens).toBeGreaterThanOrEqual(20000);
    expect(result.rawTokens).toBeLessThan(11000);
    expect(result.trusted).toBe(true);
});
it("uses a conservative measured tool-definition envelope when the current model is unmeasured", () => {
    recordToolDefinition("test-provider", "measured-model", "build", "read", "A".repeat(4000), {});
    const result = estimateFinalWireInputTokens({
        messages: [
            {
                info: { id: "m", role: "user" },
                parts: [{ type: "text", text: "hello" }],
            } as MessageLike,
        ],
        systemPromptTokens: 10_000,
        providerID: "test-provider",
        modelID: "unmeasured-model",
        agentName: "build",
    });
    expect(result.trusted).toBe(true);
    expect(result.toolDefinitionTokens).toBeGreaterThanOrEqual(
        2 * (getLargestMeasuredToolDefinitionTokens() ?? 0),
    );
});

it("unsupported nontext parts never produce a trusted fit estimate", () => {
    const result = estimate([
        {
            info: { id: "m", role: "user" },
            parts: [{ type: "audio", data: "unknown" }],
        } as unknown as MessageLike,
    ]);
    expect(result.trusted).toBe(false);
    expect(result.completeness).toBe("partial");
});
it("an inline image (like the memory mural in m[0]) keeps the estimate trusted", () => {
    const result = estimate([
        {
            info: { id: "m0", role: "user" },
            parts: [
                { type: "text", text: "<memory-mural>" },
                { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" },
            ],
        } as unknown as MessageLike,
    ]);
    expect(result.trusted).toBe(true);
});

it("a non-image attachment still leaves the estimate untrusted", () => {
    const result = estimate([
        {
            info: { id: "m", role: "user" },
            parts: [{ type: "file", mime: "application/pdf", url: "file:///tmp/spec.pdf" }],
        } as unknown as MessageLike,
    ]);
    expect(result.trusted).toBe(false);
});

it("nonfinite system mass cannot be trusted even with known tool definitions", () => {
    estimate([]);
    const result = estimateFinalWireInputTokens({
        messages: [],
        ...MODEL,
        systemPromptTokens: Number.POSITIVE_INFINITY,
    });
    expect(result.trusted).toBe(false);
});
