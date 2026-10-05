/**
 * Read git commit history from a working directory using `git log`.
 *
 * Wraps a single `git log` invocation with controlled flags and parses the
 * delimited output. Runs synchronously with a timeout guard — indexing
 * happens on a plugin timer, not on the hot transform path, so blocking for
 * a few hundred milliseconds once per refresh is acceptable.
 *
 * Parsing contract:
 *   - We request `--format=%H%x1f%s%x1f%ae%x1f%ct%x1f%b%x1e`:
 *       %H = full object name (40 hex chars, or 64 in a SHA-256 repository)
 *       %s = subject (one line)
 *       %ae = author email
 *       %ct = committer time (seconds since epoch)
 *       %b = body (multi-line)
 *     Fields are separated by US (0x1f, ASCII Unit Separator), records by RS
 *     (0x1e, ASCII Record Separator). We deliberately AVOID NUL (0x00) here:
 *     Node's `child_process.execFile` validation rejects argv elements that
 *     contain embedded NUL bytes ("must be a string without null bytes"),
 *     even when the underlying program (git) would happily accept them via
 *     other entry points. Bun's execFile is more permissive, which masked
 *     this in unit tests until live OpenCode runtime exposed it. US/RS
 *     never appear naturally in commit subjects, emails, or bodies.
 *   - Subject + trimmed body combine into the searchable message.
 *   - We skip merge commits via `--no-merges` so merge "Merge branch 'x'"
 *     noise doesn't fill the index.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../../../shared/logger";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
/** Hard cap on commits returned per invocation. Indexer loops with since-filter
 *  if it needs more history. */
const DEFAULT_MAX_COMMITS = 5000;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
/** A full SHA-1 (40 hex) or SHA-256 (64 hex) object name, as printed by `%H`. */
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Why `git log` produced no commits, when it failed. `not_a_repo` and
 * `no_head` (a repo with zero commits) are structural: retrying every sweep
 * tick cannot succeed and only floods the log, so callers put the project on
 * a long re-probe cooldown instead. `transient` covers everything else
 * (timeouts, missing git binary, permission errors) and keeps the normal
 * retry cadence.
 */
export type GitLogFailureKind = "not_a_repo" | "no_head" | "transient";

export function classifyGitLogFailure(message: string): GitLogFailureKind {
    if (message.includes("not a git repository")) return "not_a_repo";
    if (
        message.includes("unknown revision or path not in the working tree") ||
        message.includes("does not have any commits yet") ||
        message.includes("bad revision")
    ) {
        return "no_head";
    }
    return "transient";
}

export interface GitCommit {
    /** Full object name: 40 hex chars, or 64 in a SHA-256 repository. */
    sha: string;
    /** First 7 chars of SHA for display. */
    shortSha: string;
    /** Subject + body, joined with a blank line when body exists. */
    message: string;
    /** Author email, or null when unavailable. */
    author: string | null;
    /** Committer time in milliseconds since epoch. */
    committedAtMs: number;
}

export interface ReadGitCommitsOptions {
    /** Only include commits newer than this (milliseconds since epoch). */
    sinceMs?: number;
    /** Only include commits reachable from HEAD (the default). */
    branch?: string;
    /** Hard cap on returned commits. Default 5000. */
    maxCommits?: number;
    /**
     * Full name of a commit whose history is already indexed. Commits
     * reachable from it are skipped, so an incremental read returns exactly
     * the commits that became reachable since, including merged branch
     * commits whose dates are older than anything indexed. Ignored when it
     * is not a full object name; when the object no longer exists (rewritten
     * and garbage-collected), the read falls back to no exclusion.
     */
    excludeReachableFrom?: string;
    /**
     * Project identity (`git:<sha>` / `dir:<hash>`) used ONLY for log
     * correlation. We never log the absolute `directory` — it carries the
     * username + project name (privacy, and these logs flow into
     * `doctor --issue` reports). When omitted, logs fall back to a neutral
     * "<project>" placeholder.
     */
    projectIdentity?: string;
}

/**
 * Read commits reachable from HEAD (or `branch` when provided) up to
 * `maxCommits`, optionally filtered by `sinceMs`. Returns an empty array
 * when git is unavailable or the directory is not a repo. Does NOT throw
 * on non-zero git exit — logs and returns empty so indexing failures
 * never crash the plugin.
 */
export async function readGitCommits(
    directory: string,
    options: ReadGitCommitsOptions = {},
): Promise<GitCommit[]> {
    return (await readGitCommitsResult(directory, options)).commits;
}

/**
 * Like {@link readGitCommits}, but also reports WHY the read failed so the
 * sweep can distinguish structurally non-indexable directories (not a repo,
 * repo with no commits) from transient errors. `failure` is null on success —
 * including a successful read that matched zero commits.
 */
export async function readGitCommitsResult(
    directory: string,
    options: ReadGitCommitsOptions = {},
): Promise<{ commits: GitCommit[]; failure: GitLogFailureKind | null }> {
    // Guard against argument injection: a `branch` value beginning with `-`
    // would be parsed as a git OPTION (not a revision) since it sits ahead of
    // the format/since flags below. No shell is involved (execFile), so this
    // was never command injection — but the exported contract invites future
    // untrusted `branch` callers. A `--` ahead of the revision would make git
    // read it as a PATHSPEC, so we validate instead. (`HEAD`, `main`,
    // `refs/heads/x`, `a1b2c3d` all pass.)
    const revision = options.branch ?? "HEAD";
    if (revision.startsWith("-")) {
        throw new Error(
            `readGitCommits: refusing revision that looks like an option: "${revision}"`,
        );
    }
    // Privacy: logs identify the project by its opaque identity, never the
    // absolute cwd (which carries the username + project name and lands in
    // doctor --issue reports).
    const projectLabel = options.projectIdentity ?? "<project>";
    const exclusion =
        options.excludeReachableFrom && FULL_OBJECT_NAME.test(options.excludeReachableFrom)
            ? options.excludeReachableFrom
            : null;
    const args = [
        "log",
        revision,
        ...(exclusion ? [`^${exclusion}`] : []),
        "--no-merges",
        `--max-count=${options.maxCommits ?? DEFAULT_MAX_COMMITS}`,
        `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    ];
    if (options.sinceMs !== undefined && options.sinceMs > 0) {
        // git accepts ISO 8601 to --since
        const iso = new Date(options.sinceMs).toISOString();
        args.push(`--since=${iso}`);
    }
    // A trailing `--` with no paths after it tells git every argument above is
    // a revision. Without it, a worktree file named like the revision (e.g.
    // `HEAD`) fails with "ambiguous argument" on every sweep.
    args.push("--");

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, {
            windowsHide: true,
            cwd: directory,
            timeout: GIT_TIMEOUT_MS,
            // Default buffer is 1MB; bump to 32MB for large repos. Commits are
            // small but history can be long.
            maxBuffer: 32 * 1024 * 1024,
            encoding: "utf8",
        });
        stdout = result.stdout;
    } catch (error) {
        // Intentional: git may not be installed, directory may not be a repo,
        // or the invocation may time out. All are "skip indexing this cycle"
        // conditions, not crashes. We return empty; transient failures retry
        // next sweep, structural ones (classified below) go on a long cooldown.
        // We DO log the reason though — a silent empty-result masked a real
        // cwd / PATH / timeout bug during the v0.14 git-commits rollout.
        const message = error instanceof Error ? error.message : String(error);
        if (exclusion && message.includes("bad object")) {
            // The excluded commit is gone, so it no longer bounds anything:
            // read the full window and let the upsert skip known commits.
            log(
                `[git-commits] indexed tip ${exclusion.slice(0, 7)} is missing for ${projectLabel}; reading the full window`,
            );
            return readGitCommitsResult(directory, { ...options, excludeReachableFrom: undefined });
        }
        const failure = classifyGitLogFailure(message);
        if (failure === "transient") {
            log(
                `[git-commits] readGitCommits failed for ${projectLabel}: ${message.slice(0, 500)}`,
            );
        } else {
            // One quiet line instead of the full multi-line git error: these
            // directories fail the same way every sweep and were flooding the
            // recent-errors section of doctor reports.
            log(`[git-commits] ${projectLabel} is not indexable (${failure})`);
        }
        return { commits: [], failure };
    }

    if (stdout.trim().length === 0) {
        log(
            `[git-commits] readGitCommits returned empty stdout for ${projectLabel} (sinceMs=${options.sinceMs ?? "none"} args=${args.slice(0, 4).join(" ")})`,
        );
    }

    return { commits: parseGitLogOutput(stdout), failure: null };
}

export function parseGitLogOutput(stdout: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const records = stdout.split(RECORD_SEPARATOR);

    for (const rawRecord of records) {
        const record = rawRecord.replace(/^\s+/, "");
        if (!record) continue;

        // Split only on the first 4 FIELD_SEPARATOR occurrences so an embedded
        // \x1f inside the commit body doesn't truncate the body at the first
        // such byte. JavaScript's split(sep, limit) caps the output array
        // rather than capping the split count, so we split manually.
        const fields: string[] = [];
        let remaining = record;
        for (let i = 0; i < 4; i++) {
            const idx = remaining.indexOf(FIELD_SEPARATOR);
            if (idx < 0) break;
            fields.push(remaining.slice(0, idx));
            remaining = remaining.slice(idx + FIELD_SEPARATOR.length);
        }
        fields.push(remaining); // the body (may contain further \x1f bytes)
        if (fields.length < 5) continue;

        const sha = fields[0].trim();
        const subject = fields[1].trim();
        const author = fields[2].trim();
        const timeSec = Number.parseInt(fields[3].trim(), 10);
        const body = fields[4].trim();

        if (!FULL_OBJECT_NAME.test(sha) || !Number.isFinite(timeSec) || timeSec <= 0) {
            continue;
        }

        const message = body.length > 0 ? `${subject}\n\n${body}` : subject;

        commits.push({
            sha,
            shortSha: sha.slice(0, 7),
            message,
            author: author.length > 0 ? author : null,
            committedAtMs: timeSec * 1000,
        });
    }

    return commits;
}
