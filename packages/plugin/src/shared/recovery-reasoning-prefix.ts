/**
 * Serialize each request prefix ending at a thinking/reasoning part, including
 * earlier messages and earlier parts of that message. Comparing these snapshots
 * detects edits to bytes authenticated by a kept signature, or missing blocks.
 * Include reasoning without a visible signature too: a host may carry its
 * provider signature in fields this helper does not interpret.
 */
export function recoveryReasoningPrefixes(
    messages: readonly unknown[],
    partsKey: "parts" | "content",
): string[] {
    const prefixes: string[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index] as Record<string, unknown> | null;
        const parts = message?.[partsKey];
        if (!Array.isArray(parts)) continue;
        for (let p = 0; p < parts.length; p++) {
            const type = (parts[p] as { type?: string } | null)?.type;
            if (
                type !== "thinking" &&
                type !== "reasoning" &&
                type !== "redactedThinking" &&
                type !== "redacted_thinking"
            )
                continue;
            prefixes.push(
                JSON.stringify([
                    ...messages.slice(0, index),
                    { ...message, [partsKey]: parts.slice(0, p + 1) },
                ]),
            );
        }
    }
    return prefixes;
}
