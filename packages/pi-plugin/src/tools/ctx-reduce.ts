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
import {
	getProtectionWindowForSession,
	readEpochFloorSnapshot,
} from "@magic-context/core/features/magic-context/protection-window";
import { parseRangeString } from "@magic-context/core/features/magic-context/range-parser";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getInertWhitespaceAssistantTags } from "@magic-context/core/features/magic-context/storage-tags";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import { CTX_REDUCE_DESCRIPTION } from "@magic-context/core/tools/ctx-reduce/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object(
	{
		drop: Type.Optional(
			Type.String({
				description: "Tag IDs to drop entirely. Ranges: '3-5', '1,2,9'",
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

			const activeTags = allTags.filter((tag) => tag.status === "active");

			// Resolve the effective token floor threshold used to compute the protection window
			const effectiveFloor =
				readEpochFloorSnapshot(deps.db, sessionId) ??
				deps.resolveFloor?.(ctx) ??
				deps.floor ??
				deps.protectedTokens ??
				16_000;
			// Protection window membership in tag-number coordinate space (empty-window behaviour: empty set)
			const windowResult = getProtectionWindowForSession(
				deps.db,
				sessionId,
				effectiveFloor,
			);
			const hasToolTags = allTags.some((t) => t.type === "tool");
			const protectedSet = hasToolTags
				? windowResult.tagNumberSet.tagNumbers
				: typeof deps.protectedTags === "number" && deps.protectedTags > 0
					? new Set(
							activeTags
								.map((tag) => tag.tagNumber)
								.sort((left, right) => right - left)
								.slice(0, deps.protectedTags),
						)
					: new Set<number>();

			const tagStatusMap = new Map(
				allTags.map((tag) => [tag.tagNumber, tag.status]),
			);
			const inertWhitespaceTagNumbers = new Set(
				getInertWhitespaceAssistantTags(deps.db, sessionId).map(
					(tag) => tag.tagNumber,
				),
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

			const alreadyDropped = [
				...new Set(dropIds.filter((id) => tagStatusMap.get(id) === "dropped")),
			];
			const alreadyQueued = [
				...new Set(
					dropIds.filter(
						(id) =>
							tagStatusMap.get(id) !== "dropped" &&
							pendingMap.get(id) === "drop",
					),
				),
			];
			const skippedNote = [
				alreadyDropped.length
					? `Already dropped: ${formatIds(alreadyDropped)}.`
					: "",
				alreadyQueued.length
					? `Already queued: ${formatIds(alreadyQueued)}.`
					: "",
			]
				.filter(Boolean)
				.join(" ");
			dropIds = dropIds.filter(
				(id) =>
					!inertWhitespaceTagNumbers.has(id) &&
					tagStatusMap.get(id) !== "dropped" &&
					pendingMap.get(id) !== "drop",
			);

			if (dropIds.length === 0) {
				return ok(
					[inertNote, skippedNote, "No new action is needed."]
						.filter(Boolean)
						.join(" "),
				);
			}

			try {
				deps.db.transaction(() => {
					const now = Date.now();
					for (const id of dropIds) {
						queuePendingOp(deps.db, sessionId, id, "drop", now);
					}
				})();
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

			const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
			const deferredDropIds = [
				...new Set(dropIds.filter((id) => protectedSet.has(id))),
			];

			const parts: string[] = [];
			if (immediateDropIds.length > 0)
				parts.push(`drop ${formatIds(immediateDropIds)}`);
			if (deferredDropIds.length > 0)
				parts.push(`deferred drop ${formatIds(deferredDropIds)}`);
			return ok(
				`Queued: ${parts.join(", ")}.${skippedNote ? ` ${skippedNote}` : ""}${inertNote ? ` ${inertNote}` : ""}`,
			);
		},
	};
}
