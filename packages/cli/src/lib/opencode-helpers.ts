import { execFileSync, execSync } from "node:child_process";
import { extname } from "node:path";
import type { OpenCodeInstallation } from "./opencode-detect";

export interface OpenCodeCommandInvocation {
    command: string;
    args: string[];
    env?: Record<string, string>;
    windowsVerbatimArguments?: true;
}

const OPENCODE_BINARY_ENV = "MAGIC_CONTEXT_OPENCODE_BINARY";

export function getOpenCodeCommandInvocation(
    binary: string,
    args: string[],
): OpenCodeCommandInvocation {
    const extension = extname(binary).toLowerCase();
    if (extension !== ".cmd" && extension !== ".bat") {
        return { command: binary, args };
    }

    const command = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
    // cmd.exe needs the /c payload as one outer-quoted command string. Pass the
    // binary through the child environment so percent signs in a valid path are
    // not treated as another variable expansion. Current callers only supply the
    // fixed `--version` and `models` arguments.
    const commandLine = [`%${OPENCODE_BINARY_ENV}%`, ...args].map((part) => `"${part}"`).join(" ");
    return {
        command,
        args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
        env: { [OPENCODE_BINARY_ENV]: binary },
        windowsVerbatimArguments: true,
    };
}

/**
 * Run `opencode <args>`. If a `binary` path is given (an absolute path resolved
 * for a stock `~/.opencode/bin` install or a version-manager shim that is not on
 * PATH), invoke that exact path; otherwise fall back to a bare
 * `opencode` on PATH.
 */
function runOpenCode(args: string[], binary?: string | null, timeoutMs?: number): string | null {
    try {
        const options = {
            stdio: "pipe" as const,
            windowsHide: true,
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
        };
        if (binary) {
            const invocation = getOpenCodeCommandInvocation(binary, args);
            return execFileSync(invocation.command, invocation.args, {
                ...options,
                ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
                ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            })
                .toString()
                .trim();
        }
        return execSync(`opencode ${args.join(" ")}`, options)
            .toString()
            .trim();
    } catch {
        return null;
    }
}

/**
 * Version probes must be bounded because a broken shim can wait forever. The
 * doctor probes every detected install, so a per-process timeout is important.
 */
export const OPENCODE_VERSION_PROBE_TIMEOUT_MS = 2_000;

export function getOpenCodeVersion(
    binary?: string | null,
    // Tests that only verify shim/binary invocation pass a generous budget: a
    // shell spawn under a loaded host can exceed the production probe timeout,
    // and the timeout itself has its own dedicated test.
    timeoutMs: number = OPENCODE_VERSION_PROBE_TIMEOUT_MS,
): string | null {
    return runOpenCode(["--version"], binary, timeoutMs);
}

export interface OpenCodeInstallationReport extends OpenCodeInstallation {
    version: string;
    active: boolean;
}

export interface DescribeOpenCodeInstallationsDeps {
    /** Version probe used for CLI installs; defaults to the real OpenCode command. */
    getVersion?: (binary: string) => string | null;
}

/** Probe versions for all detected installs, retaining the detection order. */
export function describeOpenCodeInstallations(
    installations: OpenCodeInstallation[],
    deps: DescribeOpenCodeInstallationsDeps = {},
): OpenCodeInstallationReport[] {
    const getVersion = deps.getVersion ?? getOpenCodeVersion;
    return installations.map((installation, index) => ({
        ...installation,
        version:
            installation.kind === "cli" ? (getVersion(installation.path) ?? "unknown") : "unknown",
        active: index === 0,
    }));
}

/**
 * Pick the install whose store checks should drive OpenCode 2 advice.
 *
 * The active install is whichever binary PATH resolves first, which is the right
 * one for plugin registration. It is not always the host the user runs: OpenChamber
 * bundles its own OpenCode 2 CLI, and an OpenCode 1 left on PATH shares the same
 * data directory with it. Store-conversion checks answered for OpenCode 1 in that
 * case describe a host that is not the one converting the store, so they are asked
 * of the first OpenCode 2 CLI that was found instead.
 *
 * Returns the active install when it is already OpenCode 2, when it reported no
 * version (Desktop), or when no OpenCode 2 CLI was found. `shadowed` is true only
 * when a different install was picked.
 */
export function selectOpenCodeStoreHost(
    reports: readonly OpenCodeInstallationReport[],
    generationOf: (version: string) => "v1" | "v2",
): { host: OpenCodeInstallationReport; shadowed: boolean } | null {
    const active = reports[0];
    if (!active) return null;
    const hasVersion = (report: OpenCodeInstallationReport) => /\d/.test(report.version);
    if (!hasVersion(active) || generationOf(active.version) === "v2") {
        return { host: active, shadowed: false };
    }
    const v2 = reports.find(
        (report) =>
            report.kind === "cli" && hasVersion(report) && generationOf(report.version) === "v2",
    );
    return v2 ? { host: v2, shadowed: true } : { host: active, shadowed: false };
}

export function getAvailableModels(binary?: string | null): string[] {
    const output = runOpenCode(["models"], binary);
    if (output === null) return [];
    return output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}
