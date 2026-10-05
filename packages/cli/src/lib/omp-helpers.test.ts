import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeTestExecutable } from "@magic-context/core/shared/test-fake-executable";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    detectOmpBinary,
    getOmpCommandInvocation,
    getOmpFallbackCandidates,
    type OmpCommandExecutionDeps,
    parseOmpModelsOutput,
    runOmpCommand,
} from "./omp-helpers";

const originalPath = process.env.PATH;
const originalPackageDir = process.env.PI_PACKAGE_DIR;
const originalHome = process.env.HOME;
const roots: string[] = [];

afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = originalPackageDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OMP binary discovery", () => {
    /** A real OMP package root plus a fake `bun` on PATH; HOME has no OMP. */
    function makePackageRoot(): { root: string; binDir: string } {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-package-"));
        roots.push(root);
        mkdirSync(join(root, "pkg", "dist"), { recursive: true });
        writeFileSync(
            join(root, "pkg", "package.json"),
            JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
        );
        writeFileSync(join(root, "pkg", "dist", "cli.js"), "");
        // The fake bun is a shared content-addressed stub alone in its directory
        // (see writeTestExecutable), so it is not under `root` and not removed per test.
        const binDir = dirname(writeTestExecutable("bun", "#!/bin/sh\n"));
        process.env.HOME = join(root, "home");
        process.env.PI_PACKAGE_DIR = join(root, "pkg");
        return { root, binDir };
    }

    it("honors a validated PI_PACKAGE_DIR install root when Bun can run it", () => {
        const { root, binDir } = makePackageRoot();
        process.env.PATH = binDir;

        expect(detectOmpBinary()).toEqual({
            path: join(root, "pkg", "dist", "cli.js"),
            source: "package",
        });
    });

    it("ignores the package root when no Bun runtime can execute the CLI script", () => {
        const { root } = makePackageRoot();
        process.env.PATH = join(root, "empty-bin");

        expect(detectOmpBinary()).toBeNull();
    });

    it("routes a package CLI script through Bun instead of spawning it directly", () => {
        const { root, binDir } = makePackageRoot();
        process.env.PATH = binDir;
        const cli = join(root, "pkg", "dist", "cli.js");

        expect(getOmpCommandInvocation(cli, ["--version"])).toEqual({
            command: join(binDir, "bun"),
            args: [cli, "--version"],
        });
    });

    it("leaves a native OMP binary path untouched", () => {
        const { binDir } = makePackageRoot();
        process.env.PATH = binDir;

        expect(getOmpCommandInvocation("/usr/bin/omp", ["config", "path"])).toEqual({
            command: "/usr/bin/omp",
            args: ["config", "path"],
        });
    });
});

describe("OMP fallback discovery", () => {
    it("covers standard Windows npm and Bun install directories", () => {
        const home = "C:\\Users\\fox";
        const appData = "C:\\Users\\fox\\AppData\\Roaming";
        expect(getOmpFallbackCandidates("win32", home, appData)).toEqual([
            join(appData, "npm", "omp.cmd"),
            join(appData, "npm", "omp.exe"),
            join(home, ".bun", "bin", "omp.exe"),
            join(home, ".bun", "bin", "omp.cmd"),
        ]);
    });
});

describe("OMP model discovery", () => {
    it("parses model selectors without flattening scoped or nested IDs", () => {
        const output = JSON.stringify({
            models: [
                {
                    provider: "anthropic",
                    id: "claude-opus",
                    selector: "anthropic/claude-opus",
                },
                {
                    provider: "modal",
                    id: "@modal/qwen/model-v1",
                    selector: "modal/@modal/qwen/model-v1",
                },
                { provider: "openai", id: "fallback/model" },
            ],
        });

        expect(parseOmpModelsOutput(output)).toEqual([
            "anthropic/claude-opus",
            "modal/@modal/qwen/model-v1",
            "openai/fallback/model",
        ]);
    });
});

describe("OMP command execution", () => {
    it("preserves injected spawn timeout errors when stderr is empty", () => {
        const timeoutError = Object.assign(new Error("spawnSync omp ETIMEDOUT"), {
            code: "ETIMEDOUT",
        });
        let receivedTimeout: number | undefined;
        const spawnSync = ((
            _command: string,
            _args: readonly string[],
            options: { timeout?: number },
        ) => {
            receivedTimeout = options.timeout;
            return {
                pid: 1,
                output: [null, "", ""],
                stdout: "",
                stderr: "",
                status: null,
                signal: "SIGTERM",
                error: timeoutError,
            };
        }) as OmpCommandExecutionDeps["spawnSync"];

        const result = runOmpCommand(process.execPath, ["--version"], 10, { spawnSync });

        expect(receivedTimeout).toBe(10);
        expect(result.ok).toBe(false);
        expect(result.stderr).toBe(timeoutError.message);
    });

    it("[integration: real subprocess] captures JSON-sized output above Node's default buffer", () => {
        const result = runOmpCommand(process.execPath, [
            "-e",
            "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
        ]);
        expect(result.ok).toBe(true);
        expect(result.stdout.length).toBe(2 * 1024 * 1024);
    });
});
