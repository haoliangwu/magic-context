/**
 * Anthropic-style request checks for mock-provider drives: tool_use/tool_result
 * pairing, the no-prefill rule (a request may not end on an assistant turn),
 * non-empty text blocks, and the placement of in-conversation system messages.
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

/**
 * Where a text block with empty text sits in the request, or null. The real
 * API answers any such block, in the top-level system array, in any message
 * (including an in-conversation `system` message) or inside a tool_result,
 * with HTTP 400 `messages: text content blocks must be non-empty`.
 */
export function emptyTextBlock(body: Record<string, unknown>): string | null {
    const isEmptyText = (block: unknown) =>
        !!block &&
        typeof block === "object" &&
        (block as Block).type === "text" &&
        (block as Block).text === "";
    if (Array.isArray(body.system)) {
        const index = body.system.findIndex(isEmptyText);
        if (index >= 0) return `system.${index}`;
    }
    const messages = Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
    for (let index = 0; index < messages.length; index += 1) {
        const content = messages[index]!.content;
        if (content === "") return `messages.${index}.content`;
        if (!Array.isArray(content)) continue;
        for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
            const block = content[blockIndex] as Block;
            if (isEmptyText(block)) return `messages.${index}.content.${blockIndex}`;
            if (block?.type === "tool_result" && Array.isArray(block.content)) {
                const inner = (block.content as unknown[]).findIndex(isEmptyText);
                if (inner >= 0)
                    return `messages.${index}.content.${blockIndex}.content.${inner}`;
            }
        }
    }
    return null;
}

/** Anthropic-style request validation: returns the first violation, if any. */
export function anthropicViolation(body: Record<string, unknown>): string | null {
    const messages = body.messages as WireMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const empty = emptyTextBlock(body);
    if (empty) return `${empty}: text content blocks must be non-empty`;
    if (messages.at(-1)?.role === "assistant") {
        return "This model does not support assistant message prefill";
    }
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (message.role === "system") {
            // OpenCode 2 sends an in-conversation system update this way for Claude
            // models that accept one; the API takes it only after a user turn
            // (tool results count), never first or after an assistant turn. The
            // host may send several updates in a row after that user turn.
            const before = messages.slice(0, index).findLast((m) => m.role !== "system");
            if (before?.role !== "user") {
                return `messages.${index}: a system message must follow a user turn`;
            }
            continue;
        }
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
