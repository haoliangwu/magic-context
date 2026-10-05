/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { foldShrunkPartTags } from "./storage-tags";

const SESSION = "ses_fold";
const openDbs: Database[] = [];

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    openDbs.push(db);
    return db;
}

afterEach(() => {
    for (const db of openDbs.splice(0)) closeQuietly(db);
});

function insertPartTag(db: Database, contentId: string, tagNumber: number, status: string): void {
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', ?, 10, ?, 'opencode')",
    ).run(SESSION, contentId, status, tagNumber);
}

function statuses(db: Database): Array<{ message_id: string; tag_number: number; status: string }> {
    return db
        .prepare(
            "SELECT message_id, tag_number, status FROM tags WHERE session_id = ? ORDER BY tag_number",
        )
        .all(SESSION) as Array<{ message_id: string; tag_number: number; status: string }>;
}

describe("foldShrunkPartTags executed drops", () => {
    it("does not hide the joined text when only a folded fragment was dropped", () => {
        const db = createDb();
        insertPartTag(db, "msg_a:p0", 1, "active");
        insertPartTag(db, "msg_a:p1", 2, "dropped");
        insertPartTag(db, "msg_a:p2", 3, "active");

        const result = foldShrunkPartTags(db, SESSION, [{ messageId: "msg_a", partCount: 1 }]);

        expect(result.foldedTagNumbers).toEqual([2, 3]);
        expect(statuses(db)).toEqual([{ message_id: "msg_a:p0", tag_number: 1, status: "active" }]);
    });

    it("keeps the joined text dropped when every fragment was dropped", () => {
        const db = createDb();
        insertPartTag(db, "msg_a:p0", 1, "dropped");
        insertPartTag(db, "msg_a:p1", 2, "dropped");

        foldShrunkPartTags(db, SESSION, [{ messageId: "msg_a", partCount: 1 }]);

        expect(statuses(db)).toEqual([
            { message_id: "msg_a:p0", tag_number: 1, status: "dropped" },
        ]);
    });
});
