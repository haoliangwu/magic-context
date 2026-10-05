import { existsSync, readFileSync } from "node:fs";
import { loadRawConfigFile } from "@magic-context/core/config/raw-loader";
import { stripRemovedAgentConfig } from "@magic-context/core/config/removed-agent-config";
import { sanitizeParsedJson } from "@magic-context/core/shared/jsonc-parser";
import { parse as parseJsonc } from "comment-json";

export type JsoncReadResult =
    | { kind: "missing" }
    | { kind: "parsed"; value: Record<string, unknown> }
    | { kind: "parse-error"; error: ConfigParseError };

export class ConfigParseError extends Error {
    readonly path: string;

    constructor(path: string, content: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const location = parseErrorLocation(content, cause);
        super(
            `Refusing to overwrite unparseable config ${path} at line ${location.line}, column ${location.column}: ${detail}`,
            { cause },
        );
        this.name = "ConfigParseError";
        this.path = path;
    }
}

function parseErrorLocation(content: string, error: unknown): { line: number; column: number } {
    const lines = content.split("\n");
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unexpected end of JSON input")) {
        return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
    }

    const parserLocation = error as { line?: unknown; column?: unknown };
    if (
        typeof parserLocation.line === "number" &&
        parserLocation.line >= 1 &&
        parserLocation.line <= lines.length &&
        typeof parserLocation.column === "number" &&
        parserLocation.column >= 0
    ) {
        return { line: parserLocation.line, column: parserLocation.column + 1 };
    }

    const messageLine = /Line (\d+)/.exec(message)?.[1];
    return { line: messageLine ? Number.parseInt(messageLine, 10) : 1, column: 1 };
}

/**
 * Keeps a missing file distinct from malformed user data. Callers may create a
 * missing config, but must never replace a parse failure with an empty object.
 */
export function readJsoncConfig(path: string): JsoncReadResult {
    if (!existsSync(path)) return { kind: "missing" };

    const content = readFileSync(path, "utf-8");
    try {
        const rejectedKeyPaths: string[] = [];
        const parsed = sanitizeParsedJson(parseJsonc(content), {
            onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")),
        });
        if (rejectedKeyPaths.length > 0) {
            throw new Error(`unsafe prototype-pollution key at ${rejectedKeyPaths.join(", ")}`);
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a JSON object at the document root");
        }
        return { kind: "parsed", value: parsed as Record<string, unknown> };
    } catch (error) {
        return { kind: "parse-error", error: new ConfigParseError(path, content, error) };
    }
}

export function readJsoncConfigForUpdate(path: string): Record<string, unknown> {
    const result = readJsoncConfig(path);
    if (result.kind === "missing") return {};
    if (result.kind === "parse-error") throw result.error;
    return result.value;
}

const BYTE_ORDER_MARK = "\uFEFF";

/**
 * Read a JSONC file for byte-preserving edits. comment-json accepts a leading
 * UTF-8 byte-order mark but the text editor's parser rejects it, so the mark
 * is split off for the edit; callers write `bom + text` back.
 */
export function readJsoncTextForEdit(configPath: string): { bom: string; text: string } {
    const raw = readFileSync(configPath, "utf-8");
    return raw.startsWith(BYTE_ORDER_MARK)
        ? { bom: BYTE_ORDER_MARK, text: raw.slice(BYTE_ORDER_MARK.length) }
        : { bom: "", text: raw };
}

export function assertJsoncConfigsParseable(paths: readonly string[]): void {
    for (const path of paths) {
        const result = readJsoncConfig(path);
        if (result.kind === "parse-error") throw result.error;
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a JSONC document that will be rewritten as a whole, keeping its
 * comments. comment-json stores comments as symbol properties on the parsed
 * objects and arrays, so the result must be edited in place (see
 * `editableChild`) and written back with comment-json's stringify. The
 * prototype-pollution sanitizer runs only as a check here: its output is a
 * plain copy, and writing that copy back would drop every comment.
 */
export function parseJsoncPreservingComments(text: string): Record<string, unknown> {
    const parsed: unknown = parseJsonc(text);
    const rejectedKeyPaths: string[] = [];
    sanitizeParsedJson(parsed, {
        onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")),
    });
    if (rejectedKeyPaths.length > 0) {
        throw new Error(`unsafe prototype-pollution key at ${rejectedKeyPaths.join(", ")}`);
    }
    if (!isPlainRecord(parsed)) {
        throw new Error("expected a JSON object at the document root");
    }
    return parsed;
}

/**
 * The object stored at `parent[key]`, edited in place so its comments survive.
 * A missing or non-object value is replaced by a new empty object.
 */
export function editableChild(
    parent: Record<string, unknown>,
    key: string,
): Record<string, unknown> {
    const existing = parent[key];
    if (isPlainRecord(existing)) return existing;
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
}

/**
 * Remove the retired agent config the same way the runtime loader does, but in
 * place: the shared helper returns a shallow copy whenever it removes
 * something, and that copy carries none of the document's comments.
 */
function stripRemovedAgentConfigInPlace(config: Record<string, unknown>): void {
    const stripped = stripRemovedAgentConfig(config, []);
    if (stripped === config) return;
    for (const key of Object.keys(config)) {
        if (!Object.hasOwn(stripped, key)) delete config[key];
    }
    const profiles = config.profiles;
    const strippedProfiles = stripped.profiles;
    if (!isPlainRecord(profiles) || !isPlainRecord(strippedProfiles)) return;
    for (const [name, profile] of Object.entries(profiles)) {
        const strippedProfile = strippedProfiles[name];
        if (!isPlainRecord(profile) || !isPlainRecord(strippedProfile)) continue;
        for (const key of Object.keys(profile)) {
            if (!Object.hasOwn(strippedProfile, key)) delete profile[key];
        }
    }
}

/**
 * Read the shared config through the same raw-tier loader as runtime and doctor.
 * That loader performs any required per-harness migration before setup merges its
 * choices, so setup cannot reintroduce flat model fields into an existing config.
 * The result keeps the file's comments; edit it in place before writing it back.
 * A malformed existing file throws rather than becoming an empty config.
 */
export function readMagicContextConfigForSetup(configPath: string): Record<string, unknown> {
    const raw = loadRawConfigFile({ configPath, tier: "user" });
    if (!raw) return {};

    let config: Record<string, unknown>;
    try {
        config = parseJsoncPreservingComments(raw.text);
    } catch (error) {
        throw new ConfigParseError(configPath, raw.text, error);
    }
    stripRemovedAgentConfigInPlace(config);
    return config;
}
