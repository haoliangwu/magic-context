import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openCodeHostGenerationFromVersion } from "@magic-context/core/shared/opencode-db-path";
import { writeTestExecutable } from "@magic-context/core/shared/test-fake-executable";
import { detectOpenCodeInstallations } from "./opencode-detect";
import {
    describeOpenCodeInstallations,
    getAvailableModels,
    getOpenCodeCommandInvocation,
    getOpenCodeVersion,
    OPENCODE_VERSION_PROBE_TIMEOUT_MS,
    selectOpenCodeStoreHost,
} from "./opencode-helpers";

// These assert that a RESOLVED absolute binary path is actually invoked (the
// #196 follow-up: a stock CLI not on PATH must still enumerate). POSIX-only:
// the test writes an executable shell stub, which CI runs on Linux/macOS.
const isPosix = process.platform !== "win32";
const originalComSpec = process.env.ComSpec;
const originalPathExpansionProbe = process.env.MC_OPENCODE_TEST_PATH;

afterEach(() => {
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
    if (originalPathExpansionProbe === undefined) delete process.env.MC_OPENCODE_TEST_PATH;
    else process.env.MC_OPENCODE_TEST_PATH = originalPathExpansionProbe;
});

describe("OpenCode installation reports", () => {
    it("enumerates versions for both installs and marks PATH as active", () => {
        const pathBin = "/virtual/PATH/opencode";
        const home = "/virtual/home";
        const homeBin = join(home, ".opencode", "bin", "opencode");
        const installations = detectOpenCodeInstallations({
            exists: () => false,
            isExecutable: (path) => path === pathBin || path === homeBin,
            home,
            platform: "darwin",
            env: {},
            onPath: () => pathBin,
            realpath: (path) => path,
        });
        const versionProbes: string[] = [];

        expect(
            describeOpenCodeInstallations(installations, {
                getVersion: (path) => {
                    versionProbes.push(path);
                    return path === pathBin ? "1.18.0" : path === homeBin ? "1.15.13" : null;
                },
            }),
        ).toEqual([
            { path: pathBin, source: "PATH", kind: "cli", version: "1.18.0", active: true },
            { path: homeBin, source: "home-bin", kind: "cli", version: "1.15.13", active: false },
        ]);
        expect(versionProbes).toEqual([pathBin, homeBin]);
    });

    it("checks the store against OpenChamber's OpenCode 2 when an OpenCode 1 is first on PATH", () => {
        const pathBin = "/virtual/PATH/opencode";
        const chamberBin = "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode";
        const installations = detectOpenCodeInstallations({
            exists: () => false,
            isExecutable: (path) => path === pathBin || path === chamberBin,
            home: "/virtual/home",
            platform: "darwin",
            env: {},
            onPath: () => pathBin,
            realpath: (path) => path,
        });
        const reports = describeOpenCodeInstallations(installations, {
            getVersion: (path) => (path === pathBin ? "1.18.32" : "2.0.15"),
        });
        expect(reports.map((report) => [report.source, report.active])).toEqual([
            ["PATH", true],
            ["openchamber", false],
        ]);

        const selected = selectOpenCodeStoreHost(reports, openCodeHostGenerationFromVersion);
        expect(selected?.shadowed).toBe(true);
        expect(selected?.host.path).toBe(chamberBin);
        expect(selected?.host.version).toBe("2.0.15");
    });

    it("keeps the active install for store checks when no OpenCode 2 CLI shadows it", () => {
        const report = (path: string, version: string, active: boolean) => ({
            path,
            source: "PATH" as const,
            kind: "cli" as const,
            version,
            active,
        });
        const v1Only = [
            report("/a/opencode", "1.18.32", true),
            report("/b/opencode", "1.15.0", false),
        ];
        expect(selectOpenCodeStoreHost(v1Only, openCodeHostGenerationFromVersion)).toEqual({
            host: v1Only[0]!,
            shadowed: false,
        });
        const v2First = [
            report("/a/opencode", "2.0.16", true),
            report("/b/opencode", "1.18.32", false),
        ];
        expect(selectOpenCodeStoreHost(v2First, openCodeHostGenerationFromVersion)).toEqual({
            host: v2First[0]!,
            shadowed: false,
        });
        expect(selectOpenCodeStoreHost([], openCodeHostGenerationFromVersion)).toBeNull();
    });
});

// Stubs are content-addressed and shared across runs (see writeTestExecutable),
// so they are never removed in afterEach.
function fakeOpencode(body: string): string {
    return writeTestExecutable("opencode", `#!/bin/sh\n${body}\n`);
}

// The directory prefix deliberately contains a percent-variable and `&` so the
// cmd invocation is proven to quote the shim path instead of expanding it.
const SHIM_DIR_PREFIX = "mc %MC_OPENCODE_TEST_PATH% & shim ";

function fakeOpenCodeCommandShim(): string {
    if (process.platform === "win32") {
        return writeTestExecutable(
            "opencode.cmd",
            [
                "@echo off",
                'if "%~1"=="--version" (',
                "  echo 1.18.7",
                ') else if "%~1"=="models" (',
                "  echo anthropic/claude-opus-4-8",
                "  echo openai/gpt-5.5",
                ")",
            ].join("\r\n"),
            { dirPrefix: SHIM_DIR_PREFIX },
        );
    }

    // POSIX has no cmd.exe: a fake ComSpec answers instead, and the shim path
    // beside it only needs to exist as a string ending in .cmd.
    const comSpec = writeTestExecutable(
        "fake-cmd",
        '#!/bin/sh\ncase "$5" in\n  *--version*) echo "1.18.7" ;;\n  *models*) printf "anthropic/claude-opus-4-8\\nopenai/gpt-5.5\\n" ;;\nesac\n',
        { dirPrefix: SHIM_DIR_PREFIX },
    );
    process.env.ComSpec = comSpec;
    return join(dirname(comSpec), "opencode.cmd");
}

describe("OpenCode command execution", () => {
    it("routes cmd and bat shims through ComSpec", () => {
        process.env.ComSpec = "custom-cmd.exe";

        expect(getOpenCodeCommandInvocation("C:\\npm\\opencode.CMD", ["--version"])).toEqual({
            command: "custom-cmd.exe",
            args: ["/d", "/s", "/v:off", "/c", '""%MAGIC_CONTEXT_OPENCODE_BINARY%" "--version""'],
            env: { MAGIC_CONTEXT_OPENCODE_BINARY: "C:\\npm\\opencode.CMD" },
            windowsVerbatimArguments: true,
        });
        expect(getOpenCodeCommandInvocation("C:\\npm\\opencode.bat", ["models"])).toEqual({
            command: "custom-cmd.exe",
            args: ["/d", "/s", "/v:off", "/c", '""%MAGIC_CONTEXT_OPENCODE_BINARY%" "models""'],
            env: { MAGIC_CONTEXT_OPENCODE_BINARY: "C:\\npm\\opencode.bat" },
            windowsVerbatimArguments: true,
        });
    });

    it("invokes native executables directly", () => {
        expect(getOpenCodeCommandInvocation("/usr/local/bin/opencode", ["--version"])).toEqual({
            command: "/usr/local/bin/opencode",
            args: ["--version"],
        });
    });

    it("executes a cmd shim for version and model probes", () => {
        process.env.MC_OPENCODE_TEST_PATH = "expanded-to-the-wrong-path";
        const shim = fakeOpenCodeCommandShim();

        // Invocation shape is under test, not the probe budget (covered by the
        // hanging-probe test below); a loaded host can take >2s just to spawn sh.
        expect(getOpenCodeVersion(shim, 30_000)).toBe("1.18.7");
        expect(getAvailableModels(shim)).toEqual(["anthropic/claude-opus-4-8", "openai/gpt-5.5"]);
    });
});

describe.if(isPosix)("opencode helpers with a resolved binary path", () => {
    it("getAvailableModels invokes the given absolute binary", () => {
        const bin = fakeOpencode(
            'if [ "$1" = "models" ]; then printf "anthropic/claude-opus-4-8\\nopenai/gpt-5.5\\n"; fi',
        );
        expect(getAvailableModels(bin)).toEqual(["anthropic/claude-opus-4-8", "openai/gpt-5.5"]);
    });

    it("getOpenCodeVersion invokes the given absolute binary", () => {
        const bin = fakeOpencode('if [ "$1" = "--version" ]; then echo "1.2.3"; fi');
        expect(getOpenCodeVersion(bin)).toBe("1.2.3");
    });

    it("bounds a hanging version probe", () => {
        const bin = fakeOpencode("sleep 5");
        const started = performance.now();
        expect(getOpenCodeVersion(bin)).toBeNull();
        expect(performance.now() - started).toBeLessThan(OPENCODE_VERSION_PROBE_TIMEOUT_MS + 1_500);
    });

    it("returns empty / null when the binary path does not exist", () => {
        const missing = join(tmpdir(), "definitely-not-a-real-opencode-binary-xyz");
        expect(getAvailableModels(missing)).toEqual([]);
        expect(getOpenCodeVersion(missing)).toBeNull();
    });
});
