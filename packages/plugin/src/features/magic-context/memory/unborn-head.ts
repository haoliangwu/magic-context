/**
 * Recognize a git repository with no commits yet (an "unborn" HEAD) by reading its
 * metadata files, without starting git.
 *
 * Right after `git init` there is no root commit, so the project identity falls back to
 * the directory hash until the first commit. Deciding that through git needed up to three
 * git processes, each with a timeout. When the first one ran into its timeout (seen on
 * Windows, where a synchronous git call can stall), the repository was treated as "git
 * temporarily unavailable", which pauses memory features instead of using the directory
 * identity. A freshly initialized repository is simple enough to recognize from its files,
 * so this answers that one question without git.
 *
 * The answer is `true` only when the layout is the plain one `git init` or
 * `git worktree add --orphan` leaves behind: HEAD names a branch under `refs/heads/`, and
 * that branch has neither a loose ref file nor a `packed-refs` line. Everything unusual
 * (a detached HEAD, reftable or any other configured ref storage, unreadable or malformed
 * files, git location overrides in the environment) answers `false`, which means "ask git",
 * so git still decides every case this reader does not fully understand.
 *
 * The Rust module (`crates/mc-module/src/project_identity.rs`) carries the same rules;
 * `testdata/unborn-head-parity.json` holds the cases both implementations must agree on.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Environment variables that move or limit where git looks for the repository. When any
 * is set, the `.git` found by walking up from the directory may not be the one git uses.
 */
const GIT_LOCATION_ENV_VARS = [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_CEILING_DIRECTORIES",
] as const;

type ReadResult = { ok: true; text: string } | { ok: false; missing: boolean };

function errorCode(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function readText(file: string): ReadResult {
    try {
        return { ok: true, text: readFileSync(file, "utf8") };
    } catch (error) {
        return { ok: false, missing: errorCode(error) === "ENOENT" };
    }
}

type EntryKind = "file" | "directory" | "other" | "missing" | "error";

function entryKind(entry: string): EntryKind {
    try {
        const stat = statSync(entry);
        if (stat.isFile()) return "file";
        if (stat.isDirectory()) return "directory";
        return "other";
    } catch (error) {
        return errorCode(error) === "ENOENT" ? "missing" : "error";
    }
}

/** Drop one trailing line ending, as git does when it reads these one-line files. */
function stripLineEnding(text: string): string {
    return text.replace(/\r?\n$/u, "");
}

/** A path inside a git metadata file, which git resolves against that file's directory. */
function resolveMetadataPath(baseDirectory: string, value: string): string {
    return path.resolve(baseDirectory, value);
}

/**
 * A branch name git itself would accept after `refs/heads/`. Anything stranger makes the
 * caller ask git instead of guessing how git treats it (reftable repositories, for
 * instance, point HEAD at the deliberately invalid `refs/heads/.invalid`).
 */
function isPlainBranchName(name: string): boolean {
    if (name.length === 0 || name.endsWith("/") || name.endsWith(".")) return false;
    if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
    for (const character of name) {
        const code = character.charCodeAt(0);
        // Git refuses control characters, spaces, DEL and these punctuation marks in ref names.
        if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character)) return false;
    }
    return name
        .split("/")
        .every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
}

/**
 * Locate the git directory for `start`: the nearest `.git` at or above it. A `.git`
 * directory is used as is; a `.git` file (linked worktrees, submodules) must hold a single
 * `gitdir: <path>` line. Returns undefined when nothing usable is found.
 */
function findGitDirectory(start: string): string | undefined {
    let current = start;
    while (true) {
        const dotGit = path.join(current, ".git");
        const kind = entryKind(dotGit);
        if (kind === "directory") return dotGit;
        if (kind === "file") {
            const read = readText(dotGit);
            if (!read.ok) return undefined;
            const match = /^gitdir: (.+)$/u.exec(stripLineEnding(read.text));
            if (!match?.[1] || match[1].includes("\n")) return undefined;
            return resolveMetadataPath(current, match[1]);
        }
        if (kind !== "missing") return undefined;
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

/** True when `packed-refs` text lists `ref`; undefined when the file has lines this reader does not understand. */
function packedRefsList(text: string, ref: string): boolean | undefined {
    for (const rawLine of text.split("\n")) {
        const line = rawLine.replace(/\r$/u, "");
        if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
        const match = /^[0-9a-f]{40,64} (\S+)$/u.exec(line);
        if (!match) return undefined;
        if (match[1] === ref) return true;
    }
    return false;
}

/**
 * Read the repository layout around `directory` (already resolved to its real path) and
 * report whether its HEAD is unborn. Ignores the environment; see
 * {@link isUnbornHeadOnDisk} for the full check.
 */
export function isUnbornHeadInLayout(directory: string): boolean {
    const gitDirectory = findGitDirectory(directory);
    if (gitDirectory === undefined) return false;

    // Linked worktrees keep HEAD in their own git directory and share branches, objects
    // and configuration through the directory named in `commondir`.
    let commonDirectory = gitDirectory;
    const commondir = readText(path.join(gitDirectory, "commondir"));
    if (commondir.ok) {
        const value = stripLineEnding(commondir.text);
        if (value === "" || value.includes("\n")) return false;
        commonDirectory = resolveMetadataPath(gitDirectory, value);
    } else if (!commondir.missing) {
        return false;
    }

    // Git only accepts a directory as a repository when it has HEAD, objects and refs.
    if (entryKind(path.join(gitDirectory, "HEAD")) !== "file") return false;
    if (entryKind(path.join(commonDirectory, "objects")) !== "directory") return false;
    if (entryKind(path.join(commonDirectory, "refs")) !== "directory") return false;

    // Branches stored somewhere other than loose files and packed-refs cannot be read here.
    if (entryKind(path.join(commonDirectory, "reftable")) !== "missing") return false;
    const config = readText(path.join(commonDirectory, "config"));
    if (config.ok) {
        if (/refstorage/iu.test(config.text)) return false;
    } else if (!config.missing) {
        return false;
    }

    const head = readText(path.join(gitDirectory, "HEAD"));
    if (!head.ok) return false;
    const headMatch = /^ref: (refs\/heads\/(.+))$/u.exec(head.text.replace(/\s+$/u, ""));
    const ref = headMatch?.[1];
    const branch = headMatch?.[2];
    if (!ref || branch === undefined || !isPlainBranchName(branch)) return false;

    // Any entry at the branch's loose ref path (a commit id, or something unexpected) is
    // left to git. Both directories are checked because per-worktree refs live beside HEAD.
    const refSegments = ref.split("/");
    for (const base of new Set([commonDirectory, gitDirectory])) {
        if (entryKind(path.join(base, ...refSegments)) !== "missing") return false;
    }

    const packed = readText(path.join(commonDirectory, "packed-refs"));
    if (packed.ok) {
        if (packedRefsList(packed.text, ref) !== false) return false;
    } else if (!packed.missing) {
        return false;
    }
    return true;
}

/**
 * Whether `directory` sits in a git repository whose HEAD has no commit yet, decided from
 * the metadata files alone. `false` means "not known to be unborn": the caller asks git.
 */
export function isUnbornHeadOnDisk(
    directory: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (GIT_LOCATION_ENV_VARS.some((name) => env[name] !== undefined && env[name] !== "")) {
        return false;
    }
    let realDirectory: string;
    try {
        // Git discovers the repository from the physical working directory.
        realDirectory = realpathSync.native(path.resolve(directory));
    } catch {
        return false;
    }
    return isUnbornHeadInLayout(realDirectory);
}
