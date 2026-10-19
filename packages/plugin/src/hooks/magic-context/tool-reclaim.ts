import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import {
    AGE_RECLAIM_MIN_TOKENS,
    advanceToolReclaimWatermark,
    type ContextDatabase,
    getActiveToolTagsForAgeReclaim,
} from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import {
    farBehindToolBookmark,
    isReclaimUserTurn,
    type ReclaimDistanceEntry,
    stripReclaimMcText,
} from "../../shared/reclaim-distance";
import { estimatePartImageTokens } from "./final-wire-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike, TagTarget } from "./tag-messages";

export function buildSyntheticToolReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    watermark: number;
    pendingOps?: readonly PendingOp[];
    protectedTools?: Readonly<Record<string, number>>;
    protectedToolTags?: ReadonlySet<number>;
}): PendingOp[] {
    const watermark = Math.max(0, input.watermark);
    if (watermark <= 0) return [];

    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveToolTagsForAgeReclaim(input.db, input.sessionId);
    const protectedTags =
        input.protectedToolTags ?? protectedToolTagNumbers(tags, input.protectedTools);
    const synthetic: PendingOp[] = [];

    for (const tag of tags) {
        if (tag.tagNumber > watermark) continue;
        if (tag.reclaimableTokens !== null && tag.reclaimableTokens < AGE_RECLAIM_MIN_TOKENS) {
            continue;
        }
        if (protectedTags.has(tag.tagNumber)) continue;
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
    }

    return synthetic;
}

export function advanceToolReclaimWatermarkByDistance(
    db: ContextDatabase,
    sessionId: string,
    entries: readonly ReclaimDistanceEntry[],
    usableWindow: number,
): number {
    const bookmark = farBehindToolBookmark(entries, usableWindow);
    advanceToolReclaimWatermark(db, sessionId, bookmark);
    return bookmark;
}

/** Normalize OpenCode parts and Pi's transcript proxies into the same distance walk. */
export function toolReclaimDistanceEntries(
    messages: readonly MessageLike[],
    targets: ReadonlyMap<number, TagTarget>,
): ReclaimDistanceEntry[] {
    const outputTags = new Map<unknown, number>();
    for (const [tag, target] of targets) {
        for (const location of target.mutationParts ?? []) {
            const part = distancePart(location.part);
            if (part.kind === "tool_result" || part.kind === "tool")
                outputTags.set(location.part, tag);
        }
    }
    const entries: ReclaimDistanceEntry[] = [];
    for (const message of messages) {
        const parts = message.parts.map(distancePart);
        let userTurn = isReclaimUserTurn({ ...message.info, parts });
        for (const [index, part] of parts.entries()) {
            const authored = isReclaimUserTurn({ role: "user", parts: [part] });
            entries.push({
                tokens: message.info.syntheticHead
                    ? 0
                    : estimateTokens(stripReclaimMcText(part.text ?? "")) + part.imageTokens,
                userTurn: userTurn && authored,
                toolOutputTag: outputTags.get(message.parts[index]),
            });
            if (authored) userTurn = false;
        }
    }
    return entries;
}

function distancePart(raw: unknown): {
    kind: string;
    text?: string;
    synthetic?: boolean;
    ignored?: boolean;
    imageTokens: number;
} {
    if (!raw || typeof raw !== "object") return { kind: "structural", imageTokens: 0 };
    const part = raw as Record<string, unknown>;
    const provenance = { synthetic: part.synthetic === true, ignored: part.ignored === true };
    if (typeof part.getText === "function") {
        const text: unknown = part.getText();
        return {
            ...provenance,
            kind: String(part.kind),
            text: typeof text === "string" ? text : undefined,
            imageTokens: typeof part.imageTokens === "function" ? Number(part.imageTokens()) : 0,
        };
    }
    const metadata = { ...provenance, imageTokens: estimatePartImageTokens(raw) };
    if (part.type === "tool") {
        const state = part.state as { input?: unknown; output?: unknown } | undefined;
        return {
            ...metadata,
            kind: "tool",
            text: `${JSON.stringify(state?.input ?? {})}\n${typeof state?.output === "string" ? state.output : JSON.stringify(state?.output ?? "")}`,
        };
    }
    if (part.type === "tool_use")
        return { ...metadata, kind: "tool_use", text: JSON.stringify(part.input ?? {}) };
    if (part.type === "tool_result")
        return {
            ...metadata,
            kind: "tool_result",
            text:
                typeof part.content === "string"
                    ? part.content
                    : JSON.stringify(part.content ?? ""),
        };
    return {
        ...metadata,
        kind: String(part.type),
        text:
            typeof part.text === "string"
                ? part.text
                : typeof part.thinking === "string"
                  ? part.thinking
                  : undefined,
    };
}
