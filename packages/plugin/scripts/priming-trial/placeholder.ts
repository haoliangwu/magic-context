// Trial-only placeholder rewriting and output classification for the priming trial.
//
// Magic Context renders a dropped item as `[dropped §N§]` (and a fully emptied
// message as `[dropped]` on non-Anthropic providers). The neutral arm of the trial
// rewrites those renders on the provider wire, after Magic Context has built the
// request, so every other byte of the request is produced by unchanged plugin code.
// The rewrite is a pure function of the tag number, so a request prefix stays
// byte-identical across passes and the provider's prompt cache is unaffected.

export type PlaceholderArm = "bracket" | "neutral";

/** The neutral wording for a dropped item. It names the tag so `ctx_expand(tag=N)` still works. */
export const neutralPlaceholder = (tag: number | string): string => `(removed: tag ${tag})`;
/** The neutral wording for a message Magic Context emptied entirely; unmodified Magic Context renders such a message as `[dropped]`. */
export const NEUTRAL_WHOLE_MESSAGE = "(removed)";

const BRACKET_TAGGED = /\[dropped §(\d+|N)§\]/g;
const BRACKET_TAGGED_ONE = /^\[dropped §(\d+)§\]$/;
const TAG_TOKEN = /§\d+§/g;

/**
 * True when a string carries nothing but Magic Context markers: tag prefixes,
 * `[dropped §N§]` placeholders and the bare `[dropped]` sentinel. Only such strings are
 * rewritten in message bodies, so file contents that merely mention a placeholder
 * (for example source code read through a tool) reach the model unchanged.
 */
export function isMarkerOnly(text: string): boolean {
    if (!/\[dropped/.test(text)) return false;
    return (
        text
            .replace(BRACKET_TAGGED, "")
            .replace(/\[dropped\]/g, "")
            .replace(TAG_TOKEN, "")
            .trim() === ""
    );
}

function rewriteMarkerOnly(text: string): string {
    if (!isMarkerOnly(text)) return text;
    return text
        .replace(BRACKET_TAGGED, (_, tag) => neutralPlaceholder(tag))
        .replace(/\[dropped\]/g, NEUTRAL_WHOLE_MESSAGE);
}

/** Rewrites prose that documents the placeholder (system prompt, tool descriptions). */
function rewriteDocumentation(text: string): string {
    return text.replace(BRACKET_TAGGED, (_, tag) => neutralPlaceholder(tag));
}

function rewriteContent(content: unknown): unknown {
    if (typeof content === "string") return rewriteMarkerOnly(content);
    if (!Array.isArray(content)) return content;
    return content.map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? { ...part, text: rewriteMarkerOnly((part as { text: string }).text) }
            : part,
    );
}

/**
 * The dropped-input marker Magic Context puts in place of a dropped tool call's
 * arguments is `{"dropped":"[dropped §N§]"}`. The neutral arm renders it as
 * `{"removed":"(removed: tag N)"}` so neither the key nor the value carries the
 * bracket wording.
 */
function rewriteArguments(args: string): string {
    try {
        const parsed = JSON.parse(args) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const keys = Object.keys(parsed);
            const value = (parsed as Record<string, unknown>).dropped;
            if (keys.length === 1 && typeof value === "string") {
                const match = BRACKET_TAGGED_ONE.exec(value);
                if (match) return JSON.stringify({ removed: neutralPlaceholder(match[1]!) });
            }
        }
    } catch {
        // Arguments that are not JSON are left as they are.
    }
    return args;
}

type WireMessage = {
    role?: string;
    content?: unknown;
    tool_calls?: { function?: { arguments?: string } }[];
};

type WireBody = {
    messages?: WireMessage[];
    tools?: { function?: { description?: string; parameters?: unknown } }[];
};

/** Returns a copy of an OpenAI-compatible chat request with every placeholder render neutralized. */
export function neutralizeRequest<T extends WireBody>(body: T): T {
    const messages = body.messages?.map((message) => {
        const next: WireMessage = { ...message };
        next.content =
            message.role === "system"
                ? typeof message.content === "string"
                    ? rewriteDocumentation(message.content)
                    : Array.isArray(message.content)
                      ? message.content.map((part) =>
                            part && typeof part === "object" && typeof part.text === "string"
                                ? { ...part, text: rewriteDocumentation(part.text) }
                                : part,
                        )
                      : message.content
                : rewriteContent(message.content);
        if (message.tool_calls)
            next.tool_calls = message.tool_calls.map((call) =>
                typeof call.function?.arguments === "string"
                    ? { ...call, function: { ...call.function, arguments: rewriteArguments(call.function.arguments) } }
                    : call,
            );
        return next;
    });
    const tools = body.tools?.map((tool) =>
        tool.function
            ? {
                  ...tool,
                  function: {
                      ...tool.function,
                      ...(typeof tool.function.description === "string"
                          ? { description: rewriteDocumentation(tool.function.description) }
                          : {}),
                      ...(tool.function.parameters === undefined
                          ? {}
                          : { parameters: JSON.parse(rewriteDocumentation(JSON.stringify(tool.function.parameters))) }),
                  },
              }
            : tool,
    );
    return { ...body, ...(messages ? { messages } : {}), ...(tools ? { tools } : {}) };
}

function textOf(content: unknown): string[] {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
    );
}

export type Exposure = {
    /** Tool results whose whole content is a placeholder. */
    droppedToolResults: number;
    /** Tool calls whose arguments were replaced by the dropped-input marker. */
    droppedToolInputs: number;
    /** User or assistant text parts that are only placeholders or the whole-message sentinel. */
    droppedTextParts: number;
    /** Distinct tag numbers named by a placeholder anywhere in the messages. */
    droppedTags: number;
    /** Highest leading `§N§` tag in the messages, the base for the expected reply tag. */
    maxTag: number;
};

/** Counts Magic Context's own drop renders in a request, in either wording. */
export function measureExposure(body: WireBody): Exposure {
    const exposure: Exposure = { droppedToolResults: 0, droppedToolInputs: 0, droppedTextParts: 0, droppedTags: 0, maxTag: 0 };
    const tags = new Set<string>();
    const placeholderOnly = (text: string) => isMarkerOnly(text) || isNeutralOnly(text);
    for (const message of body.messages ?? []) {
        if (message.role === "system") continue;
        for (const text of textOf(message.content)) {
            // Magic Context puts each item's tag at the start of its text; a tag-shaped
            // string later in the text is content (or a placeholder for an older item).
            const prefix = /^§(\d+)§/.exec(text);
            if (prefix) exposure.maxTag = Math.max(exposure.maxTag, Number(prefix[1]));
            for (const match of text.matchAll(/(?:\[dropped §|\(removed: tag )(\d+)/g)) tags.add(match[1]!);
            if (!placeholderOnly(text)) continue;
            if (message.role === "tool") exposure.droppedToolResults++;
            else exposure.droppedTextParts++;
        }
        for (const call of message.tool_calls ?? []) {
            const args = call.function?.arguments ?? "";
            if (/^\{"(?:dropped|removed)":"(?:\[dropped §\d+§\]|\(removed: tag \d+\))"\}$/.test(args)) {
                exposure.droppedToolInputs++;
                for (const match of args.matchAll(/(\d+)/g)) tags.add(match[1]!);
            }
        }
    }
    exposure.droppedTags = tags.size;
    return exposure;
}

const NEUTRAL_TAGGED = /\(removed: tag \d+\)/g;

/** True when a string carries nothing but tag prefixes and neutral placeholders. */
export function isNeutralOnly(text: string): boolean {
    if (!/\(removed/.test(text)) return false;
    return text.replace(NEUTRAL_TAGGED, "").replace(/\(removed\)/g, "").replace(TAG_TOKEN, "").trim() === "";
}

/** Placeholder shapes counted in model output, in both wordings, including near variants. */
export const PLACEHOLDER_SHAPES: { name: string; pattern: RegExp }[] = [
    { name: "bracket-dropped", pattern: /\[\s*dropped\b[^\]\n]{0,24}\]?/gi },
    { name: "bracket-cleared", pattern: /\[\s*cleared\s*\]/gi },
    { name: "bracket-truncated", pattern: /\[\s*truncated\b[^\]\n]{0,24}\]?/gi },
    { name: "neutral-removed", pattern: /\(\s*removed\b[^)\n]{0,24}\)?/gi },
    { name: "removed-tag-prose", pattern: /\bremoved:\s*tag\s*\d+/gi },
];

export function placeholderHits(text: string): Record<string, number> {
    const hits: Record<string, number> = {};
    for (const { name, pattern } of PLACEHOLDER_SHAPES) {
        const count = [...text.matchAll(pattern)].length;
        if (count) hits[name] = count;
    }
    return hits;
}

/**
 * A text part that carries no content of its own: only tag tokens, placeholder
 * shapes in either wording, punctuation and whitespace. An empty text is not counted.
 */
export function isMarkerOnlyOutput(text: string): boolean {
    if (!text.trim()) return false;
    let rest = text.replace(/§\s*\d*\s*§/g, "");
    for (const { pattern } of PLACEHOLDER_SHAPES) rest = rest.replace(pattern, "");
    return rest.replace(/[\s.,:;`*_\-()[\]]/g, "") === "";
}

export type LeadingTag = { kind: "correct" | "wrong" | "missing"; tag: number | null; delta: number | null };

/**
 * Classifies a reply's leading `§N§` tag. Magic Context's prompt guidance tells the model
 * to open each reply with one more than the highest tag it can see: such a tag is
 * correct, any other number is wrong, and no leading tag is missing.
 */
export function classifyLeadingTag(text: string, maxVisibleTag: number): LeadingTag {
    const match = /^\s*§(\d+)§/.exec(text);
    if (!match) return { kind: "missing", tag: null, delta: null };
    const tag = Number(match[1]);
    const delta = tag - (maxVisibleTag + 1);
    return { kind: delta === 0 ? "correct" : "wrong", tag, delta };
}
