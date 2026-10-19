import { clearLkgRecoveryFence } from "../../hooks/magic-context/lkg-recovery-fence";
import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import { deleteChunkEmbedBackoffForSession } from "./compartment-chunk-embedding";
import { deleteUnmappedMessageFtsRows } from "./message-fts-rowid-map";
import { deleteSessionActivity } from "./session-activity";
import {
    tagIdentityRevisionKey,
    tagRevisionKey,
    tagTombstoneOwnerKey,
    tagTombstoneOwnerRange,
} from "./storage-tag-identity-revision";

export interface SessionScopedTableDefinition {
    readonly table: string;
    readonly harnessScoped?: true;
    readonly extraPredicate?: string;
}

/**
 * Tables whose rows are owned by a session. Keep this list in dependency-safe
 * deletion order so event cleanup and orphan cleanup cannot drift apart.
 */
export const SESSION_SCOPED_TABLES: readonly SessionScopedTableDefinition[] = [
    { table: "pending_ops", harnessScoped: true },
    { table: "source_contents", harnessScoped: true },
    { table: "tool_owner_backfill_state" },
    { table: "tags", harnessScoped: true },
    { table: "session_meta", harnessScoped: true },
    {
        table: "temporal_decisions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = temporal_decisions.session_id)",
    },
    // Replay decisions belong to the session's metadata row; a harness sweep that
    // keeps another harness's row keeps them too.
    {
        table: "session_replay_decisions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = session_replay_decisions.session_id)",
    },
    { table: "session_projects", harnessScoped: true },
    { table: "compartment_chunk_embeddings", harnessScoped: true },
    { table: "compartments", harnessScoped: true },
    // A harness sweep can leave another harness's compartments for the same session.
    {
        table: "compartment_history_versions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM compartments AS remaining WHERE remaining.session_id = compartment_history_versions.session_id)",
    },
    { table: "compression_depth", harnessScoped: true },
    { table: "session_facts", harnessScoped: true },
    { table: "compartment_state_lease" },
    // Smart notes are project-owned even when they record an originating session.
    { table: "notes", harnessScoped: true, extraPredicate: "type = 'session'" },
    { table: "recomp_compartments", harnessScoped: true },
    { table: "recomp_facts", harnessScoped: true },
    { table: "user_memory_candidates" },
    { table: "primer_candidates", harnessScoped: true },
    { table: "m0_mutation_log" },
    { table: "compartment_events", harnessScoped: true },
    { table: "subagent_invocations", harnessScoped: true },
    { table: "historian_runs", harnessScoped: true },
    { table: "plugin_messages" },
    { table: "transform_decisions", harnessScoped: true },
    { table: "synapse_batch_ledger" },
    { table: "embedding_measurement_corpus" },
    { table: "pending_session_cleanup", harnessScoped: true },
    { table: "message_history_fts" },
    { table: "message_fts_rowid_map" },
    { table: "message_history_source", harnessScoped: true },
    { table: "message_history_index", harnessScoped: true },
    { table: "lkg_slots" },
    { table: "lkg_slot_chunks" },
];

export interface DeleteSessionScopedRowsOptions {
    /** Set only after the Rust module has acknowledged its idempotent session deletion. */
    readonly rustModuleCleanupAcknowledged?: boolean;
    /** Keep tag-change counters when a session may resume; remove them only after host deletion is confirmed. */
    readonly preserveTagRevisionTombstones?: boolean;
}

/**
 * Delete one bounded session-id batch. A supplied harness scopes every table
 * that stores harness provenance; tables without that column rely on the
 * caller's harness-scoped candidate source.
 *
 * A Rust cleanup marker protects the entire host-side session until module
 * acknowledgement. Otherwise an orphan sweep could retain the marker while
 * deleting its session→project coordinate, making the durable retry unreachable.
 */
export function deleteSessionScopedRows(
    db: Database,
    sessionIds: readonly string[],
    harness?: string,
    options: DeleteSessionScopedRowsOptions = {},
): number {
    if (sessionIds.length === 0) return 0;
    let deletableSessionIds = [...sessionIds];
    if (options.rustModuleCleanupAcknowledged !== true) {
        const placeholders = sessionIds.map(() => "?").join(", ");
        const harnessPredicate = harness === undefined ? "" : " AND harness = ?";
        const protectedRows = db
            .prepare(
                `SELECT session_id
                 FROM pending_session_cleanup
                 WHERE session_id IN (${placeholders})
                   AND harness LIKE '%:rust'${harnessPredicate}`,
            )
            .all(...sessionIds, ...(harness === undefined ? [] : [`${harness}:rust`])) as Array<{
            session_id: string;
        }>;
        const protectedSessionIds = new Set(protectedRows.map((row) => row.session_id));
        deletableSessionIds = sessionIds.filter((sessionId) => !protectedSessionIds.has(sessionId));
    }
    if (deletableSessionIds.length === 0) return 0;
    const placeholders = deletableSessionIds.map(() => "?").join(", ");

    const harnessTables = SESSION_SCOPED_TABLES.filter((definition) => definition.harnessScoped);
    if (options.preserveTagRevisionTombstones) {
        // With the context rows gone, retain each producing harness next to the
        // tag-change counters. OpenCode's orphan sweep cannot infer Pi/OMP
        // session liveness from OpenCode's own database.
        const owners = db
            .prepare(
                harnessTables
                    .map(
                        (definition) =>
                            `SELECT session_id, harness FROM ${definition.table} WHERE session_id IN (${placeholders})${definition.extraPredicate ? ` AND ${definition.extraPredicate}` : ""}`,
                    )
                    .join(" UNION "),
            )
            .all(...harnessTables.flatMap(() => deletableSessionIds)) as {
            session_id: string;
            harness: string;
        }[];
        const record = db.prepare(
            "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, ?)",
        );
        for (const owner of owners)
            record.run(tagTombstoneOwnerKey(owner.session_id, owner.harness), owner.harness);
        const fallback = db.prepare(`INSERT INTO schema_migrations_meta (key, value)
            SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM schema_migrations_meta WHERE key >= ? AND key < ?)`);
        for (const id of deletableSessionIds)
            fallback.run(
                tagTombstoneOwnerKey(id, getHarness()),
                getHarness(),
                ...tagTombstoneOwnerRange(id),
            );
    }

    for (const sessionId of deletableSessionIds) deleteChunkEmbedBackoffForSession(db, sessionId);
    for (const definition of SESSION_SCOPED_TABLES) {
        if (definition.table === "message_history_fts") {
            db.prepare(
                `DELETE FROM message_history_fts
                 WHERE rowid IN (
                     SELECT fts_rowid
                     FROM message_fts_rowid_map
                     WHERE session_id IN (${placeholders})
                 )`,
            ).run(...deletableSessionIds);
            deleteUnmappedMessageFtsRows(db, deletableSessionIds);
            continue;
        }

        const predicates = [`session_id IN (${placeholders})`];
        if (definition.extraPredicate) predicates.push(definition.extraPredicate);
        const bindHarness = harness !== undefined && definition.harnessScoped === true;
        if (bindHarness) predicates.push("harness = ?");
        const statement = db.prepare(
            `DELETE FROM ${definition.table} WHERE ${predicates.join(" AND ")}`,
        );
        if (bindHarness) statement.run(...deletableSessionIds, harness);
        else statement.run(...deletableSessionIds);
    }
    // Activity is session-owned but stored as keys in the existing KV table,
    // so it cannot appear in the schema-derived SESSION_SCOPED_TABLES list.
    deleteSessionActivity(db, deletableSessionIds);
    if (!options.preserveTagRevisionTombstones) {
        const retireOwner = db.prepare(
            harness === undefined
                ? "DELETE FROM schema_migrations_meta WHERE key >= ? AND key < ?"
                : "DELETE FROM schema_migrations_meta WHERE key = ?",
        );
        const survivingRows = harnessTables
            .map(
                (definition) =>
                    `EXISTS (SELECT 1 FROM ${definition.table} WHERE session_id = ?${definition.extraPredicate ? ` AND ${definition.extraPredicate}` : ""})`,
            )
            .join(" OR ");
        const retire = db.prepare(`DELETE FROM schema_migrations_meta WHERE key IN (?, ?)
            AND NOT (${survivingRows})
            AND NOT EXISTS (SELECT 1 FROM schema_migrations_meta AS owners WHERE owners.key >= ? AND owners.key < ?)`);
        for (const id of deletableSessionIds) {
            if (harness === undefined) retireOwner.run(...tagTombstoneOwnerRange(id));
            else retireOwner.run(tagTombstoneOwnerKey(id, harness));
            retire.run(
                tagIdentityRevisionKey(id),
                tagRevisionKey(id),
                ...harnessTables.map(() => id),
                ...tagTombstoneOwnerRange(id),
            );
        }
    }
    for (const sessionId of deletableSessionIds) clearLkgRecoveryFence(sessionId);
    return deletableSessionIds.length;
}
