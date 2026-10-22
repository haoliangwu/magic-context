import { expect, spyOn, test } from "bun:test";
import { sweepGitCommits } from "../../../plugin/dream-timer";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import * as reader from "./git-log-reader";
import { indexCommitsForProject } from "./indexer";

function database(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

test("directory identities never probe git and log only once per non-indexable park", async () => {
    const db = database();
    const read = spyOn(reader, "readGitCommitsResult").mockResolvedValue({
        commits: [],
        failure: "not_a_repo",
    });
    const log = spyOn(logger, "log");
    try {
        const result = await indexCommitsForProject(db, "dir:no-git", "/not-a-repo", {
            sinceDays: 30,
            maxCommits: 100,
        });
        expect(result.nonIndexable).toBe(true);
        const args = {
            db,
            directory: "/not-a-repo",
            projectIdentity: "dir:no-git",
            gitCommitIndexing: { enabled: true, since_days: 30, max_commits: 100 },
        };
        await sweepGitCommits(args);
        await sweepGitCommits(args);
        await sweepGitCommits(args);
        expect(read).not.toHaveBeenCalled();
        expect(log.mock.calls.filter(([line]) => line.includes("[git-commits]"))).toHaveLength(1);
        expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("sweep parked");
    } finally {
        read.mockRestore();
        log.mockRestore();
        db.close();
    }
});
