import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import type { HarnessAdapter } from "../adapters/types";
import type { DiagnosticReport } from "../lib/diagnostics-opencode";
import { MAX_GITHUB_BODY_BYTES } from "../lib/issue-body";
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
    function fakeReport(root: string, opencodeVersion = "1.0.0"): DiagnosticReport {
        const logPath = join(root, "opencode.log");
        writeFileSync(logPath, "INFO started\n");
        return {
            timestamp: "2026-05-11T12:00:00.000Z",
            platform: "darwin",
            arch: "arm64",
            nodeVersion: "v24.0.0",
            pluginVersion: "0.39.0",
            opencodeInstalled: true,
            opencodeVersion,
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

    it("shows the sanitized backup warning for OpenCode 1 and OpenCode 2", async () => {
        const root = tempRoot();
        const originalHome = process.env.HOME;
        process.env.HOME = root;
        restores.push(() => {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
        });
        const originalCwd = process.cwd();
        process.chdir(root);
        restores.push(() => process.chdir(originalCwd));

        for (const version of ["1.0.0", "2.0.0"]) {
            const reportPath = join(root, `opencode-${version}-diagnostics.md`);
            const code = await openCodeDoctor.runIssueFlow(
                { reportPath },
                { collectDiagnostics: async () => fakeReport(root, version) },
            );

            expect(code).toBe(0);
            const body = readFileSync(reportPath, "utf-8");
            expect(body).toContain(
                "Magic Context storage is at ~/project-1/<path>, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.",
            );
            expect(body).not.toContain(root);
        }
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

function prepareOmpIssueFixture(root: string, logContent: string) {
    const agentDir = join(root, ".omp", "agent");
    const pluginDir = join(root, "plugin");
    const configDir = join(root, ".config", "cortexkit");
    const logPath = join(root, "runtime.log");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
    );
    writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
    writeFileSync(logPath, logContent);
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.XDG_CONFIG_HOME = join(root, ".config");
    process.env.XDG_DATA_HOME = join(root, ".local", "share");
    process.env.MAGIC_CONTEXT_LOG_PATH = logPath;

    return {
        logPath,
        deps: {
            detectOmpBinary: () => ({ path: "/fake/omp", source: "path" as const }),
            getOmpVersion: () => "17.1.7",
            listOmpPlugins: () => [
                {
                    name: "@cortexkit/pi-magic-context",
                    version: "0.49.2",
                    enabled: true,
                    path: pluginDir,
                },
            ],
            getOmpSetting: ((_path: string, key: string) =>
                key === "compaction.enabled" ? false : "off") as never,
            runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
        },
    };
}

describe("OMP doctor --issue --report", () => {
    const savedEnv = {
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
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

    it("includes OMP environment, checks, recent errors and sanitized log tail", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const logLine =
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] could not safely prepare this turn: protected source";
        const { deps } = prepareOmpIssueFixture(
            root,
            `${logLine}\n[2026-09-05T10:41:04.130Z] [magic-context][ses_omp] runtime continued\n`,
        );

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const body = readFileSync(join(root, "omp-diagnostics.md"), "utf-8");
        expect(body).toContain("## Environment");
        expect(body).toContain("Magic Context plugin: v0.49.2");
        expect(body).toContain("Oh My Pi: 17.1.7");
        expect(body).toContain(`OS: ${process.platform} ${process.arch}`);
        expect(body).toContain(`Runtime: Node.js ${process.version}`);
        expect(body).toContain("## OMP diagnostics");
        expect(body).toContain("Magic Context storage ~/project-1/<path>");
        expect(body).not.toContain(root);
        expect(body).toContain("## Recent errors (last 20, sanitized)");
        expect(body).toContain("refused: <text omitted>");
        expect(body).not.toContain("protected source");
        expect(body).toContain("## Log (last 400 lines, sanitized)");
        expect(body).toContain("magic-context [session-1]");
        expect(body).not.toContain("runtime continued");
    });

    it("keeps a refusal visible when a large OMP log is capped", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const lines = Array.from(
            { length: 4_600 },
            (_, index) =>
                `[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] tail count=${index} tokens=${"9".repeat(200)}`,
        );
        const refusal =
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] refused (unsafe turn preparation)";
        lines[1_000] = refusal;
        const { deps } = prepareOmpIssueFixture(root, lines.join("\n"));

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const outputPath = join(root, "omp-diagnostics.md");
        const body = readFileSync(outputPath, "utf-8");
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_GITHUB_BODY_BYTES);
        expect(body).toContain("[truncated for GitHub 64KB limit");
        expect(body).toContain("## Recent errors (last 20, sanitized)");
        expect(body).toContain("refused: <text omitted>");
        expect(body).not.toContain(refusal);
        expect(existsSync(`${outputPath}.full.md`)).toBe(true);
        expect(readFileSync(`${outputPath}.full.md`, "utf-8")).toContain("refused: <text omitted>");
        expect(readFileSync(`${outputPath}.full.md`, "utf-8")).not.toContain("ses_omp");
    });

    it("filters the interactive OMP report to the selected session", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const logLines = [
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_keep] selected-session detail count=17",
            "[2026-09-05T10:41:04.130Z] [magic-context][ses_other] unrelated-session detail count=29",
        ];
        const { deps } = prepareOmpIssueFixture(root, logLines.join("\n"));
        const prompts = new NoPrompts();
        prompts.text = (async (message: string) =>
            message === "Issue title" ? "OMP issue" : "description") as never;
        prompts.selectOne = (async (_message: string, choices: Array<{ value: string }>) => {
            expect(choices.map((choice) => choice.value)).toContain("ses_keep");
            expect(choices.map((choice) => choice.value)).toContain("__all__");
            return "ses_keep";
        }) as never;
        prompts.confirm = (async () => false) as never;

        const code = await ompDoctor.runDoctor({
            issue: true,
            cwd: root,
            prompts,
            deps: { ...deps, now: () => new Date("2026-09-21T09:15:00.000Z") },
        });

        expect(code).toBe(0);
        const reportMessage = prompts.messages.find((message) =>
            message.startsWith("success:Sanitized report written to "),
        );
        const outputPath = reportMessage?.split(" ").at(-1);
        expect(outputPath).toBeDefined();
        const body = readFileSync(outputPath!, "utf-8");
        expect(body).toContain("count=17");
        expect(body).not.toContain("count=29");
        expect(body).not.toContain("selected-session detail");
        expect(body).not.toContain("unrelated-session detail");
    });

    it("redacts a secret-looking value from an OMP runtime log", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const secret = "eyJhbGciOiJIUzI1NiJ9.signature";
        const { deps } = prepareOmpIssueFixture(
            root,
            `[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] Authorization: Bearer ${secret}\n`,
        );

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const body = readFileSync(join(root, "omp-diagnostics.md"), "utf-8");
        expect(body).not.toContain(secret);
    });

    it("reports the Hide Secrets check as a readable line without paths", async () => {
        const parent = join(tmpdir(), "magic-context", "omp-hide-secrets");
        mkdirSync(parent, { recursive: true });
        const root = createTestTempDirFromPath(join(parent, "issue-"));
        roots.push(root);
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const { deps } = prepareOmpIssueFixture(root, "");
        const agentDir = join(root, ".omp", "agent");
        writeFileSync(join(agentDir, "config.yml"), "secrets:\n  enabled: true\n");
        writeFileSync(
            join(agentDir, "secrets.yml"),
            "- type: plain\n  content: sk-fixture-SECRET\n",
        );

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const body = readFileSync(join(root, "omp-diagnostics.md"), "utf-8");
        const line = body.split("\n").find((entry) => entry.includes("Hide Secrets"));
        expect(line).toStartWith(
            "- WARN: OMP Hide Secrets (secrets.enabled) is on in OMP user settings: ",
        );
        expect(line).toContain(
            "https://docs.cortexkit.io/magic-context/help/compatibility/#omp-hide-secrets",
        );
        expect(line).not.toContain(agentDir);
        expect(body).not.toContain("sk-fixture-SECRET");
    });
});
