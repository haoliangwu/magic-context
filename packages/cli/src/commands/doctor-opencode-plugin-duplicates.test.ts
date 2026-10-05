import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "comment-json";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { checkPluginDuplicates } from "./doctor-opencode-plugin-duplicates";

const FIXTURES = join(import.meta.dir, "fixtures/plugin-duplicates");
const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A local checkout whose package.json names the published plugin, as a dev registration does. */
function makeDevCheckout(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-dup-dev-"));
    tempDirs.push(dir);
    const pluginDir = join(dir, "packages/plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@cortexkit/opencode-magic-context" }),
    );
    return pluginDir;
}

/**
 * Runs the doctor step the way runDoctor does: parse the config file with
 * comment-json, run the check, and write the config back only when it reports
 * a change.
 */
function runCheck(fixture: string, options: { fix?: boolean; devPath?: string } = {}) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-dup-cfg-"));
    tempDirs.push(dir);
    const path = join(dir, "opencode.jsonc");
    let text = readFileSync(join(FIXTURES, fixture), "utf-8");
    if (options.devPath) text = text.replace("__DEV_PATH__", options.devPath);
    writeFileSync(path, text);

    const warns: string[] = [];
    const passes: string[] = [];
    const infos: string[] = [];
    const config = parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const changed = checkPluginDuplicates(
        config,
        "opencode.jsonc",
        { fix: options.fix, configDir: dir },
        {
            warn: (m) => warns.push(m),
            pass: (m) => passes.push(m),
            info: (m) => infos.push(m),
        },
    );
    if (changed) writeFileSync(path, `${stringify(config, null, 2)}\n`);
    const after = readFileSync(path, "utf-8");
    return {
        before: text,
        after,
        parsed: JSON.parse(JSON.stringify(parse(after))) as Record<string, unknown>,
        changed,
        warns,
        passes,
        infos,
    };
}

describe("doctor OpenCode duplicate Magic Context registrations", () => {
    it("reports every entry across both keys without --fix and leaves the file untouched", () => {
        const result = runCheck("pinned-legacy-latest-native.jsonc");
        expect(result.changed).toBe(false);
        expect(result.after).toBe(result.before);
        expect(result.warns).toEqual([
            "Magic Context is registered 2 times in opencode.jsonc; OpenCode loads the first and fails the rest as duplicates",
        ]);
        expect(result.infos).toEqual([
            "  plugin[1]: @cortexkit/opencode-magic-context@0.42.6",
            "  plugins[0]: @cortexkit/opencode-magic-context@latest",
            "  Run 'doctor --fix' to keep plugins[0] (@cortexkit/opencode-magic-context@latest) and remove the others",
        ]);
    });

    it("--fix keeps the @latest entry, removes the pinned one, and preserves comments and unrelated entries", () => {
        const result = runCheck("pinned-legacy-latest-native.jsonc", { fix: true });
        expect(result.changed).toBe(true);
        expect(result.parsed.plugin).toEqual(["opencode-other-plugin"]);
        expect(result.parsed.plugins).toEqual([
            "@cortexkit/opencode-magic-context@latest",
            { package: "some-v2-plugin", options: { a: 1 } },
        ]);
        expect(result.after).toContain("// Written by an older setup run.");
        expect(result.after).toContain("// unrelated, must survive");
        expect(result.after).toContain("/* OpenCode 2 native list */");
        expect(result.passes).toHaveLength(1);
    });

    it("--fix removes the bare entry `opencode plugin add` appends next to a legacy @latest", () => {
        const result = runCheck("latest-legacy-bare-native.jsonc", { fix: true });
        expect(result.changed).toBe(true);
        // Both follow new releases; the one the host loads first (and so the
        // copy that is actually active) is kept.
        expect(result.parsed.plugin).toEqual(["@cortexkit/opencode-magic-context@latest"]);
        expect(result.parsed.plugins).toEqual(["opencode-other-plugin"]);
        expect(result.after).toContain("// from 1.x setup");
    });

    it("--fix keeps a tuple keeper's options", () => {
        const result = runCheck("keeper-tuple-options.jsonc", { fix: true });
        expect(result.parsed.plugin).toEqual([
            ["@cortexkit/opencode-magic-context@latest", { sidebar: false }],
        ]);
    });

    it("--fix keeps an object keeper's options", () => {
        const result = runCheck("keeper-object-options.jsonc", { fix: true });
        expect(result.parsed.plugin).toEqual([]);
        expect(result.parsed.plugins).toEqual([
            { package: "@cortexkit/opencode-magic-context", options: { sidebar: false } },
        ]);
    });

    it("--fix moves options from a removed pinned entry onto the kept @latest entry", () => {
        const result = runCheck("options-on-pinned.jsonc", { fix: true });
        expect(result.parsed.plugin).toEqual([]);
        expect(result.parsed.plugins).toEqual([
            ["@cortexkit/opencode-magic-context@latest", { sidebar: false }],
        ]);
    });

    it("--fix warns and leaves both entries when they carry different options", () => {
        const result = runCheck("conflicting-options.jsonc", { fix: true });
        expect(result.changed).toBe(false);
        expect(result.after).toBe(result.before);
        expect(result.warns).toContain(
            "Two Magic Context entries carry different options; leaving every entry in place — merge the options into one entry by hand",
        );
    });

    it("--fix never removes a dev-path entry: warns and leaves both", () => {
        const devPath = makeDevCheckout();
        const result = runCheck("dev-path-and-npm.jsonc", { fix: true, devPath });
        expect(result.changed).toBe(false);
        expect(result.after).toBe(result.before);
        expect(result.infos).toContain(`  plugin[0]: dev path ${devPath}`);
        expect(result.warns).toContain(
            "A local development checkout is registered next to another Magic Context entry; leaving every entry in place — remove the one you do not want by hand",
        );
    });

    it("stays silent for a single registration", () => {
        const result = runCheck("single-entry.jsonc", { fix: true });
        expect(result.changed).toBe(false);
        expect(result.warns).toEqual([]);
        expect(result.infos).toEqual([]);
    });
});
