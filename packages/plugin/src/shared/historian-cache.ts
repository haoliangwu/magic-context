import { type Node, parseTree } from "jsonc-parser/lib/esm/main.js";

export type HistorianCacheTail = "write" | "skip";

/**
 * Remove only message-block cache markers from a recognized Anthropic Messages
 * body. Splicing property spans preserves every other wire byte, including
 * number spelling, escaping and whitespace. Unknown envelopes stay untouched.
 */
export function withoutHistorianTailCache(body: string): string {
    const value = JSON.parse(body);
    if (
        !value ||
        typeof value.model !== "string" ||
        typeof value.max_tokens !== "number" ||
        !Array.isArray(value.system) ||
        value.system.length === 0 ||
        !value.system.every(
            (part: { type?: unknown; text?: unknown }) =>
                part?.type === "text" && typeof part.text === "string",
        ) ||
        !value.system.some((part: { cache_control?: unknown }) => part.cache_control) ||
        !Array.isArray(value.messages) ||
        value.cache_control !== undefined
    )
        return body;

    const root = parseTree(body);
    const property = (node: Node | undefined, key: string): Node | undefined =>
        node?.children?.find((child) => child.children?.[0]?.value === key)?.children?.[1];
    const removals: Array<[number, number]> = [];
    for (const message of property(root, "messages")?.children ?? []) {
        for (const block of property(message, "content")?.children ?? []) {
            if (block.type !== "object") continue;
            const fields = block.children ?? [];
            fields.forEach((field, index) => {
                if (field.children?.[0]?.value !== "cache_control") return;
                const next = fields[index + 1];
                const previous = fields[index - 1];
                removals.push(
                    next
                        ? [field.offset, next.offset]
                        : [
                              previous ? previous.offset + previous.length : field.offset,
                              field.offset + field.length,
                          ],
                );
            });
        }
    }
    for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) {
        body = body.slice(0, start) + body.slice(end);
    }
    return body;
}
