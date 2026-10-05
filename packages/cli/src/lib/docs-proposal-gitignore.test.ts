import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { ensureDocsProposalGitignore } from "./docs-proposal-gitignore";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(options: { repository: boolean }): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-ignore-"));
    dirs.push(dir);
    if (options.repository) mkdirSync(join(dir, ".git"));
    return dir;
}

test("adds the ignore rule once while retaining existing rules", () => {
    const dir = tempDir({ repository: true });
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureDocsProposalGitignore(dir);
    ensureDocsProposalGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
        "node_modules/\n.cortexkit/magic-context/\n",
    );
});

test("a broad .cortexkit ignore covers proposal state", () => {
    const dir = tempDir({ repository: true });
    writeFileSync(join(dir, ".gitignore"), ".cortexkit/*\n");
    ensureDocsProposalGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".cortexkit/*\n");
});

test("every spelling of a .cortexkit directory rule counts as covered", () => {
    for (const rule of [".cortexkit", "/.cortexkit", "**/.cortexkit/", ".cortexkit/**"]) {
        const dir = tempDir({ repository: true });
        writeFileSync(join(dir, ".gitignore"), `${rule}\n`);
        expect(ensureDocsProposalGitignore(dir)).toEqual({ status: "covered" });
        expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(`${rule}\n`);
    }
});

test("the plugin's own .cortexkit/.gitignore block counts as covered", () => {
    const dir = tempDir({ repository: true });
    mkdirSync(join(dir, ".cortexkit"));
    writeFileSync(
        join(dir, ".cortexkit", ".gitignore"),
        "# >>> cortexkit:magic-context\nmagic-context/\n# <<< cortexkit:magic-context\n",
    );
    expect(ensureDocsProposalGitignore(dir)).toEqual({ status: "covered" });
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
});

test("leaves a directory that is not a repository root alone", () => {
    const dir = tempDir({ repository: false });
    expect(ensureDocsProposalGitignore(dir)).toEqual({ status: "not-a-repository" });
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
});

test("reports a write failure instead of throwing", () => {
    const dir = tempDir({ repository: true });
    // A directory where the file should be makes the append fail.
    mkdirSync(join(dir, ".gitignore"));
    const result = ensureDocsProposalGitignore(dir);
    expect(result.status).toBe("failed");
});
