import { describe, expect, test } from "bun:test";

import { modelBodyField, parseProviderModel, resolveFallbackChain } from "./resolve-fallbacks";

describe("resolveFallbackChain", () => {
    // Policy: user-config-only. There is NO builtin provider-agnostic chain —
    // when the user configures no fallback_models the result is empty.
    // A hardcoded chain named providers the user may not have and
    // produced `Model not found` retry storms.
    test("returns empty when user provides nothing (no builtin chain)", () => {
        expect(resolveFallbackChain(undefined)).toEqual([]);
    });

    test("returns empty for empty string", () => {
        expect(resolveFallbackChain("")).toEqual([]);
    });

    test("returns empty for empty array", () => {
        expect(resolveFallbackChain([])).toEqual([]);
    });

    test("user-only when user provides valid fallback_models string", () => {
        expect(resolveFallbackChain("anthropic/claude-sonnet-4-6")).toEqual([
            "anthropic/claude-sonnet-4-6",
        ]);
    });

    test("user-only when user provides valid fallback_models array", () => {
        expect(
            resolveFallbackChain(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]),
        ).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]);
    });

    test("dedupes user-provided list", () => {
        expect(
            resolveFallbackChain([
                "anthropic/claude-sonnet-4-6",
                "anthropic/claude-sonnet-4-6",
                "google/gemini-3-flash",
            ]),
        ).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]);
    });

    test("strips invalid 'provider/model' entries", () => {
        expect(
            resolveFallbackChain([
                "anthropic/claude-sonnet-4-6",
                "no-slash-here",
                "/leading-slash",
                "trailing-slash/",
                "",
                "  ",
            ]),
        ).toEqual(["anthropic/claude-sonnet-4-6"]);
    });

    test("trims whitespace in user entries", () => {
        expect(
            resolveFallbackChain(["  anthropic/claude-sonnet-4-6  ", "\tgoogle/gemini-3-flash\n"]),
        ).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]);
    });
});

describe("modelBodyField", () => {
    test("sends the active entry variant and leaves a bare entry unqualified", () => {
        expect(modelBodyField({ model: "anthropic/claude-sonnet", qualifier: "high" })).toEqual({
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
            variant: "high",
        });
        expect(modelBodyField("google/gemini-flash")).toEqual({
            model: { providerID: "google", modelID: "gemini-flash" },
        });
    });
});

describe("parseProviderModel", () => {
    test("parses standard provider/model", () => {
        expect(parseProviderModel("anthropic/claude-sonnet-4-6")).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("handles model id with slashes (only splits on first slash)", () => {
        expect(parseProviderModel("lemonade/GLM-4.7-Flash-GGUF/main")).toEqual({
            providerID: "lemonade",
            modelID: "GLM-4.7-Flash-GGUF/main",
        });
    });

    test("trims whitespace", () => {
        expect(parseProviderModel("  anthropic/claude-sonnet-4-6  ")).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("returns null for no slash", () => {
        expect(parseProviderModel("anthropic")).toBeNull();
    });

    test("returns null for leading slash", () => {
        expect(parseProviderModel("/claude-sonnet-4-6")).toBeNull();
    });

    test("returns null for trailing slash", () => {
        expect(parseProviderModel("anthropic/")).toBeNull();
    });

    test("returns null for empty string", () => {
        expect(parseProviderModel("")).toBeNull();
    });
});
