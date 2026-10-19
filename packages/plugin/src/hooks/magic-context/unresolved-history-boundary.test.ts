import { expect, test } from "bun:test";
import { UnresolvedHistoryBoundaryError } from "./unresolved-history-boundary";

test("MC-H04 distinguishes a missing row from a present out-of-order boundary and explains directory recovery", () => {
    const missing = new UnresolvedHistoryBoundaryError(188048, 187500, false).message;
    const present = new UnresolvedHistoryBoundaryError(188048, 187500, true).message;
    expect(missing).toContain("boundary row is missing from the host store");
    expect(present).toContain("boundary row is present in the host store but out of order");
    expect(present).not.toContain("is missing");
    for (const message of [missing, present]) {
        expect(message).toContain("current project directory");
        expect(message).toContain("/ctx-recomp");
        expect(message).toContain("not sent");
        expect(message).toContain("MC-H04");
    }
});
