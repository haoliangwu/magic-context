/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import type { RawMessage } from "./read-session-raw";
import {
    buildTrueRawTokenIndex,
    invalidateTrueRawTokenCache,
} from "./read-session-true-raw-tokens";

describe("true raw token indexes with continued ordinals", () => {
    it("maps token queries relative to the first absolute ordinal", () => {
        const messages: RawMessage[] = [
            { id: "summary", role: "user", parts: [], ordinal: 101 },
            { id: "tail", role: "assistant", parts: [], ordinal: 102 },
        ];
        const totals = new Map([
            ["summary", 10],
            ["tail", 20],
        ]);
        const index = buildTrueRawTokenIndex("continued", messages, {
            providerShapeVersion: "opencode-v1",
            cacheNamespace: "continued-test",
            absoluteMessageCount: 102,
            storedTotalForMessage: (message) => totals.get(message.id) ?? null,
        });

        expect(index.rawMessageCount).toBe(102);
        expect(index.tokenForOrdinal(1)).toBe(0);
        expect(index.tokenForOrdinal(101)).toBe(10);
        expect(index.tokenForOrdinal(102)).toBe(20);
        expect(index.messageIdAtOrdinal(101)).toBe("summary");
        expect(index.suffixTokensFromOrdinal(101)).toBe(30);
        expect(index.rangeTokens(101, 103)).toBe(30);
        expect(index.findSuffixStartForTokens(20)).toBe(102);
        expect(index.findHeadEndForCap(101, 103, 10)).toBe(102);
    });
});

describe("true raw token cache invalidation", () => {
    it("invalidates all revisions of an exact id only in matching session namespaces", () => {
        invalidateTrueRawTokenCache({ reason: "schema.migration" });
        let calls = 0;
        const read = (namespace: string, id: string, version = 1) =>
            buildTrueRawTokenIndex(
                namespace,
                [
                    {
                        id,
                        ordinal: 1,
                        role: "user",
                        parts: [{ type: "image", url: "data:image/png;base64,x", version }],
                    },
                ],
                {
                    providerShapeVersion: "opencode-v1",
                    cacheNamespace: namespace,
                    imageTokenHeuristic: () => ++calls,
                },
            ).tokenForOrdinal(1);
        const first = read("session-A", "same");
        const revision = read("session-A", "same", 2);
        const otherSession = read("session-B", "same");
        const prefix = read("session-A", "same-longer");
        invalidateTrueRawTokenCache({
            sessionId: "session-A",
            messageId: "same",
            reason: "message.updated",
        });
        expect(read("session-A", "same")).toBeGreaterThan(first);
        expect(read("session-A", "same", 2)).toBeGreaterThan(revision);
        expect(read("session-B", "same")).toBe(otherSession);
        expect(read("session-A", "same-longer")).toBe(prefix);
        invalidateTrueRawTokenCache({ sessionId: "session-", reason: "session.deleted" });
        expect(read("session-B", "same")).toBeGreaterThan(otherSession);
        invalidateTrueRawTokenCache({ reason: "schema.migration" });
    });

    it("preserves delimiter-containing id and non-id field invalidation semantics", () => {
        invalidateTrueRawTokenCache({ reason: "schema.migration" });
        let calls = 0;
        const read = (id: string) =>
            buildTrueRawTokenIndex(
                "namespace",
                [{ id, role: "user", ordinal: 1, parts: [{ type: "image" }] }],
                {
                    cacheNamespace: "namespace",
                    providerShapeVersion: "opencode-v1",
                    imageTokenHeuristic: () => ++calls,
                },
            ).tokenForOrdinal(1);
        const delimited = read("a\0b");
        invalidateTrueRawTokenCache({ messageId: "a\0b", reason: "message.removed" });
        expect(read("a\0b")).toBeGreaterThan(delimited);
        const ordinary = read("ordinary");
        invalidateTrueRawTokenCache({ messageId: "opencode-v1", reason: "message.removed" });
        expect(read("ordinary")).toBeGreaterThan(ordinary);
        invalidateTrueRawTokenCache({ reason: "schema.migration" });
    });
});
