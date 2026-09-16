import { expect, test } from "bun:test";
import { applyDeferredCompactionMarker } from "../../../plugin/src/hooks/magic-context/compaction-marker-manager";
import { defaultCompactionMarkerStrategy, reconcileMarkerRepresentation } from "../../../plugin/src/hooks/magic-context/transform-postprocess-phase";
import { v2CompactionMarkerStrategy } from "../../../plugin/src/v2/fold/markers";
import { adaptPayload } from "../../../plugin/src/v2/hooks/payload";
import type { SessionContext } from "../../../plugin/src/v2/hooks/types";

// This unit contract complements, but does not replace, real-host fold coverage.
test("I10 marker strategy defaults retain v1 function identity", () => {
    expect(defaultCompactionMarkerStrategy.applyDeferred).toBe(applyDeferredCompactionMarker);
    expect(defaultCompactionMarkerStrategy.reconcile).toBe(reconcileMarkerRepresentation);
});

test("I10 v2 marker strategy performs no database access or draft mutation", () => {
    const db = new Proxy({}, { get() { throw new Error("v2 marker strategy accessed storage"); } });
    const messages = [{ info: { id: "user", role: "user" }, parts: [{ type: "text", text: "kept" }] }];
    const before = JSON.stringify(messages);
    expect(v2CompactionMarkerStrategy.applyDeferred(db as never, "session", {
        ordinal: 2, endMessageId: "end", publishedAt: 123,
    })).toEqual({ kind: "already-current" });
    expect(v2CompactionMarkerStrategy.reconcile(messages, null, {
        db: db as never, sessionId: "session", tagger: undefined as never,
        ctxReduceAvailability: undefined as never, isCacheBustingPass: true,
    })).toBe(false);
    expect(JSON.stringify(messages)).toBe(before);
});

function draft(messages: SessionContext["messages"]): SessionContext {
    return { sessionID: "session", agent: "build", model: { providerID: "openai", id: "model" },
        messages, system: [], tools: {}, options: {} };
}

test("s3 payload inverse projection preserves non-text media bytes and metadata", () => {
    const input = draft([{ id: "media", role: "user", providerMetadata: { keep: true }, content: [
        { type: "text", text: "look" },
        { type: "image", data: "aGVsbG8=", mediaType: "image/png", providerMetadata: { detail: "high" } },
        { type: "file", data: "cGRm", mediaType: "application/pdf", filename: "document.pdf" },
    ] }]);
    const before = JSON.stringify(input);
    adaptPayload(input).commit();
    expect(JSON.stringify(input)).toBe(before);
});

test("s3 payload inverse projection preserves orphan result and rewrites only changed output", () => {
    const input = draft([{ role: "tool", providerMetadata: { carrier: true }, content: [
        { type: "tool-result", id: "orphan", name: "read", result: { type: "json", value: { kept: [1, 2] } }, providerMetadata: { result: true } },
    ] }]);
    const before = structuredClone(input);
    adaptPayload(input).commit();
    expect(input).toEqual(before);
    const mapped = adaptPayload(input);
    const part = mapped.messages[0]!.parts[0] as { state: { output: string } };
    part.state.output = "[dropped §7§]";
    mapped.commit();
    expect(input.messages).toEqual([{ ...before.messages[0], content: [{
        ...before.messages[0]!.content[0], result: { type: "text", value: "[dropped §7§]" },
    }] }]);
});
