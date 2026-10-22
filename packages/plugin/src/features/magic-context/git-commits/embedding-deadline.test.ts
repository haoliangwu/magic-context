import { expect, spyOn, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import * as embedding from "../memory/embedding";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { embedUnembeddedCommits } from "./indexer";

test("commit embedding sweep passes its five-minute deadline signal into the provider", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue({
        gitCommitEnabled: true,
        modelId: "test-model",
    } as never);
    const embed = spyOn(embedding, "embedItemsForProject").mockImplementation(async () => null);
    try {
        db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, committed_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("a".repeat(40), "git:deadline", "aaaaaaa", "message", Date.now(), Date.now());
        expect(await embedUnembeddedCommits(db, "git:deadline")).toBe(0);
        expect(embed).toHaveBeenCalledTimes(1);
        expect(timeout).toHaveBeenCalledWith(300_000);
        expect(embed.mock.calls[0]?.[2]).toBe(controller.signal);
    } finally {
        timeout.mockRestore();
        snapshot.mockRestore();
        embed.mockRestore();
        db.close();
    }
});
