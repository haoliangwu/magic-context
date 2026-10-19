import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CTX_REDUCE_DESCRIPTION, formatCtxReduceReply } from "./constants";

interface ReplyCase {
    label: string;
    stamped: number;
    self_stamps: number;
    expected: string;
}

describe("ctx-reduce constants", () => {
    //#given
    describe("CTX_REDUCE_DESCRIPTION", () => {
        //#then
        it("should be non-empty", () => {
            expect(CTX_REDUCE_DESCRIPTION.length).toBeGreaterThan(0);
        });

        it("frames reduction as deferred discard, not immediate delete", () => {
            // The contract distinguishes stamping from deletion, explains deferred
            // clearing, and limits stamps to items no longer needed for upcoming work.
            expect(CTX_REDUCE_DESCRIPTION).toContain("stamping QUEUES it");
            expect(CTX_REDUCE_DESCRIPTION).toContain("Not a delete");
            expect(CTX_REDUCE_DESCRIPTION).toContain("no longer needed for the work ahead");
            // No scarcity/rm framing that makes models over-conservative.
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("gone forever");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("Remove entirely");
        });
    });

    it("matches the shared cross-runtime ctx_reduce reply cases", () => {
        const cases = JSON.parse(
            readFileSync(new URL("./reply-cases.json", import.meta.url), "utf8"),
        ) as ReplyCase[];
        for (const replyCase of cases) {
            expect(
                formatCtxReduceReply(replyCase.stamped, replyCase.self_stamps),
                replyCase.label,
            ).toBe(replyCase.expected);
        }
    });
});
