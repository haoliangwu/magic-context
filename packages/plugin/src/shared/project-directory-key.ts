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
