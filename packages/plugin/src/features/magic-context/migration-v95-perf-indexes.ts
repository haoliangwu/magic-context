import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { isKnownAutocommit } from "../../shared/sqlite-helpers";
import { ensureColumn } from "./storage-schema-helpers";
import { decodeTemporalDecision } from "./temporal-decisions";

// NULL records a message first observed on a defer without a served marker. It
// may be decided on a rebuild; an empty string is a final no-marker decision.
export const TEMPORAL_DECISIONS_DDL = `CREATE TABLE temporal_decisions (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    marker TEXT,
    PRIMARY KEY (session_id, message_id)
) WITHOUT ROWID`;

const indexes = [
    ["message_fts_rowid_map", "idx_message_fts_rowid_map_session_rowid", "session_id, fts_rowid"],
    ["transform_decisions", "idx_transform_decisions_retention", "session_id, harness, ts_ms"],
    ["plugin_messages", "idx_plugin_messages_session", "session_id"],
    ["user_memory_candidates", "idx_user_memory_candidates_session", "session_id"],
] as const;

export const V95_REDUNDANT_INDEXES = [
    "idx_tags_session_tag_number",
    "idx_compartments_session",
    "idx_pending_ops_session",
    "idx_source_contents_session",
    "idx_compression_depth_session",
    "idx_transform_decisions_session_harness",
    "idx_project_key_files_project",
] as const;

export const GIT_COMMIT_FTS_ROWID_MAP_DDL = `CREATE TABLE git_commit_fts_rowid_map (
    fts_rowid INTEGER PRIMARY KEY,
    sha BLOB
)`;
// BLOB affinity preserves the FTS value's storage class. FTS's unindexed SHA
// column does not coerce a numeric legacy value into a canonical text key.
export const GIT_FTS_MAP_REPAIR_COMMAND = "magic-context doctor git-fts-map --repair";
export const GIT_FTS_MAP_DISAGREEMENT_SQL = `
    SELECT 1 FROM git_commits_fts AS f
    LEFT JOIN git_commit_fts_rowid_map AS m ON m.fts_rowid = f.rowid
    WHERE m.fts_rowid IS NULL OR m.sha IS NOT f.sha OR typeof(m.sha) IS NOT typeof(f.sha)
    UNION ALL
    SELECT 1 FROM git_commit_fts_rowid_map AS m
    WHERE NOT EXISTS (SELECT 1 FROM git_commits_fts AS f WHERE f.rowid = m.fts_rowid)
    LIMIT 1`;
export function gitFtsMapRepairMessage(detail: string): string {
    return `${detail}; stop all hosts, then run \`${GIT_FTS_MAP_REPAIR_COMMAND}\` to back up both stores and rebuild only the map`;
}
const mapIndex = "CREATE INDEX idx_git_commit_fts_rowid_map_sha ON git_commit_fts_rowid_map(sha)";
const remove = (row: "NEW" | "OLD") => `
    DELETE FROM git_commits_fts WHERE rowid IN (
        SELECT fts_rowid FROM git_commit_fts_rowid_map WHERE sha = ${row}.sha
    );
    DELETE FROM git_commit_fts_rowid_map WHERE sha = ${row}.sha;`;
const insert = `
    INSERT INTO git_commits_fts(sha, project_path, message)
    VALUES (NEW.sha, NEW.project_path, NEW.message);
    INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha)
    VALUES (last_insert_rowid(), NEW.sha);`;
const triggers = [
    [
        "git_commits_fts_insert",
        `CREATE TRIGGER git_commits_fts_insert AFTER INSERT ON git_commits BEGIN${remove("NEW")}${insert}
END`,
    ],
    [
        "git_commits_fts_delete",
        `CREATE TRIGGER git_commits_fts_delete AFTER DELETE ON git_commits BEGIN${remove("OLD")}
END`,
    ],
    [
        "git_commits_fts_update",
        `CREATE TRIGGER git_commits_fts_update AFTER UPDATE OF message, project_path ON git_commits BEGIN${remove("OLD")}${insert}
END`,
    ],
] as const;

/** Preserve FTS content and rowids; only its SHA-to-rowid lookup is materialized. */
export function installV95PerfSchema(
    db: Database,
    verifyExistingMap = false,
    allowCreateMap = true,
): void {
    const schema = new Map(
        (
            db.prepare("SELECT name, sql FROM sqlite_master").all() as Array<{
                name: string;
                sql: string | null;
            }>
        ).map((row) => [row.name, row.sql]),
    );
    if (!schema.has("temporal_decisions")) {
        db.exec(TEMPORAL_DECISIONS_DDL);
        // Carry decisions made by prerelease builds into indexed storage once.
        // Preserve unrelated replay entries, and never parse the blob on an
        // ordinary open after the table has been installed.
        if (schema.has("session_meta")) {
            // Sparse legacy schemas reach migrations before the normal initializer
            // supplies this replay column. They have no temporal blob to adopt yet.
            ensureColumn(db, "session_meta", "merged_reasoning_stripped_ids", "TEXT DEFAULT ''");
            const rows = db
                .prepare(
                    "SELECT session_id, merged_reasoning_stripped_ids AS entries FROM session_meta WHERE merged_reasoning_stripped_ids LIKE '%temporal-message-v1:%'",
                )
                .all() as Array<{ session_id: string; entries: string }>;
            const insert = db.prepare(
                "INSERT OR IGNORE INTO temporal_decisions(session_id,message_id,marker) VALUES (?,?,?)",
            );
            for (const row of rows) {
                let entries: unknown;
                try {
                    entries = JSON.parse(row.entries);
                } catch {
                    sessionLog(
                        row.session_id,
                        "v95 temporal metadata: malformed JSON skipped; original blob retained",
                    );
                    continue;
                }
                if (!Array.isArray(entries)) {
                    sessionLog(
                        row.session_id,
                        "v95 temporal metadata: non-array JSON skipped; original blob retained",
                    );
                    continue;
                }
                const kept: unknown[] = [];
                for (const entry of entries) {
                    const decision =
                        typeof entry === "string" ? decodeTemporalDecision(entry) : null;
                    if (decision) insert.run(row.session_id, ...decision);
                    else kept.push(entry);
                }
                db.prepare(
                    "UPDATE session_meta SET merged_reasoning_stripped_ids=? WHERE session_id=?",
                ).run(JSON.stringify(kept), row.session_id);
            }
        }
    }
    for (const [table, name, columns] of indexes) {
        if (schema.has(table) && !schema.has(name))
            db.exec(`CREATE INDEX ${name} ON ${table}(${columns})`);
    }
    for (const name of V95_REDUNDANT_INDEXES) {
        if (schema.has(name)) db.exec(`DROP INDEX ${name}`);
    }
    // Git's base tables are created by migration 4, not the initial session schema.
    if (!schema.has("git_commits") || !schema.has("git_commits_fts")) return;
    const installed = schema.get("git_commit_fts_rowid_map");
    if (installed === undefined) {
        if (!allowCreateMap)
            throw new Error(gitFtsMapRepairMessage("git FTS rowid map is missing"));
        db.exec(GIT_COMMIT_FTS_ROWID_MAP_DDL);
        db.exec(
            "INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha) SELECT rowid, sha FROM git_commits_fts",
        );
    } else if (installed !== GIT_COMMIT_FTS_ROWID_MAP_DDL) {
        throw new Error(
            gitFtsMapRepairMessage(
                "git_commit_fts_rowid_map schema differs; refusing to replace rowid data",
            ),
        );
    }
    // A lost migration ledger may replay this body against an already-split store.
    // Validate that inventory once, without adding an FTS scan to current opens.
    if (
        verifyExistingMap &&
        installed !== undefined &&
        db.prepare(GIT_FTS_MAP_DISAGREEMENT_SQL).get()
    ) {
        throw new Error(
            gitFtsMapRepairMessage("git FTS rowid inventory differs; refusing migration replay"),
        );
    }
    if (!schema.has("idx_git_commit_fts_rowid_map_sha")) db.exec(mapIndex);
    for (const [name, ddl] of triggers) {
        if (schema.get(name) === ddl) continue;
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        db.exec(ddl);
    }
}

const tagOrderIndexes = new WeakMap<Database, { schemaVersion: number; name: string }>();

/** Pin the tag-order UNIQUE constraint without depending on SQLite's generated name. */
export function tagOrderConstraintIndex(db: Database): string {
    const version = (db.prepare("PRAGMA schema_version").get() as { schema_version: number })
        .schema_version;
    // Transaction-local DDL versions can be reused after rollback by different DDL.
    const cacheable = isKnownAutocommit(db);
    if (!cacheable) tagOrderIndexes.delete(db);
    const cached = tagOrderIndexes.get(db);
    if (cached?.schemaVersion === version) return cached.name;
    const candidates = db.prepare("PRAGMA index_list(tags)").all() as Array<{
        name: string;
        unique: number;
        origin: string;
    }>;
    for (const candidate of candidates) {
        if (!candidate.unique || candidate.origin !== "u") continue;
        const quoted = `"${candidate.name.replaceAll('"', '""')}"`;
        const columns = db.prepare(`PRAGMA index_info(${quoted})`).all() as Array<{ name: string }>;
        if (
            columns.length !== 2 ||
            columns[0]?.name !== "session_id" ||
            columns[1]?.name !== "tag_number"
        )
            continue;
        if (cacheable) tagOrderIndexes.set(db, { schemaVersion: version, name: quoted });
        return quoted;
    }
    throw new Error("tags lacks its UNIQUE(session_id, tag_number) ordering constraint");
}
