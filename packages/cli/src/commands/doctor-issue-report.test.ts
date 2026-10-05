import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import type { HarnessAdapter } from "../adapters/types";
import type { DiagnosticReport } from "../lib/diagnostics-opencode";
import type { PromptIO, PromptSpinner } from "../lib/prompts";
import * as prompts from "../lib/prompts";
import { dispatchDoctor } from "./doctor";
import * as ompDoctor from "./doctor-omp";
import * as openCodeDoctor from "./doctor-opencode";
import * as piDoctor from "./doctor-pi";

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-report-"));
    roots.push(root);
    return root;
}

function failOnPrompt(name: string): () => never {
    return () => {
        throw new Error(`--report must not prompt (${name})`);
    };
}

describe("doctor --issue --report dispatch", () => {
    it("forwards the report path to every harness doctor", async () => {
        const seen: Record<string, unknown> = {};
        const openCode = spyOn(openCodeDoctor, "runDoctor").mockImplementation(async (options) => {
            seen.opencode = options;
            return 0;
        });
        const omp = spyOn(ompDoctor, "runDoctor").mockImplementation(async (options) => {
            seen.omp = options;
            return 0;
        });
        const pi = spyOn(piDoctor, "doctor").mockImplementation(async (args) => {
            seen.pi = args;
            return 0;
        });
        restores.push(
            () => openCode.mockRestore(),
            () => omp.mockRestore(),
            () => pi.mockRestore(),
        );

        for (const kind of ["opencode", "omp", "pi"] as const) {
            await dispatchDoctor({ kind } as HarnessAdapter, {
                issue: true,
                report: "out/diagnostics.md",
            });
        }

        expect(seen.opencode).toMatchObject({ issue: true, report: "out/diagnostics.md" });
        expect(seen.omp).toMatchObject({ issue: true, report: "out/diagnostics.md" });
        expect(seen.pi).toEqual(["--issue", "--report", "out/diagnostics.md"]);
    });
});

describe("OpenCode doctor --issue --report", () => {
    function fakeReport(root: string): DiagnosticReport {
        const logPath = join(root, "opencode.log");
        writeFileSync(logPath, "INFO started\n");
        return {
            timestamp: "2026-05-11T12:00:00.000Z",
            platform: "darwin",
            arch: "arm64",
            nodeVersion: "v24.0.0",
            pluginVersion: "0.39.0",
            opencodeInstalled: true,
            opencodeVersion: "1.0.0",
            opencodeInstallKind: "cli",
            opencodeInstallations: [],
            configPaths: {
                configDir: join(root, "config"),
                opencodeConfig: join(root, "config", "opencode.jsonc"),
                opencodeConfigFormat: "jsonc",
                magicContextConfig: join(root, "config", "magic-context.jsonc"),
                tuiConfig: join(root, "config", "tui.jsonc"),
                tuiConfigFormat: "jsonc",
                omoConfig: null,
            },
            opencodeConfigHasPlugin: true,
            tuiConfigHasPlugin: true,
            magicContextConfig: { exists: true, flags: {} },
            pluginCache: { path: join(root, "cache") },
            storageDir: { path: join(root, "storage"), exists: true, contextDbSizeBytes: 0 },
            conflicts: {
                hasConflict: false,
                reasons: [],
                compactionEnabled: true,
                nativeCompaction: { auto: false, prune: false },
            },
            logFile: { path: logPath, exists: true, sizeKb: 1 },
            recentSessions: { available: true, rows: [] },
            historianDumps: { byProject: [], legacyDumps: { dir: root, count: 0, recent: [] } },
            historianFailures: { available: true, rows: [] },
            historianRuns: { available: true, rows: [] },
        };
    }

    it("writes the report to the given path without prompting", async () => {
        const root = tempRoot();
        for (const name of ["text", "confirm", "selectOne"] as const) {
            const spy = spyOn(prompts, name).mockImplementation(failOnPrompt(name));
            restores.push(() => spy.mockRestore());
        }
        const originalCwd = process.cwd();
        process.chdir(root);
        restores.push(() => process.chdir(originalCwd));

        const code = await openCodeDoctor.runIssueFlow(
            { reportPath: join("out", "diagnostics.md") },
            { collectDiagnostics: async () => fakeReport(root) },
        );

        expect(code).toBe(0);
        const written = join(root, "out", "diagnostics.md");
        expect(existsSync(written)).toBe(true);
        expect(readFileSync(written, "utf-8")).toContain("## Diagnostics");
    });
});

class NoPrompts implements PromptIO {
    readonly messages: string[] = [];
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
    confirm = failOnPrompt("confirm");
    text = failOnPrompt("text");
    selectOne = failOnPrompt("selectOne");
    selectMany = failOnPrompt("selectMany");
    selectAutocomplete = failOnPrompt("selectAutocomplete");
}

describe("OMP doctor --issue --report", () => {
    const savedEnv = {
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };

    it("writes the report to the given path without prompting", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = join(root, ".omp", "agent");
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps: {
                detectOmpBinary: () => null,
                listOmpPlugins: () => [],
            },
        });

        expect(code).toBe(0);
        const written = join(root, "omp-diagnostics.md");
        expect(existsSync(written)).toBe(true);
        expect(readFileSync(written, "utf-8")).toContain("## OMP diagnostics");
    });
});
