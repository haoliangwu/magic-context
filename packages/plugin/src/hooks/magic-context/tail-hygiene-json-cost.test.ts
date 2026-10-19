import { expect, spyOn, test } from "bun:test";
import * as stableJson from "../../shared/stable-json";
import { opencode1ToModelMessages } from "./opencode1-to-model-messages.fixture";
import { providerVisiblePart, providerVisiblePartForTailHygiene } from "./provider-visible-parts";
import { measureTailHygiene, refreshTailHygieneBaseline } from "./tail-hygiene-walk";

function metadataProbe() {
    const data = {
        diagnostics: "x".repeat(18 * 1024 * 1024),
        interrupted: true,
        output: "partial" as unknown,
    };
    let bytesVisited = 0;
    let reads = 0;
    const metadata = new Proxy(data, {
        ownKeys(target) {
            bytesVisited += data.diagnostics.length;
            return Reflect.ownKeys(target);
        },
        get(target, key, receiver) {
            if (key === "diagnostics") bytesVisited += data.diagnostics.length;
            return Reflect.get(target, key, receiver);
        },
    });
    return {
        data,
        read: () => {
            reads++;
            return metadata;
        },
        stats: () => ({ bytesVisited, reads }),
    };
}

for (const opencode2 of [false, true]) {
    test(`excluded OpenCode ${opencode2 ? 2 : 1} identity visits zero UI metadata bytes`, () => {
        const probe = metadataProbe();
        const part = {
            type: "tool",
            callID: `cost-call-${opencode2}`,
            tool: "edit",
            state: {
                status: opencode2 ? "error" : "completed",
                input: { path: "file.ts" },
                error: "[dropped §1§]",
                ...(opencode2 ? {} : { output: "[dropped §1§]" }),
                get metadata() {
                    return probe.read();
                },
            },
        };
        const messages = [
            {
                info: { id: `cost-owner-${opencode2}`, role: "assistant" },
                parts: [part, { type: "text", text: "first" }, part],
            },
            {
                info: { id: `cost-newest-${opencode2}`, role: "user" },
                parts: [{ type: "text", text: "next" }],
            },
        ];
        const input = {
            messages,
            tags: [],
            protectedTagNumbers: new Set<number>(),
            cacheBusting: true,
            now: 1,
            opencode2,
        };
        const serialize = spyOn(stableJson, "stableStringify");
        const fingerprint = spyOn(stableJson, "stableStringifyHash");
        try {
            let previous = refreshTailHygieneBaseline(input);
            expect(probe.stats()).toEqual({ bytesVisited: 0, reads: 0 });
            expect(serialize.mock.calls.filter(([value]) => value === part)).toHaveLength(0);
            expect(fingerprint).toHaveBeenCalledTimes(1);
            serialize.mockClear();
            fingerprint.mockClear();
            messages[0].parts[1] = { type: "text", text: "second" };
            previous = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
            expect(serialize).not.toHaveBeenCalled();
            expect(fingerprint).not.toHaveBeenCalled();
            probe.data.diagnostics = "y".repeat(18 * 1024 * 1024);
            messages[0].parts[1] = { type: "text", text: "third" };
            const changed = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
            // UI-only edits stay irrelevant even when a sibling invalidates message replay.
            expect(changed.baselineParts[0]).toEqual(previous.baselineParts[0]);
            expect(fingerprint).not.toHaveBeenCalled();
            expect(probe.stats()).toEqual({ bytesVisited: 0, reads: 0 });
        } finally {
            serialize.mockRestore();
            fingerprint.mockRestore();
        }
    });
}

test("excluded OpenCode identity preserves the interrupted error fields OpenCode 1 forwards", async () => {
    const probe = metadataProbe();
    const part = {
        type: "tool",
        callID: "interrupted-cost",
        tool: "edit",
        state: {
            status: "error",
            input: { path: "file.ts" },
            error: "[dropped]",
            get metadata() {
                return probe.read();
            },
        },
    };
    const messages = [
        {
            info: {
                id: "interrupted-owner",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5",
            },
            parts: [part],
        },
        {
            info: { id: "interrupted-newest", role: "user" },
            parts: [{ type: "text", text: "next" }],
        },
    ];
    const input = { messages, tags: [], protectedTagNumbers: new Set<number>() };
    const hash = () => measureTailHygiene(input).parts[0].contentHash;
    const model = {
        providerID: "anthropic",
        id: "claude-sonnet-4-5",
        api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-4-5" },
    };
    const before = hash();
    const beforeWire = JSON.stringify(await opencode1ToModelMessages(messages, model));
    probe.data.output = "different partial";
    expect(hash()).not.toBe(before);
    const afterWire = JSON.stringify(await opencode1ToModelMessages(messages, model));
    expect(afterWire).not.toBe(beforeWire);
    expect(afterWire).toContain("different partial");
    probe.data.interrupted = false;
    const notInterrupted = hash();
    probe.data.output = "irrelevant while not interrupted";
    expect(hash()).toBe(notInterrupted);
    probe.data.interrupted = true;
    probe.data.output = { UI: "not a string partial result" };
    expect(hash()).toBe(notInterrupted);
    expect(probe.stats().bytesVisited).toBe(0);
});

test("excluded OpenCode text and reasoning sentinels never visit UI state metadata", () => {
    for (const opencode2 of [false, true]) {
        const probe = metadataProbe();
        const state = {
            get metadata() {
                return probe.read();
            },
        };
        const messages = [
            {
                info: { id: `sentinel-owner-${opencode2}`, role: "assistant" },
                parts: [
                    { type: "text", text: "[dropped]", state },
                    { type: "reasoning", text: "excluded", state },
                    { type: "text", text: "sibling" },
                ],
            },
            {
                info: { id: `sentinel-newest-${opencode2}`, role: "user" },
                parts: [{ type: "text", text: "next" }],
            },
        ];
        const input = {
            messages,
            tags: [],
            protectedTagNumbers: new Set<number>(),
            cacheBusting: true,
            now: 1,
            opencode2,
        };
        const previous = refreshTailHygieneBaseline(input);
        expect(probe.stats()).toEqual({ bytesVisited: 0, reads: 0 });
        probe.data.diagnostics = "y".repeat(18 * 1024 * 1024);
        messages[0].parts[2].text = "different sibling";
        const next = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
        expect(next.baselineParts.slice(0, 2)).toEqual(previous.baselineParts.slice(0, 2));
        expect(probe.stats()).toEqual({ bytesVisited: 0, reads: 0 });
    }
});

test("tail-only metadata filtering leaves the existing replay representation unchanged", () => {
    const part = {
        type: "tool",
        state: {
            status: "error",
            input: {},
            error: "failed",
            metadata: { interrupted: false, output: { UI: "not forwarded" } },
            time: { compacted: 0 },
        },
    };
    expect(providerVisiblePart(part)).toBe(part);
    expect(providerVisiblePartForTailHygiene(part)).toEqual({
        type: "tool",
        state: {
            status: "error",
            input: {},
            error: "failed",
            time: { compacted: 0 },
        },
    });
});
