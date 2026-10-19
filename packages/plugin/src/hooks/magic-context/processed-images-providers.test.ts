import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isRecord } from "../../shared/record-type-guard";
import { stripProcessedImages } from "./strip-content";
import type { MessageLike } from "./tag-messages";

const image = (size = 300) => ({
    type: "file",
    mime: "image/png",
    url: `data:image/png;base64,${"a".repeat(size)}`,
});
const message = (id: string, role: string, parts: unknown[]): MessageLike =>
    ({ info: { id, role }, parts }) as MessageLike;

// Compare against the saved pre-change function so an accidental change to
// image eligibility or empty-marker bytes cannot also change the expected output.
const baseSource = readFileSync(
    new URL("./__fixtures__/processed-images.6dec81e7.ts.txt", import.meta.url),
    "utf8",
);
const baseJavascript = new Bun.Transpiler({ loader: "ts" })
    .transformSync(baseSource)
    .replaceAll("export ", "");
const baseStrip = new Function("isRecord", `${baseJavascript}\nreturn stripProcessedImages;`)(
    isRecord,
) as typeof stripProcessedImages;

test("issue 699 Anthropic differential preserves base bytes except newly frozen structural separators", () => {
    let seed = 699;
    const random = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
    };
    const counts = {
        exactBaseMessages: 0,
        newSeparators: 0,
        replayedSeparators: 0,
        deferPasses: 0,
    };
    for (let scenario = 0; scenario < 300; scenario++) {
        const raw: MessageLike[] = Array.from({ length: 2 + random(30) }, (_, i) =>
            message(`m-${i}`, random(3) ? "user" : "assistant", [
                { type: "text", text: `text-${random(10)}` },
                { ...image([0, 175, 200, 500][random(4)]), cache_control: { type: "ephemeral" } },
                ...(random(2) ? [image()] : []),
            ]),
        );
        const frozen = new Set<string>();
        const expectedMarkers = new Map<string, "" | "[image stripped]">();
        const markers = new Map<string, "" | "[image stripped]">();
        for (let pass = 0; pass < 5; pass++) {
            const watermark = random(raw.length);
            const detect = random(2) === 1 && watermark > 0;
            const old = structuredClone(raw);
            const current = structuredClone(raw);
            const tags = (messages: MessageLike[]) =>
                new Map(messages.map((msg, i) => [msg, i + 1]));
            const oldResult = baseStrip(old, frozen, {
                detect,
                watermark,
                messageTagNumbers: tags(old),
            });
            const expected = structuredClone(old);
            for (const id of oldResult.newlyStrippedIds) {
                const index = raw.findIndex((msg) => msg.info.id === id);
                // Only the generated image-only tail users can disappear here:
                // all initial rows contain non-empty text. Read their literal
                // neighbors, without consulting the production omission planner.
                const separator =
                    index > 0 &&
                    raw[index - 1].info.role === "assistant" &&
                    raw[index + 1]?.info.role === "assistant" &&
                    raw[index].parts.every((part) => (part as { type: string }).type === "file");
                expectedMarkers.set(id, separator ? "[image stripped]" : "");
                if (separator) counts.newSeparators++;
            }
            for (const msg of expected) {
                if (expectedMarkers.get(msg.info.id!) !== "[image stripped]") continue;
                for (const part of msg.parts) {
                    const text = part as { type?: string; text?: string };
                    if (text.type === "text" && text.text === "") text.text = "[image stripped]";
                }
                if (!oldResult.newlyStrippedIds.includes(msg.info.id!)) counts.replayedSeparators++;
            }
            const beforeMarkers = JSON.stringify([...markers]);
            let writes = 0;
            const newResult = stripProcessedImages(current, frozen, {
                detect,
                watermark,
                messageTagNumbers: tags(current),
                frozenMarkers: markers,
                persistNewIds: (ids, saved) => {
                    writes++;
                    for (const id of ids) {
                        frozen.add(id);
                        markers.set(id, saved.get(id)!);
                    }
                    return true;
                },
            });
            expect(JSON.stringify(current)).toBe(JSON.stringify(expected));
            expect(newResult).toEqual(oldResult);
            expect(markers).toEqual(expectedMarkers);
            for (let index = 0; index < current.length; index++) {
                if (expectedMarkers.get(current[index].info.id!) === "[image stripped]") continue;
                expect(JSON.stringify(current[index])).toBe(JSON.stringify(old[index]));
                counts.exactBaseMessages++;
            }
            if (!detect) {
                counts.deferPasses++;
                expect(writes).toBe(0);
                expect(JSON.stringify([...markers])).toBe(beforeMarkers);
                expect(newResult.newlyStrippedIds).toEqual([]);
            }
            const replay = structuredClone(raw);
            stripProcessedImages(replay, frozen, {
                detect: false,
                watermark: 0,
                messageTagNumbers: new Map(),
                frozenMarkers: markers,
                persistNewIds: () => {
                    throw new Error("defer must only replay saved image forms");
                },
            });
            expect(JSON.stringify(replay)).toBe(JSON.stringify(current));
            counts.replayedSeparators += [...expectedMarkers.values()].filter(Boolean).length;
            raw.push(message(`tail-${pass}`, pass % 2 ? "user" : "assistant", [image()]));
        }
    }
    expect(counts.exactBaseMessages).toBeGreaterThan(0);
    expect(counts.newSeparators).toBeGreaterThan(0);
    expect(counts.replayedSeparators).toBeGreaterThan(0);
    expect(counts.deferPasses).toBeGreaterThan(0);
    console.log(`Anthropic structural differential classes: ${JSON.stringify(counts)}`);
});

test("issue 699 tool attachments use non-empty markers, retain other files, and replay without an answer", () => {
    const raw = [
        message("tool-owner", "assistant", [
            {
                type: "tool",
                callID: "read-call",
                tool: "read",
                state: {
                    status: "completed",
                    input: { filePath: "pixel.png" },
                    output: "",
                    attachments: [
                        image(),
                        {
                            type: "file",
                            mime: "application/pdf",
                            url: "data:application/pdf;base64,abc",
                        },
                        image(),
                    ],
                },
            },
        ]),
        message("answer", "assistant", [{ type: "text", text: "seen" }]),
    ];
    const frozen = new Set<string>();
    const markers = new Map<string, "" | "[image stripped]">();
    const first = structuredClone(raw);
    const result = stripProcessedImages(first, frozen, {
        detect: true,
        watermark: 4,
        messageTagNumbers: new Map([[first[0], 3]]),
        frozenMarkers: markers,
        persistNewIds: (ids, newMarkers) => {
            expect(first).toEqual(raw);
            for (const id of ids) {
                frozen.add(id);
                markers.set(id, newMarkers.get(id)!);
            }
            return true;
        },
    });
    expect(result).toEqual({ stripped: 2, newlyStrippedIds: ["tool-owner"] });
    expect(first[0].parts).toEqual([
        {
            type: "tool",
            callID: "read-call",
            tool: "read",
            state: {
                status: "completed",
                input: { filePath: "pixel.png" },
                output: "[image stripped]\n[image stripped]",
                attachments: [
                    {
                        type: "file",
                        mime: "application/pdf",
                        url: "data:application/pdf;base64,abc",
                    },
                ],
            },
        },
    ]);
    const replay = structuredClone(raw.slice(0, 1));
    stripProcessedImages(replay, frozen, {
        detect: false,
        watermark: 0,
        messageTagNumbers: new Map(),
        frozenMarkers: markers,
    });
    expect(JSON.stringify(replay[0])).toBe(JSON.stringify(first[0]));
    const unAnswered = structuredClone(raw.slice(0, 1));
    expect(
        stripProcessedImages(unAnswered, new Set(), {
            detect: true,
            watermark: 4,
            messageTagNumbers: new Map([[unAnswered[0], 1]]),
        }).stripped,
    ).toBe(0);
    expect(unAnswered).toEqual(raw.slice(0, 1));
});

test("issue 699 failed tool-image persistence leaves native bytes intact", () => {
    const raw = [
        message("tool", "assistant", [
            {
                type: "tool",
                state: { status: "completed", output: "read", attachments: [image()] },
            },
        ]),
        message("answer", "assistant", []),
    ];
    const current = structuredClone(raw);
    let writes = 0;
    const outcome = stripProcessedImages(current, new Set(), {
        detect: true,
        watermark: 1,
        messageTagNumbers: new Map([[current[0], 1]]),
        persistNewIds: () => {
            writes++;
            return false;
        },
    });
    expect(outcome).toEqual({ stripped: 0, newlyStrippedIds: [] });
    expect(writes).toBe(1);
    expect(current).toEqual(raw);
});

test("issue 699 differential classifies unaffected and deliberately changed randomized sessions", () => {
    let seed = 6994;
    const random = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
    };
    const counts: Record<
        string,
        {
            unaffected: number;
            changed: number;
            forwardAge: number;
            recencyWindow: number;
            freshWatermark: number;
            providerMarker: number;
            structuralFallback: number;
        }
    > = {};
    for (const provider of ["anthropic", "openai"]) {
        const tally = (counts[provider] = {
            unaffected: 0,
            changed: 0,
            forwardAge: 0,
            recencyWindow: 0,
            freshWatermark: 0,
            providerMarker: 0,
            structuralFallback: 0,
        });
        for (let scenario = 0; scenario < 300; scenario++) {
            const raw = Array.from({ length: 10 }, (_, i) =>
                message(
                    `r-${i}`,
                    i % 2 ? "assistant" : "user",
                    i % 2 || random(3) === 0 ? [{ type: "text", text: "unchanged" }] : [image()],
                ),
            );
            const tags = new Map(
                raw.flatMap((msg, i) => (random(3) ? [[msg.info.id!, i + 1] as const] : [])),
            );
            const oldWatermark = random(11);
            const watermark = random(2) ? oldWatermark : Math.min(10, oldWatermark + 3);
            const protectedCutoff = random(2) ? 6 : null;
            const contextPercentage = random(4) ? 60 : 95;
            const selected = new Set<string>();
            let answered = false;
            for (let i = raw.length - 1; i >= 0; i--) {
                const msg = raw[i];
                if (msg.info.role === "assistant") {
                    answered = true;
                    continue;
                }
                if (
                    !answered ||
                    !msg.parts.some((part) => (part as { type: string }).type === "file")
                )
                    continue;
                const ownTag = tags.get(msg.info.id!);
                const position =
                    ownTag ??
                    raw
                        .slice(i + 1)
                        .map((later) => tags.get(later.info.id!))
                        .find((tag) => tag !== undefined);
                if (ownTag === undefined) tally.forwardAge++;
                if (
                    protectedCutoff !== null &&
                    position !== undefined &&
                    position >= protectedCutoff &&
                    contextPercentage < 95
                )
                    tally.recencyWindow++;
                if (
                    position !== undefined &&
                    watermark > oldWatermark &&
                    position > oldWatermark &&
                    position <= watermark
                )
                    tally.freshWatermark++;
                if (
                    watermark > 0 &&
                    position !== undefined &&
                    position <= watermark &&
                    (contextPercentage >= 95 ||
                        protectedCutoff === null ||
                        position < protectedCutoff)
                )
                    selected.add(msg.info.id!);
            }
            const expected = structuredClone(raw);
            const expectedTags = new Map(expected.map((msg) => [msg, tags.get(msg.info.id!) ?? 0]));
            baseStrip(expected, selected, {
                detect: false,
                watermark: 0,
                messageTagNumbers: expectedTags,
            });
            const legacyExpected = JSON.stringify(expected);
            if (provider === "anthropic")
                for (let index = 1; index + 1 < raw.length; index++) {
                    // This corpus alternates roles and has one image per user.
                    // A selected image between literal assistant neighbors must
                    // leave a separator, even when its eligibility matches base.
                    if (
                        selected.has(raw[index].info.id!) &&
                        raw[index - 1].info.role === "assistant" &&
                        raw[index + 1].info.role === "assistant"
                    ) {
                        expected[index].parts = [{ type: "text", text: "[image stripped]" }];
                        tally.structuralFallback++;
                    }
                }
            if (provider !== "anthropic")
                for (const msg of expected)
                    for (const part of msg.parts) {
                        const text = part as { type?: string; text?: string };
                        if (text.type === "text" && text.text === "") {
                            text.text = "[image stripped]";
                            tally.providerMarker++;
                        }
                    }
            const old = structuredClone(raw);
            if (provider === "anthropic")
                baseStrip(old, new Set(), {
                    detect: oldWatermark > 0,
                    watermark: oldWatermark,
                    messageTagNumbers: new Map(
                        old.map((msg) => [msg, tags.get(msg.info.id!) ?? 0]),
                    ),
                });
            const unaffected = JSON.stringify(expected) === JSON.stringify(old);
            tally[unaffected ? "unaffected" : "changed"]++;
            const current = structuredClone(raw);
            const frozen = new Set<string>();
            const markers = new Map<string, "" | "[image stripped]">();
            const deferred = structuredClone(raw);
            stripProcessedImages(deferred, frozen, {
                detect: false,
                watermark,
                messageTagNumbers: new Map(
                    deferred.map((msg) => [msg, tags.get(msg.info.id!) ?? 0]),
                ),
                replacementText: provider === "anthropic" ? "" : "[image stripped]",
                persistNewIds: () => {
                    throw new Error("defer must not discover a structural fallback");
                },
            });
            expect(JSON.stringify(deferred)).toBe(JSON.stringify(raw));
            const legacy = structuredClone(raw);
            stripProcessedImages(legacy, selected, {
                detect: false,
                watermark: 0,
                messageTagNumbers: new Map(),
            });
            expect(JSON.stringify(legacy)).toBe(legacyExpected);
            stripProcessedImages(current, frozen, {
                detect: true,
                watermark,
                protectedCutoff,
                contextPercentage,
                messageTagNumbers: new Map(
                    current.map((msg) => [msg, tags.get(msg.info.id!) ?? 0]),
                ),
                replacementText: provider === "anthropic" ? "" : "[image stripped]",
                frozenMarkers: markers,
                persistNewIds: (ids, saved) => {
                    for (const id of ids) {
                        frozen.add(id);
                        markers.set(id, saved.get(id)!);
                    }
                    return true;
                },
            });
            expect(JSON.stringify(current)).toBe(JSON.stringify(expected));
            if (unaffected) expect(JSON.stringify(current)).toBe(JSON.stringify(old));
            const replay = structuredClone(raw);
            stripProcessedImages(replay, frozen, {
                detect: false,
                watermark: 0,
                messageTagNumbers: new Map(),
                frozenMarkers: markers,
            });
            expect(JSON.stringify(replay)).toBe(JSON.stringify(current));
        }
        expect(tally.unaffected).toBeGreaterThan(0);
        expect(tally.changed).toBeGreaterThan(0);
        if (provider === "anthropic") expect(tally.structuralFallback).toBeGreaterThan(0);
    }
    console.log(`processed-image differential classes: ${JSON.stringify(counts)}`);
});
