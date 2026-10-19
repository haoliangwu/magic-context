/**
 * Pi-side wrapper for the `ctx_reduce` tool.
 *
 * Mirrors OpenCode's `packages/plugin/src/tools/ctx-reduce/tools.ts`.
 * Marking QUEUES content for release; it stays visible until it is actually
 * released, which may be the next turn or many turns later.
 * The shared description below keeps this contract identical to OpenCode.
 *
 * Registered for primary Pi sessions. `--no-session` child processes omit this
 * tool because it resolves the current session id at call time, and those
 * children would otherwise write drops against their hidden ephemeral session.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseRangeString } from "@magic-context/core/features/magic-context/range-parser";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getInertWhitespaceAssistantTagsByNumbers } from "@magic-context/core/features/magic-context/storage-tags";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import {
	CTX_REDUCE_DESCRIPTION,
	formatCtxReduceReply,
} from "@magic-context/core/tools/ctx-reduce/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object(
	{
		drop: Type.Optional(
			Type.String({
				description: 'Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".',
			}),
		),
	},
	{ additionalProperties: true },
);

type CtxReduceParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

function formatIds(ids: number[]): string {
	return ids.map((id) => `§${id}§`).join(", ");
}

export interface CtxReduceToolDeps {
	protectedTools?: Readonly<Record<string, number>>;
	resolveProtectedTools?: (ctx: {
		cwd: string;
	}) => Readonly<Record<string, number>> | undefined;
	db: ContextDatabase;
	protectedTags?: number;
	floor?: number;
	protectedTokens?: number;
	resolveFloor?: (ctx: { cwd: string }) => number | undefined;
	resolveProtectedTags?: (ctx: { cwd: string }) => number | undefined;
	getSessionTokens?: (sessionId: string) => number;
}

export function createCtxReduceTool(
	deps: CtxReduceToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_reduce",
		label: "Magic Context: Reduce",
		description: CTX_REDUCE_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxReduceParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["drop"], { drop: "string" });
			const sessionId = ctx.sessionManager.getSessionId();

			if (!params.drop) {
				return err("Error: 'drop' must be provided.");
			}

			let dropIds: number[] = [];
			try {
				dropIds = parseRangeString(params.drop);
			} catch (e) {
				return err(`Error: Invalid range syntax. ${(e as Error).message}`);
			}

			const allIds = [...new Set(dropIds)];

			const allTags = getTagsBySession(deps.db, sessionId);
			const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
			const unknownIds = allIds.filter((id) => !foundSet.has(id));
			if (unknownIds.length > 0) {
				return err(
					`Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`,
				);
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

			const tagStatusMap = new Map(
				allTags.map((tag) => [tag.tagNumber, tag.status]),
			);
			// Only membership of the requested tags is consulted below, so look
			// up just those instead of every inert tag in the session.
			const inertWhitespaceTagNumbers = new Set(
				getInertWhitespaceAssistantTagsByNumbers(
					deps.db,
					sessionId,
					dropIds,
				).map((tag) => tag.tagNumber),
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
			const pendingMap = new Map(
				pendingOps.map((op) => [op.tagId, op.operation]),
			);

			// Reject drops on compaction-survivor tags. Mirrors OpenCode's
			// `tagStatusMap.get(id) === "compacted"` guard — those tags are
			// the synthesized survivors of an OpenCode compaction marker and
			// can't be dropped without confusing downstream readers.
			const conflicts: string[] = [];
			for (const id of dropIds) {
				if (
					tagStatusMap.get(id) === "compacted" &&
					!inertWhitespaceTagNumbers.has(id)
				) {
					conflicts.push(`§${id}§ is from before compaction`);
				}
			}
			if (conflicts.length > 0) {
				return err(`Error: Conflicting operations — ${conflicts.join("; ")}.`);
			}

			const stampedCount = new Set(
				dropIds.filter((id) => !inertWhitespaceTagNumbers.has(id)),
			).size;
			dropIds = dropIds.filter(
				(id) =>
					!inertWhitespaceTagNumbers.has(id) &&
					tagStatusMap.get(id) !== "dropped" &&
					pendingMap.get(id) !== "drop",
			);

			if (dropIds.length === 0) {
				const reply = formatCtxReduceReply(
					stampedCount,
					ctxReduceSelfStampCount,
				);
				if (reply) return ok(`${reply}${inertNote ? ` ${inertNote}` : ""}`);
				if (inertNote) return ok(inertNote);
				return ok("No new action is needed.");
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
				return err(
					`Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
				);
			}

			const currentInputTokens =
				deps.getSessionTokens?.(sessionId) ??
				getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
			updateSessionMeta(deps.db, sessionId, {
				lastNudgeTokens: currentInputTokens,
			});

			const reply = formatCtxReduceReply(stampedCount, ctxReduceSelfStampCount);
			return ok(`${reply}${inertNote ? ` ${inertNote}` : ""}`);
		},
	};
}
