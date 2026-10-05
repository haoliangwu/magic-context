import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { OpenCodeAdapter } from "./opencode";

// An OpenCode 2 host reads its native `plugins` array and still decodes the legacy
// `plugin` array, loading BOTH. A user who registered a checkout under `plugins`
// must not get a second, npm registration appended under `plugin` by doctor/setup.
describe("OpenCodeAdapter registration keys across host generations", () => {
    let root: string;
    let configPath: string;
    const originalConfigHome = process.env.XDG_CONFIG_HOME;

    beforeEach(() => {
        root = createTestTempDirFromPath(join(tmpdir(), "mc-oc-adapter-"));
        process.env.XDG_CONFIG_HOME = root;
        configPath = join(root, "opencode", "opencode.json");
    });
    afterEach(() => {
        if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalConfigHome;
        rmSync(root, { recursive: true, force: true });
    });

    const write = (config: Record<string, unknown>) => {
        const { mkdirSync } = require("node:fs");
        mkdirSync(join(root, "opencode"), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    };
    const read = () => JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

    test("a checkout registered under the v2 `plugins` key is left alone", async () => {
        // A real checkout path: dev-path recognition verifies the nearest package.json.
        const checkout = resolve(import.meta.dir, "../../../plugin");
        write({ plugins: [checkout] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(read()).toEqual({ plugins: [checkout] });
    });

    test("an npm registration under the v2 `plugins` key counts as present", () => {
        write({ plugins: ["@cortexkit/opencode-magic-context@latest"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.hasPluginEntry()).toBe(true);
    });

    test("an object-form v2 entry ({ package, options }) counts as present and is not duplicated", async () => {
        // OpenCode 2 replaces the 1.x `[package, options]` tuple with an object
        // (core 2.0.11 decodes the legacy tuple into the same object). A matcher
        // that only knows the tuple reads this as unregistered and appends a
        // second entry, loading the plugin twice.
        const entry = { package: "@cortexkit/opencode-magic-context@latest", options: { x: 1 } };
        write({ plugins: [entry] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.hasPluginEntry()).toBe(true);
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(read()).toEqual({ plugins: [entry] });
    });

    test("an object-form v2 entry pointing at a local checkout is recognised as the dev path", async () => {
        const checkout = resolve(import.meta.dir, "../../../plugin");
        write({ plugins: [{ package: checkout }] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(read()).toEqual({ plugins: [{ package: checkout }] });
    });

    test("a fresh registration on a v2 host is written under `plugins`, never `plugin`", async () => {
        write({ model: "openai/x" });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("added");
        const config = read();
        expect(config.plugin).toBeUndefined();
        expect(config.plugins).toEqual(["@cortexkit/opencode-magic-context@latest"]);
    });

    test("a fresh registration on a v1 host keeps the singular `plugin` key", async () => {
        write({ model: "openai/x" });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v1" });
        await adapter.ensurePluginEntry();
        const config = read();
        expect(config.plugins).toBeUndefined();
        expect(config.plugin).toEqual(["@cortexkit/opencode-magic-context@latest"]);
    });

    test("a legacy `plugin` registration on a v2 host is recognised and left where it is", async () => {
        write({ plugin: ["@cortexkit/opencode-magic-context@latest"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.hasPluginEntry()).toBe(true);
        expect((await adapter.ensurePluginEntry()).action).toBe("already_present");
        expect(read()).toEqual({ plugin: ["@cortexkit/opencode-magic-context@latest"] });
    });

    test("removal keeps comments inside and around the plugin array", async () => {
        mkdirSync(join(root, "opencode"), { recursive: true });
        writeFileSync(
            configPath,
            `{
  // plugins I use
  "plugin": [
    // theme first
    "other",
    "@cortexkit/opencode-magic-context@latest",
    "third" // keep me
  ]
}
`,
        );
        const adapter = new OpenCodeAdapter({ hostGeneration: "v1" });
        const result = await adapter.removePluginEntry();
        expect(result.action).toBe("updated");
        const text = readFileSync(configPath, "utf-8");
        for (const comment of ["// plugins I use", "// theme first", "// keep me"]) {
            expect(text).toContain(comment);
        }
        expect(text).not.toContain("opencode-magic-context");
    });

    test("removal drops the entry from whichever key holds it", async () => {
        write({ plugins: ["other", "@cortexkit/opencode-magic-context@latest"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.removePluginEntry();
        expect(result.ok).toBe(true);
        expect(read()).toEqual({ plugins: ["other"] });
    });
});

// OpenCode 1 caches plugins under `<cache>/opencode/packages/`; OpenCode 2 under
// `<cache>/opencode/npm/<name>@<spec>/<generation>/`. Every fixture lives under a
// throwaway XDG root so no real cache, config or database is read or touched.
describe("OpenCodeAdapter plugin cache readers across cache layouts", () => {
    const envKeys = [
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "OPENCODE_DB",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CHANNEL",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    let root: string;
    let cache: string;

    beforeEach(() => {
        root = createTestTempDirFromPath(join(tmpdir(), "mc-oc-adapter-cache-"));
        for (const key of envKeys) savedEnv[key] = process.env[key];
        cache = join(root, "cache");
        process.env.XDG_CACHE_HOME = cache;
        process.env.XDG_CONFIG_HOME = join(root, "config");
        process.env.XDG_DATA_HOME = join(root, "data");
        process.env.OPENCODE_DB = join(root, "data", "opencode", "opencode.db");
        delete process.env.OPENCODE_CONFIG_DIR;
        delete process.env.OPENCODE_CHANNEL;
    });
    afterEach(() => {
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        rmSync(root, { recursive: true, force: true });
    });

    const writePackage = (dir: string, version: string) => {
        const packageDir = join(dir, "node_modules", "@cortexkit", "opencode-magic-context");
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(
            join(packageDir, "package.json"),
            JSON.stringify({ name: "@cortexkit/opencode-magic-context", version }),
        );
    };
    const v2Slot = (spec: string) =>
        join(cache, "opencode", "npm", "@cortexkit", `opencode-magic-context@${spec}`);
    const writeV2 = (spec: string, generation: string, version: string) =>
        writePackage(join(v2Slot(spec), generation), version);
    const writeV1 = (version: string) =>
        writePackage(
            join(cache, "opencode", "packages", "@cortexkit", "opencode-magic-context@latest"),
            version,
        );
    const writeConfig = (config: Record<string, unknown>) => {
        mkdirSync(join(root, "config", "opencode"), { recursive: true });
        writeFileSync(join(root, "config", "opencode", "opencode.json"), JSON.stringify(config));
    };

    test("an OpenCode 2 host reads the installed version from the newest generation of the npm slot", () => {
        writeV2("latest", "1790000000000", "0.42.0");
        writeV2("latest", "1790000000001", "0.43.1");
        writeV1("0.30.0");
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.getInstalledPluginVersion()).toBe("0.43.1");
    });

    test("an OpenCode 2 host reads the slot of the dist-tag the config follows", () => {
        writeV2("latest", "1790000000000", "0.43.1");
        writeV2("beta", "1790000000000", "0.44.0-beta.2");
        writeConfig({ plugins: ["@cortexkit/opencode-magic-context@beta"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.getInstalledPluginVersion()).toBe("0.44.0-beta.2");
    });

    test("an OpenCode 1 host keeps reading the packages tree", () => {
        writeV2("latest", "1790000000000", "0.43.1");
        writeV1("0.30.0");
        const adapter = new OpenCodeAdapter({ hostGeneration: "v1" });
        expect(adapter.getInstalledPluginVersion()).toBe("0.30.0");
    });

    test("--clear lists both layouts when both exist, offering only the @latest slot from npm/", () => {
        writeV1("0.30.0");
        writeV2("latest", "1790000000000", "0.43.1");
        writeV2("beta", "1790000000000", "0.44.0-beta.2");
        writePackage(join(cache, "opencode", "npm", "other-plugin@latest", "1"), "1.0.0");
        const caches = new OpenCodeAdapter({ hostGeneration: "v2" }).getPluginCacheInfo();
        expect(caches.map((c) => [c.path, c.exists])).toEqual([
            [join(cache, "opencode", "packages"), true],
            [v2Slot("latest"), true],
        ]);
        expect(caches[1]?.sizeBytes).toBeGreaterThan(0);
    });

    test("--clear on an OpenCode 2-only machine offers the @latest slot, not the missing packages tree", () => {
        writeV2("latest", "1790000000000", "0.43.1");
        const caches = new OpenCodeAdapter({ hostGeneration: "v2" }).getPluginCacheInfo();
        expect(caches.filter((c) => c.exists).map((c) => c.path)).toEqual([v2Slot("latest")]);
    });

    test("--clear removes the @latest slot only when no OpenCode process holds the database or slot", () => {
        writeV2("latest", "1790000000000", "0.43.1");
        writeV2("beta", "1790000000000", "0.44.0-beta.2");
        const probed: unknown[] = [];
        const adapter = new OpenCodeAdapter({
            hostGeneration: "v2",
            probeHostUse: (targets) => {
                probed.push(targets);
                return { status: "free" };
            },
        });
        const slot = adapter.getPluginCacheInfo().find((c) => c.path === v2Slot("latest"));
        expect(slot?.clear?.()).toEqual({ cleared: true });
        expect(existsSync(v2Slot("latest"))).toBe(false);
        expect(existsSync(v2Slot("beta"))).toBe(true);
        const db = process.env.OPENCODE_DB as string;
        expect(probed).toEqual([
            {
                files: [db, `${db}-wal`, `${db}-shm`],
                directories: [v2Slot("latest")],
            },
        ]);
    });

    test("--clear leaves the @latest slot while OpenCode is running or lsof fails", () => {
        writeV2("latest", "1790000000000", "0.43.1");
        for (const probe of [
            () => ({ status: "in_use" as const, pids: [4242] }),
            () => ({ status: "unknown" as const, reason: "could not run lsof (ENOENT)" }),
        ]) {
            const adapter = new OpenCodeAdapter({ hostGeneration: "v2", probeHostUse: probe });
            const slot = adapter.getPluginCacheInfo().find((c) => c.path === v2Slot("latest"));
            const result = slot?.clear?.();
            expect(result?.cleared).toBe(false);
            expect(existsSync(v2Slot("latest"))).toBe(true);
        }
    });
});
