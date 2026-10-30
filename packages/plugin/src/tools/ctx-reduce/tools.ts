import { createHash } from "node:crypto";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import type { ProtectionWindowResult } from "../../features/magic-context/protection-window";
import { parseRangeString } from "../../features/magic-context/range-parser";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsByNumbers,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getInertWhitespaceAssistantTagsByNumbers } from "../../features/magic-context/storage-tags";
import { isLegacyForeignTextTag } from "../../hooks/magic-context/foreign-text-parts";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { renderCapabilityRefusal } from "../../shared/user-facing-codes";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_REDUCE_DESCRIPTION, formatCtxReduceReply } from "./constants";
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
                return `Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}.`;
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
                    const refusedStampCount = new Set(refusedStamps).size;
                    const acceptedTagNumbers = Array.isArray(record.ctx_reduce_queued_tags)
                        ? record.ctx_reduce_queued_tags.filter(
                              (tagNumber): tagNumber is number =>
                                  typeof tagNumber === "number" && Number.isInteger(tagNumber),
                          )
                        : null;
                    if (queued <= 0) {
                        const alreadyStampedCount = acceptedTagNumbers
                            ? new Set(acceptedTagNumbers).size
                            : 0;
                        const reply = formatCtxReduceReply(alreadyStampedCount, refusedStampCount);
                        if (reply) return reply;
                        return "All requested tags were already queued or processed. No new action is needed.";
                    }
                    const reportedTagNumbers = [
                        ...(Array.isArray(record.held_tag_numbers)
                            ? record.held_tag_numbers.filter(
                                  (number): number is number => typeof number === "number",
                              )
                            : []),
                        ...(Array.isArray(record.immediate_tag_numbers)
                            ? record.immediate_tag_numbers.filter(
                                  (number): number is number => typeof number === "number",
                              )
                            : []),
                    ];
                    const stampedCount = acceptedTagNumbers
                        ? new Set(acceptedTagNumbers).size
                        : reportedTagNumbers.length > 0
                          ? new Set(reportedTagNumbers).size
                          : queued;
                    return formatCtxReduceReply(stampedCount, refusedStampCount);
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
            const ctxReduceSelfStampCount = new Set(
                dropIds.filter((id) => ctxReduceSelfStampIds.has(id)),
            ).size;
            dropIds = dropIds.filter((id) => !ctxReduceSelfStampIds.has(id));

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));
            // Only membership of the requested tags is consulted below, so look
            // up just those instead of every inert tag in the session.
            const inertWhitespaceTagNumbers = new Set(
                getInertWhitespaceAssistantTagsByNumbers(deps.db, sessionId, dropIds).map(
                    (tag) => tag.tagNumber,
                ),
            );
            // A tag an older release put on another plugin's text part (OpenCode 1)
            // can't reclaim anything: that text belongs to the other plugin, and a
            // new drop on it is never applied. Skip it per id like provider
            // framing; never fail the call.
            const foreignTextTagNumbers = new Set(
                dropIds.filter((id) => isLegacyForeignTextTag(sessionId, id)),
            );
            const skippedTagNumbers = new Set([
                ...inertWhitespaceTagNumbers,
                ...foreignTextTagNumbers,
            ]);
            const skippedDropIds = [...new Set(dropIds.filter((id) => skippedTagNumbers.has(id)))];
            const inertNote =
                skippedDropIds.length > 0
                    ? `Skipped: ${skippedDropIds
                          .map((id) =>
                              inertWhitespaceTagNumbers.has(id)
                                  ? `§${id}§ is provider framing, nothing to reclaim`
                                  : `§${id}§ is another plugin's text, nothing to reclaim`,
                          )
                          .join("; ")}.`
                    : "";

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted" && !skippedTagNumbers.has(id)) {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const stampedCount = new Set(dropIds.filter((id) => !skippedTagNumbers.has(id))).size;
            dropIds = dropIds.filter(
                (id) =>
                    !skippedTagNumbers.has(id) &&
                    tagStatusMap.get(id) !== "dropped" &&
                    pendingMap.get(id) !== "drop",
            );
            if (dropIds.length === 0) {
                const reply = formatCtxReduceReply(stampedCount, ctxReduceSelfStampCount);
                if (reply) return `${reply}${inertNote ? ` ${inertNote}` : ""}`;
                if (inertNote) return inertNote;
                return "All requested tags were already queued or processed. No new action is needed.";
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

            const reply = formatCtxReduceReply(stampedCount, ctxReduceSelfStampCount);
            return `${reply}${inertNote ? ` ${inertNote}` : ""}`;
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
