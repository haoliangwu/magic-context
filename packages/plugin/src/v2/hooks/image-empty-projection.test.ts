import { expect, test } from "bun:test";
import { stripProcessedImages } from "../../hooks/magic-context/strip-content";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { adaptPayload } from "./payload";
import type { SessionContext, V2Message } from "./types";

const image = () => ({
    type: "media",
    media: { mediaType: "image/png", source: { type: "base64", data: "a".repeat(300) } },
});
const text = (id: string, role: V2Message["role"]): V2Message => ({
    id,
    role,
    content: [{ type: "text", text: id }],
});
const imageRow = (): V2Message => ({ id: "image", role: "user", content: [image()] });

function project(
    provider: string,
    rows: V2Message[],
    ids: Set<string>,
    markers: Map<string, "" | "[image stripped]">,
    detect = false,
) {
    const context = {
        sessionID: "empty-image-projection",
        model: { providerID: provider, id: "model" },
        agent: "build",
        messages: rows,
        system: [],
        tools: {},
        options: {},
    } as SessionContext;
    const mapped = adaptPayload(context);
    let writes = 0;
    stripProcessedImages(mapped.messages, ids, {
        detect,
        watermark: 10,
        messageTagNumbers: new Map(mapped.messages.map((message) => [message, 1])),
        replacementText: provider === "anthropic" ? "" : "[image stripped]",
        frozenMarkers: markers,
        persistNewIds: (newIds, saved) => {
            writes++;
            for (const id of newIds) {
                ids.add(id);
                markers.set(id, saved.get(id)!);
            }
            return true;
        },
    });
    // Postprocess may replace message objects with copies. Evidence is indexed
    // by frozen image id, not by the identity of a particular message object.
    mapped.messages.splice(0, mapped.messages.length, ...structuredClone(mapped.messages));
    mapped.commit();
    return { rows: context.messages, bytes: JSON.stringify(context.messages), writes };
}

test("frozen empty image omission removes only image parts on other providers", () => {
    const rows = (): V2Message[] => [
        {
            id: "image",
            role: "user",
            content: [{ type: "text", text: "keep" }, image(), { type: "text", text: "" }],
        },
        {
            id: "answer",
            role: "assistant",
            content: [
                { type: "reasoning", text: "", signature: "signed" },
                { type: "text", text: "" },
                { type: "tool-call", id: "call", name: "read", input: {} },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call",
                    name: "read",
                    result: { type: "text", value: "" },
                },
            ],
        },
    ];
    for (const provider of ["openai", "google", "anthropic-compatible"]) {
        const projected = project(provider, rows(), new Set(["image"]), new Map());
        const expected = rows();
        expected[0].content.splice(1, 1);
        expect(projected.rows).toEqual(expected);
        expect(projected.writes).toBe(0);
    }
});

test("new empty image freezes preserve separators between assistants across restart and providers", () => {
    const rows = () => [text("before", "assistant"), imageRow(), text("after", "assistant")];
    const ids = new Set<string>();
    const markers = new Map<string, "" | "[image stripped]">();
    const frozen = project("anthropic", rows(), ids, markers, true);
    expect(markers.get("image")).toBe("[image stripped]");
    expect(frozen.rows[1].content).toEqual([{ type: "text", text: "[image stripped]" }]);
    expect(frozen.writes).toBe(1);
    for (const provider of ["anthropic", "openai", "google"]) {
        const replay = project(provider, rows(), new Set(ids), new Map(markers));
        expect(replay.bytes).toBe(frozen.bytes);
        expect(replay.writes).toBe(0);
    }
});

test("new image freezes do not merge a paired tool arc with the next assistant", () => {
    const rows = (): V2Message[] => [
        {
            id: "call-owner",
            role: "assistant",
            content: [{ type: "tool-call", id: "call", name: "read", input: {} }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call",
                    name: "read",
                    result: { type: "text", value: "ok" },
                },
            ],
        },
        imageRow(),
        text("answer", "assistant"),
    ];
    const ids = new Set<string>();
    const markers = new Map<string, "" | "[image stripped]">();
    const frozen = project("anthropic", rows(), ids, markers, true);
    expect(markers.get("image")).toBe("[image stripped]");
    expect(frozen.rows.slice(0, 2)).toEqual(rows().slice(0, 2));
    expect(frozen.rows[2].content).toEqual([{ type: "text", text: "[image stripped]" }]);
    expect(project("openai", rows(), ids, markers).bytes).toBe(frozen.bytes);
});

test("multiple new image-only rows retain a separator after joint omission", () => {
    const rows = () => [
        text("before", "assistant"),
        imageRow(),
        { ...imageRow(), id: "image-2" },
        text("after", "assistant"),
    ];
    const ids = new Set<string>();
    const markers = new Map<string, "" | "[image stripped]">();
    const frozen = project("anthropic", rows(), ids, markers, true);
    expect([...markers.values()].sort()).toEqual(["", "[image stripped]"]);
    expect(frozen.rows.map((row) => row.role)).toEqual(["assistant", "user", "assistant"]);
    expect(project("openai", rows(), ids, markers).bytes).toBe(frozen.bytes);
});

test("new image separator selection looks past rows already emptied by other cleanup", () => {
    const rows = () => [
        text("before", "assistant"),
        imageRow(),
        { id: "empty-system", role: "system" as const, content: [{ type: "text", text: "" }] },
        text("after", "assistant"),
    ];
    const markers = new Map<string, "" | "[image stripped]">();
    const frozen = project("anthropic", rows(), new Set(), markers, true);
    expect(markers.get("image")).toBe("[image stripped]");
    expect(frozen.rows.map((row) => row.role)).toEqual(["assistant", "user", "assistant"]);
    expect(frozen.rows[1].content).toEqual([{ type: "text", text: "[image stripped]" }]);
});

test("legacy unsafe empty image shape preserves already served Anthropic bytes on defer", () => {
    const rows = () => [text("before", "assistant"), imageRow(), text("after", "assistant")];
    for (const markers of [
        new Map<string, "" | "[image stripped]">(),
        new Map([["image", "" as const]]),
    ]) {
        const projected = project("anthropic", rows(), new Set(["image"]), markers);
        expect(projected.bytes).toBe(
            JSON.stringify([text("before", "assistant"), text("after", "assistant")]),
        );
        expect(projected.writes).toBe(0);
        expect(project("openai", rows(), new Set(["image"]), markers).bytes).toBe(projected.bytes);
    }
});

test("shared OC1 image freezes use the same structural fallback without changing legacy sentinels", () => {
    const rows = (): MessageLike[] => [
        { info: { id: "before", role: "assistant" }, parts: [{ type: "text", text: "before" }] },
        { info: { id: "image", role: "user" }, parts: [image()] },
        { info: { id: "after", role: "assistant" }, parts: [{ type: "text", text: "after" }] },
    ];
    const fresh = rows();
    stripProcessedImages(fresh, new Set(), {
        detect: true,
        watermark: 1,
        messageTagNumbers: new Map([[fresh[1], 1]]),
        persistNewIds: (_, saved) => {
            expect(saved.get("image")).toBe("[image stripped]");
            return true;
        },
    });
    expect(fresh[1].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
    const legacy = rows();
    stripProcessedImages(legacy, new Set(["image"]), {
        detect: false,
        watermark: 0,
        messageTagNumbers: new Map(),
    });
    expect(legacy[1].parts).toEqual([{ type: "text", text: "" }]);
});
