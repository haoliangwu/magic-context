import { expect, test } from "bun:test";
import * as Media from "@opencode/ai/media";
import { Message } from "@opencode/ai/schema/messages";
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

// OpenCode 2.0.15 carries every attachment as a `media` content part whose bytes sit in
// a `Media.Asset` class instance; `image` and `file` are not host content types, and the
// adapter now omits them with a logged reason (6ded29998c, "project synthetic tools and
// mural images into OC2 content"). The parts here are built by the host's own schema so
// the round trip is checked on the shape the host really sends.
test("s3 payload inverse projection preserves non-text media bytes and metadata", () => {
    const image = Media.base64("aGVsbG8=", "image/png");
    const pdf = Media.base64("cGRm", "application/pdf");
    const host = Message.make({ role: "user", content: [
        Message.text("look"),
        Message.media(image, { providerMetadata: { openai: { detail: "high" } } }),
        Message.media(pdf, { filename: "document.pdf" }),
    ] });
    const input = draft([{ id: "media", role: "user", providerMetadata: { openai: { keep: true } },
        content: [...host.content] as SessionContext["messages"][number]["content"] }]);
    const before = JSON.stringify(input);
    adaptPayload(input).commit();
    expect(JSON.stringify(input)).toBe(before);
    const content = input.messages[0]!.content;
    // The host rebuilds the message with an instanceof check, so the assets must come back
    // as the same objects, not as plain-object copies.
    expect(content[1]!.media).toBe(image);
    expect(content[2]!.media).toBe(pdf);
    expect(() => Message.make(input.messages[0] as never)).not.toThrow();
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
