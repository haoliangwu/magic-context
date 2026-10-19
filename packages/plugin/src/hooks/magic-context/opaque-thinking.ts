import { UNKNOWN_REASONING_STEP_TOKENS } from "./reasoning-budget";

/** Estimate encrypted thinking from the assistant's provider-reported reasoning
 * tokens, or its total output tokens when no separate reasoning count exists.
 * Without either count, use the shared 1,000-token unknown-step heuristic; it
 * is not a mathematical upper bound. When a previous request prefix matches
 * exactly, its provider-measured input plus the appended suffix replaces the
 * local estimate for checking whether the request fits the model window.
 */
export function opaqueThinkingCost(
    reasoning: unknown,
    output: unknown,
): {
    tokens: number;
    fallback: boolean;
} {
    for (const count of [reasoning, output]) {
        if (typeof count === "number" && Number.isFinite(count) && count > 0)
            return { tokens: count, fallback: false };
    }
    return { tokens: UNKNOWN_REASONING_STEP_TOKENS, fallback: true };
}
