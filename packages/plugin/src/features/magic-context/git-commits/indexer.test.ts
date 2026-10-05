import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { readGitCommitsResult } from "./git-log-reader";
import { indexCommitsForProject } from "./indexer";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("indexCommitsForProject against a real repository", () => {
    let db: Database;
    let dir: string;

    const git = (args: string[], dateMs?: number) => {
        // Run git hermetically: a caller's GIT_CONFIG_* overrides (an editor or agent
        // can inject core.hooksPath this way) and the user's global or system config
        // could add hooks that rewrite the commit messages these tests compare.
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (!key.startsWith("GIT_")) env[key] = value;
        }
        env.GIT_CONFIG_GLOBAL = "/dev/null";
        env.GIT_CONFIG_NOSYSTEM = "1";
        if (dateMs !== undefined) {
            const stamp = `@${Math.floor(dateMs / 1000)} +0000`;
            env.GIT_AUTHOR_DATE = stamp;
            env.GIT_COMMITTER_DATE = stamp;
        }
        return execFileSync("git", args, { cwd: dir, env, encoding: "utf8", windowsHide: true });
    };
    const commit = (file: string, message: string, dateMs: number) => {
        writeFileSync(join(dir, file), `${message}\n`);
        git(["add", file]);
        git(["-c", "commit.gpgsign=false", "commit", "-qm", message], dateMs);
    };
    const indexedMessages = () =>
        (
            db
                .prepare("SELECT message FROM git_commits WHERE project_path = ? ORDER BY message")
                .all("git:repo") as { message: string }[]
        ).map((row) => row.message);
    const sweep = () =>
        indexCommitsForProject(db, "git:repo", dir, {
            sinceDays: 30,
            maxCommits: 100,
            skipEmbed: true,
        });

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        dir = createTestTempDirFromPath(join(tmpdir(), "mc-git-indexer-test-"));
        git(["init", "-q", "-b", "main"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
    });

    afterEach(() => {
        closeQuietly(db);
        rmSync(dir, { recursive: true, force: true });
    });

    it("indexes merged branch commits whose committer date predates the indexed tip", async () => {
        const now = Date.now();
        commit("base.txt", "base commit", now - 5 * DAY_MS);
        git(["checkout", "-q", "-b", "feature"]);
        commit("feature.txt", "feature work from two days ago", now - 2 * DAY_MS);
        git(["checkout", "-q", "main"]);
        commit("main.txt", "main tip commit", now - 60 * 60 * 1000);

        await sweep();
        expect(indexedMessages()).toEqual(["base commit", "main tip commit"]);

        git(
            ["-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "feature"],
            now,
        );
        await sweep();

        expect(indexedMessages()).toEqual([
            "base commit",
            "feature work from two days ago",
            "main tip commit",
        ]);
    });

    it("falls back to the full window when the latest indexed commit no longer exists", async () => {
        const now = Date.now();
        commit("a.txt", "first commit", now - 3 * DAY_MS);
        commit("b.txt", "second commit", now - 2 * DAY_MS);
        // The latest indexed commit was rewritten away and garbage-collected.
        db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, 'git:repo', 'aaaaaaa', 'rewritten away', NULL, ?, ?)`,
        ).run("a".repeat(40), now - DAY_MS, now - DAY_MS);

        const result = await sweep();

        expect(result.nonIndexable).toBe(false);
        expect(indexedMessages()).toEqual(["first commit", "rewritten away", "second commit"]);
    });

    it("reads history when a worktree file is named HEAD", async () => {
        commit("HEAD", "commit adding a file named HEAD", Date.now() - DAY_MS);

        const read = await readGitCommitsResult(dir, {});

        expect(read.failure).toBeNull();
        expect(read.commits.map((entry) => entry.message)).toEqual([
            "commit adding a file named HEAD",
        ]);
    });

    it("reads a SHA-256 repository", async () => {
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        git(["init", "-q", "--object-format=sha256", "-b", "main"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        commit("a.txt", "sha256 commit", Date.now() - DAY_MS);

        const read = await readGitCommitsResult(dir, {});

        expect(read.commits.map((entry) => [entry.message, entry.sha.length])).toEqual([
            ["sha256 commit", 64],
        ]);
    });
});
