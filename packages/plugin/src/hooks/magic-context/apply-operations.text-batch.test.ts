import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { applyPendingOperations } from "./apply-operations";
import { tagMessages } from "./tag-messages";

function textBatch() {
    const db = new Database(":memory:");
    const id = "text-drop-batch";
    initializeDatabase(db);
    runMigrations(db);
    const messages = Array.from({ length: 160 }, (_, index) => ({
        info: { id: `text-${index}`, role: index % 2 ? "assistant" : "user", sessionID: id },
        parts: [{ type: "text", text: `Historical text ${index}: ${"material ".repeat(20)}` }],
    }));
    const tagger = createTagger();
    tagger.initFromDb(id, db);
    const { targets } = tagMessages(id, messages, tagger, db);
    db.transaction(() => {
        for (const tag of getTagsBySession(db, id)) queuePendingOp(db, id, tag.tagNumber, "drop");
    }).immediate();
    return { db, id, targets };
}

test("160 text drops commit once per 64-op chunk before changing wire bytes", () => {
    const { db, id, targets } = textBatch();
    const exec = db.exec.bind(db);
    let commits = 0;
    let begins = 0;
    let mutations = 0;
    db.exec = ((sql: string) => {
        const result = exec(sql);
        if (sql === "COMMIT") commits++;
        if (sql === "BEGIN IMMEDIATE") begins++;
        return result;
    }) as typeof db.exec;
    for (const target of targets.values()) {
        const set = target.setContent;
        target.setContent = (...args) => {
            expect(commits).toBe(Math.floor(mutations / 64) + 1);
            expect(getTagsBySession(db, id).filter((tag) => tag.status === "dropped")).toHaveLength(
                Math.min(commits * 64, 160),
            );
            mutations++;
            return set(...args);
        };
    }
    try {
        expect(applyPendingOperations(id, db, targets, new Set())).toBe(true);
        expect(mutations).toBe(160);
        expect(begins).toBe(3);
        expect(commits).toBe(3);
        expect(getPendingOps(db, id)).toHaveLength(0);
    } finally {
        db.close();
    }
});

test("busy admission for a later text chunk retains its bytes and queued operations", () => {
    const { db, id, targets } = textBatch();
    const exec = db.exec.bind(db);
    let begins = 0;
    db.exec = ((sql: string) => {
        if (sql === "BEGIN IMMEDIATE" && ++begins === 2)
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return exec(sql);
    }) as typeof db.exec;
    try {
        expect(applyPendingOperations(id, db, targets, new Set())).toBe(true);
        expect(getPendingOps(db, id)).toHaveLength(96);
        expect(getTagsBySession(db, id).filter((tag) => tag.status === "dropped")).toHaveLength(64);
        expect(
            [...targets.values()].filter((target) => target.getContent?.()?.startsWith("[dropped")),
        ).toHaveLength(64);
        db.exec = exec;
        expect(applyPendingOperations(id, db, targets, new Set())).toBe(true);
        expect(getPendingOps(db, id)).toHaveLength(0);
    } finally {
        db.close();
    }
});
