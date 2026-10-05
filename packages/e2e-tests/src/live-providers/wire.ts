/**
 * Reads provider request bodies and responses for the live-provider recorder.
 *
 * Request side: which assistant steps still carry reasoning, how many tool calls and results
 * are on the wire. Response side: status, provider error text, and the usage numbers the
 * provider billed, for each of the three encodings the harness drives.
 */
import type { RequestShape, UsageRecord, WireProtocol } from "./types";
import { createHash } from "node:crypto";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Requests that carry the `bash` tool are the tool loop; titles and summaries are auxiliary. */
function hasBashTool(body: Json): boolean {
    const tools = Array.isArray(body.tools)
        ? body.tools
        : isRecord(body.toolConfig) && Array.isArray(body.toolConfig.tools)
          ? body.toolConfig.tools
          : [];
    return /"(?:mcp_)?bash"/i.test(JSON.stringify(tools));
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Anthropic signed blocks are counted atomically; only hashes, never their text, are recorded. */
function anthropicShape(body: Json): Omit<RequestShape, "kind" | "bytes"> {
    const messages = Array.isArray(body.messages) ? body.messages as Json[] : [];
    let map = "";
    let reasoningItems = 0;
    let toolCalls = 0;
    let toolResults = 0;
    const history = messages.map((message) => {
        const content = Array.isArray(message.content) ? message.content as Json[] : [{ type: "text", text: message.content }];
        const thinking = content.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
        const signed = thinking.filter((b) => typeof b.signature === "string" || typeof b.data === "string");
        if (message.role === "assistant") {
            reasoningItems += thinking.length;
            map += thinking.length ? "R" : "-";
        }
        toolCalls += content.filter((b) => b.type === "tool_use").length;
        toolResults += content.filter((b) => b.type === "tool_result").length;
        // Cache markers may move when a new turn is appended. They do not alter signed content.
        const withoutCache = (block: Json) => { const { cache_control, ...rest } = block; return rest; };
        return {
            role: message.role,
            signed: signed.map((b) => hash(withoutCache(b))),
            nonThinking: content.filter((b) => !thinking.includes(b)).map((b) => ({ type: b.type, hash: hash(withoutCache(b)) })),
        };
    });
    return { reasoningMap: map, reasoningItems, emptyReasoning: 0, toolCalls, toolResults,
        flags: { thinking: body.thinking ?? null, maxTokens: body.max_tokens, outputConfig: body.output_config ?? null,
            systemHash: hash(body.system ?? null), toolsHash: hash(body.tools ?? null), history } };
}

function nonEmptyText(value: unknown): boolean {
    return typeof value === "string" && value.length > 0;
}

/**
 * OpenAI Responses `input`. A step is the run of items the model produced between two tool
 * results; it carries reasoning when a `reasoning` item appears in that run.
 */
function responsesShape(body: Json): Omit<RequestShape, "kind" | "bytes"> {
    const input = Array.isArray(body.input) ? (body.input as Json[]) : [];
    let map = "";
    let pending = false;
    let open = false;
    let reasoningItems = 0;
    let toolCalls = 0;
    let toolResults = 0;
    const close = () => {
        if (open) map += pending ? "R" : "-";
        open = false;
        pending = false;
    };
    for (const item of input) {
        const type = item.type ?? (item.role ? "message" : undefined);
        if (type === "reasoning") {
            reasoningItems++;
            pending = true;
            open = true;
        } else if (type === "function_call") {
            toolCalls++;
            open = true;
        } else if (type === "function_call_output") {
            toolResults++;
            close();
        } else if (type === "message" && item.role === "assistant") {
            open = true;
        } else if (type === "message" || type === "item_reference") {
            close();
        }
    }
    close();
    return {
        reasoningMap: map,
        reasoningItems,
        emptyReasoning: 0,
        toolCalls,
        toolResults,
        flags: {
            store: body.store,
            include: body.include,
            reasoning: body.reasoning,
            previousResponseId: body.previous_response_id ?? null,
            itemReferences: input.filter((item) => item.type === "item_reference").length,
            encryptedReasoning: input.filter(
                (item) => item.type === "reasoning" && typeof item.encrypted_content === "string",
            ).length,
        },
    };
}

/** Bedrock Converse `messages[].content[]` blocks. */
function bedrockShape(body: Json): Omit<RequestShape, "kind" | "bytes"> {
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    let map = "";
    let reasoningItems = 0;
    let toolCalls = 0;
    let toolResults = 0;
    for (const message of messages) {
        const content = Array.isArray(message.content) ? (message.content as Json[]) : [];
        if (message.role === "assistant") {
            const reasoning = content.filter((block) => "reasoningContent" in block).length;
            reasoningItems += reasoning;
            toolCalls += content.filter((block) => "toolUse" in block).length;
            map += reasoning > 0 ? "R" : "-";
        } else {
            toolResults += content.filter((block) => "toolResult" in block).length;
        }
    }
    return {
        reasoningMap: map,
        reasoningItems,
        emptyReasoning: 0,
        toolCalls,
        toolResults,
        flags: { additionalModelRequestFields: body.additionalModelRequestFields ?? null },
    };
}

/** Chat Completions (OpenRouter, DeepSeek, Kimi): reasoning rides on assistant messages. */
function chatShape(body: Json): Omit<RequestShape, "kind" | "bytes"> {
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    let map = "";
    let reasoningItems = 0;
    let emptyReasoning = 0;
    let toolCalls = 0;
    let toolResults = 0;
    for (const message of messages) {
        if (message.role === "assistant") {
            const details = Array.isArray(message.reasoning_details) ? message.reasoning_details.length : 0;
            const carries =
                details > 0 || nonEmptyText(message.reasoning_content) || nonEmptyText(message.reasoning);
            if (message.reasoning_content === "" || message.reasoning === "") emptyReasoning++;
            if (carries) reasoningItems++;
            map += carries ? "R" : "-";
            toolCalls += Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
        } else if (message.role === "tool") {
            toolResults++;
        }
    }
    return {
        reasoningMap: map,
        reasoningItems,
        emptyReasoning,
        toolCalls,
        toolResults,
        flags: {
            reasoning: body.reasoning ?? null,
            thinking: body.thinking ?? null,
            reasoningEffort: body.reasoning_effort ?? null,
            streamOptions: body.stream_options ?? null,
            usage: body.usage ?? null,
        },
    };
}

export function requestShape(protocol: WireProtocol, text: string): RequestShape {
    let body: Json = {};
    try {
        const parsed = JSON.parse(text) as unknown;
        if (isRecord(parsed)) body = parsed;
    } catch {}
    const shape =
        protocol === "openai-responses"
            ? responsesShape(body)
            : protocol === "anthropic-messages"
              ? anthropicShape(body)
            : protocol === "bedrock-converse"
              ? bedrockShape(body)
              : chatShape(body);
    return { kind: hasBashTool(body) ? "loop" : "aux", bytes: text.length, ...shape };
}

/** Model id from the request body, or from a Bedrock `/model/<id>/converse-stream` path. */
export function requestModel(protocol: WireProtocol, path: string, text: string): string | null {
    if (protocol === "bedrock-converse") {
        const match = path.match(/\/model\/([^/]+)\//);
        return match ? decodeURIComponent(match[1] as string) : null;
    }
    try {
        const body = JSON.parse(text) as Json;
        return typeof body.model === "string" ? body.model : null;
    } catch {
        return null;
    }
}

function sseEvents(text: string): Json[] {
    const events: Json[] = [];
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
            const parsed = JSON.parse(data) as unknown;
            if (isRecord(parsed)) events.push(parsed);
        } catch {}
    }
    return events;
}

/** The last JSON object in the text, for non-streamed replies. */
function plainJson(text: string): Json | null {
    try {
        const parsed = JSON.parse(text) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function responsesUsage(usage: Json): UsageRecord {
    const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
    return {
        input: num(usage.input_tokens),
        inputField: "input_tokens (includes cached)",
        cachedRead: num(inputDetails.cached_tokens),
        cacheWrite: null,
        output: num(usage.output_tokens),
        reasoning: num(outputDetails.reasoning_tokens),
        cost: null,
        raw: usage,
    };
}

function chatUsage(usage: Json): UsageRecord {
    const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    return {
        input: num(usage.prompt_tokens),
        inputField: "prompt_tokens (includes cached)",
        // DeepSeek reports `prompt_cache_hit_tokens`, Kimi a top-level `cached_tokens`,
        // OpenRouter the OpenAI-style `prompt_tokens_details.cached_tokens`.
        cachedRead:
            num(promptDetails.cached_tokens) ?? num(usage.prompt_cache_hit_tokens) ?? num(usage.cached_tokens),
        cacheWrite: num(promptDetails.cache_write_tokens),
        output: num(usage.completion_tokens),
        reasoning: num(completionDetails.reasoning_tokens),
        cost: num(usage.cost),
        raw: usage,
    };
}

/**
 * Bedrock streams AWS event-stream frames: binary headers around JSON payloads. The
 * `metadata` frame's payload holds `usage`; exception frames hold a `message`.
 */
function bedrockUsage(text: string): UsageRecord | null {
    const match = text.match(/"usage":(\{[^{}]*\})/g);
    if (!match) return null;
    const usage = JSON.parse((match.at(-1) as string).slice(8)) as Json;
    return {
        input: num(usage.inputTokens),
        inputField: "inputTokens (excludes cache reads and writes)",
        cachedRead: num(usage.cacheReadInputTokens),
        cacheWrite: num(usage.cacheWriteInputTokens),
        output: num(usage.outputTokens),
        reasoning: null,
        cost: null,
        raw: usage,
    };
}

export interface ResponseReading {
    usage: UsageRecord | null;
    /** Error text carried inside a 200 stream (provider rejected mid-stream). */
    streamError: string | null;
    diagnostics: Record<string, unknown>;
}

function anthropicUsage(usage: Json): UsageRecord {
    return { input: num(usage.input_tokens), inputField: "input_tokens (excludes cache reads and writes)",
        cachedRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
        output: num(usage.output_tokens), reasoning: null, cost: null, raw: usage };
}

/** Find diagnostics wherever the API places them, including message_start and message_delta. */
function collectDiagnostics(value: unknown, out: Record<string, unknown>, path = ""): void {
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key;
        if (/transformation|applied_edits|thinking_dropped/.test(key)) out[next] = item;
        else if (key === "type" && typeof item === "string" && /transformation|thinking_dropped/.test(item)) out[next] = item;
        else if (isRecord(item)) collectDiagnostics(item, out, next);
    }
}

export function readResponse(protocol: WireProtocol, text: string): ResponseReading {
    if (protocol === "bedrock-converse") {
        const exception = text.match(/:exception-type\x07\x00[\s\S]([A-Za-z]+)/);
        const message = text.match(/\{"message":"((?:[^"\\]|\\.)*)"\}/);
        return {
            usage: bedrockUsage(text),
            streamError: exception ? `${exception[1]}: ${message?.[1] ?? ""}` : null,
            diagnostics: {},
        };
    }
    const events = sseEvents(text);
    const single = events.length === 0 ? plainJson(text) : null;
    const all = single ? [single] : events;
    let usage: UsageRecord | null = null;
    let streamError: string | null = null;
    const diagnostics: Record<string, unknown> = {};
    let anthropicRaw: Json = {};
    for (const event of all) {
        collectDiagnostics(event, diagnostics);
        if (protocol === "openai-responses") {
            const response = isRecord(event.response) ? event.response : event;
            if (isRecord(response.usage)) usage = responsesUsage(response.usage);
            if (event.type === "error" || event.type === "response.failed") {
                const error = isRecord(response.error) ? response.error : event;
                streamError = String(error.message ?? JSON.stringify(error));
            }
        } else if (protocol === "anthropic-messages") {
            const message = isRecord(event.message) ? event.message : event;
            if (isRecord(message.usage)) anthropicRaw = { ...anthropicRaw, ...message.usage };
            if (isRecord(event.usage)) anthropicRaw = { ...anthropicRaw, ...event.usage };
            if (Object.keys(anthropicRaw).length) usage = anthropicUsage(anthropicRaw);
            if (isRecord(event.error)) streamError = String(event.error.message ?? JSON.stringify(event.error));
        } else {
            if (isRecord(event.usage)) usage = chatUsage(event.usage);
            if (isRecord(event.error)) streamError = String(event.error.message ?? JSON.stringify(event.error));
        }
    }
    return { usage, streamError, diagnostics };
}

/** Provider error text, cut short and with anything shaped like a key removed. */
export function scrubError(text: string, secrets: string[]): string {
    let out = text;
    for (const secret of secrets) if (secret) out = out.replaceAll(secret, "[REDACTED]");
    // Only key-length runs are redacted, so prose such as "Bearer token has expired" survives.
    return out
        .replace(/Bearer\s+[\w.~+/=-]{20,}|sk-[\w-]{8,}|bedrock-api-key-\S+/gi, "[REDACTED]")
        .slice(0, 800);
}
