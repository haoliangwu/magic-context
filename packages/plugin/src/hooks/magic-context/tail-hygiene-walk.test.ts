import { describe, expect, it, spyOn } from "bun:test";
import { computeProtectionWindow } from "../../features/magic-context/protection-window";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import type { TagEntry } from "../../features/magic-context/types";
import { buildChannel1Reminder, decideChannel1 } from "./ctx-reduce-nudge";
import * as formattingModule from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import {
    assertTailHygieneContentUnchanged,
    effectiveTailHygiene,
    measureTailHygiene,
    refreshTailHygieneBaseline,
    sameTailHygieneStructuralSignature,
    tailHygieneStructuralSignature,
} from "./tail-hygiene-walk";

function message(
    id: string,
    role: "user" | "assistant",
    parts: unknown[],
    extra: Partial<MessageLike["info"]> = {},
): MessageLike {
    return { info: { id, role, ...extra }, parts };
}

function textMessage(id: string, text: string, role: "user" | "assistant" = "user"): MessageLike {
    return message(id, role, [{ type: "text", text }]);
}

function tag(
    tagNumber: number,
    messageId: string,
    type: TagEntry["type"],
    overrides: Partial<TagEntry> = {},
): TagEntry {
    return {
        tagNumber,
        messageId,
        type,
        status: "active",
        dropMode: "full",
        toolName: type === "tool" ? "read" : null,
        inputByteSize: 0,
        byteSize: 1,
        reasoningByteSize: 0,
        sessionId: "ses-walk",
        cavemanDepth: 0,
        toolOwnerMessageId: type === "tool" ? "owner" : null,
        ...overrides,
    };
}

function nativeTool(ownerId: string, callID: string, input: unknown, output: string): MessageLike {
    return message(ownerId, "assistant", [
        { type: "tool", callID, tool: "read", state: { input, output } },
    ]);
}

describe("tail hygiene single-walk instrument", () => {
    it("reproduces the live incident from rendered-tail coordinates", () => {
        const messages = [
            textMessage("conversation", "prose ".repeat(58_000)),
            nativeTool("tool-owner", "call-live", { path: "fixture" }, "result ".repeat(81_000)),
            {
                info: { role: "user", syntheticHead: true },
                parts: [{ type: "text", text: "m0 ".repeat(131_000), synthetic: true }],
            } as MessageLike,
        ];
        const tags = [tag(2, "call-live", "tool", { toolOwnerMessageId: "tool-owner" })];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const severity = measured.u / measured.t;
        const oldInputRelativeSeverity = measured.u / 648_000;
        const oldRebasedPressure = 0.2;
        const oldWouldFire = oldInputRelativeSeverity >= 0.2 && oldRebasedPressure >= 0.8;

        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThanOrEqual(measured.t);
        expect(severity).toBeGreaterThanOrEqual(0.55);
        expect(severity).toBeLessThan(0.7);
        expect(oldWouldFire).toBe(false);
    });

    it("consumes token-window membership derived from the floor and persisted tag mass", () => {
        const messages: MessageLike[] = [];
        const tags: TagEntry[] = [];
        const persistedRows: Array<{
            tag_number: number;
            block_id: string;
            kind: "tool";
            token_count: number;
        }> = [];
        for (let number = 1; number <= 4; number += 1) {
            const owner = `owner-${number}`;
            const callId = `call-${number}`;
            messages.push(nativeTool(owner, callId, { path: String(number) }, `result ${number}`));
            tags.push(tag(number, callId, "tool", { toolOwnerMessageId: owner }));
            persistedRows.push({
                tag_number: number,
                block_id: callId,
                kind: "tool",
                token_count: 4_000,
            });
        }
        const protectedTagNumbers = computeProtectionWindow(persistedRows, 16_000).tagNumberSet
            .tagNumbers;
        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers });

        expect(protectedTagNumbers).toEqual(new Set([1, 2, 3, 4]));
        expect(measured.u).toBe(0);
        expect(measured.t).toBeGreaterThan(0);

        const emptyProtectedTagNumbers = computeProtectionWindow(
            [{ tag_number: 5, block_id: "message:p0", kind: "message", token_count: 8_000 }],
            16_000,
        ).tagNumberSet.tagNumbers;
        const emptyWindowMeasured = measureTailHygiene({
            messages: [textMessage("message", "still reclaimable")],
            tags: [tag(5, "message:p0", "message")],
            protectedTagNumbers: emptyProtectedTagNumbers,
        });
        expect(emptyProtectedTagNumbers).toEqual(new Set());
        expect(emptyWindowMeasured.u).toBe(emptyWindowMeasured.t);
    });

    it("is invariant to raw tag weights and measures only final rendered content", () => {
        const messages = [
            textMessage("m1", "kept rendered prose ".repeat(200)),
            nativeTool("m2", "call-drift", { path: "small" }, "rendered output ".repeat(150)),
        ];
        const normalTags = [
            tag(1, "m1:p0", "message", { byteSize: 100 }),
            tag(2, "call-drift", "tool", {
                byteSize: 100,
                inputByteSize: 20,
                toolOwnerMessageId: "m2",
            }),
        ];
        const driftedTags = normalTags.map((entry) => ({
            ...entry,
            byteSize: entry.byteSize + 380_000,
            inputByteSize: entry.inputByteSize + 200_000,
        }));

        expect(
            measureTailHygiene({ messages, tags: driftedTags, protectedTagNumbers: new Set() }),
        ).toEqual(
            measureTailHygiene({ messages, tags: normalTags, protectedTagNumbers: new Set() }),
        );
    });

    it("counts caveman-compressed bytes and excludes truncated tool skeletons", () => {
        const messages = [
            textMessage("compressed", "compact summary"),
            nativeTool(
                "skeleton-owner",
                "call-truncated",
                { path: "/very/large/original/path", payload: "x".repeat(50_000) },
                "[truncated §2§]",
            ),
        ];
        const tags = [
            tag(1, "compressed:p0", "message", { byteSize: 500_000, cavemanDepth: 3 }),
            tag(2, "call-truncated", "tool", {
                byteSize: 500_000,
                inputByteSize: 100_000,
                toolOwnerMessageId: "skeleton-owner",
            }),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const compressedOnly = measureTailHygiene({
            messages: [messages[0]],
            tags: [tags[0]],
            protectedTagNumbers: new Set(),
        });

        expect(measured.u).toBe(compressedOnly.u);
        expect(measured.t).toBe(compressedOnly.t);
    });

    it("excludes reasoning and signatures in both directions", () => {
        const base = [textMessage("m", "visible working text ".repeat(100))];
        const withReasoning = [
            message("m", "user", [
                { type: "text", text: "visible working text ".repeat(100) },
                {
                    type: "thinking",
                    thinking: "private chain ".repeat(50_000),
                    signature: "signed ".repeat(10_000),
                },
                { type: "redacted_thinking", data: "opaque ".repeat(50_000) },
                { type: "signature", text: "signature ".repeat(50_000) },
            ]),
        ];
        const tags = [tag(1, "m:p0", "message")];

        const expected = measureTailHygiene({
            messages: base,
            tags,
            protectedTagNumbers: new Set(),
        });
        const actual = measureTailHygiene({
            messages: withReasoning,
            tags,
            protectedTagNumbers: new Set(),
        });
        expect({ u: actual.u, t: actual.t }).toEqual({ u: expected.u, t: expected.t });
    });

    it("excludes m0/m1, todo, Channel-2, and compaction-summary synthetics", () => {
        const syntheticMessages: MessageLike[] = [
            {
                info: { role: "user", syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                info: { id: "__magic_context_todo_head__", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "mc_synthetic_todo_0123456789abcdef",
                        tool: "todowrite",
                        syntheticTodoMarker: true,
                        state: { input: { todos: [] }, output: "todo" },
                    },
                ],
            },
            message("channel2", "user", [
                { type: "text", text: "<system-reminder>drop</system-reminder>", synthetic: true },
            ]),
            message("summary", "assistant", [{ type: "text", text: "compacted" }], {
                summary: true,
            }),
        ];

        expect(
            measureTailHygiene({
                messages: syntheticMessages,
                tags: [],
                protectedTagNumbers: new Set(),
            }),
        ).toMatchObject({ u: 0, t: 0 });
    });

    it("excludes protected ctx_reduce exemplar arcs from U while retaining them in T", () => {
        const messages = Array.from({ length: 4 }, (_, index) =>
            nativeTool(
                `reduce-owner-${index + 1}`,
                `reduce-${index + 1}`,
                { drop: index + 1 },
                `reduced ${index + 1}`,
            ),
        );
        const tags = Array.from({ length: 4 }, (_, index) =>
            tag(index + 1, `reduce-${index + 1}`, "tool", {
                toolName: "ctx_reduce",
                toolOwnerMessageId: `reduce-owner-${index + 1}`,
            }),
        );

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const protectedTagNumbers = new Set(
            measured.parts.filter((part) => part.protected).map((part) => part.tagNumber),
        );
        const oldestArcParts = measured.parts.filter((part) => part.tagNumber === 1);
        const exemplarParts = measured.parts.filter((part) => (part.tagNumber ?? 0) >= 2);

        expect(protectedTagNumbers).toEqual(new Set([2, 3, 4]));
        expect(oldestArcParts.every((part) => part.uTokens > 0)).toBe(true);
        expect(exemplarParts.every((part) => part.uTokens === 0)).toBe(true);
        expect(measured.u).toBeGreaterThan(0);
        expect(measured.t).toBeGreaterThan(measured.u);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("keeps U as a constructed subset of T, including image/file parts", () => {
        const messages = [
            message("file-owner", "user", [
                { type: "file", mime: "image/png", url: "data:image/png;base64,garbage" },
            ]),
            nativeTool("tool-owner", "call-subset", { query: "x" }, "answer"),
            textMessage("untagged", "visible but not reclaimable"),
        ];
        const tags = [
            tag(1, "file-owner:file0", "file"),
            tag(2, "call-subset", "tool", { toolOwnerMessageId: "tool-owner" }),
        ];
        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });

        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThan(measured.t);
        expect(measured.u).toBeLessThanOrEqual(measured.t);
    });

    it("attributes a single orphan only in its tag-number neighborhood", () => {
        const messages = [
            textMessage("before", "before"),
            nativeTool("legacy-owner", "call-reused", { n: 1 }, "legacy output"),
            textMessage("after", "after"),
            textMessage("later-before", "later before"),
            nativeTool("recycled-owner", "call-reused", { n: 2 }, "recycled output"),
            textMessage("later-after", "later after"),
        ];
        const tags = [
            tag(9, "before:p0", "message"),
            tag(10, "call-reused", "tool", { toolOwnerMessageId: null }),
            tag(11, "after:p0", "message"),
            tag(100, "later-before:p0", "message"),
            tag(102, "later-after:p0", "message"),
        ];

        const both = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const legacyOnly = measureTailHygiene({
            messages: messages.slice(0, 3),
            tags,
            protectedTagNumbers: new Set(),
        });
        const legacyProseOnly = measureTailHygiene({
            messages: [messages[0], messages[2]],
            tags,
            protectedTagNumbers: new Set(),
        });
        const laterOnly = measureTailHygiene({
            messages: messages.slice(3),
            tags,
            protectedTagNumbers: new Set(),
        });
        const laterProseOnly = measureTailHygiene({
            messages: [messages[3], messages[5]],
            tags,
            protectedTagNumbers: new Set(),
        });
        const allProse = measureTailHygiene({
            messages: [messages[0], messages[2], messages[3], messages[5]],
            tags,
            protectedTagNumbers: new Set(),
        });
        const legacyToolU = legacyOnly.u - legacyProseOnly.u;

        expect(legacyToolU).toBeGreaterThan(0);
        expect(laterOnly.u).toBe(laterProseOnly.u);
        expect(both.u).toBe(allProse.u + legacyToolU);
        expect(both.u).toBeLessThan(both.t);
    });

    it("treats multiple NULL-owner rows for one callID as ambiguous", () => {
        const messages = [
            textMessage("before", "before"),
            nativeTool("legacy-owner", "call-ambiguous", { n: 1 }, "legacy output"),
            textMessage("after", "after"),
        ];
        const tags = [
            tag(9, "before:p0", "message"),
            tag(10, "call-ambiguous", "tool", { toolOwnerMessageId: null }),
            tag(10_000, "call-ambiguous", "tool", { toolOwnerMessageId: null }),
            tag(11, "after:p0", "message"),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        // The neighboring tagged prose still contributes U even though both orphan rows are rejected.
        expect(measured.u).toBeGreaterThan(0);
        const textOnly = measureTailHygiene({
            messages: [messages[0], messages[2]],
            tags,
            protectedTagNumbers: new Set(),
        });
        expect(measured.u).toBe(textOnly.u);
        expect(measured.t).toBeGreaterThan(measured.u);
    });
});

describe("tail hygiene baseline and defer-window deltas", () => {
    it("keeps a bust pass and an unchanged defer pass identical", () => {
        const messages = [textMessage("m", "working tail ".repeat(10_000))];
        const tags = [tag(1, "m:p0", "message")];
        const bust = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: bust,
        });

        expect(effectiveTailHygiene(defer)).toEqual(effectiveTailHygiene(bust));
        expect(defer.baselineGeneration).toBe(bust.baselineGeneration);
        expect(defer.evaluable).toBe(true);
    });

    it("subtracts queued-drop mass through the defer delta without changing T or the frozen baseline", () => {
        const messages = [
            textMessage("queued", "mass ".repeat(25_000)),
            textMessage("remaining", "mass ".repeat(45_000)),
            textMessage("untagged", "mass ".repeat(30_000)),
        ];
        const tags = [tag(1, "queued:p0", "message"), tag(2, "remaining:p0", "message")];
        const initial = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const queuedMass = measureTailHygiene({
            messages: [messages[0]],
            tags: [tags[0]],
            protectedTagNumbers: new Set(),
        }).u;
        const baseline = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const queued = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            pendingDropTagNumbers: new Set([1]),
        });
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            pendingDropTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: baseline,
        });

        expect(queued.t).toBe(initial.t);
        expect(queued.u).toBe(initial.u - queuedMass);
        expect(defer.evaluable).toBe(true);
        expect(defer.baselineU).toBe(baseline.baselineU);
        expect(defer.baselineT).toBe(baseline.baselineT);
        expect(effectiveTailHygiene(defer)).toEqual({ u: queued.u, t: queued.t });
        expect(
            decideChannel1({
                ...baseline,
                lastNudgeUndropped: 0,
                lastNudgeLevel: "",
                hasRecentReduce: false,
            }).level,
        ).toBe("urgent");
        expect(
            decideChannel1({
                ...defer,
                lastNudgeUndropped: 0,
                lastNudgeLevel: "",
                hasRecentReduce: false,
            }).level,
        ).toBe("firm");
    });

    it("replays a prior Channel-1 reminder byte-identically when queue state changes U", () => {
        const original = nativeTool(
            "owner",
            "call-replay",
            { path: "x" },
            "tool output ".repeat(500),
        );
        const tags = [tag(1, "call-replay", "tool", { toolOwnerMessageId: "owner" })];
        const reminder = buildChannel1Reminder("firm", 42_000, 16);
        const served = structuredClone(original) as MessageLike;
        (served.parts[0] as { state: { output: string } }).state.output += reminder;
        const baseline = refreshTailHygieneBaseline({
            messages: [served],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const replay = refreshTailHygieneBaseline({
            messages: [served],
            tags,
            protectedTagNumbers: new Set(),
            pendingDropTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: baseline,
        });

        expect((served.parts[0] as { state: { output: string } }).state.output).toContain(reminder);
        expect(replay.contentSignature).toBe(baseline.contentSignature);
        expect(replay.evaluable).toBe(true);
    });

    it("walks typed appended deltas while protected and untagged tool output is T-only", () => {
        const baseMessages = [textMessage("base", "base text ".repeat(100))];
        const baseTags = [tag(1, "base:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: baseMessages,
            tags: baseTags,
            protectedTagNumbers: new Set([1]),
            cacheBusting: true,
        });
        const messages = [
            ...baseMessages,
            textMessage("user-delta", "new user prose ".repeat(100)),
            textMessage("assistant-delta", "new assistant prose ".repeat(100), "assistant"),
            message("image-delta", "user", [
                { type: "file", mime: "image/png", url: "data:image/png;base64,garbage" },
            ]),
            nativeTool("tool-delta", "call-delta", { path: "new" }, "new tool output ".repeat(100)),
            nativeTool("untagged-tool", "call-untagged", { path: "other" }, "untagged output"),
        ];
        const tags = [
            ...baseTags,
            tag(2, "user-delta:p0", "message"),
            tag(3, "assistant-delta:p0", "message"),
            tag(4, "image-delta:file0", "file"),
            tag(5, "call-delta", "tool", { toolOwnerMessageId: "tool-delta" }),
        ];
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: baseline,
        });

        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaT).toBeGreaterThan(0);
        expect(defer.turnDeltaU).toBeGreaterThan(0);
        expect(defer.turnDeltaU).toBeLessThan(defer.turnDeltaT);
        expect(effectiveTailHygiene(defer).u).toBeLessThanOrEqual(effectiveTailHygiene(defer).t);
    });

    it("adds exactly persisted mass when the protection boundary advances", () => {
        const before = [
            textMessage("old", "old reclaimable mass ".repeat(100)),
            textMessage("protected", "still protected ".repeat(100)),
        ];
        const beforeTags = [tag(1, "old:p0", "message"), tag(2, "protected:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: before,
            tags: beforeTags,
            protectedTagNumbers: new Set([1, 2]),
            cacheBusting: true,
        });
        const oldMass = measureTailHygiene({
            messages: [before[0]],
            tags: [beforeTags[0]],
            protectedTagNumbers: new Set(),
        }).t;
        const appended = textMessage("newest", "newest protected ".repeat(100));
        const defer = refreshTailHygieneBaseline({
            messages: [...before, appended],
            tags: [...beforeTags, tag(3, "newest:p0", "message")],
            protectedTagNumbers: new Set([2, 3]),
            cacheBusting: false,
            previous: baseline,
        });

        expect(baseline.baselineU).toBe(0);
        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaU).toBe(oldMass);
        expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
    });

    it("ignores a Channel-1 reminder appended after the measured pass", () => {
        const original = nativeTool("owner", "call-reminder", { path: "x" }, "tool output");
        const tags = [tag(1, "call-reminder", "tool", { toolOwnerMessageId: "owner" })];
        const baseline = refreshTailHygieneBaseline({
            messages: [original],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const mutated = structuredClone(original) as MessageLike;
        const toolPart = mutated.parts[0] as { state: { output: string } };
        toolPart.state.output += buildChannel1Reminder("gentle", 25_000, 16);
        const defer = refreshTailHygieneBaseline({
            messages: [mutated],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: baseline,
        });

        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaU).toBe(0);
        expect(defer.turnDeltaT).toBe(0);
        expect(effectiveTailHygiene(defer)).toEqual(effectiveTailHygiene(baseline));
    });

    it("marks non-append mutation as generation-invalidated until a bust rewalk", () => {
        const original = [textMessage("m", "original content")];
        const tags = [tag(1, "m:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: original,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const changed = [textMessage("m", "changed content")];
        const defer = refreshTailHygieneBaseline({
            messages: changed,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: baseline,
        });
        const rewalk = refreshTailHygieneBaseline({
            messages: changed,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
            previous: defer,
        });

        expect(defer.evaluable).toBe(false);
        expect(defer.generationInvalidated).toBe(true);
        expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
        expect(rewalk.evaluable).toBe(true);
        expect(rewalk.generationInvalidated).toBe(false);
        expect(rewalk.baselineGeneration).toBe(baseline.baselineGeneration + 1);
    });

    it("detects a byte mutation after the walk with a content-hash assertion", () => {
        const messages = [textMessage("m", "stable content")];
        const tags = [tag(1, "m:p0", "message")];
        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        (messages[0].parts[0] as { text: string }).text = "mutated bytes!";

        expect(() =>
            assertTailHygieneContentUnchanged({
                messages,
                tags,
                protectedTagNumbers: new Set(),
                expectedSignature: measured.contentSignature,
            }),
        ).toThrow(/tail hygiene walk was not the last byte-affecting operation/i);
    });
});

describe("tail hygiene image content memoization", () => {
    it("hashes raw and prefixed user/tool-result images without text-tokenizing their payloads", () => {
        const rawPayload = "A".repeat(3 * 1024 * 1024);
        const prefixedPayload = `data:image/png;base64,${rawPayload}`;
        const messages = [
            message("user-image", "user", [{ type: "file", mime: "image/png", url: rawPayload }]),
            message("tool-result-image", "assistant", [
                { type: "file", mime: "image/png", url: prefixedPayload },
            ]),
        ];
        const tokenizer = spyOn(formattingModule, "estimateTokens");
        try {
            const tags = [
                tag(1, "user-image:file0", "file"),
                tag(2, "tool-result-image:file0", "file"),
            ];
            const baseline = measureTailHygiene({
                messages,
                tags,
                protectedTagNumbers: new Set(),
            });
            const measured = measureTailHygiene({
                messages,
                tags,
                protectedTagNumbers: new Set([2]),
                pendingDropTagNumbers: new Set([1]),
            });
            const imageParts = measured.parts.filter((part) => part.kind === "file");
            const imagePayloadCalls = tokenizer.mock.calls.filter(
                ([content]) => typeof content === "string" && content.includes(rawPayload),
            );

            expect(imagePayloadCalls).toHaveLength(0);
            expect(imageParts.map(({ kind, tokens }) => ({ kind, tokens }))).toEqual([
                { kind: "file", tokens: 1200 },
                { kind: "file", tokens: 1200 },
            ]);
            expect(measured.t).toBe(baseline.t);
            expect(measured.u).toBe(0);
            expect(baseline.contentSignature).toBe(measured.contentSignature);
            expect(measured.contentSignature).toBe("30a3de96");
            expect(measured.parts.find((part) => part.tagNumber === 1)).toMatchObject({
                queuedForDrop: true,
                protected: false,
            });
            expect(measured.parts.find((part) => part.tagNumber === 2)).toMatchObject({
                queuedForDrop: false,
                protected: true,
                uTokens: 0,
            });
        } finally {
            tokenizer.mockRestore();
        }
    });

    it("counts a previously hash-only file key exactly once when text accounting follows", () => {
        const content = `data:image/png;base64,${"B".repeat(64)}`;
        const part = { type: "file", mime: "image/png", url: content };
        const imageMessage = message("hash-first", "user", [part]);
        const expectedTextTokens = formattingModule.estimateTokens(content);
        const tokenizer = spyOn(formattingModule, "estimateTokens");
        try {
            measureTailHygiene({
                messages: [imageMessage],
                tags: [tag(3, "hash-first:file0", "file")],
                protectedTagNumbers: new Set(),
            });
            part.mime = "text/plain";
            const measured = measureTailHygiene({
                messages: [imageMessage],
                tags: [tag(3, "hash-first:file0", "file")],
                protectedTagNumbers: new Set(),
            });
            const textCalls = tokenizer.mock.calls.filter(([value]) => value === content);

            expect(textCalls).toHaveLength(1);
            expect(measured.parts[0]?.tokens).toBe(expectedTextTokens);
        } finally {
            tokenizer.mockRestore();
        }
    });

    it("caches a genuine zero and keeps excluded content out of the tokenizer", () => {
        const zeroContent = "opencode-zero-token-fixture";
        const excludedContent = "opencode-excluded-fixture";
        const tokenizer = spyOn(formattingModule, "estimateTokens").mockImplementation((content) =>
            content === zeroContent ? 0 : 1,
        );
        try {
            const messages = [
                message("zero", "user", [
                    { type: "text", text: zeroContent },
                    { type: "thinking", thinking: excludedContent },
                ]),
            ];
            const input = {
                messages,
                tags: [tag(4, "zero:p0", "message")],
                protectedTagNumbers: new Set<number>(),
            };
            const first = measureTailHygiene(input);
            const second = measureTailHygiene(input);
            expect(first.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
            expect(second.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
            expect(tokenizer.mock.calls.filter(([value]) => value === zeroContent)).toHaveLength(1);
            expect(
                tokenizer.mock.calls.filter(([value]) => value === excludedContent),
            ).toHaveLength(0);
        } finally {
            tokenizer.mockRestore();
        }
    });
});

describe("tail hygiene walk performance", () => {
    it("stays below 30ms p95 on a 250k-token rendered tail", () => {
        const messages = [textMessage("perf", "token ".repeat(250_000))];
        const tags = [tag(1, "perf:p0", "message")];
        const durations: number[] = [];
        for (let iteration = 0; iteration < 25; iteration += 1) {
            const start = performance.now();
            measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
            durations.push(performance.now() - start);
        }
        durations.sort((left, right) => left - right);
        const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
        console.log(`tail-hygiene-walk 250k-token p95=${p95.toFixed(3)}ms`);
        // Parallel workers can add scheduler delay to this wall-clock measurement. A 30ms
        // ceiling tolerates observed shared-runner contention while still rejecting a
        // regression far above the usual 1–3ms measurements.
        expect(p95).toBeLessThan(30);
    });
});

describe("tail hygiene structural signature", () => {
    it("counts nested string lengths, own keys and array elements without serializing or encoding", () => {
        const messages = [message("m", "user", [{ text: "🙂", nested: ["abc", null, 42, false] }])];
        const stringify = spyOn(JSON, "stringify").mockImplementation(() => {
            throw new Error("structural traversal must not serialize");
        });
        const encode = spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
            throw new Error("structural traversal must not encode");
        });
        let signature: ReturnType<typeof tailHygieneStructuralSignature>;
        try {
            signature = tailHygieneStructuralSignature(messages);
            expect(stringify).not.toHaveBeenCalled();
            expect(encode).not.toHaveBeenCalled();
        } finally {
            stringify.mockRestore();
            encode.mockRestore();
        }
        // Six own keys, five array elements, and ten UTF-16 string code units.
        expect(signature).toEqual({ messageCount: 1, partCounts: [1], totalBytes: 21 });
    });

    it("detects nested string growth and structural additions on the same objects", () => {
        const part = { text: "before", nested: ["kept"] };
        const messages = [message("m", "user", [part])];
        const before = tailHygieneStructuralSignature(messages);
        part.text += "!";
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(false);
        part.text = "before";
        part.nested.push("");
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(false);
        part.nested.pop();
        Object.assign(part, { added: null });
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(false);
    });

    it("remains a size alarm rather than a same-length content hash", () => {
        const part = { text: "before" };
        const messages = [message("m", "user", [part])];
        const before = tailHygieneStructuralSignature(messages);
        part.text = "after!";
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(true);
    });
});

describe("tail hygiene protectedTagNumbers set form (token window)", () => {
    it("consumes protectedTagNumbers set in tag-number coordinate space and excludes protected tool tags from U", () => {
        const messages = [
            nativeTool("owner-1", "call-1", { cmd: "test" }, "tool output 1 ".repeat(100)),
            nativeTool("owner-2", "call-2", { cmd: "test" }, "tool output 2 ".repeat(100)),
        ];
        const tags = [
            tag(10, "call-1", "tool", { toolOwnerMessageId: "owner-1" }),
            tag(20, "call-2", "tool", { toolOwnerMessageId: "owner-2" }),
        ];

        // Coordinate space: tag-number space. Tag 20 is in the token protection window
        const protectedTagNumbers: ReadonlySet<number> = new Set([20]);

        const measured = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers,
        });

        // Tag 10 is unprotected -> included in U
        // Tag 20 is protected -> excluded from U
        expect(measured.t).toBeGreaterThan(0);
        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThan(measured.t);

        const part10 = measured.parts.find((p) => p.tagNumber === 10);
        const part20 = measured.parts.find((p) => p.tagNumber === 20);
        expect(part10?.protected).toBe(false);
        expect(part10?.uTokens).toBeGreaterThan(0);
        expect(part20?.protected).toBe(true);
        expect(part20?.uTokens).toBe(0);
    });

    it("declares empty-window behavior: empty set protects 0 tool tags, non-tool tags are never reclaim targets", () => {
        const messages = [
            textMessage("msg-1", "prose message text ".repeat(50)),
            nativeTool("owner-1", "call-1", { cmd: "test" }, "tool output 1 ".repeat(50)),
        ];
        const tags = [
            tag(5, "msg-1:p0", "message"),
            tag(10, "call-1", "tool", { toolOwnerMessageId: "owner-1" }),
        ];

        // Empty window: protectedTagNumbers = empty set
        const protectedTagNumbers: ReadonlySet<number> = new Set();

        const measured = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers,
        });

        // Tool tag 10 is unprotected
        const toolPart = measured.parts.find((p) => p.tagNumber === 10);
        expect(toolPart?.protected).toBe(false);
        expect(toolPart?.uTokens).toBeGreaterThan(0);

        // Non-tool message tag 5 has its eligibility decided solely by independent protections (prose text)
        const msgPart = measured.parts.find((p) => p.tagNumber === 5);
        expect(msgPart?.kind).toBe("text");
    });
});
