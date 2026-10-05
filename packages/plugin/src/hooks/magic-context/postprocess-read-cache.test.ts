import { afterEach, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { insertTag, updateTagStatus } from "../../features/magic-context/storage-tags";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    postprocessOldestTags,
    postprocessReplaySnapshot,
    postprocessTailTags,
} from "./postprocess-read-cache";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

it("reuses attribution rows and invalidates on local writes and external commits", () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "postprocess-tags-"));
    directories.push(directory);
    const db = new Database(join(directory, "test.db"));
    databases.push(db);
    initializeDatabase(db);
    insertTag(db, "snapshot", "m:p0", "message", 100, 1);
    const first = postprocessTailTags(db, "snapshot");
    expect(first).toHaveLength(1);
    expect(postprocessTailTags(db, "snapshot")).toBe(first);
    updateTagStatus(db, "snapshot", 1, "dropped");
    expect(postprocessTailTags(db, "snapshot")).toHaveLength(0);
    const other = new Database(join(directory, "test.db"));
    databases.push(other);
    updateTagStatus(other, "snapshot", 1, "active");
    expect(postprocessTailTags(db, "snapshot")).toHaveLength(1);
});

it("does not retain rolled-back attribution and invalidates hint protection", () => {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    insertTag(db, "snapshot", "tool-call", "tool", 4000, 1);
    db.prepare(
        "UPDATE tags SET tool_name = 'read', tool_owner_message_id = 'owner' WHERE session_id = ?",
    ).run("snapshot");
    const first = postprocessTailTags(db, "snapshot");
    expect(postprocessOldestTags(db, "snapshot", new Set())).toHaveLength(1);
    expect(postprocessOldestTags(db, "snapshot", new Set([1]))).toHaveLength(0);
    db.exec("BEGIN");
    updateTagStatus(db, "snapshot", 1, "dropped");
    expect(postprocessTailTags(db, "snapshot")).toHaveLength(0);
    db.exec("ROLLBACK");
    expect(postprocessTailTags(db, "snapshot")).toEqual(first);
    expect(postprocessOldestTags(db, "snapshot", new Set())).toHaveLength(1);
});

it("isolates pass-local frozen decisions and reloads changed replay rows", () => {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    getOrCreateSessionMeta(db, "replay-cache");
    const first = postprocessReplaySnapshot(db, "replay-cache");
    first.strippedPlaceholderIds.add("not-committed");
    first.trailingBlankDecisions.set("not-committed", "strip");
    const replay = postprocessReplaySnapshot(db, "replay-cache");
    expect(replay.strippedPlaceholderIds.has("not-committed")).toBe(false);
    expect(replay.trailingBlankDecisions.has("not-committed")).toBe(false);
    db.prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?").run(
        JSON.stringify({ committed: "strip" }),
        "replay-cache",
    );
    expect(
        postprocessReplaySnapshot(db, "replay-cache").trailingBlankDecisions.get("committed"),
    ).toBe("strip");
});
