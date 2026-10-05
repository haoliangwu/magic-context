/**
 * Pi-side wrapper for the `ctx_expand` tool.
 *
 * Mirrors OpenCode's `packages/plugin/src/tools/ctx-expand/tools.ts`:
 * given the N-M range from a rendered `## N-M · date · title` heading, return
 * the original compacted U:/A: transcript so the agent can see the raw
 * discussion behind a summarized region.
 *
 * Implementation: shared `readSessionChunk` reads via the per-session
 * `RawMessageProvider` registry. We register Pi's `readPiSessionMessages`
 * for the duration of this single tool call (and unregister in `finally`)
 * so we never accidentally leak the provider into other transform passes
 * which might race against this call.
 *
 * Token budget mirrors OpenCode's `CTX_EXPAND_TOKEN_BUDGET = 15_000` —
 * shared constant imported from the OpenCode tool's constants module so
 * both harnesses produce equivalent slices for the same range.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	hasRawMessageProvider,
	readSessionChunk,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	CTX_EXPAND_DESCRIPTION,
	CTX_EXPAND_TOKEN_BUDGET,
} from "@magic-context/core/tools/ctx-expand/constants";
import { resolveCtxExpandMode } from "@magic-context/core/tools/ctx-expand/mode";
import {
	renderItemByTag,
	renderMessageByOrdinal,
	renderVerboseRange,
} from "@magic-context/core/tools/ctx-expand/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";
import { readPiSessionMessages } from "../read-session-pi";

const ParamsSchema = Type.Object(
	{
		tag: Type.Optional(
			Type.Union([Type.Number(), Type.String()], {
				description:
					"Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
			}),
		),
		start: Type.Optional(
			Type.Number({
				description:
					"First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number.",
			}),
		),
		end: Type.Optional(
			Type.Number({
				description:
					"Last message ordinal of the range, inclusive, not a tag number.",
			}),
		),
		verbose: Type.Optional(
			Type.Boolean({
				description:
					"With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
			}),
		),
		message: Type.Optional(
			Type.Number({
				description:
					"Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.",
			}),
		),
	},
	{ additionalProperties: true },
);

type CtxExpandParams = Static<typeof ParamsSchema>;

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

export interface CtxExpandToolDeps {
	db: ContextDatabase;
	expandTools?: Record<string, string | false>;
}

export function createCtxExpandTool(
	deps: CtxExpandToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_expand",
		label: "Magic Context: Expand",
		description: CTX_EXPAND_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxExpandParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["tag", "message", "start"], {
				start: "number",
				end: "number",
				verbose: "boolean",
				message: "number",
			});
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) {
				return err("Error: no active Pi session.");
			}

			// All raw reads go through the shared provider-aware helpers, so
			// they need a Pi source for this session. One is usually registered
			// already: each transform pass registers its branch snapshot, and a
			// background historian or recomp holds one for its whole run. Use it
			// rather than replacing it: a session has one provider slot, and
			// releasing a replacement empties the slot, which would leave that
			// background run reading the wrong store. Only when nothing is
			// registered does this call install a live source of its own.
			const unregister = hasRawMessageProvider(sessionId)
				? () => {}
				: setRawMessageProvider(sessionId, {
						readMessages: () => readPiSessionMessages(ctx),
					});

			try {
				const mode = resolveCtxExpandMode(params, "positive");
				if (mode.kind === "error") {
					return err(mode.message);
				}
				if (mode.kind === "tag") {
					return ok(renderItemByTag(deps.db, sessionId, mode.tag, "text"));
				}
				if (mode.kind === "message") {
					return ok(renderMessageByOrdinal(sessionId, mode.message));
				}
				const { start, end, verbose } = mode;

				// Clamp to the last compartment boundary (parity with OpenCode +
				// ctx_search): messages after it are the live tail already visible
				// to the agent, so re-expanding them wastes output tokens. -1 = no
				// compartments yet → nothing compacted, so don't clamp.
				const lastCompartmentEnd = getLastCompartmentEndMessage(
					deps.db,
					sessionId,
				);
				if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
					return ok(
						`Range ${start}-${end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`,
					);
				}
				const effectiveEnd =
					lastCompartmentEnd >= 0 ? Math.min(end, lastCompartmentEnd) : end;

				// Verbose mode: each message separate, with ids + per-part previews.
				if (verbose) {
					const v = renderVerboseRange(
						sessionId,
						start,
						effectiveEnd,
						CTX_EXPAND_TOKEN_BUDGET,
						deps.expandTools,
					);
					if (!v.text) {
						return ok(
							`No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`,
						);
					}
					const out = [
						`Messages ${start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
						"",
						v.text,
					];
					if (v.truncated) {
						out.push(
							"",
							`Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
						);
					}
					return ok(out.join("\n"));
				}

				const chunk = readSessionChunk(
					sessionId,
					CTX_EXPAND_TOKEN_BUDGET,
					start,
					effectiveEnd + 1, // readSessionChunk uses exclusive end
					{ expand: false },
				);

				if (!chunk.text || chunk.messageCount === 0) {
					return ok(
						`No messages found in range ${start}-${end}. The range may be outside this session's history.`,
					);
				}

				const lines: string[] = [];
				lines.push(
					`Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
				);
				lines.push("");
				lines.push(chunk.text);

				if (chunk.endIndex < effectiveEnd) {
					lines.push("");
					lines.push(
						`Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
					);
				}

				return ok(lines.join("\n"));
			} finally {
				unregister();
			}
		},
	};
}
