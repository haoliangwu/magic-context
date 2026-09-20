/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePluginConfig, resetProtectedTagsDeprecationWarningForTest } from "./index";
import { constrainProjectThresholdOverrides } from "./project-security";
import { deriveDefaultProtectedTokens, MagicContextConfigSchema } from "./schema/magic-context";

describe("protected_tokens config and derivation", () => {
    describe("derived-default table asserted by value", () => {
        it("asserts 100k -> 8,000", () => {
            expect(deriveDefaultProtectedTokens(100_000)).toBe(8_000);
        });

        it("asserts 200k -> 16,000", () => {
            expect(deriveDefaultProtectedTokens(200_000)).toBe(16_000);
        });

        it("asserts 372k -> 18,600", () => {
            expect(deriveDefaultProtectedTokens(372_000)).toBe(18_600);
        });

        it("asserts 872k -> 43,600", () => {
            expect(deriveDefaultProtectedTokens(872_000)).toBe(43_600);
        });

        it("asserts 1M -> 50,000", () => {
            expect(deriveDefaultProtectedTokens(1_000_000)).toBe(50_000);
        });
    });

    describe("override range enforced at both ends", () => {
        it("accepts values within 4_000 .. 1_000_000", () => {
            expect(
                MagicContextConfigSchema.parse({ protected_tokens: 4_000 }).protected_tokens,
            ).toBe(4_000);
            expect(
                MagicContextConfigSchema.parse({ protected_tokens: 30_000 }).protected_tokens,
            ).toBe(30_000);
            expect(
                MagicContextConfigSchema.parse({ protected_tokens: 1_000_000 }).protected_tokens,
            ).toBe(1_000_000);
        });

        it("rejects values below 4_000", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tokens: 3_999 })).toThrow();
            expect(() => MagicContextConfigSchema.parse({ protected_tokens: 0 })).toThrow();
            expect(() => MagicContextConfigSchema.parse({ protected_tokens: -100 })).toThrow();
        });

        it("rejects values above 1_000_000", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tokens: 1_000_001 })).toThrow();
        });
    });

    describe("config-form parity tests against pinned Ruling 5 shape", () => {
        // Shared expectation: any non-positive-integer shape is an invalid leaf
        // (warning emitted, fall back to derived floor, plugin remains enabled).
        it("(a) object form without default is an invalid leaf and falls back to derived", () => {
            const raw = { protected_tokens: { "anthropic/claude-3-5-sonnet": 30_000 } };
            const parsed = MagicContextConfigSchema.safeParse(raw);
            expect(parsed.success).toBe(false);

            const recovered = parsePluginConfig(raw);
            expect(recovered.protected_tokens).toBeUndefined();
            expect(
                recovered.configWarnings?.some((w) =>
                    w.includes('"protected_tokens": invalid value'),
                ),
            ).toBe(true);
            const resolvedFloor =
                recovered.protected_tokens ?? deriveDefaultProtectedTokens(200_000);
            expect(resolvedFloor).toBe(16_000);
        });

        it("(b) unmatched model key in object form is an invalid leaf and falls back to derived", () => {
            const raw = { protected_tokens: { unmatched_model: 25_000 } };
            const parsed = MagicContextConfigSchema.safeParse(raw);
            expect(parsed.success).toBe(false);

            const recovered = parsePluginConfig(raw);
            expect(recovered.protected_tokens).toBeUndefined();
            expect(
                recovered.configWarnings?.some((w) =>
                    w.includes('"protected_tokens": invalid value'),
                ),
            ).toBe(true);
            const resolvedFloor =
                recovered.protected_tokens ?? deriveDefaultProtectedTokens(200_000);
            expect(resolvedFloor).toBe(16_000);
        });

        it("(c) fractional override is an invalid leaf and falls back to derived", () => {
            const raw = { protected_tokens: 16000.5 };
            const parsed = MagicContextConfigSchema.safeParse(raw);
            expect(parsed.success).toBe(false);

            const recovered = parsePluginConfig(raw);
            expect(recovered.protected_tokens).toBeUndefined();
            expect(
                recovered.configWarnings?.some((w) =>
                    w.includes('"protected_tokens": invalid value'),
                ),
            ).toBe(true);
            const resolvedFloor =
                recovered.protected_tokens ?? deriveDefaultProtectedTokens(200_000);
            expect(resolvedFloor).toBe(16_000);
        });
    });

    describe("precedence: project (raise-only, only if >= resolved user value) > user > derived", () => {
        it("project raises user value when >= resolved user value", () => {
            const mergedRaw: Record<string, unknown> = { protected_tokens: 20_000 };
            const projectRaw = { protected_tokens: 30_000 };
            const warnings = constrainProjectThresholdOverrides({
                mergedRaw,
                projectRaw,
                trustedBaseConfig: { protected_tokens: 20_000 },
            });
            expect(mergedRaw.protected_tokens).toBe(30_000);
            expect(warnings).toHaveLength(0);
        });

        it("project lower than user value is rejected with warning and user value stands", () => {
            const mergedRaw: Record<string, unknown> = { protected_tokens: 25_000 };
            const projectRaw = { protected_tokens: 10_000 };
            const warnings = constrainProjectThresholdOverrides({
                mergedRaw,
                projectRaw,
                trustedBaseConfig: { protected_tokens: 25_000 },
            });
            expect(mergedRaw.protected_tokens).toBe(25_000);
            expect(warnings.some((w) => w.includes("protected_tokens"))).toBe(true);
        });

        it("rejects a project object and preserves the trusted user scalar", () => {
            const mergedRaw: Record<string, unknown> = {
                protected_tokens: { default: 35_000 },
            };
            const projectRaw = { protected_tokens: { default: 35_000 } };
            const warnings = constrainProjectThresholdOverrides({
                mergedRaw,
                projectRaw,
                trustedBaseConfig: { protected_tokens: 20_000 },
            });
            expect(mergedRaw.protected_tokens).toBe(20_000);
            expect(warnings.some((w) => w.includes("protected_tokens"))).toBe(true);
        });

        it("rejects a project object and falls back to derivation when the user omitted the setting", () => {
            const mergedRaw: Record<string, unknown> = {
                protected_tokens: { default: 35_000 },
            };
            const projectRaw = { protected_tokens: { default: 35_000 } };
            const warnings = constrainProjectThresholdOverrides({
                mergedRaw,
                projectRaw,
                trustedBaseConfig: {},
            });
            expect(mergedRaw.protected_tokens).toBeUndefined();
            expect(warnings.some((w) => w.includes("protected_tokens"))).toBe(true);
        });

        it("project override applies when user tier is omitted", () => {
            const mergedRaw: Record<string, unknown> = {};
            const projectRaw = { protected_tokens: 32_000 };
            const warnings = constrainProjectThresholdOverrides({
                mergedRaw,
                projectRaw,
                trustedBaseConfig: {},
            });
            expect(mergedRaw.protected_tokens).toBe(32_000);
            expect(warnings).toHaveLength(0);
        });
    });

    describe("root configuration reference", () => {
        const reference = readFileSync(
            resolve(import.meta.dir, "../../../../CONFIGURATION.md"),
            "utf8",
        );

        it("documents protected_tokens as live and protected_tags only as deprecated and ignored", () => {
            expect(reference).toContain("| `protected_tokens` |");
            expect(reference).not.toContain("| `protected_tags` |");
            expect(reference).toContain("`protected_tags` is deprecated and ignored");
        });
    });

    describe("protected_tokens below-minimum warning", () => {
        it("emits the specific token-floor warning for a numeric value below the schema minimum", () => {
            const recovered = parsePluginConfig({ protected_tokens: 20 });
            const warnings = recovered.configWarnings ?? [];
            expect(warnings.some((w) => w.includes("protected_tokens is a token floor"))).toBe(
                true,
            );
            expect(warnings.some((w) => w.includes('"protected_tokens": invalid value'))).toBe(
                false,
            );
        });

        it("keeps the generic type message for a string value", () => {
            const recovered = parsePluginConfig({ protected_tokens: "20" });
            const warnings = recovered.configWarnings ?? [];
            expect(warnings.some((w) => w.includes('"protected_tokens": invalid value'))).toBe(
                true,
            );
            expect(warnings.some((w) => w.includes("protected_tokens is a token floor"))).toBe(
                false,
            );
        });

        it("keeps the generic above-max message for a value above the maximum", () => {
            const recovered = parsePluginConfig({ protected_tokens: 2_000_000 });
            const warnings = recovered.configWarnings ?? [];
            expect(warnings.some((w) => w.includes('"protected_tokens": invalid value'))).toBe(
                true,
            );
            expect(warnings.some((w) => w.includes("protected_tokens is a token floor"))).toBe(
                false,
            );
        });

        it("emits no warning when the key is absent", () => {
            const recovered = parsePluginConfig({});
            expect(recovered.configWarnings ?? []).toEqual([]);
        });
    });

    describe("protected_tags deprecation", () => {
        it("is parsed at any value (including 0 and 101) with parse succeeding and no numeric conversion", () => {
            resetProtectedTagsDeprecationWarningForTest();
            const config0 = MagicContextConfigSchema.parse({ protected_tags: 0 });
            expect(config0.protected_tags).toBe(0);

            const config101 = MagicContextConfigSchema.parse({ protected_tags: 101 });
            expect(config101.protected_tags).toBe(101);

            const configArbitrary = MagicContextConfigSchema.parse({
                protected_tags: "legacy-string",
            });
            expect(configArbitrary.protected_tags).toBe("legacy-string");

            // Verify no numeric conversion happened
            expect(typeof configArbitrary.protected_tags).toBe("string");
        });

        it("emits a once-per-process loud deprecation warning naming the replacement", () => {
            resetProtectedTagsDeprecationWarningForTest();
            const warnCalls: string[] = [];
            const originalWarn = console.warn;
            console.warn = (...args: unknown[]) => warnCalls.push(args.map(String).join(" "));

            try {
                const res1 = parsePluginConfig({ protected_tags: 20 });
                expect(
                    res1.configWarnings?.some((w) =>
                        w.includes(
                            "protected_tags is deprecated and ignored; use protected_tokens instead.",
                        ),
                    ),
                ).toBe(true);
                expect(warnCalls).toHaveLength(1);
                expect(warnCalls[0]).toContain("protected_tokens");

                // Second parse in same process must NOT log to console again
                parsePluginConfig({ protected_tags: 10 });
                expect(warnCalls).toHaveLength(1);
            } finally {
                console.warn = originalWarn;
            }
        });
    });
});
