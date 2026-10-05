import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import type { GitCommit } from "./git-log-reader";
import { searchGitCommitsSync } from "./search-git-commits";
import { saveCommitEmbedding } from "./storage-git-commit-embeddings";
import { upsertCommits } from "./storage-git-commits";

function makeCommit(index: number): GitCommit {
    const sha = index.toString(16).padStart(40, "0");
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `semantic commit ${index}`,
        author: "dev@example.com",
        committedAtMs: 1_700_000_000_000 + index,
    };
}

describe("searchGitCommitsSync", () => {
    it("cached commit vectors observe own writes, external commits and distinct database handles", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "commit-search-cache-"));
        const reader = new Database(join(dir, "copy.db"));
        initializeDatabase(reader);
        runMigrations(reader);
        const writer = new Database(join(dir, "copy.db"));
        const other = new Database(":memory:");
        initializeDatabase(other);
        runMigrations(other);
        const commits = [makeCommit(1), makeCommit(2)];
        const search = (database: Database, model = "mock:model") =>
            searchGitCommitsSync(database, "git:cache", "lexical-miss-token", {
                limit: 1,
                queryEmbedding: new Float32Array([1, 0]),
                queryModelId: model,
            }).map((hit) => hit.commit.sha);
        try {
            for (const database of [reader, other]) {
                upsertCommits(database, "git:cache", commits);
                saveCommitEmbedding(
                    database,
                    commits[0].sha,
                    new Float32Array([1, 0]),
                    "mock:model",
                );
                saveCommitEmbedding(
                    database,
                    commits[1].sha,
                    new Float32Array([0, 1]),
                    "mock:model",
                );
            }
            expect(search(reader)).toEqual([commits[0].sha]);
            saveCommitEmbedding(reader, commits[1].sha, new Float32Array([1, 0]), "mock:model");
            expect(search(reader)).toEqual([commits[1].sha]);
            saveCommitEmbedding(writer, commits[1].sha, new Float32Array([0, 1]), "mock:model");
            expect(search(reader)).toEqual([commits[0].sha]);
            expect(search(other)).toEqual([commits[0].sha]);
            expect(search(reader, "other:model")).toEqual([]);
            writer.prepare("DELETE FROM git_commit_embeddings").run();
            expect(search(reader)).toEqual([]);
        } finally {
            reader.close();
            writer.close();
            other.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("loads a large semantic-only commit set through one JSON batch", () => {
        const projectPath = "git:semantic-batch";
        const modelId = "mock:model";
        const commits = Array.from({ length: 1_200 }, (_, index) => makeCommit(index));
        upsertCommits(db, projectPath, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 0]), modelId);
        }

        const results = searchGitCommitsSync(db, projectPath, "lexical-miss-token", {
            limit: 5,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results).toHaveLength(5);
        expect(results.every((result) => result.matchType === "semantic")).toBe(true);
        expect(results.map((result) => result.commit.sha)).toEqual(
            commits
                .slice(-5)
                .reverse()
                .map((commit) => commit.sha),
        );
    });

    it("treats % and _ in the LIKE fallback as literal characters", () => {
        const projectPath = "git:like-escape";
        const plain = { ...makeCommit(1), message: "tune worker pool" };
        const percent = { ...makeCommit(2), message: "cap cpu at 90% load" };
        const underscore = { ...makeCommit(3), message: "rename max_retries flag" };
        upsertCommits(db, projectPath, [plain, percent, underscore]);
        const shas = (query: string) =>
            searchGitCommitsSync(db, projectPath, query, { limit: 10 }).map(
                (result) => result.commit.sha,
            );

        // Neither query has a word token, so FTS finds nothing and the LIKE
        // fallback runs; an unescaped wildcard would match every commit.
        expect(shas("%")).toEqual([percent.sha]);
        expect(shas("_")).toEqual([underscore.sha]);
    });
});
