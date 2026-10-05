import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { Database } from "../../shared/sqlite";
import { renderItemByTag } from "./render";

test("Pi tool recovery visits only the first result after its owner and closes the iterator", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO tags (message_id, type, status, byte_size, session_id, tag_number, tool_owner_message_id) VALUES ('call', 'tool', 'active', 20, 'bounded-pi', 1, 'owner')",
    ).run();
    const owner: RawMessage = {
        ordinal: 60000,
        id: "owner",
        role: "assistant",
        parts: [{ type: "tool_use", id: "call", name: "read", input: { path: "file.ts" } }],
    };
    let visited = 0;
    let closed = 0;
    let reused = false;
    const release = setRawMessageProvider("bounded-pi", {
        readMessages: () => {
            throw new Error("Full session read is forbidden");
        },
        readMessageById: () => owner,
        *iterateMessageRange(from) {
            expect(from).toBe(60001);
            try {
                visited++;
                yield {
                    ordinal: 60001,
                    id: "result",
                    role: "user",
                    parts: reused
                        ? [{ type: "tool_use", id: "call", name: "read", input: {} }]
                        : [{ type: "tool_result", tool_use_id: "call", content: "file contents" }],
                };
                visited++;
                yield {
                    ordinal: 60002,
                    id: "later",
                    role: "user",
                    parts: [{ type: "text", text: "must not visit" }],
                };
            } finally {
                closed++;
            }
        },
    });
    try {
        expect(renderItemByTag(db, "bounded-pi", 1)).toBe(
            '  [tool: read #call]\n  input: {"path":"file.ts"}\n  [tool: tool_result #call]\n  output:\nfile contents',
        );
        expect(visited).toBe(1);
        expect(closed).toBe(1);
        reused = true;
        expect(renderItemByTag(db, "bounded-pi", 1)).toBe(
            '  [tool: read #call]\n  input: {"path":"file.ts"}',
        );
        expect(visited).toBe(2);
        expect(closed).toBe(2);
    } finally {
        release();
        db.close();
    }
});
