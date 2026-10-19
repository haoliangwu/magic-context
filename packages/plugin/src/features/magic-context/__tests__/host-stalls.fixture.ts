import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";

export const SESSION = "review-session";
export function fixture() {
    const root = join(tmpdir(), "magic-context", "host-stalls-five-review");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "case-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function random(seed: number) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
}

export function hostStore(path: string, count: number, seed?: number) {
    const db = new Database(path);
    db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE session(id TEXT PRIMARY KEY);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            time_created INTEGER, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
        CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE INDEX part_message_id_id_idx ON part(message_id,id);
        CREATE INDEX part_session_idx ON part(session_id);`);
    db.prepare("INSERT INTO session VALUES (?)").run(SESSION);
    const rng = random(seed ?? 0);
    const data = [
        '{"role":"user"}',
        '{"role":"assistant","summary":true,"finish":"stop"}',
        '{"role":"assistant","summary":1,"finish":"stop"}',
        '{"role":"assistant","summary":true,"finish":"length"}',
        '{"summary":0}',
        '{"summary":"true","finish":"stop"}',
        '{"summary":false}',
        "malformed",
        "[]",
        "null",
        "17",
        '"scalar"',
        "{}",
    ];
    const insert = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
    db.transaction(() => {
        for (let i = 0; i < count; i++) {
            insert.run(
                messageId(i),
                SESSION,
                Math.floor(i / 3),
                i,
                seed === undefined ? data[0] : data[Math.floor(rng() * data.length)],
            );
        }
    }).immediate();
    return db;
}
export const messageId = (index: number) => `msg_${String(index).padStart(6, "0")}`;

// Preserve the original OFFSET predicate as an independent oracle. Invalid JSON
// consumes an ordinal, so removing malformed rows before numbering shifts IDs.
const OFFSET_SQL = `SELECT id,data FROM message WHERE session_id=? AND
    CASE WHEN json_valid(data) THEN NOT (COALESCE(json_type(data,'$.summary'),'')='true'
    AND COALESCE(json_extract(data,'$.finish'),'')='stop') ELSE 1 END
    ORDER BY time_created,id LIMIT ? OFFSET ?`;
export function offsetOracle(db: Database, from: number, to: number) {
    from = Math.max(1, Math.floor(from));
    to = Math.floor(to);
    if (to < from) return new Map<string, number>();
    const rows = db.prepare(OFFSET_SQL).all(SESSION, to - from + 1, from - 1) as Array<{
        id: string;
        data: string;
    }>;
    const entries: Array<[string, number]> = [];
    for (const [i, row] of rows.entries()) {
        try {
            const parsed = JSON.parse(row.data);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
                entries.push([row.id, from + i]);
        } catch {
            /* Invalid JSON consumes an ordinal without an id entry. */
        }
    }
    return new Map(entries);
}

export function contextStore(path: string) {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA journal_mode=WAL");
    return db;
}
