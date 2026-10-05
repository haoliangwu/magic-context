import { afterEach, describe, expect, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    describeUnresolvedProjectIdentity,
    isLinkedGitWorktree,
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
} from "./project-identity";

function tempDir(): string {
    return createTestTempDirFromPath(join(tmpdir(), "mc-identity-"));
}

function returningRootCommit(rootCommit: string): typeof execFileSync {
    return (() => `${rootCommit}\n`) as typeof execFileSync;
}

afterEach(() => {
    __resetProjectIdentityForTests();
});

describe("linked Git worktree detection", () => {
    test("compares the per-checkout git dir with the shared common dir once per directory", () => {
        const calls: string[] = [];
        __setProjectIdentityTestHooks({
            execFileSync: ((command: string, args: string[], options: { cwd?: string }) => {
                expect(command).toBe("git");
                expect(args).toEqual([
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-dir",
                    "--git-common-dir",
                ]);
                const directory = String(options.cwd);
                calls.push(directory);
                return directory.endsWith("linked")
                    ? "/repo/.git/worktrees/linked\n/repo/.git\n"
                    : "/repo/.git\n/repo/.git\n";
            }) as unknown as typeof execFileSync,
        });

        expect(isLinkedGitWorktree("/repo/primary")).toBe(false);
        expect(isLinkedGitWorktree("/repo/linked")).toBe(true);
        expect(isLinkedGitWorktree("/repo/linked")).toBe(true);
        expect(calls).toEqual(["/repo/primary", "/repo/linked"]);
    });
});

describe("resolveProjectIdentity directory fallback", () => {
    test("refuses the exact canonical home directory unless the user opts in", () => {
        expect(resolveProjectIdentityForSession(homedir())).toBeUndefined();
        expect(resolveProjectIdentityForSession(join(homedir(), "a-project"))).not.toBeUndefined();
    });

    // Agents read this text; it must name the home-directory rule and the opt-in,
    // not leave them to guess "no git repo" (which resolves fine).
    test("explains the home-directory refusal with the opt-in", () => {
        const reason = describeUnresolvedProjectIdentity(homedir());
        expect(reason).toContain("home directory");
        expect(reason).toContain("allow_home_project");
        expect(reason).not.toContain("git");
    });

    test("uses the canonical home directory's stable dir identity when opted in", () => {
        const canonicalHome = realpathSync.native(homedir());
        const expected = `dir:${createHash("md5").update(canonicalHome, "utf8").digest("hex").slice(0, 12)}`;

        expect(resolveProjectIdentityForSession(homedir(), true)).toBe(expected);
    });

    test("resolves a project identity when sandbox policy denies realpath for the home directory", () => {
        const project = tempDir();
        const deniedHome = tempDir();
        const originalNative = realpathSync.native;
        const permissionDenied = (): NodeJS.ErrnoException => {
            const error = new Error("sandbox denied realpath") as NodeJS.ErrnoException;
            error.code = "EPERM";
            return error;
        };
        __setProjectIdentityTestHooks({ homeDirectory: () => deniedHome });
        Object.defineProperty(realpathSync, "native", {
            configurable: true,
            value: (() => {
                throw permissionDenied();
            }) as typeof realpathSync.native,
        });

        try {
            const expected = `dir:${createHash("md5")
                .update(project, "utf8")
                .digest("hex")
                .slice(0, 12)}`;
            expect(resolveProjectIdentityForSession(project)).toBe(expected);
        } finally {
            Object.defineProperty(realpathSync, "native", {
                configurable: true,
                value: originalNative,
            });
            rmSync(project, { recursive: true, force: true });
            rmSync(deniedHome, { recursive: true, force: true });
        }
    });

    test("keeps a contained repository distinct from the home identity", () => {
        const contained = createTestTempDirFromPath(join(homedir(), "mc-home-identity-"));
        try {
            mkdirSync(join(contained, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
            const homeIdentity = resolveProjectIdentityForSession(homedir(), true);
            const containedIdentity = resolveProjectIdentityForSession(contained, true);

            expect(homeIdentity).toBeDefined();
            expect(containedIdentity).toBe("git:abc1234");
            expect(containedIdentity).not.toBe(homeIdentity);
        } finally {
            rmSync(contained, { recursive: true, force: true });
        }
    });

    test("requires home opt-in when a child inherits the home git repository", () => {
        const fakeHome = tempDir();
        const child = join(fakeHome, "nested", "project");
        try {
            mkdirSync(join(fakeHome, ".git"));
            mkdirSync(child, { recursive: true });
            __setProjectIdentityTestHooks({
                execFileSync: returningRootCommit("def5678"),
                homeDirectory: () => fakeHome,
            });
            // Opt-in permits memory, not a second identity for the home repository.
            const expectedHomeIdentity = "git:def5678";

            expect(resolveProjectIdentityForSession(fakeHome)).toBeUndefined();
            expect(resolveProjectIdentityForSession(child)).toBeUndefined();
            expect(resolveProjectIdentityForSession(fakeHome, true)).toBe(expectedHomeIdentity);
            expect(resolveProjectIdentityForSession(child, true)).toBe(expectedHomeIdentity);
        } finally {
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });
    test("flips dir: fallback to git: once a repo gains its first commit (no stale cache)", () => {
        const dir = tempDir();
        try {
            const first = resolveProjectIdentity(dir);
            expect(first).toMatch(/^dir:[0-9a-f]{12}$/);
            expect(resolveProjectIdentity(dir)).toBe(first);

            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });

            const second = resolveProjectIdentity(dir);
            expect(second).toBe("git:abc1234");
            expect(second).not.toBe(first);
            expect(resolveProjectIdentity(dir)).toBe(second);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("keeps the remembered git identity for a leftover worktree folder with no git metadata", () => {
        const dir = tempDir();
        const neverResolved = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("fedcba9") });
            expect(resolveProjectIdentity(dir)).toBe("git:fedcba9");

            // A new process sees only the durable sidecar. Removing the worktree's git
            // metadata leaves an empty folder that git no longer recognizes.
            __resetProjectIdentityForTests();
            rmSync(join(dir, ".git"), { recursive: true, force: true });
            expect(resolveProjectIdentity(dir)).toBe("git:fedcba9");
            expect(resolveProjectIdentityForSession(dir)).toBe("git:fedcba9");

            // A plain folder the plugin never resolved to git keeps its directory identity.
            expect(resolveProjectIdentity(neverResolved)).toBe(
                `dir:${createHash("md5").update(neverResolved, "utf8").digest("hex").slice(0, 12)}`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(neverResolved, { recursive: true, force: true });
        }
    });

    test("derives a deterministic identity from grafted-history repos (multiple root commits)", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            // Repos merged with --allow-unrelated-histories keep several live root
            // commits, and git's enumeration order varies by traversal. The identity
            // must be the lexicographic minimum of the SET, not the first line.
            __setProjectIdentityTestHooks({
                execFileSync: (() => "7e96b9e\n1e394c2\n4058752\n") as typeof execFileSync,
            });
            expect(resolveProjectIdentity(dir)).toBe("git:1e394c2");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reuses a parent repository identity for subdirectory transient git failures", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("def5678") });
            const parentIdentity = resolveProjectIdentity(dir);
            const subdir = join(dir, "nested", "child");
            mkdirSync(subdir, { recursive: true });

            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw new Error("temporary git failure");
                }) as typeof execFileSync,
            });

            expect(resolveProjectIdentity(subdir)).toBe(parentIdentity);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
