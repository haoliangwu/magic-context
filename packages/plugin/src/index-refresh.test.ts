import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHiddenAgentConfig } from "./agents/hidden-agent-registrations";

describe("plugin model-limit cache warmup", () => {
    test("warms model limits once at startup and does not schedule periodic refresh", () => {
        const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
        const refreshCalls = source.match(/refreshModelLimitsFromApi\(/g) ?? [];

        expect(refreshCalls).toHaveLength(1); // one startup call, no timer callback
        expect(source).not.toContain("setInterval(");
        expect(source).toContain("Do NOT refresh periodically");
    });
});

describe("historian timer fallback budget", () => {
    test("uses the resolved OpenCode fallback chain length", () => {
        const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

        expect(source).toMatch(
            /fallbackModelCount:\s*resolveHistorianModel\(\s*historian,\s*"opencode",?\s*\)\.fallbacks\s*\.length,/,
        );
        expect(source).toMatch(
            /historianRunConfig\(\s*pluginConfig,\s*liveConfigReader\.poll\(\)\.effective,?\s*\)/,
        );
        expect(source).not.toContain("pluginConfig.historian?.fallback_models");
    });
});

describe("buildHiddenAgentConfig", () => {
    test("clamps maxSteps overrides above the hard cap", () => {
        const config = buildHiddenAgentConfig("prompt", ["read"], 40, { maxSteps: 100_000 });

        expect(config.maxSteps).toBe(40);
        expect(config.steps).toBe(40);
    });

    test("honors maxSteps/steps overrides below the hard cap", () => {
        const config = buildHiddenAgentConfig("prompt", ["read"], 40, {
            maxSteps: 12,
            steps: 10,
        });

        expect(config.maxSteps).toBe(12);
        expect(config.steps).toBe(10);
    });

    test("lockPermissions drops a user prompt/system override (privacy-hardened prompt wins)", () => {
        const config = buildHiddenAgentConfig(
            "HARDENED PROMPT",
            ["ctx_search"],
            40,
            { prompt: "evil override", system: "evil system" },
            "dreamer-retrospective",
            true,
        );
        expect(config.prompt).toBe("HARDENED PROMPT");
        expect((config as Record<string, unknown>).system).toBeUndefined();
    });

    test("unlocked agents keep a user prompt/system override", () => {
        const config = buildHiddenAgentConfig(
            "base prompt",
            ["read"],
            40,
            { prompt: "user prompt", system: "user system" },
            "dreamer-docs",
            false,
        );
        expect(config.prompt).toBe("user prompt");
        expect((config as Record<string, unknown>).system).toBe("user system");
    });
});
