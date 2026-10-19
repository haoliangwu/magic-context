import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelsDevCatalogPath } from "./models-dev-temperature";
import {
    __temperatureTest,
    applyHiddenSubagentTemperature,
    resolveTemperatureCapability,
    subagentTemperature,
} from "./subagent-temperature";
import { cleanupTestTempDir, createTestTempDirFromPath } from "./test-temp-dir";

// Every test reads a catalog it wrote itself, never the machine's OpenCode cache.
const cacheRoot = createTestTempDirFromPath(join(tmpdir(), "mc-temperature-catalog-"));
const savedEnv = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
};

/** Shape of OpenCode's cached models.dev api.json, trimmed to the fields that matter. */
const CATALOG = {
    google: {
        id: "google",
        models: {
            "gemini-3.8-flash": { id: "gemini-3.8-flash", temperature: true, reasoning: true },
        },
    },
    openrouter: {
        id: "openrouter",
        models: {
            "google/gemini-3.8-flash": { temperature: true, reasoning: true },
            "openai/gpt-6.1-sol": { temperature: false, reasoning: true },
        },
    },
    openai: { id: "openai", models: { "gpt-6.1-sol": { temperature: false, reasoning: true } } },
    opencode: { id: "opencode", models: { "gemini-3.8-flash": { temperature: true } } },
    broken: { id: "broken", models: { "no-flag": { reasoning: true } } },
};

function writeCatalog(contents: string = JSON.stringify(CATALOG)): void {
    const path = join(cacheRoot, "opencode", "models.json");
    mkdirSync(join(cacheRoot, "opencode"), { recursive: true });
    writeFileSync(path, contents);
}

function removeCatalog(): void {
    rmSync(join(cacheRoot, "opencode"), { recursive: true, force: true });
}

beforeEach(() => {
    process.env.XDG_CACHE_HOME = cacheRoot;
    delete process.env.OPENCODE_MODELS_PATH;
    removeCatalog();
    __temperatureTest.reset();
});

afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    cleanupTestTempDir(cacheRoot);
});

describe("subagent sampling metadata", () => {
    for (const [host, yes, no] of [
        [
            "OpenCode 1",
            { capabilities: { temperature: true } },
            { capabilities: { temperature: false } },
        ],
        ["OpenCode 2", { temperature: true }, { temperature: false }],
        [
            "Pi",
            { compat: { supportsTemperature: true } },
            { compat: { supportsTemperature: false } },
        ],
        [
            "OMP",
            { compat: { supportsSamplingParams: true } },
            { compat: { supportsSamplingParams: false } },
        ],
    ] as const) {
        test(`${host} requires affirmative metadata and preserves explicit zero`, () => {
            const logs: string[] = [];
            const note = (line: string) => logs.push(line);
            expect(subagentTemperature("provider/yes", yes, 0.1, note)).toBe(0.1);
            expect(subagentTemperature("provider/yes", yes, 0, note)).toBe(0);
            expect(subagentTemperature("provider/no", no, 0.1, note)).toBeUndefined();
            expect(
                subagentTemperature("provider/missing", { reasoning: false }, 0.1, note),
            ).toBeUndefined();
            expect(
                subagentTemperature("provider/unknown", { temperature: "yes" }, 0.1, note),
            ).toBeUndefined();
            expect(subagentTemperature("provider/unset", yes, undefined, note)).toBeUndefined();
            expect(logs).toEqual([
                "Subagent temperature sent for provider/yes: host model metadata says yes",
                "Subagent temperature omitted for provider/no: host model metadata says no",
                "Subagent temperature omitted for provider/missing: no host or models.dev metadata",
                "Subagent temperature omitted for provider/unknown: no host or models.dev metadata",
            ]);
        });
    }

    test("decision logging is once per model and decision, and does not remember a denial as a capability", () => {
        const logs: string[] = [];
        const note = (line: string) => logs.push(line);
        expect(subagentTemperature("p/m", undefined, 0.1, note)).toBeUndefined();
        expect(subagentTemperature("p/m", undefined, 0.1, note)).toBeUndefined();
        expect(subagentTemperature("p/m", { temperature: true }, 0.1, note)).toBe(0.1);
        expect(subagentTemperature("p/m", { temperature: true }, 0.1, note)).toBe(0.1);
        expect(logs).toEqual([
            "Subagent temperature omitted for p/m: no host or models.dev metadata",
            "Subagent temperature sent for p/m: host model metadata says yes",
        ]);
    });

    test("OpenCode 1 guards historian, dreamer and compiler per resolved model, not unrelated agents", () => {
        const yes = { providerID: "p", id: "flash", capabilities: { temperature: true } };
        const no = { providerID: "p", id: "fallback", capabilities: { temperature: false } };
        for (const agent of [
            "historian",
            "historian-editor",
            "historian-recomp",
            "dreamer",
            "dreamer-classifier",
            "smart-note-compiler",
        ]) {
            const output: { temperature?: number } = { temperature: 0 };
            applyHiddenSubagentTemperature({ agent, model: yes }, output, () => {});
            expect(output).toEqual({ temperature: 0 });
            applyHiddenSubagentTemperature({ agent, model: no }, output, () => {});
            expect(output).toEqual({});
            output.temperature = 0.1;
            applyHiddenSubagentTemperature({ agent }, output, () => {});
            expect(output).toEqual({});
        }
        const output = { temperature: 0.4 };
        applyHiddenSubagentTemperature({ agent: "build", model: no }, output, () => {});
        expect(output.temperature).toBe(0.4);
    });
});

describe("models.dev catalog fallback when the host is silent", () => {
    test("resolves the cached catalog by provider and exact model id", () => {
        writeCatalog();
        const logs: string[] = [];
        const note = (line: string) => logs.push(line);
        // Pi and OpenCode 2 rows carry no temperature field.
        const silent = { reasoning: true, compat: { thinkingFormat: "openrouter" } };
        expect(subagentTemperature("openrouter/google/gemini-3.8-flash", silent, 0.1, note)).toBe(
            0.1,
        );
        expect(subagentTemperature("google/gemini-3.8-flash", silent, 0, note)).toBe(0);
        expect(subagentTemperature("opencode-zen/gemini-3.8-flash", silent, 0.1, note)).toBe(0.1);
        expect(subagentTemperature("openai/gpt-6.1-sol", silent, 0.1, note)).toBeUndefined();
        expect(
            subagentTemperature("openrouter/openai/gpt-6.1-sol", silent, 0.1, note),
        ).toBeUndefined();
        expect(logs).toEqual([
            "Subagent temperature sent for openrouter/google/gemini-3.8-flash: models.dev cache entry openrouter/google/gemini-3.8-flash says yes",
            "Subagent temperature sent for google/gemini-3.8-flash: models.dev cache entry google/gemini-3.8-flash says yes",
            "Subagent temperature sent for opencode-zen/gemini-3.8-flash: models.dev cache entry opencode/gemini-3.8-flash says yes",
            "Subagent temperature omitted for openai/gpt-6.1-sol: models.dev cache entry openai/gpt-6.1-sol says no",
            "Subagent temperature omitted for openrouter/openai/gpt-6.1-sol: models.dev cache entry openrouter/openai/gpt-6.1-sol says no",
        ]);
    });

    test("both Antigravity spellings map to the underlying Gemini entry", () => {
        writeCatalog();
        for (const model of [
            "google/antigravity-gemini-3.8-flash",
            "google-antigravity/gemini-3.8-flash",
            "google-antigravity/antigravity-gemini-3.8-flash",
        ]) {
            expect(resolveTemperatureCapability(model, {})).toEqual({
                supported: true,
                source: "catalog",
                entry: "google/gemini-3.8-flash",
            });
        }
        // The prefix is only an Antigravity spelling on Google, not a general rewrite.
        expect(resolveTemperatureCapability("openrouter/antigravity-gemini-3.8-flash", {})).toEqual(
            {
                supported: undefined,
                source: "none",
            },
        );
    });

    test("Codex and unmatched models stay unknown, so temperature is omitted", () => {
        writeCatalog();
        for (const model of [
            "openai-codex/gpt-6.1-sol",
            "google/gemini-3.8-flash-preview",
            "google/claude-opus-4-6-thinking",
            "broken/no-flag",
            "unknown/unknown",
            "no-slash",
        ]) {
            expect(resolveTemperatureCapability(model, undefined)).toEqual({
                supported: undefined,
                source: "none",
            });
            expect(subagentTemperature(model, undefined, 0.1, () => {})).toBeUndefined();
        }
    });

    test("host metadata outranks the catalog in both directions", () => {
        writeCatalog();
        expect(
            subagentTemperature(
                "google/gemini-3.8-flash",
                { capabilities: { temperature: false } },
                0.1,
                () => {},
            ),
        ).toBeUndefined();
        expect(
            subagentTemperature(
                "openai/gpt-6.1-sol",
                { compat: { supportsSamplingParams: true } },
                0.1,
                () => {},
            ),
        ).toBe(0.1);
    });

    test("a missing, empty or partially written catalog is not evidence", () => {
        const silent = {};
        expect(
            subagentTemperature("google/gemini-3.8-flash", silent, 0.1, () => {}),
        ).toBeUndefined();
        writeCatalog(JSON.stringify(CATALOG).slice(0, 200));
        expect(
            subagentTemperature("google/gemini-3.8-flash", silent, 0.1, () => {}),
        ).toBeUndefined();
        writeCatalog("[]");
        expect(
            subagentTemperature("google/gemini-3.8-flash", silent, 0.1, () => {}),
        ).toBeUndefined();
    });

    test("a rewritten catalog is re-read rather than served from memory", () => {
        writeCatalog();
        expect(resolveTemperatureCapability("google/gemini-3.8-flash", {}).supported).toBe(true);
        writeCatalog(
            JSON.stringify({
                google: { models: { "gemini-3.8-flash": { temperature: false, note: "changed" } } },
            }),
        );
        expect(resolveTemperatureCapability("google/gemini-3.8-flash", {}).supported).toBe(false);
    });

    test("OPENCODE_MODELS_PATH takes precedence over the cache, as it does for OpenCode", () => {
        writeCatalog();
        const override = join(cacheRoot, "override.json");
        writeFileSync(
            override,
            JSON.stringify({ google: { models: { "gemini-3.8-flash": { temperature: false } } } }),
        );
        process.env.OPENCODE_MODELS_PATH = override;
        expect(modelsDevCatalogPath()).toBe(override);
        expect(resolveTemperatureCapability("google/gemini-3.8-flash", {}).supported).toBe(false);
        delete process.env.OPENCODE_MODELS_PATH;
        expect(modelsDevCatalogPath()).toBe(join(cacheRoot, "opencode", "models.json"));
    });
});
