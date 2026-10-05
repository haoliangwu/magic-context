/**
 * Test fixture: an OpenCode v1 session store (the `message` and `part` tables)
 * with sessions shaped like real coding sessions, for tests that must prove
 * which history a reader touches and how much of it lands in memory.
 *
 * Each session alternates a user text message with an assistant message that
 * carries one completed tool call. Tool parts can carry a large output and LSP
 * diagnostics in `state.metadata`, the payload that dominates real stores.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "../../shared/sqlite";

export interface OpenCodeFixtureSession {
    sessionId: string;
    directory?: string;
    /** Number of user/assistant message pairs. */
    turns: number;
    /** Characters of tool output per assistant message. */
    toolOutputChars?: number;
    /** LSP diagnostic entries stored in each tool part's metadata. */
    diagnosticsPerTool?: number;
}

export function writeOpenCodeV1FixtureStore(
    dbPath: string,
    sessions: readonly OpenCodeFixtureSession[],
): void {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT);
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS message_session_idx ON message(session_id, time_created, id);
            CREATE INDEX IF NOT EXISTS part_message_idx ON part(message_id);
            CREATE INDEX IF NOT EXISTS part_session_idx ON part(session_id);
        `);
        const insertSession = db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)");
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        db.transaction(() => {
            for (const session of sessions) {
                insertSession.run(
                    session.sessionId,
                    session.directory ?? `/fixture/${session.sessionId}`,
                );
                const output = "x".repeat(session.toolOutputChars ?? 64);
                const diagnostics = Array.from(
                    { length: session.diagnosticsPerTool ?? 0 },
                    (_, index) => ({
                        severity: 1,
                        message: `Unresolved reference: symbol${index}`,
                        range: { start: { line: index, character: 0 } },
                    }),
                );
                let time = 1_000;
                for (let turn = 1; turn <= session.turns; turn += 1) {
                    const userId = `${session.sessionId}-u${String(turn).padStart(6, "0")}`;
                    const assistantId = `${session.sessionId}-a${String(turn).padStart(6, "0")}`;
                    time += 1;
                    insertMessage.run(
                        userId,
                        session.sessionId,
                        time,
                        time,
                        JSON.stringify({ role: "user", time: { created: time } }),
                    );
                    insertPart.run(
                        `${userId}-p1`,
                        userId,
                        session.sessionId,
                        time,
                        time,
                        JSON.stringify({ type: "text", text: `question ${turn}` }),
                    );
                    time += 1;
                    insertMessage.run(
                        assistantId,
                        session.sessionId,
                        time,
                        time,
                        JSON.stringify({ role: "assistant", time: { created: time } }),
                    );
                    insertPart.run(
                        `${assistantId}-p1`,
                        assistantId,
                        session.sessionId,
                        time,
                        time,
                        JSON.stringify({
                            type: "tool",
                            tool: "read",
                            callID: `call-${turn}`,
                            state: {
                                status: "completed",
                                input: { filePath: `/src/File${turn}.kt` },
                                output,
                                metadata: { diagnostics: { [`/src/File${turn}.kt`]: diagnostics } },
                            },
                        }),
                    );
                    insertPart.run(
                        `${assistantId}-p2`,
                        assistantId,
                        session.sessionId,
                        time,
                        time,
                        JSON.stringify({ type: "text", text: `answer ${turn}` }),
                    );
                }
            }
        }).immediate();
    } finally {
        db.close();
    }
}
