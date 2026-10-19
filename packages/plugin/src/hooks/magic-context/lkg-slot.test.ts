/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
    beginLkgPass,
    captureSlot,
    getInMemorySlot,
    getSlot,
    incrementalLkgContentDigests,
    type LkgDigestEntry,
    type LkgSlot,
    lkgContentDigest,
    lkgContentDigestFromFields,
    lkgContentFields,
    lkgSlotRejection,
    memoizedLkgContentDigestFromFields,
    noteEntry,
    registerLkgPersistence,
    resetLkgSlotsForTest,
} from "./lkg-slot";

function entry(id: string, text: string): LkgDigestEntry {
    const fields = lkgContentFields({ id, text });
    if (!fields) throw new Error("failed to flatten fixture");
    return { id, signature: `sig:${id}:${text}`, fields };
}

describe("LKG durable hydration pass", () => {
    it("coalesces a miss until the next pass and then observes the durable slot", () => {
        resetLkgSlotsForTest();
        const messages = [
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "same" }] },
        ];
        const durable: LkgSlot = {
            jsonPrefix: JSON.stringify(messages),
            inputIdSeq: ["m1"],
            inputContentDigests: ["digest-m1"],
            lastInputMessageId: "m1",
            modelKey: "test/model",
            providerKey: "test",
            capturedAt: 1,
        };
        let available: LkgSlot | undefined;
        let loads = 0;
        registerLkgPersistence({
            load: () => {
                loads += 1;
                return available;
            },
            clear: () => {},
        });

        beginLkgPass("session");
        expect(getSlot("session")).toBeUndefined();
        available = durable;
        expect(getSlot("session")).toBeUndefined();
        expect(loads).toBe(1);

        beginLkgPass("session");
        const hydrated = getSlot("session");
        expect(loads).toBe(2);
        const digest = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
        expect(digest(JSON.parse(hydrated!.jsonPrefix))).toBe(digest(messages));
        registerLkgPersistence(undefined);
    });

    it("reads a successful capture directly from memory without durable hydration", () => {
        resetLkgSlotsForTest();
        let loads = 0;
        registerLkgPersistence({
            load: () => {
                loads += 1;
                return undefined;
            },
            clear: () => {},
        });
        beginLkgPass("captured");
        expect(
            captureSlot("captured", {
                jsonPrefix: "[]",
                inputIdSeq: ["m1"],
                inputContentDigests: ["digest-m1"],
                lastInputMessageId: "m1",
                modelKey: "test/model",
                providerKey: "test",
                capturedAt: 1,
            }),
        ).toBe(true);
        expect(getInMemorySlot("captured")?.lastInputMessageId).toBe("m1");
        expect(loads).toBe(0);
        registerLkgPersistence(undefined);
    });
});

describe("LKG slot size cap", () => {
    const slotWithPrefixChars = (chars: number): LkgSlot => ({
        jsonPrefix: `["${"x".repeat(chars)}"]`,
        inputIdSeq: ["m1"],
        inputContentDigests: ["digest-m1"],
        lastInputMessageId: "m1",
        modelKey: "test/model",
        providerKey: "test",
        capturedAt: 1,
    });

    it("keeps a snapshot of any request size a provider accepts (Anthropic allows 32 MB)", () => {
        resetLkgSlotsForTest();
        // A 32 MB request: the old cap refused anything over about 12 MB of JSON.
        const atLimit = slotWithPrefixChars(32 * 1000 * 1000);
        expect(lkgSlotRejection("big", atLimit)).toBeNull();
        expect(captureSlot("big", atLimit)).toBe(true);
    });

    it("still rejects a single slot beyond any provider's request limit", () => {
        resetLkgSlotsForTest();
        expect(lkgSlotRejection("huge", slotWithPrefixChars(40 * 1024 * 1024))).toMatch(
            /^slot_bytes=/,
        );
    });
});

describe("incremental LKG content digests", () => {
    it("shares exact digests but rehashes same-id metadata, type and nested content changes", () => {
        resetLkgSlotsForTest();
        const message = {
            info: { id: "same", role: "user" },
            parts: [{ type: "text", text: "wire", metadata: { counter: 1 as number | string } }],
        };
        const initial = lkgContentFields(message)!;
        const expected = lkgContentDigest(message);
        expect(memoizedLkgContentDigestFromFields("same", initial)).toBe(expected);
        // A fresh tree, not reference identity, must prove the cached digest safe.
        expect(
            memoizedLkgContentDigestFromFields("same", lkgContentFields(structuredClone(message))!),
        ).toBe(expected);
        for (const counter of [2, "2", 1]) {
            message.parts[0]!.metadata.counter = counter;
            const fields = lkgContentFields(message)!;
            expect(memoizedLkgContentDigestFromFields("same", fields)).toBe(
                lkgContentDigest(message),
            );
        }
        captureSlot("entry", {
            jsonPrefix: "[]",
            inputIdSeq: ["same"],
            inputContentDigests: [expected!],
            lastInputMessageId: "same",
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        });
        expect(noteEntry("entry", [message])?.entryContentDigests).toEqual([
            lkgContentDigest(message)!,
        ]);
        message.parts[0]!.text = "changed after note";
        expect(noteEntry("entry", [message])?.entryContentDigests).toEqual([
            lkgContentDigest(message)!,
        ]);
    });
    it("matches a full recompute and reuses an unchanged prefix", () => {
        const prefix = [entry("m1", "one"), entry("m2", "two"), entry("m3", "three")];
        const tail = [entry("m4", "four"), entry("m5", "five")];
        const original = [...prefix, ...tail];
        const fullOriginal = original.map((item) => lkgContentDigestFromFields(item.fields));

        const first = incrementalLkgContentDigests(original);
        expect(first.reusedPrefix).toBe(0);
        expect(first.digests).toEqual(fullOriginal);

        const unchanged = incrementalLkgContentDigests(original, {
            ids: original.map((item) => item.id),
            signatures: original.map((item) => item.signature),
            digests: first.digests,
        });
        expect(unchanged.reusedPrefix).toBe(original.length);
        expect(unchanged.digests).toEqual(fullOriginal);

        const mutated = [...prefix, entry("m4", "FOUR-CHANGED"), tail[1]!];
        const fullMutated = mutated.map((item) => lkgContentDigestFromFields(item.fields));
        const incremental = incrementalLkgContentDigests(mutated, {
            ids: original.map((item) => item.id),
            signatures: original.map((item) => item.signature),
            digests: first.digests,
        });
        expect(incremental.reusedPrefix).toBe(prefix.length);
        expect(incremental.digests).toEqual(fullMutated);
        expect(incremental.digests.slice(0, prefix.length)).toEqual(
            fullOriginal.slice(0, prefix.length),
        );
        expect(incremental.digests[prefix.length]).not.toBe(fullOriginal[prefix.length]);
    });
});
