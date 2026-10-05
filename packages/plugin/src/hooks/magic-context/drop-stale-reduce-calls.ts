import { isRecord } from "../../shared/record-type-guard";
import { toolPartHasUserAnswer } from "../../shared/user-answer";
import { isSentinel, makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const STALE_TOOL_NAMES = new Set(["ctx_reduce"]);

export function isReduceToolPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    // OpenCode format: { type: "tool", tool: "ctx_reduce" }
    if (part.type === "tool" && typeof part.tool === "string" && STALE_TOOL_NAMES.has(part.tool))
        return true;
    // tool-invocation format: { type: "tool-invocation", toolName: "ctx_reduce" }
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        STALE_TOOL_NAMES.has(part.toolName)
    )
        return true;
    // tool_use format: { type: "tool_use", name: "ctx_reduce" }
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        STALE_TOOL_NAMES.has(part.name)
    )
        return true;
    return false;
}

function hasAnyMeaningfulPart(parts: unknown[]): boolean {
    for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
            return true;
        if (
            part.type === "thinking" ||
            part.type === "reasoning" ||
            part.type === "redacted_thinking"
        )
            continue;
        if (part.type === "meta" || part.type === "step-start" || part.type === "step-finish")
            continue;
        if (part.type !== "tool" || !isReduceToolPart(part)) return true;
    }
    return false;
}

function messageHasReducePart(message: MessageLike): boolean {
    for (const part of message.parts) {
        if (isSentinel(part)) continue;
        if (isReduceToolPart(part)) return true;
    }
    return false;
}

function sentinelizeReduceParts(
    message: MessageLike,
    onFirstApplication?: (message: MessageLike, partIndex: number) => void,
): boolean {
    let touched = false;
    for (let j = 0; j < message.parts.length; j++) {
        const part = message.parts[j];
        if (isSentinel(part)) continue;
        if (isReduceToolPart(part)) {
            onFirstApplication?.(message, j);
            message.parts[j] = makeSentinel(part);
            touched = true;
        }
    }
    if (touched && !hasAnyMeaningfulPart(message.parts)) {
        onFirstApplication?.(message, 0);
        // Whole message becomes a single-sentinel-part shell. Preserves
        // messages.length so proxy cache hashes stay stable.
        message.parts.length = 0;
        message.parts.push(makeSentinel(undefined));
    }
    return touched;
}

export interface StaleReduceStripResult {
    /** True if any ctx_reduce part was sentinelized this pass. */
    didDrop: boolean;
    /** Message ids newly detected as aged this pass (only when detect=true). */
    newlyStrippedIds: string[];
}

/**
 * Sentinel-strip aged `ctx_reduce` tool parts using a FROZEN replay watermark.
 *
 * The cache-stability contract: a defer pass must replay byte-identical to the
 * prior pass. An earlier version recomputed eligibility from the live
 * `messages.length - protectedCount` boundary on every pass — but that boundary
 * MOVES as the conversation grows, so a defer pass with tail growth would newly
 * strip an older ctx_reduce call mid-prefix (for Anthropic the empty sentinel is
 * filtered before the wire and the dropped tool_result lets the SDK merge
 * adjacent assistants → the message vanishes + the array shifts → the cached
 * prefix busts). That is exactly the bug this design removes.
 *
 * Instead, eligibility is an id-keyed frozen set:
 * - REPLAY (every pass): strip ctx_reduce parts in any message whose `info.id`
 *   is in `frozenIds`. Growth-invariant and compaction-safe (a missing id is a
 *   no-op). This is what makes defer passes byte-identical.
 * - DETECT (cache-busting passes only, `detect=true`): additionally scan the
 *   pre-protected region for ctx_reduce calls not yet frozen, strip them, and
 *   return their ids in `newlyStrippedIds` so the caller can advance the
 *   persisted watermark. Detection happens only on passes where the wire is
 *   already allowed to change, so it never busts a defer pass.
 *
 * Messages without a stable `info.id` are never newly detected (they cannot be
 * frozen for deterministic replay), so they are left intact rather than stripped
 * inconsistently.
 */
export function dropStaleReduceCalls(
    messages: MessageLike[],
    frozenIds: Set<string>,
    options: {
        detect?: boolean;
        protectedCount?: number;
        /** Reports only newly edited locations, never frozen-id replay. */
        onFirstApplication?: (message: MessageLike, partIndex: number) => void;
    } = {},
): StaleReduceStripResult {
    const detect = options.detect ?? false;
    const protectedCount = options.protectedCount ?? 0;
    const protectedStart = messages.length - protectedCount;
    const newlyStrippedIds: string[] = [];
    let didDrop = false;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const id = typeof message.info.id === "string" ? message.info.id : undefined;

        // Replay: any message frozen on a prior cache-busting pass.
        const inFrozen = id !== undefined && frozenIds.has(id);
        // Detect (cache-busting passes only): a not-yet-frozen ctx_reduce call
        // that has aged past the protected window and carries a stable id.
        const isNewDetection =
            !inFrozen &&
            detect &&
            i < protectedStart &&
            id !== undefined &&
            messageHasReducePart(message) &&
            !message.parts.some(toolPartHasUserAnswer);

        if (!inFrozen && !isNewDetection) continue;

        const touched = sentinelizeReduceParts(
            message,
            isNewDetection ? options.onFirstApplication : undefined,
        );
        if (touched) {
            didDrop = true;
            if (isNewDetection && id !== undefined) newlyStrippedIds.push(id);
        }
    }

    return { didDrop, newlyStrippedIds };
}
