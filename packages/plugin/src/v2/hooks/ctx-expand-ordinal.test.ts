import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setBoundedRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createCtxExpandTools } from "../../tools/ctx-expand/tools";
import { V2StoreReader } from "../store-reader";
import { createV2RawMessageProvider, createV2RawMessageReader } from "./store";

const SESSION_ID = "ses-expand-out-of-range";
const FIRST_MESSAGE_TEXT = "first source text must never be labelled as 9999";

function createSessionDatabase(path: string): Database {
    const db = new Database(path);
    db.exec(`
        CREATE TABLE session_message(
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            time_created INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL
        );
        CREATE TABLE compartments(
            session_id TEXT NOT NULL,
            end_message INTEGER,
            rebase_status TEXT
        );
    `);
    const insert = db.prepare(
        "INSERT INTO session_message(id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("user-1", SESSION_ID, "user", 1, JSON.stringify({ text: FIRST_MESSAGE_TEXT }));
    insert.run(
        "assistant-2",
        SESSION_ID,
        "assistant",
        2,
        JSON.stringify({ content: [{ type: "text", text: "second message text" }] }),
    );
    insert.run("user-3", SESSION_ID, "user", 3, JSON.stringify({ text: "third message text" }));
    return db;
}

describe("OpenCode 2 ctx_expand ordinal resolution", () => {
    it("does not relabel the first source message as an out-of-range ordinal", async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-v2-ctx-expand-ordinal-");
        const path = join(root, "opencode.db");
        let db: Database | undefined;
        let contextDb: Database | undefined;
        let unregister: (() => void) | undefined;

        try {
            db = createSessionDatabase(path);
            contextDb = new Database(":memory:");
            initializeDatabase(contextDb);
            runMigrations(contextDb);
            const reader = createV2RawMessageReader(() => new V2StoreReader(path));
            unregister = setBoundedRawMessageProvider(
                SESSION_ID,
                createV2RawMessageProvider(reader, SESSION_ID),
            );
            const ctxExpand = createCtxExpandTools({ db: contextDb as never }).ctx_expand;
            const context = { sessionID: SESSION_ID } as never;

            const message = await ctxExpand.execute({ message: 9999 }, context);
            const range = await ctxExpand.execute({ start: 9999, end: 10000 }, context);
            const partialRange = await ctxExpand.execute({ start: 1, end: 10000 }, context);
            const verboseRange = await ctxExpand.execute(
                { start: 9999, end: 10000, verbose: true },
                context,
            );

            expect(message).toContain("No message at ordinal 9999");
            expect(message).not.toContain(FIRST_MESSAGE_TEXT);
            expect(range).toContain("No messages found in range 9999-10000");
            expect(range).not.toContain(FIRST_MESSAGE_TEXT);
            expect(partialRange).toContain("Messages 1-3 (3 messages,");
            expect(partialRange).toContain("[1] U:");
            expect(partialRange).toContain("[2] A:");
            expect(partialRange).toContain("[3] U:");
            expect(partialRange).not.toContain("[10000]");
            expect(verboseRange).toContain("No messages found in range 9999-10000");
            expect(verboseRange).not.toContain(FIRST_MESSAGE_TEXT);
        } finally {
            unregister?.();
            contextDb?.close();
            db?.close();
            cleanup();
        }
    });
});
