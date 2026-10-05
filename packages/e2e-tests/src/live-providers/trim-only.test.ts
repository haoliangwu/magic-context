import { expect, it } from "bun:test";
import { qualifyTrimOnly } from "./trim-only";
import type { CallRecord } from "./types";

const msg = (role: string, signed: string[], type: string, hash: string) => ({ role, signed, nonThinking: [{ type, hash }] });
function fixture(): CallRecord[] {
    const initial = [msg("user", [], "text", "u1"), msg("assistant", ["s1"], "tool_use", "t1"),
        msg("user", [], "tool_result", "result1"), msg("assistant", ["s2"], "text", "a2"), msg("user", [], "text", "u2")];
    const trimmed = structuredClone(initial);
    trimmed[1]!.signed = [];
    trimmed.push(msg("assistant", ["s3"], "text", "a3"), msg("user", [], "text", "u3"));
    const cached = [...structuredClone(trimmed), msg("assistant", ["s4"], "text", "a4"), msg("user", [], "text", "u4")];
    const mixed = structuredClone(cached);
    mixed[2]!.nonThinking[0]!.hash = "result-edited";
    for (const m of mixed.slice(2)) m.signed = [];
    return [initial, trimmed, cached, mixed].map((history, index) => ({ index: index + 1, at: "", path: "/v1/messages", model: "claude-opus-5-5",
        phase: ["turn-1", "trim-only", "cache-follow-up", "tool-edit"][index]!, status: 200, accepted: true, error: null, durationMs: 0,
        requestId: "req_fixture", diagnostics: {}, usage: { input: 10, inputField: "input_tokens", cachedRead: index === 2 ? 100 : 0,
            cacheWrite: 0, output: 5, reasoning: null, cost: null, raw: {} },
        request: { kind: "loop", reasoningMap: "", reasoningItems: 0, emptyReasoning: 0, toolCalls: 1, toolResults: 1, bytes: 0,
            flags: { history, systemHash: "system", toolsHash: "tools", bindingBeta: true,
                thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } } } } }));
}
it("qualifies oldest-prefix-only trim, cache read and subsequent tool-edit suffix strip", () => {
    expect(qualifyTrimOnly(fixture())).toMatchObject({ qualified: true, removedOldestBlocks: 1, retainedSignedBlocks: 1,
        trimCall: 2, cacheCall: 3, toolEditCall: 4, failures: [] });
});
it("refuses a passing HTTP status when no trim or cache phase was reached", () => {
    expect(qualifyTrimOnly(fixture().slice(0, 1)).qualified).toBe(false);
});
it("refuses middle gaps and earlier non-thinking changes on the trim pass", () => {
    const calls = fixture();
    const history = calls[1]!.request.flags.history as ReturnType<typeof msg>[];
    history[1]!.signed = ["s1"];
    history[3]!.signed = [];
    history[2]!.nonThinking[0]!.hash = "accidental-tool-edit";
    expect(qualifyTrimOnly(calls).failures).toEqual([
        "trim did not remove only a nonempty gap-free oldest prefix while retaining newer signed blocks",
        "trim pass also changed earlier non-thinking content, system or tools",
        "cache follow-up changed the trimmed prefix instead of replaying it identically",
    ]);
});
it("requires cache reads to recover beyond the first trimming request", () => {
    const calls = fixture();
    calls[1]!.usage!.cachedRead = 100;
    expect(qualifyTrimOnly(calls).failures).toEqual(["next request did not recover cache reads beyond the trimming point"]);
});
it("refuses cache misses, server transformations and later signed blocks after a tool edit", () => {
    const calls = fixture();
    calls[2]!.usage!.cachedRead = 0;
    calls[1]!.diagnostics = { input_transformations: [{ type: "thinking_dropped" }] };
    (calls[3]!.request.flags.history as ReturnType<typeof msg>[])[3]!.signed = ["s2"];
    expect(qualifyTrimOnly(calls).failures).toEqual([
        "next request did not report a cache read",
        "mixed pass retained signed thinking after the earlier tool-result edit",
        "call 2 returned transformation diagnostics; inspect before qualifying",
    ]);
});
