import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createPromptSurfaceGuidanceEpochCache,
    createPromptSurfaceRuntime,
    LIGHT_TOOL_DESCRIPTIONS,
} from "./prompt-surface-runtime";

const tempDirs: string[] = [];

function tempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "prompt-surface-runtime-"));
    tempDirs.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of tempDirs) {
        rmSync(directory, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

describe("prompt-surface runtime", () => {
    it("rejects guidance overrides with zero or two section markers", () => {
        for (const [name, content, expectedCount] of [
            ["zero.md", "Custom guidance without a section marker", 0],
            ["two.md", "## Magic Context\n\nFirst\n\n## Magic Context\n\nSecond", 2],
        ] as const) {
            const directory = tempDir();
            writeFileSync(join(directory, name), content);
            const warnings: string[] = [];
            const runtime = createPromptSurfaceRuntime({
                userConfigDirectory: directory,
                warn: (warning) => warnings.push(warning),
            });

            const selection = runtime.resolveGuidance(
                { default: "full", guidance_override_path: name },
                "provider/model",
            );

            expect(selection.primaryOverride).toBeUndefined();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("must contain exactly one");
            expect(warnings[0]).toContain(`found ${expectedCount}`);
        }
    });

    it("captures a valid relative override once per model-key epoch", () => {
        const directory = tempDir();
        const path = join(directory, "guidance.md");
        const first = "## Magic Context\n\nFirst epoch";
        const second = "## Magic Context\n\nSecond epoch";
        writeFileSync(path, first);
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: directory,
            warn: () => undefined,
        });
        const epochs = createPromptSurfaceGuidanceEpochCache(runtime);
        const config = {
            default: "full" as const,
            models: { "provider/light": "light" as const },
            guidance_override_path: "guidance.md",
        };

        const initial = epochs.resolve("session", config, "provider/full");
        writeFileSync(path, second);
        const fiveDeferred = Array.from({ length: 5 }, () =>
            epochs.resolve("session", config, "provider/full"),
        );
        const changedModel = epochs.resolve("session", config, "provider/light");

        expect(initial.primaryOverride).toBe(first);
        expect(fiveDeferred.every((selection) => selection === initial)).toBe(true);
        expect(changedModel.preset).toBe("light");
        expect(changedModel.primaryOverride).toBe(second);
    });

    it("shares one frozen guidance epoch between the system hook and Rust adapter", () => {
        const directory = tempDir();
        const path = join(directory, "guidance.md");
        const first = "## Magic Context\n\nShared first epoch";
        const second = "## Magic Context\n\nShared second epoch";
        writeFileSync(path, first);
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: directory,
            warn: () => undefined,
        });
        const systemEpochs = createPromptSurfaceGuidanceEpochCache(runtime);
        const adapterEpochs = createPromptSurfaceGuidanceEpochCache(runtime);
        const config = {
            default: "full" as const,
            guidance_override_path: "guidance.md",
        };

        const systemInitial = systemEpochs.resolve("session", config, "provider/model");
        writeFileSync(path, second);
        const adapterDeferred = adapterEpochs.resolve("session", config, "provider/model");
        expect(adapterDeferred).toBe(systemInitial);
        expect(adapterDeferred.primaryOverride).toBe(first);

        adapterEpochs.clear("session");
        const systemNextEpoch = systemEpochs.resolve("session", config, "provider/model");
        expect(systemNextEpoch.primaryOverride).toBe(second);
    });

    it("uses registration default, applies known overrides, and reports invalid IDs", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: tempDir(),
            warn: (warning) => warnings.push(warning),
        });
        const registration = runtime.resolveRegistration({
            default: "full",
            models: { "provider/model": "light" },
            tool_descriptions: {
                ctx_search: "Custom search description",
                unknown_tool: "Not allowed",
            },
        });

        expect(registration.preset).toBe("full");
        expect(registration.descriptionFor("ctx_search", "Full search")).toBe(
            "Custom search description",
        );
        expect(registration.descriptionFor("ctx_reduce", "Full reduce")).toBe("Full reduce");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("unknown_tool");
    });

    it("lets a user description override the built-in light catalog", () => {
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: tempDir(),
            warn: () => undefined,
        });
        const registration = runtime.resolveRegistration({
            default: "light",
            tool_descriptions: { ctx_search: "User light search" },
        });

        expect(registration.descriptionFor("ctx_search", "Full search")).toBe("User light search");
        expect(registration.descriptionFor("ctx_reduce", "Full reduce")).toBe(
            LIGHT_TOOL_DESCRIPTIONS.ctx_reduce,
        );
    });

    it("serves built-in light descriptions without a fallback notice", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: tempDir(),
            warn: (warning) => warnings.push(warning),
        });
        const config = { default: "light" as const };

        const registration = runtime.resolveRegistration(config);
        const guidance = runtime.resolveGuidance(config, "provider/model");
        runtime.resolveGuidance(config, "provider/other");

        expect(registration.descriptionFor("ctx_search", "Full search")).toBe(
            LIGHT_TOOL_DESCRIPTIONS.ctx_search,
        );
        expect(guidance.preset).toBe("light");
        expect(warnings).toEqual([]);
    });
});

describe("prompt-surface user config directory resolution per harness", () => {
    const savedEnv: Record<string, string | undefined> = {};
    let configHome: string;
    let homeDir: string;
    const guidanceContent = "## Magic Context\n\nLegacy-resolved guidance";

    /** Point XDG_CONFIG_HOME/HOME at temp dirs, seed legacy configs, no shared config. */
    function isolateWithLegacyConfigs(): void {
        configHome = tempDir();
        homeDir = tempDir();
        // No $XDG_CONFIG_HOME/cortexkit/magic-context.* → the shared base is
        // absent, so the harness legacy-fallback branch decides the outcome.
        const opencodeDir = join(configHome, "opencode");
        const piAgentDir = join(homeDir, ".pi", "agent");
        mkdirSync(opencodeDir, { recursive: true });
        mkdirSync(piAgentDir, { recursive: true });
        for (const directory of [opencodeDir, piAgentDir]) {
            writeFileSync(join(directory, "magic-context.jsonc"), "{}");
            writeFileSync(join(directory, "guidance.md"), guidanceContent);
        }
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.HOME = homeDir;
    }

    beforeEach(() => {
        savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
        savedEnv.HOME = process.env.HOME;
        isolateWithLegacyConfigs();
    });

    afterEach(() => {
        process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
        process.env.HOME = savedEnv.HOME;
    });

    const legacyOverrideConfig = {
        default: "full" as const,
        guidance_override_path: "guidance.md",
    };

    it("falls back to the OpenCode legacy config directory", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            harness: "opencode",
            warn: (warning) => warnings.push(warning),
        });

        expect(
            runtime.resolveGuidance(legacyOverrideConfig, "provider/model").primaryOverride,
        ).toBe(guidanceContent);
        expect(warnings).toEqual([]);
    });

    it("maps opencode2 onto the OpenCode legacy config directory", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            harness: "opencode2",
            warn: (warning) => warnings.push(warning),
        });

        expect(
            runtime.resolveGuidance(legacyOverrideConfig, "provider/model").primaryOverride,
        ).toBe(guidanceContent);
        expect(warnings).toEqual([]);
    });

    it("maps omp onto the Pi legacy config directory", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            harness: "omp",
            warn: (warning) => warnings.push(warning),
        });

        expect(
            runtime.resolveGuidance(legacyOverrideConfig, "provider/model").primaryOverride,
        ).toBe(guidanceContent);
        expect(warnings).toEqual([]);
    });

    it("dsh skips legacy fallbacks and uses only the shared base", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            harness: "dsh",
            warn: (warning) => warnings.push(warning),
        });

        // Neither the OpenCode nor the Pi legacy config exists for dsh: the
        // shared base is the only user-config source, so the relative
        // guidance override cannot resolve from any legacy directory.
        const selection = runtime.resolveGuidance(legacyOverrideConfig, "provider/model");
        expect(selection.primaryOverride).toBeUndefined();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("could not be read");
    });
});
