import { describe, expect, it } from "bun:test";
import { summarize } from "./runner";
import type { CallRecord, RequestShape } from "./types";
import { readResponse, requestShape, scrubError } from "./wire";

describe("live-provider wire reading", () => {
    it("reads Anthropic signed blocks, tool pairs and subscription-prefixed tools", () => {
        const shape = requestShape("anthropic-messages", JSON.stringify({
            tools: [{ name: "mcp_Bash" }], max_tokens: 1024, thinking: { type: "adaptive" },
            messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "fixture", signature: "fixture-signature" },
                { type: "tool_use", id: "t1", name: "mcp_Bash", input: { command: "echo ok" } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
                { role: "assistant", content: [{ type: "redacted_thinking", data: "fixture-redacted" }, { type: "text", text: "OK" }] }],
        }));
        expect(shape).toMatchObject({ kind: "loop", reasoningMap: "RR", reasoningItems: 2, toolCalls: 1, toolResults: 1 });
        expect(shape.flags.maxTokens).toBe(1024);
        expect(JSON.stringify(shape)).not.toContain("fixture-signature");
        expect(JSON.stringify(shape)).not.toContain("fixture-redacted");
    });

    it("merges Anthropic start/delta usage and records nested transformation diagnostics", () => {
        const response = 'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"cache_read_input_tokens":100,"cache_creation_input_tokens":30,"output_tokens":1},"input_transformations":[{"type":"thinking_dropped"}]}}\n' +
            'data: {"type":"message_delta","usage":{"output_tokens":12},"context_management":{"applied_edits":[]}}';
        expect(readResponse("anthropic-messages", response)).toMatchObject({
            usage: { input: 9, cachedRead: 100, cacheWrite: 30, output: 12 }, streamError: null,
            diagnostics: { "message.input_transformations": [{ type: "thinking_dropped" }], "context_management.applied_edits": [] },
        });
        expect(readResponse("anthropic-messages", '{"usage":{"input_tokens":7,"output_tokens":2}}').diagnostics).toEqual({});
        expect(readResponse("anthropic-messages", 'data: {"type":"error","error":{"message":"prefix mismatch"}}').streamError).toBe("prefix mismatch");
    });

    it("maps OpenAI Responses steps to reasoning-bearing and bare ones", () => {
        const body = {
            input: [
                { role: "user", content: "go" },
                { type: "reasoning", encrypted_content: "e1" },
                { type: "function_call", call_id: "a" },
                { type: "function_call_output", call_id: "a" },
                { type: "function_call", call_id: "b" },
                { type: "function_call_output", call_id: "b" },
                { type: "reasoning", encrypted_content: "e3" },
                { type: "function_call", call_id: "c" },
                { type: "function_call_output", call_id: "c" },
            ],
            tools: [{ type: "function", name: "bash" }],
        };
        const shape = requestShape("openai-responses", JSON.stringify(body));
        expect(shape).toMatchObject({ kind: "loop", reasoningMap: "R-R", reasoningItems: 2, toolCalls: 3 });
        expect(shape.flags.encryptedReasoning).toBe(2);
    });

    it("counts empty reasoning_content separately from carried reasoning", () => {
        const body = {
            messages: [
                { role: "assistant", reasoning_content: "", tool_calls: [{ id: "a" }] },
                { role: "tool", tool_call_id: "a" },
                { role: "assistant", reasoning_content: "thinking", tool_calls: [{ id: "b" }] },
                { role: "tool", tool_call_id: "b" },
            ],
        };
        const shape = requestShape("chat-completions", JSON.stringify(body));
        expect(shape).toMatchObject({ kind: "aux", reasoningMap: "-R", reasoningItems: 1, emptyReasoning: 1 });
    });

    it("reads usage and in-stream errors from each encoding", () => {
        const responses = [
            'data: {"type":"response.created"}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":100},"output_tokens":5}}}',
        ].join("\n");
        expect(readResponse("openai-responses", responses).usage).toMatchObject({ input: 120, cachedRead: 100 });
        const failed = 'data: {"type":"response.failed","response":{"error":{"message":"bad reasoning item"}}}';
        expect(readResponse("openai-responses", failed).streamError).toBe("bad reasoning item");

        const deepseek = 'data: {"choices":[],"usage":{"prompt_tokens":50,"prompt_cache_hit_tokens":40}}\ndata: [DONE]';
        expect(readResponse("chat-completions", deepseek).usage).toMatchObject({ input: 50, cachedRead: 40 });

        // Event-stream frames carry binary headers around JSON payloads.
        const frame = '\x00\x00\x01:event-type\x07\x00\x08metadata{"usage":{"inputTokens":7,"cacheReadInputTokens":3}}';
        expect(readResponse("bedrock-converse", frame).usage).toMatchObject({ input: 7, cachedRead: 3 });
    });

    it("redacts key-length bearer values but keeps provider prose", () => {
        const text = 'Bearer token has expired; sent Bearer abcdefghijklmnopqrstuvwxyz0123 and sk-proj-12345678';
        expect(scrubError(text, [])).toBe("Bearer token has expired; sent [REDACTED] and [REDACTED]");
        expect(scrubError("key SECRET-VALUE leaked", ["SECRET-VALUE"])).toBe("key [REDACTED] leaked");
    });
});

describe("live-provider scenario summary", () => {
    const shape = (reasoningMap: string, toolCalls: number): RequestShape => ({
        kind: "loop",
        reasoningMap,
        reasoningItems: [...reasoningMap].filter((c) => c === "R").length,
        emptyReasoning: 0,
        toolCalls,
        toolResults: toolCalls,
        bytes: 0,
        flags: {},
    });
    const call = (index: number, map: string, toolCalls: number, accepted = true): CallRecord => ({
        index,
        at: "",
        phase: "",
        path: "",
        model: null,
        status: accepted ? 200 : 400,
        accepted,
        error: null,
        usage: null,
        diagnostics: {},
        requestId: null,
        request: shape(map, toolCalls),
        durationMs: 0,
    });

    it("finds the first request where reasoning left the wire", () => {
        const summary = summarize([call(1, "RR", 2), call(2, "RRR", 3), call(3, "-RR-", 3), call(4, "-RR--", 4)]);
        expect(summary).toMatchObject({ firstRemovalCall: 3, acceptedAfterRemoval: true, callsAfterRemoval: 2 });
        expect(summary.before?.index).toBe(2);
    });

    it("treats a removed tool pair as removal and reports a later rejection", () => {
        const summary = summarize([call(1, "RRR", 3), call(2, "RR", 2, false)]);
        expect(summary).toMatchObject({ firstRemovalCall: 2, acceptedAfterRemoval: false });
    });

    it("reports no removal when every request only grows", () => {
        expect(summarize([call(1, "R", 1), call(2, "R-", 2)]).firstRemovalCall).toBeNull();
    });
});
