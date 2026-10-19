/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import * as decisions from "../../features/magic-context/merged-reasoning-decisions";
import { MERGED_REASONING_PARTS_PREFIX } from "../../features/magic-context/merged-reasoning-decisions";
import { isRecord } from "../../shared/record-type-guard";
import { hasAnthropicReasoning, isInActiveAnthropicTurn } from "./active-anthropic-turn";
import { estimateTokens } from "./read-session-formatting";
import {
    opencodeReasoningBudgetCutoff,
    reasoningBudgetCutoff,
    reasoningStepCost,
    reasoningTextAndOpaque,
} from "./reasoning-budget";
import { neutralizedReasoningSource } from "./sentinel";
import {
    findLatestAssistantReasoningMutationExemptMessage,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import type { MessageLike } from "./tag-messages";

type CutoffArgs = Parameters<typeof opencodeReasoningBudgetCutoff>[0];

/**
 * opencodeReasoningBudgetCutoff as it was before this change. Each assistant's
 * cost callback called stripReasoningFromMergedAssistants, which decoded every
 * frozen merged-reasoning decision (the persisted record of which reasoning
 * parts to replace with sentinels) again. Copied here so a change to the
 * implementation cannot move both sides of the comparison.
 */
function frozenCutoff(args: CutoffArgs): number {
    const assistants = args.messages.filter((message) => message.info.role === "assistant");
    const newest = assistants.at(-1);
    const exempt = findLatestAssistantReasoningMutationExemptMessage(args.messages);
    return reasoningBudgetCutoff(
        assistants.map((message) => ({
            tag: args.messageTagNumbers.get(message) ?? 0,
            exempt:
                message === newest ||
                message === exempt ||
                isInActiveAnthropicTurn(
                    args.messages,
                    args.messages.indexOf(message),
                    args.anthropic ?? hasAnthropicReasoning(args.messages),
                ),
            cost: () => {
                const costMessage = { ...message, parts: [...message.parts] };
                if (args.frozenMergedIds)
                    stripReasoningFromMergedAssistants([costMessage], "anthropic", {
                        frozenMessageIds: args.frozenMergedIds,
                    });
                const visible = reasoningTextAndOpaque(
                    args.countNeutralized
                        ? costMessage.parts.map(neutralizedReasoningSource)
                        : costMessage.parts,
                );
                if (!visible.hasReasoning && !visible.inlineText) return 0;
                const info = message.info as unknown as Record<string, unknown>;
                const tokens = isRecord(info.tokens) ? info.tokens.reasoning : undefined;
                const typedGone =
                    typeof message.info.id === "string" &&
                    (args.alreadyRemoved?.has(message.info.id) === true ||
                        args.alsoGone?.has(message.info.id) === true);
                return (
                    (visible.hasReasoning && !typedGone
                        ? reasoningStepCost(
                              typeof tokens === "number" ? tokens : undefined,
                              estimateTokens(visible.text) * (args.proseRatio ?? 1),
                              visible.opaque,
                          )
                        : 0) +
                    Math.ceil(estimateTokens(visible.inlineText) * (args.proseRatio ?? 1))
                );
            },
        })),
        args.budget,
    );
}

function user(index: number): MessageLike {
    return {
        info: { id: `u-${index}`, role: "user" },
        parts: [{ type: "text", text: `question ${index}` }],
    } as unknown as MessageLike;
}

/**
 * An assistant with two reasoning parts around a tool call, so stripping has to
 * choose which part to replace.
 */
function assistant(index: number): MessageLike {
    return {
        info: { id: `a-${index}`, role: "assistant", tokens: { reasoning: index % 3 ? 0 : 40 } },
        parts: [
            {
                id: `p-${index}-0`,
                type: "reasoning",
                text: "first thought ".repeat(5 + (index % 7)),
                metadata: { anthropic: { signature: `sig-${index}-0` } },
            },
            {
                type: "tool",
                tool: "read",
                callID: `call-${index}`,
                state: { status: "completed", input: {}, output: "ok" },
            },
            {
                id: `p-${index}-1`,
                type: "reasoning",
                text: "second thought ".repeat(3 + (index % 5)),
                metadata: { anthropic: { signature: `sig-${index}-1` } },
            },
        ],
    } as unknown as MessageLike;
}

/**
 * Assistant runs separated by users. Some assistants have a decision naming the
 * exact reasoning parts to strip, some an older decision holding only the
 * message id, and the rest none.
 */
function fixture(assistantCount: number): CutoffArgs {
    const messages: MessageLike[] = [];
    const messageTagNumbers = new Map<MessageLike, number>();
    const frozenMergedIds = new Set<string>();
    let tag = 0;
    for (let index = 0; index < assistantCount; index += 1) {
        if (index % 4 === 0) messages.push(user(index));
        const message = assistant(index);
        messages.push(message);
        messageTagNumbers.set(message, ++tag);
        if (index % 5 === 1) {
            // A decision naming the parts to strip, by host part id or by index.
            frozenMergedIds.add(
                MERGED_REASONING_PARTS_PREFIX +
                    JSON.stringify([`a-${index}`, index % 2 ? [`p-${index}-1`] : [0]]),
            );
            frozenMergedIds.add(`a-${index}`);
        } else if (index % 5 === 3) {
            // An older decision holding only the message id: the parts to strip
            // are chosen from the message's layout, not named individually.
            frozenMergedIds.add(`a-${index}`);
        }
    }
    return { messages, messageTagNumbers, budget: 0, frozenMergedIds, anthropic: true };
}

describe("reasoning budget cutoff with frozen merged-reasoning decisions", () => {
    it("gives the same cutoff as decoding the decisions inside every cost", () => {
        const args = fixture(60);
        for (const countNeutralized of [false, true]) {
            for (let budget = 0; budget <= 4_000; budget += 37) {
                const input = { ...args, budget, countNeutralized };
                expect({ budget, cutoff: opencodeReasoningBudgetCutoff(input) }).toEqual({
                    budget,
                    cutoff: frozenCutoff(input),
                });
            }
        }
    });

    it("decodes the frozen decisions once per cutoff, however many assistants it costs", () => {
        const decodes = (assistantCount: number): number => {
            const spy = spyOn(decisions, "readFrozenMergedReasoningParts");
            try {
                opencodeReasoningBudgetCutoff({ ...fixture(assistantCount), budget: 1e9 });
                return spy.mock.calls.length;
            } finally {
                spy.mockRestore();
            }
        };
        expect(decodes(40)).toBe(1);
        expect(decodes(400)).toBe(1);
    });
});
