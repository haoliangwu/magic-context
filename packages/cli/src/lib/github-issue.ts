import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** GitHub's documented maximum issue-body length. */
export const MAX_GITHUB_ISSUE_BODY_CHARS = 65_536;

export interface GhCommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export type GhCommandRunner = (args: string[]) => GhCommandResult;

export type GithubIssueFailureReason =
    | "gh-not-installed"
    | "not-authenticated"
    | "body-too-large"
    | "body-unreadable"
    | "create-failed";

export type GithubIssueSubmission =
    | { ok: true; output: string }
    | { ok: false; reason: GithubIssueFailureReason; message: string };

function runGhCommand(args: string[]): GhCommandResult {
    try {
        const result = spawnSync("gh", args, {
            windowsHide: true,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return {
            status: result.status,
            stdout: String(result.stdout ?? ""),
            stderr: String(result.stderr ?? ""),
        };
    } catch (error) {
        return {
            status: null,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
        };
    }
}

function failed(result: GhCommandResult): boolean {
    return result.status !== 0;
}

/**
 * Submit an issue through the GitHub CLI without putting report contents in a
 * shell command or a URL. The body is read from a file, so markdown fences,
 * backticks, and control characters remain data rather than syntax.
 *
 * The runner is injectable so tests can exercise every failure class without
 * invoking the real GitHub CLI or creating a remote issue.
 */
export function submitGithubIssue(
    title: string,
    bodyPath: string,
    runner: GhCommandRunner = runGhCommand,
): GithubIssueSubmission {
    let body: string;
    try {
        body = readFileSync(bodyPath, "utf-8");
    } catch (error) {
        return {
            ok: false,
            reason: "body-unreadable",
            message: `The diagnostics file could not be read (${error instanceof Error ? error.message : String(error)}).`,
        };
    }

    // Check both JavaScript characters and UTF-8 bytes. GitHub documents a
    // character limit, while the API also rejects an oversized encoded payload;
    // the report builder normally leaves enough room for either interpretation.
    if (
        Array.from(body).length > MAX_GITHUB_ISSUE_BODY_CHARS ||
        Buffer.byteLength(body, "utf8") > MAX_GITHUB_ISSUE_BODY_CHARS
    ) {
        return {
            ok: false,
            reason: "body-too-large",
            message: `The GitHub issue body is larger than GitHub's ${MAX_GITHUB_ISSUE_BODY_CHARS.toLocaleString()}-character limit.`,
        };
    }

    const installed = runner(["--version"]);
    if (failed(installed)) {
        return {
            ok: false,
            reason: "gh-not-installed",
            message: "The GitHub CLI (gh) is not installed or could not be started.",
        };
    }

    const auth = runner(["auth", "status", "--hostname", "github.com"]);
    if (failed(auth)) {
        return {
            ok: false,
            reason: "not-authenticated",
            message: "gh is not authenticated. Run `gh auth login` before submitting an issue.",
        };
    }

    const result = runner([
        "issue",
        "create",
        "-R",
        "cortexkit/magic-context",
        "--title",
        title,
        "--body-file",
        bodyPath,
    ]);
    if (result.status === 0) {
        return { ok: true, output: result.stdout.trim() };
    }

    const details = result.stderr.trim() || result.stdout.trim();
    return {
        ok: false,
        reason: "create-failed",
        message: details
            ? `GitHub issue creation failed: ${details}`
            : "GitHub issue creation failed: gh returned a non-zero status.",
    };
}

/** Add a local-file fallback to a submission failure without losing its cause. */
export function formatGithubIssueFallback(
    submission: Extract<GithubIssueSubmission, { ok: false }>,
    fallbackPath: string,
): string {
    return `${submission.message} The sanitized diagnostics are saved at ${fallbackPath}; open https://github.com/cortexkit/magic-context/issues/new and drag that file into the issue before submitting manually.`;
}
