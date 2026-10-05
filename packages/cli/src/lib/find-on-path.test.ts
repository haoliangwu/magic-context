import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { writeTestExecutable } from "@magic-context/core/shared/test-fake-executable";
import { findOnPath } from "./find-on-path";

/**
 * Build an isolated PATH out of tmpdir-allocated bin directories so tests
 * don't depend on the host's real PATH (which would make the suite
 * order-dependent and brittle across CI envs).
 *
 * Each scenario stages its own set of dirs, installs marker files with the
 * expected permission bits, then sets process.env.PATH for the duration of
 * the test and restores it after.
 *
 * Executables come from writeTestExecutable: each lives alone in a shared,
 * content-addressed directory that is reused across runs and never removed by
 * the per-test cleanup below. Scenarios that need two distinct directories ask
 * for two different stub bodies.
 */
describe("findOnPath", () => {
    let originalPath: string | undefined;
    let tempRoot: string;
    const isWindows = process.platform === "win32";

    beforeEach(() => {
        originalPath = process.env.PATH;
        tempRoot = join(
            tmpdir(),
            `find-on-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        mkdirSync(tempRoot, { recursive: true });
    });

    afterEach(() => {
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        try {
            rmSync(tempRoot, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    /** Returns the stub's path; its directory is the PATH entry to use. */
    function makeExecutable(name: string, variant = ""): string {
        const body = isWindows ? `@echo off\n${variant}` : `#!/bin/sh\necho hi\n${variant}`;
        return writeTestExecutable(name, body);
    }

    function makeNonExecutable(dir: string, name: string): string {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, "not executable\n");
        if (!isWindows) chmodSync(path, 0o644);
        return path;
    }

    it("returns null when PATH is unset", () => {
        delete process.env.PATH;
        expect(findOnPath("opencode")).toBeNull();
    });

    it("returns null when PATH is empty", () => {
        process.env.PATH = "";
        expect(findOnPath("opencode")).toBeNull();
    });

    it("returns null when binary is nowhere on PATH", () => {
        const dir = join(tempRoot, "empty-bin");
        mkdirSync(dir, { recursive: true });
        process.env.PATH = dir;
        expect(findOnPath("nonexistent-binary-xyzzy")).toBeNull();
    });

    it("finds an executable in a single-entry PATH (POSIX/Windows)", () => {
        const binName = isWindows ? "opencode.exe" : "opencode";
        const expected = makeExecutable(binName);
        process.env.PATH = dirname(expected);

        const found = findOnPath("opencode");
        expect(found).toBe(expected);
    });

    it("returns the first match when binary exists in multiple PATH dirs", () => {
        const binName = isWindows ? "opencode.exe" : "opencode";
        const firstPath = makeExecutable(binName, "echo first\n");
        const secondPath = makeExecutable(binName, "echo second\n");
        const dir1 = dirname(firstPath);
        const dir2 = dirname(secondPath);
        process.env.PATH = `${dir1}${delimiter}${dir2}`;

        const found = findOnPath("opencode");
        expect(found).toBe(firstPath);
    });

    it("skips empty PATH segments without error", () => {
        const binName = isWindows ? "opencode.exe" : "opencode";
        const expected = makeExecutable(binName);
        const dir = dirname(expected);
        // PATH like ":dir:" — empty segments at start, middle, end
        process.env.PATH = `${delimiter}${dir}${delimiter}${delimiter}`;

        const found = findOnPath("opencode");
        expect(found).toBe(expected);
    });

    it.if(!isWindows)("returns null for non-executable files on POSIX", () => {
        const dir = join(tempRoot, "bin");
        makeNonExecutable(dir, "opencode");
        process.env.PATH = dir;
        expect(findOnPath("opencode")).toBeNull();
    });

    it.if(!isWindows)("follows symlinks to a real executable on POSIX", () => {
        const dir2 = join(tempRoot, "link");
        const realPath = makeExecutable("opencode");
        mkdirSync(dir2, { recursive: true });
        const linkPath = join(dir2, "opencode");
        symlinkSync(realPath, linkPath);
        process.env.PATH = dir2;

        const found = findOnPath("opencode");
        expect(found).toBe(linkPath);
    });

    it.if(!isWindows)("ignores broken symlinks on POSIX", () => {
        const dir = join(tempRoot, "broken");
        mkdirSync(dir, { recursive: true });
        const brokenLink = join(dir, "opencode");
        symlinkSync(join(tempRoot, "does-not-exist"), brokenLink);
        process.env.PATH = dir;

        expect(findOnPath("opencode")).toBeNull();
    });

    it.if(!isWindows)("recognizes wrapper scripts (regression for issue #75)", () => {
        // Reporter's case: PATH starts with a directory holding a custom
        // wrapper script that does env setup before invoking the real
        // opencode binary. The wrapper IS a regular executable file —
        // detection should succeed without caring about content.
        const wrapperPath = writeTestExecutable(
            "opencode",
            '#!/bin/sh\n# Wrapper that does mise env setup, then execs real opencode\nexec /usr/bin/opencode "$@"\n',
        );
        process.env.PATH = dirname(wrapperPath);

        const found = findOnPath("opencode");
        expect(found).toBe(wrapperPath);
    });

    it.if(!isWindows)("does not match directories named like the binary", () => {
        // Edge: someone has a directory called `opencode/` in a PATH entry.
        // statSync().isFile() must reject it.
        const dir = join(tempRoot, "bin");
        mkdirSync(join(dir, "opencode"), { recursive: true });
        process.env.PATH = dir;
        expect(findOnPath("opencode")).toBeNull();
    });

    it.if(isWindows)("tries .exe, .cmd, .bat, .com extensions on Windows", () => {
        // Install only a .cmd to verify extension fallback works.
        const cmdPath = makeExecutable("opencode.cmd");
        process.env.PATH = dirname(cmdPath);

        const found = findOnPath("opencode");
        expect(found).toBe(cmdPath);
    });

    it.if(isWindows)("prefers .exe over .cmd when both exist", () => {
        // Needs both extensions in one directory, which a content-addressed stub
        // directory never holds, so this Windows-only case stages its own files.
        // Windows has no executable bit and no macOS-style first-launch malware
        // scan, so fresh files here cost nothing.
        const dir = join(tempRoot, "bin");
        mkdirSync(dir, { recursive: true });
        const exePath = join(dir, "opencode.exe");
        writeFileSync(exePath, "@echo off\n");
        writeFileSync(join(dir, "opencode.cmd"), "@echo off\n");
        process.env.PATH = dir;

        const found = findOnPath("opencode");
        expect(found).toBe(exePath);
    });
});
