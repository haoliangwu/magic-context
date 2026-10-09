import { createHash } from "node:crypto";
import type { Database, Statement } from "../../../shared/sqlite";
import { hasMuralCueColumns } from "./storage-mural-cues";

const statements = new WeakMap<Database, Statement>();

/** Hash the source, not just the last render: new/stale cues, deletions, expiry and
 * budget-selection changes must invalidate even before a new PNG is published.
 * SQLite returns one compact string; no Memory objects, tokenization, image BLOB
 * read or base64 encoding is needed to check an unchanged candidate. */
export function muralSourceRevision(db: Database, projectPath: string): string {
    let statement = statements.get(db);
    if (!statement) {
        const cues = hasMuralCueColumns(db) ? "mural_cue, mural_cue_hash" : "NULL, NULL";
        statement = db.prepare(`
            SELECT json_group_array(json_array(id, content, category, importance, status,
                last_seen_at, verified_at, ${cues})) AS revision
            FROM (SELECT * FROM memories WHERE project_path = ?
                AND status IN ('active', 'permanent')
                AND (expires_at IS NULL OR expires_at > ?)
                ORDER BY category ASC, updated_at DESC, id ASC)
        `);
        statements.set(db, statement);
    }
    const row = statement.get(projectPath, Date.now()) as { revision: string };
    return createHash("sha256").update(row.revision).digest("hex");
}
