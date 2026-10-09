import {
    normalizeProtectedToolName,
    protectedToolTagNumbers,
} from "../../features/magic-context/reclaim-protection";
import { type ContextDatabase, getActiveTagsBySession } from "../../features/magic-context/storage";
import { getRecentTagOwnerMessageIds } from "../../features/magic-context/storage-tags";
import type { PendingOp } from "../../features/magic-context/types";
import { isEditTool } from "./edit-marker";
import type { TagTarget } from "./tag-messages";

// Select completed tool results made obsolete by later state, regardless of
// age. The caller acts on this selection only during an execute pass that is
// already rebuilding the cache, so selection alone never invalidates a cache.
//
// Keep counts come from the shared protected-tools snapshot.

/** Preserve tool entries owned by the newest 20 messages as continuation context. */
export const SUPERSESSION_RECENT_MESSAGE_WINDOW = 20;

/**
 * Derive the continuation floor from persisted tag ordinals rather than the
 * current provider projection. Marker advances can temporarily contract that
 * projection, but persisted rows retain each owner's chronological position,
 * so a missing owner cannot become reclaimable before it reappears.
 */
export function recentSupersessionOwnerMessageIds(
    db: ContextDatabase,
    sessionId: string,
): Set<string> {
    return getRecentTagOwnerMessageIds(db, sessionId, SUPERSESSION_RECENT_MESSAGE_WINDOW);
}

// Tools whose output is worthless once the call ran. ctx_note is handled
// separately because only its read/dismiss actions are zero-value.
const ZERO_VALUE_META_TOOLS = new Set(["bash_status", "bash_kill"]);
// ctx_note actions that carry no durable value (write/update carry intent and
// are never dropped). An unreadable action fails safe = not a target.
const CTX_NOTE_ZERO_VALUE_ACTIONS = new Set(["read", "dismiss"]);

/**
 * Build synthetic drop ops for superseded spent-control-plane tool outputs.
 * Mirrors `buildSyntheticToolReclaimOps`'s op shape. The caller merges these
 * into the same gated `applyPendingOperations` call as the positional sweep.
 */
export function buildSupersessionReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
    protectedTools?: Readonly<Record<string, number>>;
    protectedToolTags?: ReadonlySet<number>;
    recentMessageIds?: ReadonlySet<string>;
    /**
     * Union projection form: protectedTagNumbers (tag-number set form).
     * Coordinate space: tag-number space.
     * Empty-window behavior: empty set means zero tool tags are protected by the token window;
     * non-tool tags are never reclaim targets.
     */
    protectedTagNumbers?: ReadonlySet<number>;
}): PendingOp[] {
    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);

    // Active tool tags, newest-first, so "keep newest N" = the first N seen.
    const toolTags = tags
        .filter((tag) => tag.type === "tool" && tag.status === "active")
        .sort((left, right) => right.tagNumber - left.tagNumber);

    const dropTagIds: number[] = [];
    const protectedTags =
        input.protectedToolTags ?? protectedToolTagNumbers(toolTags, input.protectedTools);

    for (const tag of toolTags) {
        if (input.protectedTagNumbers?.has(tag.tagNumber)) {
            continue;
        }
        const name = normalizeProtectedToolName(tag.toolName);
        if (!name) continue;

        let isTarget = false;
        if (name === "todowrite" || name === "ctx_reduce") {
            isTarget = true;
        } else if (ZERO_VALUE_META_TOOLS.has(name)) {
            isTarget = true;
        } else if (name === "ctx_note") {
            const action = input.targets.get(tag.tagNumber)?.readInput?.()?.action;
            // Fail safe: only drop when we can positively read a zero-value action.
            isTarget = typeof action === "string" && CTX_NOTE_ZERO_VALUE_ACTIONS.has(action);
        }
        if (
            isTarget &&
            (!input.recentMessageIds ||
                (tag.toolOwnerMessageId !== null &&
                    !input.recentMessageIds.has(tag.toolOwnerMessageId)))
        ) {
            dropTagIds.push(tag.tagNumber);
        }
    }

    const synthetic: PendingOp[] = [];
    for (const tagId of dropTagIds) {
        if (realPendingTagIds.has(tagId)) continue;
        if (protectedTags.has(tagId)) continue;
        if (input.targets.get(tagId)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId,
            operation: "drop",
            queuedAt: 0,
        });
    }
    return synthetic;
}

/**
 * Select superseded edit/write tool calls for COMPRESSION (not full drop).
 * Among active edit/write tags grouped by their `filePath`, the newest stays
 * full; every older edit to the same file is an edit_marker target. Like the
 * control-plane selector, supersession is age-independent so the watermark is
 * ignored, but the caller only acts inside the gated pass.
 *
 * Returns both the drop ops AND the set of tag ids that must be compressed as
 * edit_marker (the caller passes the set to applyPendingOperations).
 */
export function buildEditSupersessionReclaim(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
    protectedTools?: Readonly<Record<string, number>>;
    protectedToolTags?: ReadonlySet<number>;
    recentMessageIds?: ReadonlySet<string>;
    /**
     * Union projection form: protectedTagNumbers (tag-number set form).
     * Coordinate space: tag-number space.
     * Empty-window behavior: empty set means zero tool tags are protected by the token window.
     */
    protectedTagNumbers?: ReadonlySet<number>;
}): { ops: PendingOp[]; editMarkerTagIds: Set<number> } {
    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);

    // Active edit/write tags, newest-first, so the FIRST seen per file is kept.
    const editTags = tags
        .filter((tag) => tag.type === "tool" && tag.status === "active" && isEditTool(tag.toolName))
        .sort((left, right) => right.tagNumber - left.tagNumber);

    const seenFile = new Set<string>();
    const ops: PendingOp[] = [];
    const editMarkerTagIds = new Set<number>();
    const protectedTags =
        input.protectedToolTags ?? protectedToolTagNumbers(tags, input.protectedTools);

    for (const tag of editTags) {
        if (input.protectedTagNumbers?.has(tag.tagNumber)) {
            continue;
        }
        const filePath = readFilePath(input.targets.get(tag.tagNumber));
        // No resolvable filePath → cannot prove supersession by file identity;
        // leave it alone (fail safe).
        if (!filePath) continue;
        if (!seenFile.has(filePath)) {
            seenFile.add(filePath); // newest edit to this file stays full
            continue;
        }
        // Older edit to an already-seen file → compress, except within the
        // owner-message recency floor where the call may still guide continuation.
        if (
            input.recentMessageIds &&
            (tag.toolOwnerMessageId === null || input.recentMessageIds.has(tag.toolOwnerMessageId))
        ) {
            continue;
        }
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (protectedTags.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        editMarkerTagIds.add(tag.tagNumber);
        ops.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
    }
    return { ops, editMarkerTagIds };
}

const FILE_PATH_KEYS = ["filePath", "file_path", "path"] as const;

function readFilePath(target: TagTarget | undefined): string | null {
    const input = target?.readInput?.();
    if (!input) return null;
    for (const key of FILE_PATH_KEYS) {
        const value = input[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}
