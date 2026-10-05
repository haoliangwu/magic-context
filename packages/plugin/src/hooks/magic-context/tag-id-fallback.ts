import type { ContextDatabase } from "../../features/magic-context/storage";
import { updateTagMessageId } from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";

type TaggableContentType = "message" | "file";

interface ScopedAssignment {
    tagNumber: number;
    contentId: string;
    partIndex: number;
}

type ScopedAssignments = Record<TaggableContentType, ScopedAssignment[]>;

interface ParsedContentId {
    messageId: string;
    type: TaggableContentType;
    partIndex: number;
}

export interface ExistingTagResolver {
    resolve: (
        messageId: string,
        type: TaggableContentType,
        currentContentId: string,
        ordinal: number,
        options?: { accept?: (tagNumber: number) => boolean },
    ) => number | undefined;
}

function parseScopedContentId(contentId: string): ParsedContentId | null {
    const match = /^(.*):(p|file)(\d+)$/.exec(contentId);
    if (!match) return null;

    return {
        messageId: match[1],
        type: match[2] === "file" ? "file" : "message",
        partIndex: Number.parseInt(match[3], 10),
    };
}

function createScopedAssignments(
    assignments: ReadonlyMap<string, number>,
): Map<string, ScopedAssignments> {
    const scoped = new Map<string, ScopedAssignments>();

    for (const [contentId, tagNumber] of assignments) {
        const parsed = parseScopedContentId(contentId);
        if (!parsed) continue;

        const entry = scoped.get(parsed.messageId) ?? { message: [], file: [] };
        entry[parsed.type].push({ tagNumber, contentId, partIndex: parsed.partIndex });
        scoped.set(parsed.messageId, entry);
    }

    for (const entry of scoped.values()) {
        entry.message.sort((left, right) => left.partIndex - right.partIndex);
        entry.file.sort((left, right) => left.partIndex - right.partIndex);
    }

    return scoped;
}

export function createExistingTagResolver(
    sessionId: string,
    tagger: Tagger,
    db: ContextDatabase,
): ExistingTagResolver {
    const assignments = tagger.getAssignments(sessionId);
    let cachedAssignmentSize = -1;
    let cachedScopedAssignments: Map<string, ScopedAssignments> | null = null;
    const usedTagNumbers = new Set<number>();
    // Content ids of parts this pass has already resolved. Each one is the live
    // identity of a part whose tag is already decided (an exact hit, a fallback
    // rebind, or a fresh tag allocated by the caller after a miss), so its
    // binding must never be offered as the fallback for a later part.
    const claimedContentIds = new Set<string>();

    function getScopedAssignments(): Map<string, ScopedAssignments> {
        if (!cachedScopedAssignments || cachedAssignmentSize !== assignments.size) {
            cachedScopedAssignments = createScopedAssignments(assignments);
            cachedAssignmentSize = assignments.size;
        }

        return cachedScopedAssignments;
    }

    return {
        resolve(messageId, type, currentContentId, ordinal, options) {
            const accept = options?.accept ?? (() => true);
            claimedContentIds.add(currentContentId);
            const exactTagId = assignments.get(currentContentId);
            if (exactTagId !== undefined && accept(exactTagId)) {
                usedTagNumbers.add(exactTagId);
                return exactTagId;
            }

            const fallback = getScopedAssignments().get(messageId)?.[type][ordinal];
            // The scoped view is rebuilt whenever the assignment count changes, so a
            // rebuild in the middle of a pass also lists tags the caller allocated
            // earlier in this same pass, which usedTagNumbers never saw. Skipping
            // candidates bound to a part already claimed this pass keeps a tag that
            // is already on another part from being handed out twice.
            if (
                !fallback ||
                usedTagNumbers.has(fallback.tagNumber) ||
                claimedContentIds.has(fallback.contentId) ||
                !accept(fallback.tagNumber)
            ) {
                return undefined;
            }

            updateTagMessageId(db, sessionId, fallback.tagNumber, currentContentId);
            tagger.unbindTag(sessionId, fallback.contentId);
            tagger.bindTag(sessionId, currentContentId, fallback.tagNumber);
            usedTagNumbers.add(fallback.tagNumber);
            return fallback.tagNumber;
        },
    };
}
