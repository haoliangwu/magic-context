import { describe, expect, it } from "bun:test";
import { MagicContextConfigSchema } from "../config/schema/magic-context";
import { resolveCacheTtl } from "../hooks/magic-context/event-resolvers";

describe("known model cache TTL", () => {
    it("matches canonical model versions through provider prefixes", () => {
        for (const prefix of ["", "openai/", "openai-codex/", "openrouter/openai/", "azure/"]) {
            for (const model of [
                "gpt-5.6",
                "gpt-5.6-sol",
                "gpt-5.7",
                "gpt-5.10",
                "gpt-6",
                "gpt-6.1",
                "gpt-6-mini",
                "gpt-7",
            ]) {
                expect(resolveCacheTtl("5m", prefix + model), prefix + model).toBe("30m");
            }
            for (const model of ["gpt-5.5", "gpt-5.1", "gpt-5", "gpt-4o", "unknown", "not-gpt-6"]) {
                expect(resolveCacheTtl("5m", prefix + model), prefix + model).toBe("5m");
            }
        }
    });
    it("uses built-ins for unset and global 5m, but honors global 10m", () => {
        expect(resolveCacheTtl(MagicContextConfigSchema.parse({}).cache_ttl, "openai/gpt-6")).toBe(
            "30m",
        );
        expect(resolveCacheTtl("5m", "openai/gpt-6")).toBe("30m");
        expect(resolveCacheTtl("10m", "openai/gpt-6")).toBe("10m");
    });
    it("honors per-model entries before built-ins and built-ins before object defaults", () => {
        expect(resolveCacheTtl({ default: "10m" }, "openai/gpt-6")).toBe("30m");
        expect(resolveCacheTtl({ default: "10m", "gpt-6": "5m" }, "openai/gpt-6")).toBe("5m");
        expect(resolveCacheTtl({ default: "10m", "openai/*": "never" }, "openai/gpt-6")).toBe(
            "never",
        );
        expect(resolveCacheTtl({ default: "10m" }, "other/model")).toBe("10m");
    });
});
