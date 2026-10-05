import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only helper for fake executables (shell stubs standing in for opencode,
 * sqlite3, bun, ...).
 *
 * macOS runs a malware assessment the first time any new executable file is
 * launched. Writing a fresh stub into a fresh temp directory for every test
 * case therefore triggers one assessment per case per run. Instead, each
 * distinct stub lives at a fixed, content-addressed path and is written only
 * once; later tests and later runs reuse the same file.
 *
 * Callers must never delete these files in per-test cleanup, and must never
 * modify one in place: a test that needs a stub to "change" between steps asks
 * for a second stub with different content, which lands at a different path.
 */

/** Directory name under the OS temp dir that holds every shared fake executable. */
export const TEST_EXECUTABLE_ROOT_NAME = "magic-context-test-bin";

export function testExecutableRoot(): string {
    return join(tmpdir(), TEST_EXECUTABLE_ROOT_NAME);
}

export interface WriteTestExecutableOptions {
    /**
     * Kept verbatim in front of the hash in the directory name. Use it only when
     * the test depends on the directory name itself, for example to exercise
     * quoting of spaces or shell metacharacters in the executable's path.
     */
    dirPrefix?: string;
}

function assertSinglePathSegment(label: string, value: string, allowEmpty: boolean): void {
    if ((!allowEmpty && value.length === 0) || value === "." || value === "..") {
        throw new Error(`writeTestExecutable: invalid ${label} ${JSON.stringify(value)}`);
    }
    if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
        throw new Error(`writeTestExecutable: ${label} must be a single path segment`);
    }
}

function hasExpectedContent(path: string, content: string): boolean {
    try {
        if (readFileSync(path, "utf8") !== content) return false;
        // Windows has no executable bit, so content alone decides there.
        return process.platform === "win32" || (statSync(path).mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

/**
 * Returns the path of an executable named `name` whose bytes are `content`,
 * creating it only when no identical file exists yet. The path is
 * `<tmpdir>/magic-context-test-bin/<dirPrefix><first 16 hex of sha256(name, content)>/<name>`,
 * so each directory holds exactly one executable and pointing PATH at it
 * exposes nothing else.
 *
 * The file is written to a unique temporary name in the same directory and
 * then renamed into place, so concurrent test processes never observe a
 * half-written stub.
 */
export function writeTestExecutable(
    name: string,
    content: string,
    options: WriteTestExecutableOptions = {},
): string {
    const dirPrefix = options.dirPrefix ?? "";
    assertSinglePathSegment("name", name, false);
    assertSinglePathSegment("dirPrefix", dirPrefix, true);

    // The NUL separator keeps ("ab", "c") and ("a", "bc") from sharing a hash.
    const hash = createHash("sha256")
        .update(name)
        .update("\0")
        .update(content)
        .digest("hex")
        .slice(0, 16);
    const dir = join(testExecutableRoot(), `${dirPrefix}${hash}`);
    const target = join(dir, name);
    if (hasExpectedContent(target, content)) return target;

    mkdirSync(dir, { recursive: true });
    const staging = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
        writeFileSync(staging, content, { mode: 0o755 });
        // The process umask can strip bits from the create mode; set them explicitly.
        chmodSync(staging, 0o755);
        renameSync(staging, target);
    } catch (error) {
        rmSync(staging, { force: true });
        // Another process may have won the race with identical bytes (Windows
        // refuses to rename over a file that is currently open).
        if (hasExpectedContent(target, content)) return target;
        throw error;
    }
    return target;
}
