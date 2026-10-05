import { describe, expect, spyOn, test } from "bun:test";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    buildLkgPrefix,
    captureLkgSlot,
    projectLkgEntry,
    replayLkg,
    validateAnthropicReasoningRuns,
    validateLkgEntry,
    validateLkgSeam,
} from "./lkg-replay";
import {
    captureSlot,
    getSlot,
    lkgContentDigest,
    messageContentFields,
    noteEntry,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import { createPassOutcome } from "./pass-outcome";
import type { MessageLike } from "./transform-operations";

function user(
    id: string,
    created: number,
    model = { providerID: "test", modelID: "model" },
): MessageLike {
    return {
        info: { id, role: "user", sessionID: "session", model, time: { created } } as never,
        parts: [{ type: "text", text: id }],
    };
}

function assistant(id: string, created: number, parts: unknown[] = []): MessageLike {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session",
            time: { created },
            finish: "stop",
        } as never,
        parts,
    };
}

describe("LKG transform replay", () => {
    test("captures entry digests before live tagging mutates the host messages", () => {
        resetLkgSlotsForTest();
        const raw = [user("u0", 1), user("u1", 2)];
        const pristine = structuredClone(raw);
        const entry = projectLkgEntry(raw);
        (raw[0].parts[0] as { text: string }).text = "§1§ managed summary";
        expect(
            captureLkgSlot({
                sessionId: "eager-input",
                input: entry,
                output: raw,
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(true);
        const replay = replayLkg({
            sessionId: "eager-input",
            messages: pristine,
            modelKey: "test/model",
            providerKey: "test",
        });
        expect(replay.ok).toBe(true);
        if (replay.ok) expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(raw));
    });

    test("projects only anchor fields without retaining message parts", () => {
        const input = [
            user("u0", 1),
            assistant("a1", 2, [
                {
                    type: "tool",
                    providerExecuted: false,
                    state: { status: "running" },
                    nested: { large: true },
                },
            ]),
            user("u1", 3),
        ];
        const projected = projectLkgEntry(input);
        expect(projected).toEqual([
            {
                id: "u0",
                role: "user",
                synthetic: false,
                timeCreated: 1,
                finish: undefined,
                hasIncompleteTool: false,
            },
            {
                id: "a1",
                role: "assistant",
                synthetic: false,
                timeCreated: 2,
                finish: "stop",
                hasIncompleteTool: true,
            },
            {
                id: "u1",
                role: "user",
                synthetic: false,
                timeCreated: 3,
                finish: undefined,
                hasIncompleteTool: false,
            },
        ]);
        expect("parts" in (projected[1] as object)).toBe(false);
    });

    test("captures only the prefix through an early anchor and serves a pristine tail", () => {
        resetLkgSlotsForTest();
        const input = [
            user("u0", 1),
            user("u1", 2),
            assistant("a1", 3, [
                {
                    type: "tool",
                    callID: "call-1",
                    state: { status: "completed", output: { nested: "original" } },
                },
            ]),
        ];
        const output = structuredClone(input) as MessageLike[];
        expect(
            captureLkgSlot({
                sessionId: "session",
                input,
                output,
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(true);
        const current = [...structuredClone(input), user("u2", 4)] as MessageLike[];
        const entry = noteEntry("session", current);
        expect(entry).not.toBeNull();
        const originalTail = structuredClone(entry?.pristineTail);
        const tool = current[2]?.parts[0] as Record<string, unknown>;
        (tool.state as Record<string, unknown>).output = { nested: "mutated" };
        const replay = replayLkg({
            sessionId: "session",
            messages: current,
            modelKey: "test/model",
            providerKey: "test",
            entry,
        });
        expect(replay.ok).toBe(true);
        if (replay.ok) {
            expect(replay.messages.map((message) => message.info.id)).toEqual([
                "u0",
                "u1",
                "a1",
                "u2",
            ]);
            expect(replay.messages[2]).toEqual(originalTail?.[0]);
            expect(new Set(replay.messages.map((message) => message.info.id)).size).toBe(4);
        }
    });

    test("accepts an empty host diff summary added after capture without masking real changes", () => {
        resetLkgSlotsForTest();
        const input = [user("u0", 1), user("u1", 2)];
        expect(
            captureLkgSlot({
                sessionId: "late-empty-summary",
                input,
                output: structuredClone(input),
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(true);
        const current = [...structuredClone(input), user("u2", 3)] as MessageLike[];
        (current[1]!.info as Record<string, unknown>).summary = { diffs: [] };
        expect(messageContentFields(current[1]!)).toEqual(messageContentFields(input[1]!));
        expect(
            replayLkg({
                sessionId: "late-empty-summary",
                messages: current,
                modelKey: "test/model",
                providerKey: "test",
            }).ok,
        ).toBe(true);
        (current[1]!.parts[0] as { text: string }).text = "edited despite stable id";
        expect(
            replayLkg({
                sessionId: "late-empty-summary",
                messages: current,
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toEqual({ ok: false, reason: "lkg_content_mismatch" });
    });

    test("declines replay when stable-id content changes through the anchor", () => {
        resetLkgSlotsForTest();
        const input = [user("u0", 1), user("u1", 2)];
        expect(
            captureLkgSlot({
                sessionId: "content-mismatch",
                input,
                output: structuredClone(input),
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(true);
        const current = structuredClone(input) as MessageLike[];
        (current[1]?.parts[0] as { text: string }).text = "same id, changed content";

        expect(
            replayLkg({
                sessionId: "content-mismatch",
                messages: current,
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toEqual({ ok: false, reason: "lkg_content_mismatch" });
        expect(getSlot("content-mismatch")).toBeUndefined();
    });

    test("serializes the capture prefix once and stores that artifact", () => {
        resetLkgSlotsForTest();
        const input = [user("u0", 1)];
        const stringifySpy = spyOn(JSON, "stringify");

        try {
            expect(
                captureLkgSlot({
                    sessionId: "single-serialization",
                    input,
                    output: structuredClone(input),
                    modelKey: "test/model",
                    providerKey: "test",
                }),
            ).toBe(true);
            expect(stringifySpy).toHaveBeenCalledTimes(1);
            expect(getSlot("single-serialization")?.jsonPrefix).toBe(
                stringifySpy.mock.results[0]?.value,
            );
        } finally {
            stringifySpy.mockRestore();
        }
    });

    test("declines duplicate input ids instead of storing a full-output snapshot", () => {
        resetLkgSlotsForTest();
        const input = [user("u0", 1), user("u0", 2)];
        expect(buildLkgPrefix(input, input)).toBeNull();
        expect(getSlot("session")).toBeUndefined();
    });

    test("marker validation rejects shifted starts, missing anchors, and suffix-only matches", () => {
        resetLkgSlotsForTest();
        captureSlot("session", {
            jsonPrefix: JSON.stringify([user("u1", 1)]),
            inputIdSeq: ["u1", "u2"],
            inputContentDigests: ["digest-u1", "digest-u2"],
            lastInputMessageId: "u2",
            modelKey: "test/model",
            providerKey: "test",
            capturedAt: 1,
        });
        const slot = getSlot("session");
        expect(slot).toBeDefined();
        expect(validateLkgEntry(slot!, ["u0", "u1", "u2", "u3"])).toBe(false);
        expect(validateLkgEntry(slot!, ["u1", "u3", "u4"])).toBe(false);
        expect(validateLkgEntry(slot!, ["u1", "u2", "u3"])).toBe(true);
    });

    test("degraded passes decline capture and preserve the prior snapshot", () => {
        resetLkgSlotsForTest();
        captureSlot("session", {
            jsonPrefix: JSON.stringify([user("old", 1)]),
            inputIdSeq: ["old"],
            inputContentDigests: ["digest-old"],
            lastInputMessageId: "old",
            modelKey: "test/model",
            providerKey: "test",
            capturedAt: 1,
        });
        const outcome = createPassOutcome();
        outcome.record("session-meta-early-return", "fatal");
        outcome.markFinalized();
        expect(outcome.captureEligible).toBe(false);
        expect(getSlot("session")?.lastInputMessageId).toBe("old");
    });

    test("provider-visible fixture survives serializer round trip", () => {
        const fixture = [
            { role: "user", content: "inspect" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
                ],
            },
            { role: "tool", tool_call_id: "call-1", content: "ok" },
        ];
        const roundTripped = JSON.parse(JSON.stringify(fixture));
        expect(roundTripped).toEqual(fixture);
        expect(validateLkgSeam(fixture as never, [], "openai")).toBe(true);
    });

    test("declines a seam that splits an unfinished tool run", () => {
        const prefix = [
            assistant("a1", 1, [{ type: "tool", callID: "call-1", state: { status: "running" } }]),
        ];
        const tail = [
            {
                info: { id: "tool-result", role: "tool" } as never,
                parts: [{ type: "tool_result", tool_call_id: "call-1", output: "result" }],
            } as MessageLike,
        ];
        expect(validateLkgSeam(prefix, tail, "openai")).toBe(false);
    });

    test("declines Anthropic replay when adjacent assistants would merge signed thinking runs", () => {
        resetLkgSlotsForTest();
        captureSlot("anthropic-invalid", {
            jsonPrefix: JSON.stringify([
                assistant("a-prefix", 1, [
                    { type: "thinking", thinking: "first signed trace", signature: "sig-a" },
                    { type: "text", text: "first response" },
                ]),
            ]),
            inputIdSeq: ["u-anchor"],
            inputContentDigests: [
                lkgContentDigest(
                    user("u-anchor", 2, { providerID: "anthropic", modelID: "claude-test" }),
                )!,
            ],
            lastInputMessageId: "u-anchor",
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
            capturedAt: 1,
        });
        const current = [
            user("u-anchor", 2, { providerID: "anthropic", modelID: "claude-test" }),
            assistant("a-tail", 3, [
                { type: "thinking", thinking: "second signed trace", signature: "sig-b" },
                { type: "text", text: "second response" },
            ]),
        ];

        expect(
            replayLkg({
                sessionId: "anthropic-invalid",
                messages: current,
                modelKey: "anthropic/claude-test",
                providerKey: "anthropic",
            }),
        ).toEqual({ ok: false, reason: "lkg_anthropic_reasoning_run_invalid" });
        expect(getSlot("anthropic-invalid")).toBeUndefined();
    });

    test("serves a new Anthropic thinking run after a completed tool result", () => {
        resetLkgSlotsForTest();
        const prefix = assistant("a-prefix", 1, [
            { type: "step-start" },
            { type: "thinking", thinking: "first signed trace", signature: "sig-a" },
            { type: "text", text: "calling a tool" },
            {
                type: "tool",
                callID: "call-1",
                tool: "read",
                providerExecuted: false,
                state: { status: "completed", input: {}, output: "result" },
            },
            { type: "step-finish" },
        ]);
        captureSlot("anthropic-tool-boundary", {
            jsonPrefix: JSON.stringify([prefix]),
            inputIdSeq: ["u-anchor"],
            inputContentDigests: [
                lkgContentDigest(
                    user("u-anchor", 2, { providerID: "anthropic", modelID: "claude-test" }),
                )!,
            ],
            lastInputMessageId: "u-anchor",
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
            capturedAt: 1,
        });
        const current = [
            user("u-anchor", 2, { providerID: "anthropic", modelID: "claude-test" }),
            assistant("a-tail", 3, [
                { type: "thinking", thinking: "second signed trace", signature: "sig-b" },
                { type: "text", text: "second response" },
            ]),
        ];

        const replay = replayLkg({
            sessionId: "anthropic-tool-boundary",
            messages: current,
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
        });
        expect(replay).toEqual({ ok: true, messages: [prefix, current[1]] });
    });

    test("accepts CEREB's contiguous signed thinking pair before a completed tool in one message", () => {
        const message = assistant("a-cereb", 1, [
            { type: "step-start" },
            { type: "reasoning", text: "first trace", signature: "synthetic-sig-a" },
            { type: "reasoning", text: "second trace", signature: "synthetic-sig-b" },
            {
                type: "tool",
                callID: "call-1",
                tool: "read",
                providerExecuted: false,
                state: { status: "completed", input: {}, output: "result" },
            },
            { type: "step-finish" },
        ]);

        expect(validateAnthropicReasoningRuns([message])).toBe(true);
    });

    test("declines a contiguous thinking pair split across merged assistant messages", () => {
        const first = assistant("a-first", 1, [
            { type: "thinking", thinking: "first trace", signature: "synthetic-sig-a" },
        ]);
        const second = assistant("a-second", 2, [
            { type: "thinking", thinking: "second trace", signature: "synthetic-sig-b" },
        ]);

        expect(validateAnthropicReasoningRuns([first, second])).toBe(false);
    });

    test("accepts leading thinking after an assistant that holds only step markers", () => {
        // Step markers never reach the provider, so the second message's thinking
        // still leads the merged run on the wire.
        expect(
            validateAnthropicReasoningRuns([
                assistant("a-empty", 1, [{ type: "step-start" }]),
                assistant("a-thinking", 2, [
                    { type: "thinking", thinking: "trace", signature: "synthetic-sig" },
                ]),
            ]),
        ).toBe(true);
    });

    test("declines thinking from a second merged assistant after text in the first", () => {
        expect(
            validateAnthropicReasoningRuns([
                assistant("a-text", 1, [{ type: "text", text: "preface" }]),
                assistant("a-thinking", 2, [
                    { type: "thinking", thinking: "trace", signature: "synthetic-sig" },
                ]),
            ]),
        ).toBe(false);
    });

    test("declines thinking after text in the same assistant run", () => {
        expect(
            validateAnthropicReasoningRuns([
                assistant("a-text-first", 1, [
                    { type: "text", text: "preface" },
                    { type: "thinking", thinking: "late trace", signature: "synthetic-sig" },
                ]),
            ]),
        ).toBe(false);
    });

    test("declines thinking after a tool use in the same assistant run", () => {
        expect(
            validateAnthropicReasoningRuns([
                assistant("a-tool-first", 1, [
                    { type: "tool", providerExecuted: true, state: { status: "completed" } },
                    { type: "thinking", thinking: "late trace", signature: "synthetic-sig" },
                ]),
            ]),
        ).toBe(false);
    });

    test("applies durable thinking strips before validating a replay candidate", () => {
        resetLkgSlotsForTest();
        const input = [user("u0", 1, { providerID: "anthropic", modelID: "claude-test" })];
        const prefix = assistant("a-prefix", 2, [
            { type: "thinking", thinking: "signed prefix", signature: "sig-a" },
            { type: "text", text: "answer" },
        ]);
        captureSlot("strip-before-validate", {
            jsonPrefix: JSON.stringify([prefix]),
            inputIdSeq: ["u0"],
            inputContentDigests: [lkgContentDigest(input[0])!],
            lastInputMessageId: "u0",
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
            capturedAt: 1,
        });
        const tail = assistant("a-tail", 3, [
            { type: "thinking", thinking: "previously stripped", signature: "sig-b" },
            { type: "text", text: "continued answer" },
        ]);
        const replay = replayLkg({
            sessionId: "strip-before-validate",
            messages: [...input, tail],
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
            prepareReplay: (messages) => {
                const restored = messages.find((message) => message.info.id === "a-tail")!;
                restored.parts = restored.parts.filter(
                    (part) => (part as { type: string }).type !== "thinking",
                );
            },
        });
        expect(replay.ok).toBe(true);
        if (replay.ok) expect(JSON.stringify(replay.messages)).not.toContain("previously stripped");
        expect(getSlot("strip-before-validate")).toBeDefined();
    });

    test("declines a new thinking run after a provider-executed tool", () => {
        const first = assistant("a-prefix", 1, [
            { type: "thinking", thinking: "first signed trace", signature: "sig-a" },
            {
                type: "tool",
                callID: "call-1",
                tool: "provider-tool",
                providerExecuted: true,
                state: { status: "completed", input: {}, output: "result" },
            },
        ]);
        const second = assistant("a-tail", 2, [
            { type: "thinking", thinking: "second signed trace", signature: "sig-b" },
        ]);

        expect(validateAnthropicReasoningRuns([first, second])).toBe(false);
    });

    test("serves an Anthropic replay with one leading thinking block in an assistant run", () => {
        resetLkgSlotsForTest();
        captureSlot("anthropic-valid", {
            jsonPrefix: JSON.stringify([
                assistant("a-prefix", 1, [
                    { type: "thinking", thinking: "signed trace", signature: "sig-a" },
                    { type: "text", text: "first response" },
                ]),
            ]),
            inputIdSeq: ["u-anchor"],
            inputContentDigests: [
                lkgContentDigest(
                    user("u-anchor", 2, { providerID: "anthropic", modelID: "claude-test" }),
                )!,
            ],
            lastInputMessageId: "u-anchor",
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
            capturedAt: 1,
        });
        const current = [
            user("u-anchor", 2, { providerID: "anthropic", modelID: "claude-test" }),
            assistant("a-tail", 3, [{ type: "text", text: "second response" }]),
        ];

        const replay = replayLkg({
            sessionId: "anthropic-valid",
            messages: current,
            modelKey: "anthropic/claude-test",
            providerKey: "anthropic",
        });
        expect(replay.ok).toBe(true);
        if (replay.ok)
            expect(replay.messages.map((message) => message.info.id)).toEqual([
                "a-prefix",
                "a-tail",
            ]);
    });

    test("replays across Pi-native model aliases without treating them as a model switch", () => {
        resetLkgSlotsForTest();
        const input = [user("u0", 1)];
        expect(
            captureLkgSlot({
                sessionId: "model-alias",
                input,
                output: structuredClone(input),
                modelKey: "openai/gpt-5.6-sol",
                providerKey: "openai",
            }),
        ).toBe(true);

        const current = [...structuredClone(input), user("u1", 2)] as MessageLike[];
        expect(
            replayLkg({
                sessionId: "model-alias",
                messages: current,
                modelKey: "openai-codex/gpt-5.6-sol",
                providerKey: "openai-codex",
            }),
        ).toMatchObject({ ok: true });
    });

    test("outermost handler rethrows emergency fail-closed errors", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new EmergencyFailClosedError("abort failed");
                },
            },
        });
        const output = { messages: [user("u0", 1)] } as never;
        await expect(handler({}, output)).rejects.toBeInstanceOf(EmergencyFailClosedError);
    });
});
