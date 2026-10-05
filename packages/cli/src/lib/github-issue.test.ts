import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { formatGithubIssueFallback, type GhCommandResult, submitGithubIssue } from "./github-issue";

function makeTempReport(content: string): { root: string; path: string } {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-gh-issue-"));
    const path = join(root, "report.md");
    writeFileSync(path, content);
    return { root, path };
}

describe("submitGithubIssue", () => {
    it("names the unauthenticated cause and preserves the local fallback path", () => {
        const report = makeTempReport("## Diagnostics\nlog with `fences` and control-safe text");
        try {
            const calls: string[][] = [];
            const result = submitGithubIssue("title", report.path, (args): GhCommandResult => {
                calls.push(args);
                if (args[0] === "--version") {
                    return { status: 0, stdout: "gh version 2.0", stderr: "" };
                }
                return { status: 1, stdout: "", stderr: "not logged into any GitHub hosts" };
            });

            expect(result).toMatchObject({ reason: "not-authenticated" });
            if (result.ok) throw new Error("expected authentication failure");
            expect(result.message).toContain("not authenticated");
            expect(formatGithubIssueFallback(result, report.path)).toContain(report.path);
            expect(calls).toEqual([["--version"], ["auth", "status", "--hostname", "github.com"]]);
        } finally {
            rmSync(report.root, { recursive: true, force: true });
        }
    });

    it("detects an oversized body before transport and names the fallback path", () => {
        const report = makeTempReport("x".repeat(65_537));
        try {
            let invoked = false;
            const result = submitGithubIssue("title", report.path, () => {
                invoked = true;
                return { status: 0, stdout: "", stderr: "" };
            });

            expect(result).toMatchObject({ reason: "body-too-large" });
            if (result.ok) throw new Error("expected body-size failure");
            expect(result.message).toContain("65,536-character limit");
            expect(formatGithubIssueFallback(result, report.path)).toContain(report.path);
            expect(invoked).toBe(false);
        } finally {
            rmSync(report.root, { recursive: true, force: true });
        }
    });

    it("passes markdown as a body file instead of interpolating it into a URL or shell", () => {
        const report = makeTempReport("## Diagnostics\n```\ncontrol\u0001 text\n```");
        try {
            const calls: string[][] = [];
            const result = submitGithubIssue("title with `fence`", report.path, (args) => {
                calls.push(args);
                if (args[0] === "issue") {
                    return {
                        status: 0,
                        stdout: "https://github.com/cortexkit/magic-context/issues/1",
                        stderr: "",
                    };
                }
                return { status: 0, stdout: "gh ok", stderr: "" };
            });

            expect(result).toEqual({
                ok: true,
                output: "https://github.com/cortexkit/magic-context/issues/1",
            });
            expect(calls[2]).toEqual([
                "issue",
                "create",
                "-R",
                "cortexkit/magic-context",
                "--title",
                "title with `fence`",
                "--body-file",
                report.path,
            ]);
        } finally {
            rmSync(report.root, { recursive: true, force: true });
        }
    });

    it("names a transport failure instead of exposing a bare gh error", () => {
        const report = makeTempReport("small report");
        try {
            const result = submitGithubIssue("title", report.path, (args) => {
                if (args[0] === "issue") {
                    return { status: 1, stdout: "", stderr: "Error: unable to create Issue" };
                }
                return { status: 0, stdout: "", stderr: "" };
            });

            expect(result).toMatchObject({ reason: "create-failed" });
            if (result.ok) throw new Error("expected transport failure");
            expect(result.message).toBe(
                "GitHub issue creation failed: Error: unable to create Issue",
            );
            expect(formatGithubIssueFallback(result, report.path)).toContain(report.path);
        } finally {
            rmSync(report.root, { recursive: true, force: true });
        }
    });
});
