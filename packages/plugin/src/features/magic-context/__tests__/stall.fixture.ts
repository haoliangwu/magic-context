import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "./opencode1-query-fixture";

export const STALL_SESSION = "stall-session";
export const stallMessageId = (index: number) => `msg_${String(index).padStart(8, "0")}`;

/** Generate synthetic coding-session JSON with kilobyte-sized metadata and tool
 * outputs to exercise database readers without opening or copying any user store. */
export function createStallHost(path: string, count: number, partCount: number): Database {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec(
        `PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY); ${OPENCODE1_MESSAGE_PART_SCHEMA}`,
    );
    db.prepare("INSERT INTO session VALUES (?)").run(STALL_SESSION);
    const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    const metadata = "diagnostic detail ".repeat(160);
    const toolOutput = "source line with identifiers and comments\n".repeat(50);
    db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const id = stallMessageId(i);
            const data =
                i === count - 7
                    ? "malformed"
                    : JSON.stringify({
                          role: i % 4 === 0 ? "user" : "assistant",
                          parentID: stallMessageId(Math.max(0, i - 1)),
                          summary: i % 1024 === 512 ? true : i % 1024 === 513 ? 1 : false,
                          finish: "stop",
                          agent: "build",
                          modelID: "fixture-model",
                          providerID: "fixture-provider",
                          tokens: {
                              input: 8000,
                              output: 500,
                              reasoning: 200,
                              cache: { read: 6000, write: 1000 },
                          },
                          path: { cwd: "/fixture/project", root: "/fixture/project" },
                          time: { created: i, completed: i + 1 },
                          metadata,
                      });
            message.run(id, STALL_SESSION, i, i, data);
            const n =
                Math.floor(((i + 1) * partCount) / count) - Math.floor((i * partCount) / count);
            for (let j = 0; j < n; j++)
                part.run(
                    `prt_${i}_${j}`,
                    id,
                    STALL_SESSION,
                    i,
                    i,
                    JSON.stringify(
                        j === 0
                            ? { type: "text", text: `message ${i}` }
                            : {
                                  type: "tool",
                                  tool: "read",
                                  callID: `call_${i}_${j}`,
                                  state: {
                                      status: "completed",
                                      input: { filePath: `/fixture/file${i}.ts` },
                                      output: toolOutput,
                                      metadata: {
                                          diagnostics: [{ severity: 1, message: metadata }],
                                      },
                                  },
                              },
                    ),
                );
        }
    }).immediate();
    return db;
}

export function createStallContext(path: string, count: number): Database {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA journal_mode=WAL");
    const insert = db.prepare(`INSERT INTO tags(session_id, message_id, type, status, tag_number,
        tool_owner_message_id, token_count, input_token_count, reasoning_token_count, entry_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const owner = stallMessageId(i);
            insert.run(
                STALL_SESSION,
                `${owner}:p0`,
                "message",
                i % 3 ? "active" : "dropped",
                3 * i + 1,
                null,
                i % 200,
                null,
                i % 15,
                JSON.stringify(["assistant", i, "text", "fixture", `digest-${i}`]),
            );
            insert.run(
                STALL_SESSION,
                `call_${i}`,
                "tool",
                i % 3 ? "compacted" : "active",
                3 * i + 2,
                owner,
                i === count - 3 ? null : i % 400,
                11,
                null,
                null,
            );
            insert.run(
                STALL_SESSION,
                `${owner}:file1`,
                "file",
                "active",
                3 * i + 3,
                null,
                75,
                null,
                null,
                null,
            );
        }
        for (const [i, prefix] of ["pi-msg-", "PI-MSG-", "Pi-MsG-"].entries()) {
            insert.run(
                STALL_SESSION,
                `${prefix}fallback:p0`,
                "message",
                "active",
                3 * count + i * 2 + 1,
                null,
                22,
                null,
                null,
                JSON.stringify(["user", i, "text", "fixture", "digest"]),
            );
            insert.run(
                STALL_SESSION,
                `fallback_call_${i}`,
                "tool",
                "dropped",
                3 * count + i * 2 + 2,
                `${prefix}fallback`,
                50,
                null,
                null,
                null,
            );
        }
        db.prepare(
            "INSERT INTO message_history_index(session_id,harness,last_indexed_ordinal,dirty_floor_ordinal,updated_at) VALUES (?,'opencode',?,0,1)",
        ).run(STALL_SESSION, count);
    }).immediate();
    return db;
}

// Frozen pre-fix predicates serve as differential oracles, not rewrites of the optimized SQL.
export const OLD_LEGACY_MARKER_SQL = `SELECT m.id FROM message m WHERE m.session_id=? AND m.id<>?
    AND COALESCE(json_extract(m.data,'$.summary'),0)=1 AND COALESCE(json_extract(m.data,'$.finish'),'')='stop'
    AND COALESCE(json_extract(m.data,'$.parentID'),'')=? AND EXISTS(SELECT 1 FROM part p
      WHERE +p.session_id=m.session_id AND p.message_id=m.id AND COALESCE(json_extract(p.data,'$.type'),'')='text'
      AND COALESCE(json_extract(p.data,'$.text'),'')=?)`;
export const OLD_PI_OWNER_SQL = `SELECT tag_number AS tagNumber,message_id AS callId,tool_owner_message_id AS toolOwnerMessageId,status
    FROM tags WHERE session_id=? AND type='tool' AND tool_owner_message_id LIKE 'pi-msg-%' ORDER BY tag_number`;
