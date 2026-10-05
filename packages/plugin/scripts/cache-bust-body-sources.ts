import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type BodyProvider = "anthropic" | "openai" | "gemini";

type Json = Record<string, unknown>;

export interface NormalizedPart {
    type: string;
    length: number;
    textPrefix: string;
}

export interface NormalizedMessage {
    role: string;
    parts: NormalizedPart[];
    hash: string;
    bytes: number;
    breakpoint: boolean;
    canonical: string;
}

export interface NormalizedRequestBody {
    provider: BodyProvider;
    messages: NormalizedMessage[];
}

export interface PiBodySnapshot {
    sequence: number;
    path: string;
    wireModel?: string;
    messages: NormalizedMessage[];
}

export interface BodyPairDivergence {
    index: number;
    description: string;
    previousText: string;
    currentText: string;
}

function asJson(value: unknown): Json | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Json)
        : undefined;
}

function sha(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

/**
 * Values the caller rotates on every request even when the prompt is byte-stable.
 * The Anthropic auth plugin prepends a billing-header block to `system` whose
 * `cch`, `cc_prev_req`, and `cc_prompt_id` change per request; the provider meter
 * reports a full cache read straight across those rotations, so a comparison that
 * counts them reports a divergence on every single request and buries the real
 * ones. The whole header line is replaced rather than each field, so a field
 * added to it later cannot quietly reintroduce the noise.
 */
export function stripRotatingRequestFields(text: string): string {
    return text
        .replace(/^[ \t]*x-anthropic-billing-header:.*$/gim, "x-anthropic-billing-header: <rotating>")
        .replace(/cch=[^;]*;/g, "cch=<NONCE>;");
}

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    const object = asJson(value);
    if (!object) {
        return typeof value === "string" ? stripRotatingRequestFields(value) : value;
    }
    const normalized: Json = {};
    for (const [key, child] of Object.entries(object)) {
        if (key !== "cache_control") normalized[key] = stripCacheControl(child);
    }
    return normalized;
}

function hasCacheControl(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasCacheControl);
    const object = asJson(value);
    if (!object) return false;
    if (object.cache_control !== undefined) return true;
    return Object.values(object).some(hasCacheControl);
}

function textForPart(value: unknown): string {
    if (typeof value === "string") return value;
    const object = asJson(value);
    if (!object) return JSON.stringify(stripCacheControl(value)) ?? String(value);
    for (const key of ["text", "thinking", "output", "arguments", "input"] as const) {
        const candidate = object[key];
        if (typeof candidate === "string") return candidate;
        if (candidate !== undefined) return JSON.stringify(stripCacheControl(candidate)) ?? "";
    }
    return JSON.stringify(stripCacheControl(object)) ?? "";
}

function partType(value: unknown, fallback: string): string {
    const object = asJson(value);
    return typeof object?.type === "string" ? object.type : fallback;
}

function normalizePart(value: unknown, fallbackType: string): NormalizedPart {
    // Normalize before measuring: the part length and text prefix both feed the
    // message identity the analyzer diffs on, so an un-normalized length or
    // prefix would diverge on a rotation the hash already forgives.
    const text = stripRotatingRequestFields(textForPart(value));
    const oneLine = text.replace(/\s+/g, " ").trim();
    return {
        type: partType(value, fallbackType),
        length: text.length,
        textPrefix: oneLine.slice(0, 120),
    };
}

function contentParts(content: unknown, fallbackType: string): NormalizedPart[] {
    if (Array.isArray(content)) {
        return content.map((part) => normalizePart(part, fallbackType));
    }
    return [normalizePart(content, fallbackType)];
}

function normalizedMessage(
    role: string,
    content: unknown,
    original: unknown,
    fallbackType: string,
): NormalizedMessage {
    const canonical = JSON.stringify({ role, content: stripCacheControl(content) });
    return {
        role,
        parts: contentParts(content, fallbackType),
        hash: sha(canonical),
        bytes: Buffer.byteLength(JSON.stringify(original)),
        breakpoint: hasCacheControl(original),
        canonical,
    };
}

function openAiRole(item: Json): string {
    if (typeof item.role === "string") return item.role;
    switch (item.type) {
        case "function_call":
        case "reasoning":
            return "assistant";
        case "function_call_output":
            return "tool";
        default:
            return typeof item.type === "string" ? item.type : "unknown";
    }
}

function normalizeAnthropicBody(body: Json): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    if (body.system !== undefined) {
        const system = Array.isArray(body.system) ? body.system : [body.system];
        messages.push(normalizedMessage("system", system, system, "text"));
    }
    if (!Array.isArray(body.messages)) return messages;
    for (const value of body.messages) {
        const message = asJson(value);
        if (!message) continue;
        const role = typeof message.role === "string" ? message.role : "unknown";
        messages.push(normalizedMessage(role, message.content, message, "text"));
    }
    return messages;
}

function normalizeOpenAiBody(body: Json): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    if (body.instructions !== undefined) {
        messages.push(
            normalizedMessage("system", body.instructions, body.instructions, "instructions"),
        );
    }
    if (!Array.isArray(body.input)) return messages;
    for (const value of body.input) {
        const item = asJson(value);
        if (!item) {
            messages.push(normalizedMessage("user", value, value, "input_text"));
            continue;
        }
        const content = item.content ?? item;
        messages.push(normalizedMessage(openAiRole(item), content, item, partType(item, "input")));
    }
    return messages;
}

/** Gemini parts carry no `type`; the payload key (text, functionCall, ...) names the part. */
function geminiPartType(value: unknown): string {
    const object = asJson(value);
    if (!object) return "text";
    for (const key of [
        "functionCall",
        "functionResponse",
        "inlineData",
        "fileData",
        "executableCode",
        "codeExecutionResult",
    ] as const) {
        if (object[key] !== undefined) return key;
    }
    if (object.text !== undefined) return object.thought === true ? "thought" : "text";
    return "part";
}

function geminiMessage(role: string, parts: unknown, original: unknown): NormalizedMessage {
    const message = normalizedMessage(role, parts, original, "text");
    return {
        ...message,
        parts: Array.isArray(parts)
            ? parts.map((part) => normalizePart(part, geminiPartType(part)))
            : message.parts,
    };
}

/**
 * Gemini `generateContent` bodies: `systemInstruction` + `tools` + `contents[]`.
 * Google Code Assist (Antigravity) wraps the same request in a
 * `{model, project, request: {...}}` envelope, so the inner request is read when
 * present. Tool declarations are kept as their own message because they sit in the
 * provider's cached prefix: a changed tool list is a real prefix rewrite.
 */
function normalizeGeminiBody(body: Json): NormalizedMessage[] {
    const request = asJson(body.request) ?? body;
    const messages: NormalizedMessage[] = [];
    if (request.systemInstruction !== undefined) {
        const system = asJson(request.systemInstruction);
        messages.push(geminiMessage("system", system?.parts ?? request.systemInstruction, system));
    }
    if (request.tools !== undefined) {
        messages.push(normalizedMessage("tools", request.tools, request.tools, "tools"));
    }
    if (!Array.isArray(request.contents)) return messages;
    for (const value of request.contents) {
        const content = asJson(value);
        if (!content) continue;
        const role = typeof content.role === "string" ? content.role : "unknown";
        messages.push(geminiMessage(role, content.parts, content));
    }
    return messages;
}

/** Convert Anthropic `messages[]`, Responses `input[]`, and Gemini `contents[]` into the same diagnostic shape. */
export function normalizeRequestBody(body: Json, provider?: BodyProvider): NormalizedRequestBody {
    const resolvedProvider = provider ?? (Array.isArray(body.input) ? "openai" : "anthropic");
    return {
        provider: resolvedProvider,
        messages:
            resolvedProvider === "openai"
                ? normalizeOpenAiBody(body)
                : resolvedProvider === "gemini"
                  ? normalizeGeminiBody(body)
                  : normalizeAnthropicBody(body),
    };
}

export function firstNormalizedDivergence(
    previous: readonly NormalizedMessage[],
    current: readonly NormalizedMessage[],
): number {
    const shared = Math.min(previous.length, current.length);
    for (let index = 0; index < shared; index += 1) {
        if (previous[index].hash !== current[index].hash) return index;
    }
    return previous.length === current.length ? -1 : shared;
}

export function describeNormalizedMessage(message: NormalizedMessage): string {
    const parts = message.parts.map((part) => `${part.type}(${part.length})`).join(",");
    const prefix = message.parts.find((part) => part.textPrefix)?.textPrefix ?? "";
    return `role=${message.role} parts=[${parts || "none"}] text=${JSON.stringify(prefix)}`;
}

export function describeBodyPair(
    previous: readonly NormalizedMessage[],
    current: readonly NormalizedMessage[],
): BodyPairDivergence | undefined {
    const index = firstNormalizedDivergence(previous, current);
    if (index < 0) return undefined;
    const message = current[index] ?? previous[index];
    return {
        index,
        description: `message[${index}] ${describeNormalizedMessage(message)}`,
        previousText: previous[index]?.canonical ?? "(message absent)",
        currentText: current[index]?.canonical ?? "(message absent)",
    };
}

function clippedVersion(text: string, start: number, end: number): string {
    const before = text.slice(Math.max(0, start - 120), start);
    const changed = text.slice(start, Math.min(end, start + 240));
    const after = text.slice(end, end + 120);
    return `${start > 120 ? "…" : ""}${before}[${changed}${end - start > 240 ? "…" : ""}]${after}${end + 120 < text.length ? "…" : ""}`;
}

export function clippedBodyPairVersions(divergence: BodyPairDivergence): {
    character: number;
    previous: string;
    current: string;
} {
    const previous = divergence.previousText;
    const current = divergence.currentText;
    let start = 0;
    while (
        start < previous.length &&
        start < current.length &&
        previous[start] === current[start]
    ) {
        start += 1;
    }
    let previousEnd = previous.length;
    let currentEnd = current.length;
    while (
        previousEnd > start &&
        currentEnd > start &&
        previous[previousEnd - 1] === current[currentEnd - 1]
    ) {
        previousEnd -= 1;
        currentEnd -= 1;
    }
    return {
        character: start,
        previous: clippedVersion(previous, start, previousEnd),
        current: clippedVersion(current, start, currentEnd),
    };
}

function sessionCwdFromJsonl(sessionPath: string): string | undefined {
    try {
        for (const raw of readFileSync(sessionPath, "utf8").split("\n")) {
            if (!raw.trim()) continue;
            const entry = asJson(JSON.parse(raw));
            if (entry?.type === "session" && typeof entry.cwd === "string") return entry.cwd;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function cwdFromEncodedSessionDirectory(sessionPath: string): string | undefined {
    const encoded = basename(dirname(sessionPath));
    if (!encoded.startsWith("--") || !encoded.endsWith("--")) return undefined;
    const inner = encoded.slice(2, -2);
    return inner ? `/${inner.replaceAll("-", "/")}` : undefined;
}

export function resolvePiBodiesDirectory(
    sessionId: string,
    sessionPath: string,
    override?: string,
): string | undefined {
    if (override) {
        const nested = join(override, sessionId);
        if (existsSync(nested)) return nested;
        return existsSync(override) ? override : undefined;
    }
    const cwd = sessionCwdFromJsonl(sessionPath) ?? cwdFromEncodedSessionDirectory(sessionPath);
    if (!cwd) return undefined;
    const candidate = join(cwd, ".pi", "pi-llm-debugging", sessionId);
    return existsSync(candidate) ? candidate : undefined;
}

export function loadPiBodySnapshots(directory: string | undefined): Map<number, PiBodySnapshot> {
    const snapshots = new Map<number, PiBodySnapshot>();
    if (!directory || !existsSync(directory)) return snapshots;
    for (const file of readdirSync(directory)) {
        const match = /^(\d+)-req\.json$/.exec(file);
        if (!match) continue;
        const path = join(directory, file);
        try {
            const body = JSON.parse(readFileSync(path, "utf8")) as Json;
            snapshots.set(Number.parseInt(match[1], 10), {
                sequence: Number.parseInt(match[1], 10),
                path,
                wireModel:
                    typeof body.model === "string" && body.model.length > 0 ? body.model : undefined,
                messages: normalizeRequestBody(body, "openai").messages,
            });
        } catch {
            // A partial diagnostic write must not hide the other complete bodies.
        }
    }
    return snapshots;
}
