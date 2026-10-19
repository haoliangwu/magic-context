import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Message } from "@opencode/ai/schema/messages";
import { stripProcessedImages } from "../../hooks/magic-context/strip-content";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { isRecord } from "../../shared/record-type-guard";
import { rememberHostMedia, resetHostMediaForTests } from "../fold/host-media";
import { adaptPayload } from "./payload";
import type { SessionContext } from "./types";

const baseSource = readFileSync(
    new URL(
        "../../hooks/magic-context/__fixtures__/processed-images.6dec81e7.ts.txt",
        import.meta.url,
    ),
    "utf8",
);
const baseStrip = new Function(
    "isRecord",
    `${new Bun.Transpiler({ loader: "ts" }).transformSync(baseSource).replaceAll("export ", "")}\nreturn stripProcessedImages;`,
)(isRecord) as typeof stripProcessedImages;

class Asset {
    readonly mediaType = "image/png";
    constructor(
        readonly source: { type: "base64"; data: string } | { type: "bytes"; data: Uint8Array },
    ) {}
}

function draft(provider: string, kind: "base64" | "bytes" = "base64"): SessionContext {
    return {
        sessionID: "independent-image-review",
        model: { providerID: provider, id: "model" },
        agent: "build",
        messages: [
            {
                id: "image",
                role: "user",
                content: [
                    {
                        type: "media",
                        media: new Asset(
                            kind === "base64"
                                ? { type: "base64", data: "a".repeat(300) }
                                : { type: "bytes", data: new Uint8Array(300) },
                        ),
                    },
                ],
            },
            { id: "answer", role: "assistant", content: [{ type: "text", text: "seen" }] },
        ],
        system: [],
        tools: {},
        options: {},
    };
}

test("independent image differential: three seeds and 48 passes per host/provider have live identity classes", () => {
    rememberHostMedia([
        Message.make({ role: "user", content: [{ type: "text", text: "seed schema" }] }),
    ]);
    const counts: Record<
        string,
        { identical: number; changed: number; baseStrips: number; imagePasses: number }
    > = {};
    for (const host of ["oc1", "oc2"] as const) {
        for (const provider of ["anthropic", "openai"]) {
            const tally = { identical: 0, changed: 0, baseStrips: 0, imagePasses: 0 };
            counts[`${host}/${provider}`] = tally;
            for (const initialSeed of [0x3a991d, 0xc0ffee, 0x715912]) {
                let seed = initialSeed;
                const random = (max: number) => {
                    seed ^= seed << 13;
                    seed ^= seed >>> 17;
                    seed ^= seed << 5;
                    return (seed >>> 0) % max;
                };
                const frozen = new Set<string>();
                const markers = new Map<string, "" | "[image stripped]">();
                for (let pass = 0; pass < 48; pass++) {
                    const detect = pass % 4 !== 0;
                    const watermark = 1 + random(16);
                    const cutoff = pass % 3 === 0 ? 7 : null;
                    const percentage = pass % 5 === 0 ? 95 : 60;
                    const raw: MessageLike[] = Array.from({ length: 12 }, (_, i) => ({
                        info: {
                            id: `${initialSeed}-${pass}-${i}`,
                            role: i % 3 === 2 ? "assistant" : "user",
                        },
                        parts: [
                            { type: "text", text: `untouched ${random(1000)}` },
                            {
                                type: "file",
                                mime: "image/png",
                                url: `data:image/png;base64,${"b".repeat([10, 178, 179, 320][random(4)])}`,
                                cache_control: { type: "ephemeral" },
                            },
                        ],
                    }));
                    // Include cases where the pre-change helper actually removes an
                    // image, not only cases both versions leave alone. OpenCode 2 can
                    // receive file parts from restored OpenCode 1 history; native media
                    // assets have separate reconstruction tests below.
                    const tagValues = raw.map((_, i) => (pass % 6 === 1 || random(4) ? i + 1 : 0));
                    const baseline = structuredClone(raw);
                    const current = structuredClone(raw);
                    const tags = (messages: MessageLike[]) =>
                        new Map(messages.map((message, i) => [message, tagValues[i]]));
                    const old =
                        provider === "anthropic"
                            ? baseStrip(baseline, frozen, {
                                  detect,
                                  watermark,
                                  messageTagNumbers: tags(baseline),
                              })
                            : { stripped: 0 };
                    tally.baseStrips += old.stripped;
                    tally.imagePasses++;
                    // Classify independently, before invoking the candidate. The oracle
                    // scans forward, unlike the implementation's backwards age scan.
                    const expected = structuredClone(raw);
                    for (let i = 0; i < expected.length; i++) {
                        const message = expected[i];
                        const age = tagValues.slice(i).find((tag) => tag > 0);
                        const answered = expected
                            .slice(i + 1)
                            .some((later) => later.info.role === "assistant");
                        const eligible =
                            message.info.role === "user" &&
                            detect &&
                            answered &&
                            age !== undefined &&
                            age <= watermark &&
                            (percentage >= 95 || cutoff === null || age < cutoff);
                        if (eligible)
                            message.parts = message.parts.map((part) => {
                                const file = part as {
                                    type?: string;
                                    url?: string;
                                    cache_control?: unknown;
                                };
                                return file.type === "file" && (file.url?.length ?? 0) > 200
                                    ? {
                                          type: "text",
                                          text: provider === "anthropic" ? "" : "[image stripped]",
                                          cache_control: file.cache_control,
                                      }
                                    : part;
                            });
                    }
                    const render = (messages: MessageLike[]) => {
                        if (host === "oc1") return JSON.stringify(messages);
                        const context = draft(provider);
                        context.messages = messages.map((message) => ({
                            id: message.info.id,
                            role: message.info.role!,
                            content: message.parts as Record<string, unknown>[],
                        }));
                        const mapped = adaptPayload(context);
                        mapped.commit();
                        return JSON.stringify(context.messages);
                    };
                    const expectedBytes = render(expected);
                    if (host === "oc2") expect(render(raw)).toContain('"type":"media"');
                    const unaffected = expectedBytes === render(baseline);
                    tally[unaffected ? "identical" : "changed"]++;
                    stripProcessedImages(current, frozen, {
                        detect,
                        watermark,
                        protectedCutoff: cutoff,
                        contextPercentage: percentage,
                        messageTagNumbers: tags(current),
                        frozenMarkers: markers,
                        replacementText: provider === "anthropic" ? "" : "[image stripped]",
                        persistNewIds: (ids, saved) => {
                            for (const id of ids) {
                                frozen.add(id);
                                markers.set(id, saved.get(id)!);
                            }
                            return true;
                        },
                    });
                    expect(render(current)).toBe(expectedBytes);
                    if (unaffected) expect(render(current)).toBe(render(baseline));
                    const replay = structuredClone(raw);
                    stripProcessedImages(replay, frozen, {
                        detect: false,
                        watermark: 0,
                        messageTagNumbers: new Map(),
                        frozenMarkers: markers,
                    });
                    expect(render(replay)).toBe(render(current));
                }
            }
            expect(tally.imagePasses).toBe(144);
            expect(tally.identical).toBeGreaterThan(0);
            expect(tally.changed).toBeGreaterThan(0);
            if (provider === "anthropic") expect(tally.baseStrips).toBeGreaterThan(0);
        }
    }
    console.log(`independent image differential classes: ${JSON.stringify(counts)}`);
    resetHostMediaForTests();
});

for (const kind of ["base64", "bytes"] as const) {
    test(`independent native ${kind}: defer and failed persistence cannot first-apply, fresh native reconstruction replays`, () => {
        const frozen = new Set<string>();
        const markers = new Map<string, "" | "[image stripped]">();
        const serve = (detect: boolean, persist: boolean) => {
            const context = draft("openai", kind);
            const before = JSON.stringify(context.messages);
            const mapped = adaptPayload(context);
            let writes = 0;
            const result = stripProcessedImages(mapped.messages, frozen, {
                detect,
                watermark: 5,
                messageTagNumbers: new Map([[mapped.messages[1], 2]]),
                replacementText: "[image stripped]",
                frozenMarkers: markers,
                persistNewIds: (ids, saved) => {
                    writes++;
                    expect(JSON.stringify(context.messages)).toBe(before);
                    expect(JSON.stringify(mapped.messages[0].parts)).toContain('"media"');
                    if (!persist) return false;
                    for (const id of ids) {
                        frozen.add(id);
                        markers.set(id, saved.get(id)!);
                    }
                    return true;
                },
            });
            mapped.commit();
            return { bytes: JSON.stringify(context.messages), before, writes, result };
        };
        const deferred = serve(false, true);
        expect(deferred.bytes).toBe(deferred.before);
        expect(deferred.writes).toBe(0);
        const failed = serve(true, false);
        expect(failed.bytes).toBe(failed.before);
        expect(failed.writes).toBe(1);
        expect(failed.result.stripped).toBe(0);
        const rewritten = serve(true, true);
        expect(rewritten.result.stripped).toBe(1);
        expect(rewritten.bytes).toContain("[image stripped]");
        expect(serve(false, false).bytes).toBe(rewritten.bytes);
    });
}

test("independent witness: OC2 legacy empty image replay has identical bytes across provider switches", () => {
    const serve = (provider: string) => {
        const context = draft(provider);
        const mapped = adaptPayload(context);
        stripProcessedImages(mapped.messages, new Set(["image"]), {
            detect: false,
            watermark: 0,
            messageTagNumbers: new Map(),
            replacementText: provider === "anthropic" ? "" : "[image stripped]",
        });
        mapped.commit();
        return JSON.stringify(context.messages);
    };
    const anthropic = serve("anthropic");
    const openai = serve("openai");
    expect(anthropic).not.toContain('"media"');
    expect(openai).not.toContain('"media"');
    expect(openai).toBe(anthropic);
});
