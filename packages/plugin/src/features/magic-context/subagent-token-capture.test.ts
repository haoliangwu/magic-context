import { describe, expect, test } from "bun:test";

import type { Database } from "../../shared/sqlite";
import { failedInvocationStatus, recordChildInvocation } from "./subagent-token-capture";

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

describe("recordChildInvocation model identity", () => {
    test("fills an omitted provider from the same run's assistant message", () => {
        const inserts: unknown[][] = [];
        const db = {
            prepare: () => ({
                run: (...parameters: unknown[]) => {
                    inserts.push(parameters);
                    return { lastInsertRowid: 7 };
                },
            }),
        } as unknown as Database;

        recordChildInvocation({
            db,
            parentSessionId: "fixture-session",
            harness: "pi",
            subagent: "historian",
            startedAt: 1,
            endedAt: 2,
            status: "completed",
            modelId: "gpt-6.1-sol",
            messages: [
                {
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-6.1-sol",
                    usage: { input: 40, output: 5 },
                },
            ],
        });

        expect(inserts[0]?.[4]).toBe("openai");
        expect(inserts[0]?.[5]).toBe("gpt-6.1-sol");
    });
});
