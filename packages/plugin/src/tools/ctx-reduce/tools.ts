import { createHash } from "node:crypto";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
    getProtectionWindowForSession,
    type ProtectionWindowResult,
} from "../../features/magic-context/protection-window";
import { parseRangeString } from "../../features/magic-context/range-parser";
import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import {
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsByNumbers,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getInertWhitespaceAssistantTags } from "../../features/magic-context/storage-tags";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { renderCapabilityRefusal } from "../../shared/user-facing-codes";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_REDUCE_DESCRIPTION, ctxReduceSelfStampMessage } from "./constants";
import type { CtxReduceArgs } from "./types";

export { CTX_REDUCE_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxReduceToolDeps {
    db: Database;
    /**
     * Tag numbers protected by the current token window. An empty set means no
     * results are held by that window; per-tool keep counts still hold queued
     * drops until newer calls displace the result and a rebuilding pass applies them.
     */
    protectedSet?: ReadonlySet<number> | ((sessionId: string) => ReadonlySet<number>);
    protectedTools?: Readonly<Record<string, number>>;
    getProtectionWindow?: (sessionId: string) => ProtectionWindowResult;
    floor?: number;
    getSessionTokens?: (sessionId: string) => number;
    rustToolBackends?: RustToolBackends;
}

function formatRawDropForAck(rawDrop: string): string {
    return rawDrop
        .trim()
        .split(",")
        .map((token) => {
            const trimmed = token.trim();
            return /^\d+$/.test(trimmed) ? `§${trimmed}§` : trimmed;
        })
        .join(", ");
}

const ctxReduceArgsShape = {
    drop: tool.schema
        .string()
        .optional()
        .describe('Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".'),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxReduceArgsSchema = tool.schema.object(ctxReduceArgsShape).passthrough();

function createCtxReduceTool(deps: CtxReduceToolDeps): ToolDefinition {
    let fallbackCommandSequence = 0;

    const commandIdForInvocation = (sessionId: string, toolContext: unknown): string => {
        const context =
            toolContext !== null && typeof toolContext === "object"
                ? (toolContext as Record<string, unknown>)
                : {};
        const callId =
            (typeof context.callID === "string" && context.callID.trim()) ||
            (typeof context.callId === "string" && context.callId.trim());
        if (callId) {
            const stableId = `oc-${sessionId}-${callId}`;
            if (Buffer.byteLength(stableId) <= 128) return stableId;
            return `oc-${createHash("sha256").update(stableId).digest("hex")}`;
        }
        fallbackCommandSequence += 1;
        const monotonicId = `oc-${sessionId}-${fallbackCommandSequence}`;
        return Buffer.byteLength(monotonicId) <= 128
            ? monotonicId
            : `oc-${createHash("sha256").update(monotonicId).digest("hex")}`;
    };

    return tool({
        description: CTX_REDUCE_DESCRIPTION,
        args: ctxReduceArgsShape,
        async execute(rawArgs: CtxReduceArgs, toolContext) {
            const parsedArgs = ctxReduceArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxReduceArgs;
            args = unwrapImitatedReducedArgs(args, ["drop"], { drop: "string" });
            const sessionId = toolContext.sessionID;

            if (!args.drop) {
                return "Error: 'drop' must be provided.";
            }

            const rustReduce = deps.rustToolBackends?.reduce;
            if (rustReduce) {
                try {
                    const response = await rustReduce({
                        sessionId,
                        projectRoot: toolContext.directory,
                        drop: args.drop,
                        commandId: commandIdForInvocation(sessionId, toolContext),
                    });
                    const value =
                        response !== null && typeof response === "object" && "result" in response
                            ? (response as { result?: unknown }).result
                            : response;
                    const record =
                        value !== null && typeof value === "object"
                            ? (value as Record<string, unknown>)
                            : null;
                    if (record === null || record.ok !== true) {
                        const error =
                            record && "error" in record
                                ? (record as { error?: unknown }).error
                                : undefined;
                        const errorRecord =
                            error !== null && typeof error === "object"
                                ? (error as { message?: unknown })
                                : undefined;
                        const message =
                            (typeof error === "string" && error.trim() ? error : undefined) ??
                            (typeof errorRecord?.message === "string" && errorRecord.message.trim()
                                ? errorRecord.message
                                : undefined) ??
                            (typeof record?.message === "string" && record.message.trim()
                                ? record.message
                                : "module rejected agent_drops.append");
                        sessionLog(sessionId, "ctx_reduce capability refusal", message);
                        return renderCapabilityRefusal("context_cleanup");
                    }
                    const queued = typeof record.queued === "number" ? record.queued : 0;
                    const refusedStamps = Array.isArray(record.ctx_reduce_self_stamps)
                        ? record.ctx_reduce_self_stamps.filter(
                              (tagNumber): tagNumber is number =>
                                  typeof tagNumber === "number" && Number.isInteger(tagNumber),
                          )
                        : [];
                    const refusedStampNote = refusedStamps.map(ctxReduceSelfStampMessage).join(" ");
                    const acceptedTagNumbers = Array.isArray(record.ctx_reduce_queued_tags)
                        ? record.ctx_reduce_queued_tags.filter(
                              (tagNumber): tagNumber is number =>
                                  typeof tagNumber === "number" && Number.isInteger(tagNumber),
                          )
                        : null;
                    if (queued <= 0) {
                        if (refusedStampNote) return refusedStampNote;
                        return "All requested tags were already queued or processed. No new action is needed.";
                    }
                    if (
                        Array.isArray(record.held_tag_numbers) &&
                        record.held_tag_numbers.length > 0
                    ) {
                        const held = record.held_tag_numbers.filter(
                            (number): number is number => typeof number === "number",
                        );
                        const immediate = Array.isArray(record.immediate_tag_numbers)
                            ? record.immediate_tag_numbers.filter(
                                  (number): number is number => typeof number === "number",
                              )
                            : [];
                        const sentence =
                            held.length === 1
                                ? `Held: §${held[0]} is inside the protected working set; it applies once newer work displaces it.`
                                : `Held: ${held.map((id) => `§${id}`).join(", ")} are inside the protected working set; they apply once newer work displaces them.`;
                        const acknowledgement =
                            immediate.length > 0
                                ? `Queued: drop ${formatIds(immediate)}. ${sentence}`
                                : sentence;
                        return `${acknowledgement}${refusedStampNote ? ` ${refusedStampNote}` : ""}`;
                    }
                    // The module owns range parsing and tag canonicalization. Keep the
                    // existing queued acknowledgement shape without reimplementing that
                    // parsing in the OpenCode tool.
                    const acknowledgedDrop = acceptedTagNumbers
                        ? formatIds(acceptedTagNumbers)
                        : formatRawDropForAck(args.drop);
                    return `Queued: drop ${acknowledgedDrop}.${refusedStampNote ? ` ${refusedStampNote}` : ""}`;
                } catch (error) {
                    sessionLog(sessionId, "ctx_reduce capability refusal", error);
                    return renderCapabilityRefusal("context_cleanup");
                }
            }

            let dropIds: number[] = [];

            try {
                dropIds = parseRangeString(args.drop);
            } catch (e) {
                return `Error: Invalid range syntax. ${(e as Error).message}`;
            }

            const allIds = [...new Set(dropIds)];

            const allTags = getTagsByNumbers(deps.db, sessionId, allIds);
            const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
            const unknownIds = allIds.filter((id) => !foundSet.has(id));
            if (unknownIds.length > 0) {
                return `Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`;
            }

            const ctxReduceSelfStampIds = new Set(
                allTags
                    .filter((tag) => tag.toolName?.toLowerCase() === "ctx_reduce")
                    .map((tag) => tag.tagNumber),
            );
            const ctxReduceSelfStampNote = dropIds
                .filter((id) => ctxReduceSelfStampIds.has(id))
                .filter((id, index, ids) => ids.indexOf(id) === index)
                .map(ctxReduceSelfStampMessage)
                .join(" ");
            dropIds = dropIds.filter((id) => !ctxReduceSelfStampIds.has(id));

            // Form: protectedSet (tag-number set form). Coordinate space: tag-number space.
            // Empty-window behavior: empty set means zero tool tags are protected by the window;
            // non-tool tags never become reclaim targets.
            let protectedSet: ReadonlySet<number>;
            if (deps.protectedSet) {
                protectedSet =
                    typeof deps.protectedSet === "function"
                        ? deps.protectedSet(sessionId)
                        : deps.protectedSet;
            } else if (deps.getProtectionWindow) {
                protectedSet = deps.getProtectionWindow(sessionId).protectedTagNumbers;
            } else {
                protectedSet = getProtectionWindowForSession(
                    deps.db,
                    sessionId,
                    deps.floor,
                ).protectedTagNumbers;
            }

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));
            protectedSet = new Set([
                ...protectedSet,
                ...protectedToolTagNumbers(
                    getActiveTagsBySession(deps.db, sessionId),
                    deps.protectedTools,
                ),
            ]);
            const inertWhitespaceTagNumbers = new Set(
                getInertWhitespaceAssistantTags(deps.db, sessionId).map((tag) => tag.tagNumber),
            );
            const inertDropIds = [
                ...new Set(dropIds.filter((id) => inertWhitespaceTagNumbers.has(id))),
            ];
            const inertNote =
                inertDropIds.length > 0
                    ? `Skipped: ${inertDropIds
                          .map((id) => `§${id}§ is provider framing, nothing to reclaim`)
                          .join("; ")}.`
                    : "";

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted" && !inertWhitespaceTagNumbers.has(id)) {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const preFilterDropCount = dropIds.length;
            dropIds = dropIds.filter(
                (id) =>
                    !inertWhitespaceTagNumbers.has(id) &&
                    tagStatusMap.get(id) !== "dropped" &&
                    pendingMap.get(id) !== "drop",
            );
            const skippedCount = preFilterDropCount - dropIds.length;

            if (dropIds.length === 0) {
                const noActionNotes = [ctxReduceSelfStampNote, inertNote].filter(Boolean);
                if (!ctxReduceSelfStampNote) {
                    noActionNotes.push(
                        "All requested tags were already queued or processed. No new action is needed.",
                    );
                }
                return noActionNotes.join(" ");
            }

            try {
                deps.db
                    .transaction(() => {
                        const now = Date.now();
                        for (const id of dropIds) {
                            queuePendingOp(deps.db, sessionId, id, "drop", now);
                        }
                    })
                    .immediate();
            } catch (error) {
                const errorMessage = getErrorMessage(error);
                return `Error: Failed to queue ctx_reduce operations. ${errorMessage}`;
            }

            const currentInputTokens =
                deps.getSessionTokens?.(sessionId) ??
                getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
            updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });

            const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
            const deferredDropIds = [...new Set(dropIds.filter((id) => protectedSet.has(id)))];
            const skippedNote =
                skippedCount > 0
                    ? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
                    : "";

            let heldSentence = "";
            if (deferredDropIds.length === 1) {
                heldSentence = `Held: §${deferredDropIds[0]} is inside the protected working set; it applies once newer work displaces it.`;
            } else if (deferredDropIds.length > 1) {
                heldSentence = `Held: ${deferredDropIds.map((id) => `§${id}`).join(", ")} are inside the protected working set; they apply once newer work displaces them.`;
            }

            if (immediateDropIds.length > 0 && heldSentence.length > 0) {
                return `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""} ${heldSentence}${ctxReduceSelfStampNote ? ` ${ctxReduceSelfStampNote}` : ""}`;
            }
            if (immediateDropIds.length > 0) {
                return `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}${ctxReduceSelfStampNote ? ` ${ctxReduceSelfStampNote}` : ""}`;
            }
            if (heldSentence.length > 0) {
                return `${heldSentence}${skippedNote}${inertNote ? ` ${inertNote}` : ""}${ctxReduceSelfStampNote ? ` ${ctxReduceSelfStampNote}` : ""}`;
            }
            return `Queued: drop ${formatIds(dropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}${ctxReduceSelfStampNote ? ` ${ctxReduceSelfStampNote}` : ""}`;
        },
    });
}

function formatIds(ids: number[]): string {
    return ids.map((id) => `§${id}§`).join(", ");
}

export function createCtxReduceTools(deps: CtxReduceToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_reduce: createCtxReduceTool(deps),
    };
}
