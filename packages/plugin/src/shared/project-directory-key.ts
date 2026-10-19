import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Normalize Windows-formatted directory paths consistently, even on a non-Windows OS.
 *
 * Spelling only, no filesystem access: separators become `/`, the `\\?\` and
 * `\\?\UNC\` long-path prefixes are dropped, a trailing separator is removed and
 * the result is lowercased, because Windows paths are case-insensitive. A POSIX
 * path is resolved to an absolute path, which also drops a trailing slash.
 */
export function projectDirectoryKey(directory: string): string {
    const slashed = directory
        .replaceAll("\\", "/")
        .replace(/^\/\/\?\/UNC\//i, "//")
        .replace(/^\/\/\?\//, "");
    if (/^[a-z]:\//i.test(slashed) || slashed.startsWith("//")) {
        return path.win32.normalize(slashed).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    }
    return path.resolve(directory);
}

/**
 * Whether two spellings name the same directory, judged by spelling alone.
 *
 * Hosts and the plugin do not agree on how to write a directory: OpenCode 2 on
 * Windows stores a session's directory as `D:/work/app` while the plugin's own
 * location is `D:\work\app`, and a drive letter can arrive in either case.
 * Both sides go through `projectDirectoryKey`, so separators, Windows case,
 * `\\?\` prefixes, trailing separators and `.`/`..` segments cannot make one
 * directory look like two. POSIX paths keep their case. Symlinks are not
 * resolved here; callers that must follow them use `canonicalProjectDirectory`.
 *
 * An empty spelling never matches anything: `path.resolve("")` is the process's
 * working directory, and a session with no recorded directory must not be
 * taken for one in the directory the process happens to run in.
 */
export function sameProjectDirectory(a: string, b: string): boolean {
    if (a.length === 0 || b.length === 0) return false;
    return projectDirectoryKey(a) === projectDirectoryKey(b);
}

let realpathForCanonicalDirectory: (directory: string) => string = (directory) =>
    realpathSync.native(directory);

/**
 * One spelling for a project directory, shared by everything that has to agree
 * on it across processes (the RPC server that writes its discovery file and the
 * TUI that looks the file up).
 *
 * The filesystem's own answer comes first where the directory exists:
 * `realpathSync.native` resolves symlinks (macOS `/var` → `/private/var`),
 * junctions, and Windows 8.3 short names (`AMMINI~1` → the long name). The
 * result then goes through `projectDirectoryKey`, so drive-letter case,
 * separators, `\\?\` prefixes and trailing separators cannot make two
 * spellings of one directory differ. A directory that cannot be resolved (it
 * no longer exists, or access is denied) falls back to its spelling alone.
 */
export function canonicalProjectDirectory(directory: string): string {
    let resolved = directory;
    try {
        resolved = realpathForCanonicalDirectory(directory);
    } catch {
        // Keep the given spelling; the key below still normalizes it.
    }
    return projectDirectoryKey(resolved);
}

/** Test seam: stand in for the filesystem's realpath (for example Windows 8.3 expansion). */
export function __setCanonicalDirectoryRealpathForTests(
    realpath?: (directory: string) => string,
): void {
    realpathForCanonicalDirectory = realpath ?? ((directory) => realpathSync.native(directory));
}
