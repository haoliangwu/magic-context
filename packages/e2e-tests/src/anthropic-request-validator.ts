/**
 * Anthropic-style request checks for mock-provider drives: tool_use/tool_result
 * pairing and the no-prefill rule (a request may not end on an assistant turn).
 * A drive installs `anthropicViolation` as its first mock matcher and answers a
 * violating request with a 400, the way the real API does.
 */
export type Block = {
    type?: string;
    id?: string;
    tool_use_id?: string;
    input?: unknown;
    content?: unknown;
    text?: string;
};
export type WireMessage = { role: string; content: unknown };

export function blocks(message: WireMessage | undefined): Block[] {
    if (!message) return [];
    return Array.isArray(message.content)
        ? (message.content as Block[])
        : [{ type: "text", text: String(message.content) }];
}

/** Anthropic-style request validation: returns the first violation, if any. */
export function anthropicViolation(body: Record<string, unknown>): string | null {
    const messages = body.messages as WireMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    if (messages.at(-1)?.role === "assistant") {
        return "This model does not support assistant message prefill";
    }
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (message.role === "assistant") {
            const next = messages[index + 1];
            const answered = new Set(
                next?.role === "user"
                    ? blocks(next)
                            .filter((block) => block.type === "tool_result")
                            .map((block) => block.tool_use_id)
                    : [],
            );
            for (const use of blocks(message).filter(
                (block) => block.type === "tool_use",
            )) {
                if (!answered.has(use.id)) {
                    return `tool_use ids were found without tool_result blocks immediately after: ${use.id}`;
                }
            }
        } else if (message.role === "user") {
            const previous = messages[index - 1];
            const asked = new Set(
                previous?.role === "assistant"
                    ? blocks(previous)
                            .filter((block) => block.type === "tool_use")
                            .map((block) => block.id)
                    : [],
            );
            for (const result of blocks(message).filter(
                (block) => block.type === "tool_result",
            )) {
                if (!asked.has(result.tool_use_id)) {
                    return `unexpected tool_use_id found in tool_result blocks: ${result.tool_use_id}`;
                }
            }
        }
    }
    return null;
}

export function resultText(block: Block | undefined): string {
    if (!block) return "";
    if (typeof block.content === "string") return block.content;
    if (Array.isArray(block.content)) {
        return (block.content as Block[]).map((part) => part.text ?? "").join("");
    }
    return "";
}

export function findToolUse(messages: WireMessage[], id: string): Block | undefined {
    return messages
        .flatMap((message) => blocks(message))
        .find((block) => block.type === "tool_use" && block.id === id);
}

export function findToolResult(
    messages: WireMessage[],
    id: string,
): Block | undefined {
    return messages
        .flatMap((message) => blocks(message))
        .find((block) => block.type === "tool_result" && block.tool_use_id === id);
}
