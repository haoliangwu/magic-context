import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
    CTX_REDUCE_DESCRIPTION,
    CTX_REDUCE_SELF_STAMP_MESSAGE_TEMPLATE,
    ctxReduceSelfStampMessage,
} from "./constants";

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

    it("matches the shared TypeScript/Rust self-stamp message golden", () => {
        const golden = readFileSync(
            new URL("./self-stamp-message.golden", import.meta.url),
            "utf8",
        ).trimEnd();
        expect(CTX_REDUCE_SELF_STAMP_MESSAGE_TEMPLATE).toBe(golden);
        expect(ctxReduceSelfStampMessage(17)).toBe(golden.replace("§N§", "§17§"));
    });
});
