import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { isDevPathPluginEntry } from "../adapters/opencode";
import { projectPathToPiDirSlug } from "../commands/migrate";
import { resolveAdaptersForCommand } from "./harness-select";
import { detectConfigPaths } from "./paths";
import { isPiMagicContextPackageEntry } from "./pi-package-entry";

const roots: string[] = [];
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;

afterEach(() => {
    if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-cli-hardening-"));
    roots.push(root);
    return root;
}

describe("CLI hardening helpers", () => {
    it("rejects invalid harness overrides instead of treating them as absent", async () => {
        await expect(
            resolveAdaptersForCommand(["--harness", "opencdoe"], {
                allowMulti: false,
                verb: "setup",
            }),
        ).rejects.toThrow("Invalid --harness value: opencdoe");
    });

    it("selects opencode.jsonc for a fresh configuration", () => {
        const root = tempRoot();
        process.env.OPENCODE_CONFIG_DIR = root;
        const paths = detectConfigPaths();
        expect(paths.opencodeConfig).toBe(join(root, "opencode.jsonc"));
        expect(paths.opencodeConfigFormat).toBe("none");
    });

    it("accepts only local development paths with the exact package name", () => {
        const root = tempRoot();
        const plugin = join(root, "plugin");
        const theme = join(root, "magic-context-theme");
        mkdirSync(plugin, { recursive: true });
        mkdirSync(theme, { recursive: true });
        writeFileSync(
            join(plugin, "package.json"),
            JSON.stringify({ name: "@cortexkit/opencode-magic-context" }),
        );
        writeFileSync(join(theme, "package.json"), JSON.stringify({ name: "magic-context-theme" }));

        expect(isDevPathPluginEntry(pathToFileURL(plugin).href, root)).toBe(true);
        expect(isDevPathPluginEntry(pathToFileURL(theme).href, root)).toBe(false);
    });

    it("resolves a relative development path against the config file's directory", () => {
        // OpenCode resolves `./…` plugin entries against the directory of the
        // config file that declares them, not the shell's working directory.
        const configDir = tempRoot();
        const elsewhere = tempRoot();
        mkdirSync(join(configDir, "mc", "plugin"), { recursive: true });
        writeFileSync(
            join(configDir, "mc", "plugin", "package.json"),
            JSON.stringify({ name: "@cortexkit/opencode-magic-context" }),
        );
        const originalCwd = process.cwd();
        process.chdir(elsewhere);
        try {
            expect(isDevPathPluginEntry("./mc/plugin", configDir)).toBe(true);
            // The same relative path from the shell's directory is not the checkout.
            expect(isDevPathPluginEntry("./mc/plugin", elsewhere)).toBe(false);
        } finally {
            process.chdir(originalCwd);
        }
    });

    it("recognizes source-only Pi object entries without substring matches", () => {
        expect(
            isPiMagicContextPackageEntry({
                source: "npm:@cortexkit/pi-magic-context@0.31.5",
            }),
        ).toBe(true);
        expect(isPiMagicContextPackageEntry("npm:@cortexkit/pi-magic-context-theme")).toBe(false);
    });

    it("uses Pi's Windows-safe session slug encoding", () => {
        expect(projectPathToPiDirSlug("C:\\Users\\me\\repo", "win32")).toBe("--C-Users-me-repo--");
    });
});
