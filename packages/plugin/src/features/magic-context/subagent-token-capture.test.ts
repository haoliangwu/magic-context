import { describe, expect, test } from "bun:test";

import type { Database } from "../../shared/sqlite";
import {
    failedInvocationStatus,
    MAX_SUBAGENT_INVOCATION_ERROR_CHARS,
    recordChildInvocation,
} from "./subagent-token-capture";

test("records the attempted model before a child times out without an assistant message", () => {
    const inserts: unknown[][] = [];
    const db = {
        prepare: () => ({
            run: (...parameters: unknown[]) => {
                inserts.push(parameters);
                return { lastInsertRowid: 6 };
            },
        }),
    } as unknown as Database;

    recordChildInvocation({
        db,
        parentSessionId: "fixture-timeout-model",
        harness: "opencode",
        subagent: "historian",
        startedAt: 1,
        endedAt: 2,
        status: "timed_out",
        attemptedModel: "provider/model-timed-out",
        error: new Error("prompt timed out after 600000ms"),
    });

    expect(inserts[0]?.[4]).toBe("provider");
    expect(inserts[0]?.[5]).toBe("model-timed-out");
    expect(inserts[0]?.[13]).toContain("prompt timed out after 600000ms");
});

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

    test("records the attempted model and sanitized host refusal without assistant messages", () => {
        const inserts: unknown[][] = [];
        const db = {
            prepare: () => ({
                run: (...parameters: unknown[]) => {
                    inserts.push(parameters);
                    return { lastInsertRowid: 8 };
                },
            }),
        } as unknown as Database;
        const model = "provider/model-missing";
        const suggestion = "provider/model-available";

        recordChildInvocation({
            db,
            parentSessionId: "fixture-model-refusal",
            harness: "opencode",
            subagent: "historian",
            startedAt: 1,
            endedAt: 2,
            status: "empty",
            providerId: "provider",
            modelId: "model-missing",
            attemptedModel: { model, sourceConfigKey: "historian.opencode.model" },
            error: "Historian returned no assistant output.",
            hostError: {
                name: "ProviderModelNotFoundError",
                data: {
                    message: `Model not found: ${model}. Did you mean: ${suggestion}?`,
                    prompt: "PRIVATE_PROMPT_SENTINEL",
                    api_key: "sk-secret",
                },
            },
        });

        expect(inserts[0]?.[4]).toBe("provider");
        expect(inserts[0]?.[5]).toBe("model-missing");
        expect(inserts[0]?.[13]).toBe(
            `No reply: OpenCode refused the model: Model not found: ${model} (did you mean ${suggestion}?)`,
        );
        expect(inserts[0]?.[13]).not.toContain("PRIVATE_PROMPT_SENTINEL");
        expect(inserts[0]?.[13]).not.toContain("sk-secret");
    });

    test("prefers the model reported by the assistant when the host reroutes", () => {
        const inserts: unknown[][] = [];
        const db = {
            prepare: () => ({
                run: (...parameters: unknown[]) => {
                    inserts.push(parameters);
                    return { lastInsertRowid: 9 };
                },
            }),
        } as unknown as Database;

        recordChildInvocation({
            db,
            parentSessionId: "fixture-rerouted-model",
            harness: "opencode2",
            subagent: "historian",
            startedAt: 1,
            endedAt: 2,
            status: "completed",
            attemptedModel: {
                model: "configured/requested",
                sourceConfigKey: "historian.opencode.model",
            },
            messages: [
                {
                    role: "assistant",
                    providerID: "host-provider",
                    modelID: "host-selected-model",
                },
            ],
        });

        expect(inserts[0]?.[4]).toBe("host-provider");
        expect(inserts[0]?.[5]).toBe("host-selected-model");
    });

    test("redacts credentials and home paths, flattens lines, and caps host errors", () => {
        const inserts: unknown[][] = [];
        const db = {
            prepare: () => ({
                run: (...parameters: unknown[]) => {
                    inserts.push(parameters);
                    return { lastInsertRowid: 11 };
                },
            }),
        } as unknown as Database;
        const bearer = "bearer-secret-value-123456";
        const apiKey = "api-key-secret-value-123456";
        const hostMessage =
            `Authorization: Bearer ${bearer}; api_key=${apiKey}; ` +
            "/Users/alice/private/project/file\n" +
            "diagnostic ".repeat(200);

        recordChildInvocation({
            db,
            parentSessionId: "fixture-redacted-host-error",
            harness: "opencode",
            subagent: "historian",
            startedAt: 1,
            endedAt: 2,
            status: "failed",
            attemptedModel: "provider/model",
            error: new Error("provider failed"),
            hostError: { name: "APIError", data: { message: hostMessage } },
        });

        const error = String(inserts[0]?.[13]);
        expect(error).toContain("Authorization: Bearer <REDACTED:bearer>");
        expect(error).toContain("api_key=<REDACTED:");
        expect(error).toContain("/Users/<USER>/private/project/file");
        expect(error).not.toContain(bearer);
        expect(error).not.toContain(apiKey);
        expect(error).not.toMatch(/[\r\n]/);
        expect(error.length).toBeLessThanOrEqual(MAX_SUBAGENT_INVOCATION_ERROR_CHARS);
    });

    test("retains the no-output fallback text when there is no host error", () => {
        const inserts: unknown[][] = [];
        const db = {
            prepare: () => ({
                run: (...parameters: unknown[]) => {
                    inserts.push(parameters);
                    return { lastInsertRowid: 10 };
                },
            }),
        } as unknown as Database;

        recordChildInvocation({
            db,
            parentSessionId: "fixture-empty-fallback",
            harness: "opencode",
            subagent: "historian",
            startedAt: 1,
            endedAt: 2,
            status: "empty",
            attemptedModel: "provider/model",
            error: "Historian returned no assistant output.",
        });

        expect(inserts[0]?.[13]).toBe("Historian returned no assistant output.");
    });
});
