/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { stripProcessedImages } from "../../hooks/magic-context/strip-content";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { adaptPayload } from "./payload";
import type { SessionContext } from "./types";

// The adapter keeps the host's media asset intact until an admitted image strip
// replaces the whole content part with text; unstripped assets must stay instances.
const DATA = "a".repeat(300);

test("image strip review control: OpenCode file shape reaches the strip helper", () => {
    const image: MessageLike = {
        info: { id: "user-image", role: "user" },
        parts: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${DATA}` }],
    };
    const result = stripProcessedImages(
        [
            image,
            { info: { id: "answer", role: "assistant" }, parts: [{ type: "text", text: "seen" }] },
        ],
        new Set(),
        {
            detect: true,
            watermark: 5,
            messageTagNumbers: new Map([[image, 1]]),
            persistNewIds: () => true,
        },
    );
    expect(result.stripped).toBe(1);
});

test("image strip review witness: native v2 user media is stripped on an admitted bust", () => {
    // Match the host's class-instance payload: its base64 bytes live under media.source,
    // rather than the top-level mime/url fields the helper reads from a `file` part.
    class HostAsset {
        readonly source = { type: "base64", data: DATA, mediaType: "image/png" };
        readonly mediaType = "image/png";
    }
    const draft: SessionContext = {
        sessionID: "image-review",
        model: { providerID: "anthropic", id: "model" },
        agent: "build",
        system: [],
        tools: {},
        options: {},
        messages: [
            {
                id: "user-image",
                role: "user",
                content: [
                    { type: "text", text: "inspect" },
                    { type: "media", media: new HostAsset(), filename: "image.png" },
                ],
            },
            { id: "answer", role: "assistant", content: [{ type: "text", text: "seen" }] },
        ],
    };
    const mapped = adaptPayload(draft);
    const image = mapped.messages[0];
    expect((image.parts[1] as { media: unknown }).media).toBeInstanceOf(HostAsset);
    const result = stripProcessedImages(mapped.messages, new Set(), {
        detect: true,
        watermark: 5,
        messageTagNumbers: new Map([[image, 1]]),
        persistNewIds: () => true,
    });
    mapped.commit();
    expect(result.stripped).toBe(1);
    expect(draft.messages[0].content.some((part) => part.type === "media")).toBe(false);
});

test("native v2 image replay keeps marker bytes and unstripped host assets intact", () => {
    class HostAsset {
        constructor(
            readonly source: { type: string; data?: string; url?: string },
            readonly mediaType: string,
        ) {}
    }
    const large = new HostAsset({ type: "base64", data: DATA }, "image/png");
    const tiny = new HostAsset({ type: "base64", data: "a" }, "image/png");
    const remote = new HostAsset(
        { type: "url", url: "https://example.invalid/pixel.png" },
        "image/png",
    );
    const pdf = new HostAsset({ type: "base64", data: DATA }, "application/pdf");
    const source = (): MessageLike[] => [
        {
            info: { id: "native-image", role: "user" },
            parts: [large, tiny, remote, pdf].map((media) => ({ type: "media", media })),
        },
        { info: { id: "answer", role: "assistant" }, parts: [{ type: "text", text: "seen" }] },
    ];
    const frozen = new Set<string>();
    const markers = new Map<string, "" | "[image stripped]">();
    const first = source();
    stripProcessedImages(first, frozen, {
        detect: true,
        watermark: 1,
        messageTagNumbers: new Map([[first[0], 1]]),
        replacementText: "[image stripped]",
        frozenMarkers: markers,
        persistNewIds: (ids, saved) => {
            for (const id of ids) {
                frozen.add(id);
                markers.set(id, saved.get(id)!);
            }
            return true;
        },
    });
    expect(first[0].parts[0]).toEqual({ type: "text", text: "[image stripped]" });
    for (const [index, asset] of [tiny, remote, pdf].entries())
        expect((first[0].parts[index + 1] as { media: unknown }).media).toBe(asset);
    const replay = source();
    stripProcessedImages(replay, frozen, {
        detect: false,
        watermark: 0,
        messageTagNumbers: new Map(),
        replacementText: "",
        frozenMarkers: markers,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(large.source.data).toBe(DATA);
});

test("native v2 inline byte assets strip without cloning surviving host assets", () => {
    class HostAsset {
        readonly mediaType = "image/png";
        constructor(readonly source: { type: "bytes"; data: Uint8Array }) {}
    }
    const large = new HostAsset({ type: "bytes", data: new Uint8Array(300) });
    const tiny = new HostAsset({ type: "bytes", data: new Uint8Array(1) });
    const image: MessageLike = {
        info: { id: "byte-image", role: "user" },
        parts: [large, tiny].map((media) => ({ type: "media", media })),
    };
    const result = stripProcessedImages(
        [
            image,
            { info: { id: "answer", role: "assistant" }, parts: [{ type: "text", text: "seen" }] },
        ],
        new Set(),
        {
            detect: true,
            watermark: 1,
            messageTagNumbers: new Map([[image, 1]]),
            replacementText: "[image stripped]",
            persistNewIds: () => true,
        },
    );
    expect(result.stripped).toBe(1);
    expect(image.parts[0]).toEqual({ type: "text", text: "[image stripped]" });
    expect((image.parts[1] as { media: unknown }).media).toBe(tiny);
    expect(large.source.data).toHaveLength(300);
});
