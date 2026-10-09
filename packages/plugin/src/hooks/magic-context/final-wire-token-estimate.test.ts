import { afterEach, describe, expect, it } from "bun:test";
import {
    __resetToolDefinitionMeasurements,
    getLargestMeasuredToolDefinitionTokens,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { outgoingContextRefusal } from "./emergency-fail-closed";
import {
    createFinalWireUsageTracker,
    describeFinalWireTail,
    estimateFinalWireInputTokens,
    estimateOutgoingWireForRefusal,
    type FinalWireTokenEstimate,
} from "./final-wire-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";

const MODEL = { providerID: "test-provider", modelID: "test-model", agentName: "build" };

afterEach(() => __resetToolDefinitionMeasurements());

it("healthy refusal settles over and under byte bounds without token counts", () => {
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read", {});
    const huge = estimateOutgoingWireForRefusal(
        {
            messages: [toolMessage("x".repeat(12 * 1024 * 1024 + 1000))],
            systemPromptTokens: 100,
            ...MODEL,
        },
        16000,
    );
    expect(huge.refusalBasis).toBe("byte-bound");
    expect(huge.refusalGrade).toBe(true);
    expect(huge.messageTokens).toEqual({ conversation: 0, toolCall: 0 });
    const small = estimateOutgoingWireForRefusal(
        { messages: [toolMessage("x".repeat(4000))], systemPromptTokens: 100, ...MODEL },
        16000,
    );
    expect(small.refusalBasis).toBe("byte-bound");
    expect(small.refusalGrade).toBe(false);
    expect(small.messageTokens).toEqual({ conversation: 0, toolCall: 0 });
});

it("uncertain refusal bounds pathological text without changing shared tokenization", () => {
    const ordinary = estimateTokens("ordinary words");
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read", {});
    const text = "x".repeat(16385);
    const startedAt = performance.now();
    const result = estimateOutgoingWireForRefusal(
        { messages: [toolMessage(text)], systemPromptTokens: 100, ...MODEL },
        10000,
    );
    expect(result.messageTokens.toolCall).toBeGreaterThanOrEqual(Buffer.byteLength(text));
    expect(result.refusalGrade).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(estimateTokens("ordinary words")).toBe(ordinary);
});

it("borrowed tool definitions and family fallback are admission-only even on complete over-limit envelopes", () => {
    recordToolDefinition("other", "route", "build", "probe", "word ".repeat(20000), {});
    const messages = [toolMessage("word ".repeat(20000))];
    const borrowed = estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 100,
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
        agentName: "build",
    });
    expect(borrowed.trusted).toBe(true);
    expect(borrowed.tokens).toBeGreaterThan(16000);
    expect(borrowed.toolDefinitionsMeasured).toBe(false);
    expect(borrowed.refusalGrade).toBe(false);
    expect(outgoingContextRefusal(borrowed, 16000)).toBeUndefined();
    recordToolDefinition("anthropic", "claude-fable-5-2", "build", "probe", "A probe", {});
    const inherited = estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 100,
        providerID: "anthropic",
        modelID: "claude-fable-5-2",
        agentName: "build",
    });
    expect(inherited.trusted).toBe(true);
    expect(inherited.toolDefinitionsMeasured).toBe(true);
    expect(inherited.refusalGrade).toBe(false);
    expect(outgoingContextRefusal(inherited, 16000)).toBeUndefined();
});

it("OpenCode correlated provider usage wins over full-prefix estimates and rejects stale evidence", () => {
    const route = { providerID: "anthropic", modelID: "claude-fable-5-1", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const tracker = createFinalWireUsageTracker();
    const prefix = [
        {
            info: { id: "input", role: "user" },
            parts: [{ type: "text", text: "word ".repeat(20000) }],
        },
    ] as MessageLike[];
    const envelope = { systemPromptTokens: 100, systemPromptHash: "system-v1", ...route };
    tracker.capture("session", { messages: prefix, ...envelope });
    const reply = {
        info: {
            id: "reply",
            role: "assistant",
            parentID: "input",
            ...route,
            finish: "stop",
            time: { completed: Date.now() + 1 },
            tokens: { input: 100, cache: { read: 20, write: 10 } },
        },
        parts: [{ type: "text", text: "New reply" }],
    } as unknown as MessageLike;
    const messages = [...prefix, reply];
    const measured = tracker.estimate("session", { messages, ...envelope });
    expect(measured.tokens).toBeGreaterThan(16000);
    expect(measured.refusalBasis).toBe("provider-prefix");
    expect(measured.refusalTokens).toBeGreaterThanOrEqual(130);
    expect(measured.refusalTokens).toBeLessThan(200);
    expect(outgoingContextRefusal(measured, 16000)).toBeUndefined();
    for (const input of [
        { messages, ...envelope, systemPromptHash: "system-v2" },
        {
            messages: [{ ...prefix[0], parts: [{ type: "text", text: "changed prefix" }] }, reply],
            ...envelope,
        },
        {
            messages: [...prefix, { ...reply, info: { ...reply.info, parentID: "other" } }],
            ...envelope,
        },
        {
            messages: [...prefix, { ...reply, info: { ...reply.info, providerID: "other" } }],
            ...envelope,
        },
    ])
        expect(tracker.estimate("session", input).refusalBasis).toBe("calibrated");
    recordToolDefinition(
        route.providerID,
        route.modelID,
        route.agentName,
        "probe",
        "Changed schema",
        {},
    );
    expect(tracker.estimate("session", { messages, ...envelope }).refusalBasis).toBe("calibrated");
});

it("OpenCode measured preceding overflow does not refuse a fitting protected subset", () => {
    const route = { providerID: "anthropic", modelID: "claude-fable-5-1", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const tracker = createFinalWireUsageTracker();
    const envelope = { systemPromptTokens: 100, systemPromptHash: "system-v1", ...route };
    const prefix = [
        { info: { id: "input", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ] as MessageLike[];
    tracker.capture("session", { messages: prefix, ...envelope });
    const reply = {
        info: {
            id: "reply",
            role: "assistant",
            parentID: "input",
            ...route,
            finish: "stop",
            time: { completed: Date.now() + 1 },
            tokens: { input: 15000, cache: { read: 900, write: 200 } },
        },
        parts: [{ type: "text", text: "hello" }],
    } as unknown as MessageLike;
    const estimate = tracker.estimate("session", { messages: [...prefix, reply], ...envelope });
    expect(estimate.tokens).toBeLessThan(1000);
    expect(estimate.refusalTokens).toBeGreaterThan(16000);
    expect(outgoingContextRefusal(estimate, 16000, 0)).toBeUndefined();
    expect(outgoingContextRefusal(estimate, 16000, 10)).toBeUndefined();
});

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
