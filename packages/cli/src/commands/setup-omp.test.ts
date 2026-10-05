import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { __test, type OmpSetupDeps } from "./setup-omp";

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    constructor(private readonly confirms: boolean[]) {}
    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };
    intro(): void {}
    outro(): void {}
    note(): void {}
    spinner(): PromptSpinner {
        return { start: () => {}, stop: () => {}, message: () => {} };
    }
    async confirm(): Promise<boolean> {
        const value = this.confirms.shift();
        if (value === undefined) throw new Error("missing confirm response");
        return value;
    }
    async text(): Promise<string> {
        return "";
    }
    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        return options[0]?.value ?? "";
    }
    async selectMany(_message: string, options: SelectOption[]): Promise<string[]> {
        return options.map((option) => option.value);
    }
    async selectAutocomplete(_message: string, options: SelectOption[]): Promise<string> {
        return options[0]?.value ?? "";
    }
}

const roots: string[] = [];
const originalPiConfigFiles = process.env.PI_CONFIG_FILES;

afterEach(() => {
    if (originalPiConfigFiles === undefined) delete process.env.PI_CONFIG_FILES;
    else process.env.PI_CONFIG_FILES = originalPiConfigFiles;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeVirtualOmp(options: { failMemorySet?: boolean; pluginEnabled?: boolean } = {}) {
    const cwd = createTestTempDirFromPath(join(tmpdir(), "mc-omp-setup-"));
    roots.push(cwd);
    const binaryPath = "/virtual/bin/omp";
    const state = { compaction: true, memory: "mnemopi" };
    const commands: string[][] = [];
    const getOmpSetting = ((_path: string, key: string) =>
        key === "compaction.enabled"
            ? state.compaction
            : state.memory) as OmpSetupDeps["getOmpSetting"];
    const runOmpCommand: OmpSetupDeps["runOmpCommand"] = (_path, args) => {
        commands.push(args);
        if (args[0] !== "config" || args[1] !== "set") {
            return { ok: false, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
        }
        if (args[2] === "memory.backend" && options.failMemorySet) {
            return { ok: false, stdout: "", stderr: "memory set failed" };
        }
        if (args[2] === "compaction.enabled") state.compaction = args[3] === "true";
        else state.memory = args[3] ?? state.memory;
        return { ok: true, stdout: "", stderr: "" };
    };
    const host = __test.createOmpHost({
        detectOmpBinary: () => ({ path: binaryPath, source: "path" }),
        getOmpSetting,
        listOmpPlugins: () =>
            options.pluginEnabled
                ? [
                      {
                          name: "@cortexkit/pi-magic-context",
                          version: "0.33.0",
                          enabled: true,
                      },
                  ]
                : [],
        runOmpCommand,
    });
    return { binaryPath, commands, cwd, host, state };
}

describe("OMP setup probe wiring", () => {
    it("routes binary, version, and model discovery through injected probes", () => {
        const probes: string[] = [];
        const env = __test.createOmpEnvironment({
            detectOmpBinary: () => {
                probes.push("detect");
                return { path: "/virtual/bin/omp", source: "path" };
            },
            getOmpVersion: (path) => {
                probes.push(`version:${path}`);
                return "17.1.7";
            },
            getOmpAvailableModels: (path) => {
                probes.push(`models:${path}`);
                return ["anthropic/claude-opus"];
            },
        });

        expect(env.detectPiBinary()).toEqual({ path: "/virtual/bin/omp", source: "path" });
        expect(env.getPiVersion("/virtual/bin/omp")).toBe("17.1.7");
        expect(env.getAvailableModels("/virtual/bin/omp")).toEqual(["anthropic/claude-opus"]);
        expect(probes).toEqual(["detect", "version:/virtual/bin/omp", "models:/virtual/bin/omp"]);
    });
});

describe("OMP setup transaction", () => {
    it("restores native settings when a later setup step rolls back", async () => {
        const { binaryPath, cwd, host, state } = makeVirtualOmp();
        const prompts = new MockPrompts([true, true]);
        const rollback = await host.beforeWrite?.({
            binaryPath,
            cwd,
            prompts,
            dryRun: false,
            configureHost: true,
        });
        expect(typeof rollback).toBe("function");
        expect(state).toEqual({ compaction: false, memory: "off" });

        if (typeof rollback === "function") await rollback();
        expect(state).toEqual({ compaction: true, memory: "mnemopi" });
    });

    it("automatically restores an earlier setting when a later write fails", async () => {
        const { binaryPath, cwd, host, state } = makeVirtualOmp({ failMemorySet: true });
        const prompts = new MockPrompts([true, true]);

        const result = await host.beforeWrite?.({
            binaryPath,
            cwd,
            prompts,
            dryRun: false,
            configureHost: true,
        });

        expect(result).toBe(false);
        expect(state).toEqual({ compaction: true, memory: "mnemopi" });
        expect(prompts.messages.join("\n")).toContain("memory set failed");
        expect(prompts.messages.join("\n")).toContain("Restored OMP compaction.enabled=true");
    });

    it("does not change native settings when registration is skipped and plugin is absent", async () => {
        const { binaryPath, commands, cwd, host, state } = makeVirtualOmp();
        const prompts = new MockPrompts([]);
        const rollback = await host.beforeWrite?.({
            binaryPath,
            cwd,
            prompts,
            dryRun: false,
            configureHost: false,
        });
        expect(typeof rollback).toBe("function");
        expect(state).toEqual({ compaction: true, memory: "mnemopi" });
        expect(commands).toEqual([]);
    });

    it("refuses global setting writes when a project OMP config is active", async () => {
        const { binaryPath, commands, host, state } = makeVirtualOmp();
        const cwd = createTestTempDirFromPath(join(tmpdir(), "mc-omp-project-"));
        roots.push(cwd);
        mkdirSync(join(cwd, ".omp"), { recursive: true });
        writeFileSync(join(cwd, ".omp", "config.yml"), "compaction:\n  enabled: true\n");
        const prompts = new MockPrompts([true, true]);

        const result = await host.beforeWrite?.({
            binaryPath,
            cwd,
            prompts,
            dryRun: false,
            configureHost: true,
        });

        expect(result).toBe(false);
        expect(state).toEqual({ compaction: true, memory: "mnemopi" });
        expect(commands).toEqual([]);
        expect(prompts.messages.join("\n")).toContain("refusing to mutate the global config");
    });

    it("refuses global setting writes when PI_CONFIG_FILES overlays are active", async () => {
        const { binaryPath, commands, host, state } = makeVirtualOmp();
        const cwd = createTestTempDirFromPath(join(tmpdir(), "mc-omp-overlay-"));
        roots.push(cwd);
        process.env.PI_CONFIG_FILES = "settings/omp.yml";
        const prompts = new MockPrompts([true, true]);

        const result = await host.beforeWrite?.({
            binaryPath,
            cwd,
            prompts,
            dryRun: false,
            configureHost: true,
        });

        expect(result).toBe(false);
        expect(state).toEqual({ compaction: true, memory: "mnemopi" });
        expect(commands).toEqual([]);
        expect(prompts.messages.join("\n")).toContain(join(cwd, "settings", "omp.yml"));
    });
});
