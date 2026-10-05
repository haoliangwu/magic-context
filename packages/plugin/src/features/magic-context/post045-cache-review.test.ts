import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { getDreamTaskBacklogs } from "./dreamer/task-gates";
import type { GitCommit } from "./git-commits/git-log-reader";
import { searchGitCommitsSync } from "./git-commits/search-git-commits";
import { saveCommitEmbedding } from "./git-commits/storage-git-commit-embeddings";
import { upsertCommits } from "./git-commits/storage-git-commits";
import { insertMemory } from "./memory";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function commit(index: number): GitCommit {
    const sha = index.toString(16).padStart(40, "0");
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `semantic commit ${index}`,
        author: "review@example.invalid",
        committedAtMs: 1_700_000_000_000 + index,
    };
}

// These are deliberately red review regressions. A read performed inside a
// transaction must not publish rolled-back rows into a later committed read.
test("post045: commit vector memo discards a rolled-back transactional observation", () => {
    const db = freshDb();
    const project = "git:post045-vectors";
    const model = "review:model";
    const first = commit(1);
    const second = commit(2);
    const search = () =>
        searchGitCommitsSync(db, project, "lexical-miss-token", {
            limit: 1,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: model,
        }).map((hit) => hit.commit.sha);
    try {
        upsertCommits(db, project, [first, second]);
        saveCommitEmbedding(db, first.sha, new Float32Array([1, 0]), model);
        saveCommitEmbedding(db, second.sha, new Float32Array([0, 1]), model);
        expect(search()).toEqual([first.sha]);
        db.exec("BEGIN");
        saveCommitEmbedding(db, second.sha, new Float32Array([1, 0]), model);
        expect(search()).toEqual([second.sha]);
        const beforeRollback = db.prepare("SELECT total_changes() AS writes").get();
        db.exec("ROLLBACK");
        expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual(beforeRollback);
        // The rollback succeeded; only the vector cache can still choose second.
        const row = db
            .prepare("SELECT embedding FROM git_commit_embeddings WHERE sha = ?")
            .get(second.sha) as { embedding: Uint8Array };
        const bytes = new Uint8Array(row.embedding);
        expect(Array.from(new Float32Array(bytes.buffer))).toEqual([0, 1]);
        expect(search()).toEqual([first.sha]);
    } finally {
        db.close();
    }
});

test("post045: backlog memo discards a rolled-back transactional observation", () => {
    const db = freshDb();
    const project = "git:post045-backlog";
    const read = () => getDreamTaskBacklogs(db, project, ["map-memories"])["map-memories"];
    try {
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "durable" });
        expect(read()).toEqual({ pending: 1, total: 1 });
        db.exec("BEGIN");
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "temporary" });
        expect(read()).toEqual({ pending: 2, total: 2 });
        const beforeRollback = db.prepare("SELECT total_changes() AS writes").get();
        db.exec("ROLLBACK");
        expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual(beforeRollback);
        expect(db.prepare("SELECT content FROM memories ORDER BY id").all()).toEqual([
            { content: "durable" },
        ]);
        expect(read()).toEqual({ pending: 1, total: 1 });
    } finally {
        db.close();
    }
});
