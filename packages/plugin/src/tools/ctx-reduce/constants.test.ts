import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_DESCRIPTION } from "./constants";

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
});
