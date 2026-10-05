import {
    loadPostprocessReplaySnapshot,
    type PostprocessReplaySnapshot,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getOldestActiveUnprotectedToolTags,
    getTailHygieneTags,
} from "../../features/magic-context/storage-tags";
import type { TagEntry } from "../../features/magic-context/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { Database, Statement } from "../../shared/sqlite";

interface TagSnapshot {
    version: number;
    changes: number;
    tags?: TagEntry[];
    replay?: PostprocessReplaySnapshot;
    hints?: {
        protectedNumbers: Set<number>;
        value: ReturnType<typeof getOldestActiveUnprotectedToolTags>;
    };
}
const connections = new WeakMap<
    Database,
    {
        stamp: Statement;
        sessions: BoundedSessionMap<TagSnapshot>;
    }
>();

/** Read-only attribution snapshot; callers must not mutate the returned rows. */
function snapshot(db: Database, sessionId: string): TagSnapshot {
    const transaction = db as unknown as { inTransaction?: boolean; isTransaction?: boolean };
    // Never retain uncommitted rows: total_changes does not advance on rollback.
    try {
        if (transaction.inTransaction || transaction.isTransaction) {
            connections.delete(db);
            return { version: -1, changes: -1 };
        }
    } catch {
        // Instrumented database proxies may not bind native SQLite getters.
        // If transaction state is unavailable, use uncached reads rather than
        // risk retaining rows from a transaction that later rolls back.
        connections.delete(db);
        return { version: -1, changes: -1 };
    }
    let connection = connections.get(db);
    if (!connection) {
        connection = {
            stamp: db.prepare(
                "SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version",
            ),
            sessions: new BoundedSessionMap<TagSnapshot>(100),
        };
        connections.set(db, connection);
    }
    // Local writes invalidate via total_changes; commits from other connections
    // invalidate via data_version. Neither clock depends on wall time or tag age.
    const stamp = connection.stamp.get() as { version: number; changes: number };
    const previous = connection.sessions.get(sessionId);
    if (previous?.version === stamp.version && previous.changes === stamp.changes) {
        return previous;
    }
    const value = { ...stamp };
    connection.sessions.set(sessionId, value);
    return value;
}

export function postprocessTailTags(db: Database, sessionId: string): TagEntry[] {
    const state = snapshot(db, sessionId);
    return (state.tags ??= getTailHygieneTags(db, sessionId));
}

export function postprocessOldestTags(
    db: Database,
    sessionId: string,
    protectedNumbers: ReadonlySet<number>,
): ReturnType<typeof getOldestActiveUnprotectedToolTags> {
    const state = snapshot(db, sessionId);
    const hints = state.hints;
    if (
        hints &&
        hints.protectedNumbers.size === protectedNumbers.size &&
        [...protectedNumbers].every((number) => hints.protectedNumbers.has(number))
    ) {
        return hints.value;
    }
    // Pending drops and token/status changes share the database clocks above;
    // a protection-window change additionally invalidates this hint selection.
    const value = getOldestActiveUnprotectedToolTags(db, sessionId, protectedNumbers);
    state.hints = { protectedNumbers: new Set(protectedNumbers), value };
    return value;
}

export function postprocessReplaySnapshot(
    db: Database,
    sessionId: string,
): PostprocessReplaySnapshot {
    const state = snapshot(db, sessionId);
    const replay = (state.replay ??= loadPostprocessReplaySnapshot(db, sessionId));
    // Strip detection extends the pass-local sets. Never expose cached mutable
    // containers: even a failed persistence attempt must not poison later replay.
    return {
        ...replay,
        staleReduceStrippedIds: new Set(replay.staleReduceStrippedIds),
        processedImageStrippedIds: new Set(replay.processedImageStrippedIds),
        strippedPlaceholderIds: new Set(replay.strippedPlaceholderIds),
        hiddenSeamPlaceholderIds: new Set(replay.hiddenSeamPlaceholderIds),
        mergedReasoningStrippedIds: new Set(replay.mergedReasoningStrippedIds),
        trailingBlankDecisions: new Map(replay.trailingBlankDecisions),
        noteNudgeAnchors: structuredClone(replay.noteNudgeAnchors),
        autoSearchHintDecisions: structuredClone(replay.autoSearchHintDecisions),
        todoSyntheticAnchor: structuredClone(replay.todoSyntheticAnchor),
        pendingCompactionMarker: structuredClone(replay.pendingCompactionMarker),
        compactionMarker: structuredClone(replay.compactionMarker),
    };
}
