import { describe, expect, test } from "bun:test";

import { failedInvocationStatus } from "./subagent-token-capture";

describe("failedInvocationStatus", () => {
    test("our own slice expiry is timed_out", () => {
        expect(failedInvocationStatus(new Error("prompt timed out after 240000ms"))).toBe(
            "timed_out",
        );
    });

    test("a host request timer (Bun fetch TimeoutError) is timed_out", () => {
        // Bun rejects a fetch whose default timer fired with this DOMException.
        const error = new DOMException("The operation timed out.", "TimeoutError");
        expect(failedInvocationStatus(error)).toBe("timed_out");
    });

    test("an ordinary provider failure stays failed", () => {
        expect(failedInvocationStatus(new Error("upstream 502"))).toBe("failed");
    });
});
