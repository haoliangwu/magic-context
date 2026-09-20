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
	readSessionChunk,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	CTX_EXPAND_DESCRIPTION,
	CTX_EXPAND_TOKEN_BUDGET,
} from "@magic-context/core/tools/ctx-expand/constants";
import { resolveCtxExpandMode } from "@magic-context/core/tools/ctx-expand/mode";
import {
	renderMessageByOrdinal,
	renderVerboseRange,
} from "@magic-context/core/tools/ctx-expand/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";
import { readPiSessionMessages } from "../read-session-pi";

const ParamsSchema = Type.Object(
	{
		start: Type.Optional(
			Type.Number({
				description:
					'First message ordinal to expand — a compartment\'s start="N" attribute, or an ordinal from a ctx_search message hit',
			}),
		),
		end: Type.Optional(
			Type.Number({
				description:
					'Last message ordinal to expand (inclusive) — a compartment\'s end="M" attribute',
			}),
		),
		verbose: Type.Optional(
			Type.Boolean({
				description:
					"With start/end: list each message separately with its ordinal [N] and per-part preview, so you can recover one in full by ordinal.",
			}),
		),
		message: Type.Optional(
			Type.Number({
				description:
					"Full untruncated recovery of ONE message by its ordinal (every text part + every tool call's complete input/output). Use an ordinal from a compartment, ctx_search hit, or verbose range. Recovers a tool output you dropped with ctx_reduce.",
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
			params = unwrapImitatedReducedArgs(params, ["message", "start"], {
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
			// register Pi's source for the duration of this single call.
			// setRawMessageProvider returns an unregister fn so we don't leak the
			// binding into concurrent transform passes.
			const unregister = setRawMessageProvider(sessionId, {
				readMessages: () => readPiSessionMessages(ctx),
			});

			try {
				const mode = resolveCtxExpandMode(params, "positive");
				if (mode.kind === "error") {
					return err(mode.message);
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
