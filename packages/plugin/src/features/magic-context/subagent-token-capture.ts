import { describeError } from "../../shared/error-message";
import type { HarnessId } from "../../shared/harness";
import { log, sessionLog } from "../../shared/logger";
import { sanitizeDiagnosticText } from "../../shared/redaction";
import type { Database } from "../../shared/sqlite";
import {
    recordSubagentInvocation,
    type SubagentInvocationStatus,
    type SubagentKind,
} from "./storage-subagent-invocations";

export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface LastAssistantModel {
    providerId: string | null;
    modelId: string | null;
}

export interface ChildInvocationRecordInput {
    db: Database | null;
    parentSessionId: string;
    harness: HarnessId;
    subagent: SubagentKind;
    startedAt: number;
    endedAt?: number;
    status: SubagentInvocationStatus;
    task?: string | null;
    messages?: unknown[];
    tokens?: TokenTotals;
    providerId?: string | null;
    modelId?: string | null;
    /** Model selected before dispatch, used when the child never sends an assistant message. */
    attemptedModel?: string | { model: string; sourceConfigKey?: string };
    configuredModels?: readonly (string | { model: string; sourceConfigKey?: string })[];
    modelConfigKey?: string;
    /** The host's structured child-session error, when it did not produce a reply. */
    hostError?: unknown;
    error?: unknown;
    parentInvocationId?: number | null;
}

const warnedUnknownModels = new Set<string>();
const loggedModelReroutes = new Set<string>();
export const MAX_SUBAGENT_INVOCATION_ERROR_CHARS = 1_000;

export interface SubagentInvocationErrorDetails {
    attemptedModel?: string;
    modelConfigKey?: string;
    hostError?: unknown;
}

const invocationErrorDetails = new WeakMap<object, SubagentInvocationErrorDetails>();

/** Retain dispatch facts on a thrown error without adding them to its user-facing message. */
export function annotateSubagentInvocationError<T>(
    error: T,
    details: SubagentInvocationErrorDetails,
): T {
    if (error && typeof error === "object") {
        const previous = invocationErrorDetails.get(error) ?? {};
        invocationErrorDetails.set(error, {
            ...previous,
            ...details,
            hostError: details.hostError ?? previous.hostError,
        });
    }
    return error;
}

function errorDetailsOf(error: unknown): SubagentInvocationErrorDetails {
    const seen = new Set<object>();
    const visit = (value: unknown, depth: number): SubagentInvocationErrorDetails => {
        if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return {};
        seen.add(value);
        const direct = invocationErrorDetails.get(value) ?? {};
        const record = value as Record<string, unknown>;
        const nested = visit(record.hostError, depth + 1);
        const cause = visit(record.cause, depth + 1);
        return {
            ...cause,
            ...nested,
            ...direct,
            hostError: direct.hostError ?? nested.hostError ?? cause.hostError ?? record.hostError,
        };
    };
    return visit(error, 0);
}

function modelRef(value: ChildInvocationRecordInput["attemptedModel"]): string | undefined {
    const reference = typeof value === "string" ? value : value?.model;
    return typeof reference === "string" && reference.trim().length > 0
        ? reference.trim()
        : undefined;
}

function splitModelRef(value: string | undefined): LastAssistantModel {
    if (!value) return { providerId: null, modelId: null };
    const slash = value.indexOf("/");
    return slash > 0 && slash < value.length - 1
        ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
        : { providerId: null, modelId: value };
}

function cleanOneLine(value: string): string {
    const oneLine = sanitizeDiagnosticText(value)
        .replaceAll("\r", " ")
        .replaceAll("\n", " ")
        .replaceAll("\t", " ")
        .replace(/\s+/g, " ")
        .trim();
    return oneLine.length <= MAX_SUBAGENT_INVOCATION_ERROR_CHARS
        ? oneLine
        : `${oneLine.slice(0, MAX_SUBAGENT_INVOCATION_ERROR_CHARS - 1)}…`;
}

function recordMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (!error || typeof error !== "object") return String(error ?? "");
    const record = error as Record<string, unknown>;
    const data =
        record.data && typeof record.data === "object"
            ? (record.data as Record<string, unknown>)
            : undefined;
    const message =
        typeof data?.message === "string"
            ? data.message
            : typeof record.message === "string"
              ? record.message
              : typeof record.description === "string"
                ? record.description
                : "";
    const name =
        typeof record.name === "string"
            ? record.name
            : typeof record.type === "string"
              ? record.type
              : "";
    return (
        [name, message].filter(Boolean).join(": ") ||
        "The host reported an error without a message."
    );
}

interface ModelNotFoundDetail {
    model: string;
    suggestion?: string;
    message: string;
}

function modelNotFoundDetail(
    error: unknown,
    attemptedModel: string | undefined,
): ModelNotFoundDetail | null {
    const seen = new Set<object>();
    const visit = (value: unknown, depth: number): ModelNotFoundDetail | null => {
        if (typeof value === "string") {
            const modelMatch = value.match(/model not found:\s*(.+?)(?=(?:\.?\s*did you mean|$))/i);
            if (!modelMatch) return null;
            const model = modelMatch[1].trim().replace(/[.,;(]+$/, "");
            const suggestion = value.match(/did you mean:?\s*\(?\s*([^?);]+)/i)?.[1]?.trim();
            const message = `Model not found: ${model}${suggestion ? ` (did you mean ${suggestion}?)` : ""}`;
            return { model, ...(suggestion ? { suggestion } : {}), message };
        }
        if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return null;
        seen.add(value);
        const record = value as Record<string, unknown>;
        const data =
            record.data && typeof record.data === "object"
                ? (record.data as Record<string, unknown>)
                : undefined;
        const modelRecord = (data?.model ?? record.model) as Record<string, unknown> | undefined;
        const modelId =
            (typeof data?.modelID === "string" ? data.modelID : undefined) ??
            (typeof modelRecord?.modelID === "string" ? modelRecord.modelID : undefined) ??
            (typeof modelRecord?.id === "string" ? modelRecord.id : undefined);
        const providerId =
            (typeof data?.providerID === "string" ? data.providerID : undefined) ??
            (typeof modelRecord?.providerID === "string" ? modelRecord.providerID : undefined);
        const suggestions = data?.suggestions;
        const suggestion =
            Array.isArray(suggestions) && typeof suggestions[0] === "string"
                ? suggestions[0]
                : typeof data?.suggestion === "string"
                  ? data.suggestion
                  : undefined;
        const rawMessage = recordMessage(value);
        const fromMessage = visit(rawMessage, depth + 1);
        if (fromMessage)
            return fromMessage.suggestion || !suggestion
                ? fromMessage
                : {
                      ...fromMessage,
                      suggestion,
                      message: `Model not found: ${fromMessage.model} (did you mean ${suggestion}?)`,
                  };
        const name = `${String(record.name ?? "")} ${String(record.type ?? "")}`;
        if (/ProviderModelNotFoundError|model not found/i.test(name) && modelId) {
            const model = providerId ? `${providerId}/${modelId}` : modelId;
            const detail = `Model not found: ${model}${suggestion ? ` (did you mean ${suggestion}?)` : ""}`;
            return { model, ...(suggestion ? { suggestion } : {}), message: detail };
        }
        for (const key of ["data", "error", "cause", "hostError"] as const) {
            const match = visit(record[key], depth + 1);
            if (match) return match;
        }
        return null;
    };
    const found = visit(error, 0);
    if (
        !found &&
        attemptedModel &&
        ((typeof error === "string" && /ProviderModelNotFoundError/i.test(error)) ||
            (error !== null &&
                typeof error === "object" &&
                /ProviderModelNotFoundError/i.test(
                    `${String((error as Record<string, unknown>).name ?? "")} ${String((error as Record<string, unknown>).type ?? "")}`,
                )))
    ) {
        return { model: attemptedModel, message: `Model not found: ${attemptedModel}` };
    }
    return found;
}

function hostLabel(harness: HarnessId): string {
    switch (harness) {
        case "opencode2":
            return "OpenCode 2";
        case "opencode":
            return "OpenCode";
        case "pi":
            return "Pi";
        case "omp":
            return "Oh My Pi";
    }
}

function invocationErrorText(
    input: ChildInvocationRecordInput,
    details: SubagentInvocationErrorDetails,
    attemptedModel: string | undefined,
): string | null {
    if (input.error == null && input.hostError == null && details.hostError == null) return null;
    const rawHostError = input.hostError ?? details.hostError;
    const modelError = modelNotFoundDetail(rawHostError ?? input.error, attemptedModel);
    if (modelError) {
        return cleanOneLine(
            `No reply: ${hostLabel(input.harness)} refused the model: ${modelError.message}`,
        );
    }
    if (rawHostError != null) {
        return cleanOneLine(
            `No reply: ${hostLabel(input.harness)} reported a child-session error: ${recordMessage(rawHostError)}`,
        );
    }
    return cleanOneLine(describeError(input.error).brief);
}

function warnUnknownModel(
    input: ChildInvocationRecordInput,
    details: SubagentInvocationErrorDetails,
    attemptedModel: string | undefined,
    modelConfigKey: string | undefined,
): void {
    if (!attemptedModel) return;
    const issue = modelNotFoundDetail(
        input.hostError ?? details.hostError ?? input.error,
        attemptedModel,
    );
    if (!issue || warnedUnknownModels.has(attemptedModel)) return;
    if (!modelConfigKey) return;
    warnedUnknownModels.add(attemptedModel);
    const suggestion = issue.suggestion
        ? `provider suggests ${cleanOneLine(issue.suggestion)}`
        : "provider gave no model suggestion";
    log(
        `[magic-context] WARNING: ${modelConfigKey} configured ${attemptedModel}, but ${hostLabel(input.harness)} does not know that model; ${suggestion}`,
    );
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenObjectFromMessage(message: Record<string, unknown>): Record<string, unknown> | null {
    const info = message.info;
    if (info && typeof info === "object") {
        const tokens = (info as Record<string, unknown>).tokens;
        if (tokens && typeof tokens === "object") return tokens as Record<string, unknown>;
    }
    const tokens = message.tokens;
    if (tokens && typeof tokens === "object") return tokens as Record<string, unknown>;
    // Pi/OMP --mode json puts provider accounting on message.usage rather
    // than OpenCode's info.tokens. Keep the normalized totals below shared so
    // both harnesses write the same invocation columns.
    const usage = message.usage;
    if (usage && typeof usage === "object") return usage as Record<string, unknown>;
    return null;
}

function isAssistantMessage(message: unknown): message is Record<string, unknown> {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    const info = record.info;
    if (info && typeof info === "object") {
        return (info as Record<string, unknown>).role === "assistant";
    }
    return record.role === "assistant";
}

function modelFromMessage(message: Record<string, unknown>): LastAssistantModel {
    const info = message.info;
    const source = info && typeof info === "object" ? (info as Record<string, unknown>) : message;
    return {
        providerId:
            typeof source.providerID === "string"
                ? source.providerID
                : typeof source.providerId === "string"
                  ? source.providerId
                  : null,
        modelId:
            typeof source.modelID === "string"
                ? source.modelID
                : typeof source.modelId === "string"
                  ? source.modelId
                  : null,
    };
}

export function failedInvocationStatus(error: unknown): SubagentInvocationStatus {
    const message = describeError(error).brief;
    if (/timed out after \d+ms|prompt timed out/i.test(message)) return "timed_out";
    // A host client's request timer (Bun's fetch rejects with a DOMException named
    // TimeoutError) ends the prompt the same way our own slice expiry does.
    if (
        error !== null &&
        typeof error === "object" &&
        (error as { name?: unknown }).name === "TimeoutError"
    ) {
        return "timed_out";
    }
    if (
        /length-capped|no (?:assistant )?output|empty (?:assistant )?(?:output|text)/i.test(message)
    ) {
        return "empty";
    }
    return "failed";
}

export function emptyTokenTotals(): TokenTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function sumTokensFromChildMessages(messages: unknown[]): TokenTotals {
    const totals = emptyTokenTotals();
    for (const message of messages) {
        if (!isAssistantMessage(message)) continue;
        const tokens = tokenObjectFromMessage(message);
        if (!tokens) continue;
        const cache =
            tokens.cache && typeof tokens.cache === "object"
                ? (tokens.cache as Record<string, unknown>)
                : {};
        totals.input += asNumber(tokens.input);
        totals.output += asNumber(tokens.output);
        totals.cacheRead += asNumber(cache.read ?? tokens.cacheRead ?? tokens.cache_read);
        totals.cacheWrite += asNumber(cache.write ?? tokens.cacheWrite ?? tokens.cache_write);
    }
    return totals;
}

export function findLastAssistantModel(messages: unknown[]): LastAssistantModel {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isAssistantMessage(message)) {
            const model = modelFromMessage(message);
            if (model.providerId || model.modelId) return model;
        }
    }
    return { providerId: null, modelId: null };
}

export function recordChildInvocation(input: ChildInvocationRecordInput): number | null {
    // Best-effort telemetry: when storage is unavailable (openDatabase() returned
    // null on the schema fence), silently skip recording rather than crash the
    // subagent that was only trying to log its token usage.
    if (!input.db) return null;
    const tokens = input.tokens ?? sumTokensFromChildMessages(input.messages ?? []);
    const observedModel = findLastAssistantModel(input.messages ?? []);
    const details = errorDetailsOf(input.error);
    const attemptedModel = details.attemptedModel ?? modelRef(input.attemptedModel);
    const attemptConfig = [input.attemptedModel, ...(input.configuredModels ?? [])].find(
        (candidate) => modelRef(candidate) === attemptedModel,
    );
    const modelConfigKey =
        details.modelConfigKey ??
        input.modelConfigKey ??
        (typeof attemptConfig === "object" ? attemptConfig?.sourceConfigKey : undefined);
    const attemptedParts = splitModelRef(attemptedModel);
    const model = {
        providerId: observedModel.providerId ?? input.providerId ?? attemptedParts.providerId,
        modelId: observedModel.modelId ?? input.modelId ?? attemptedParts.modelId,
    };
    const reportedModelRef =
        observedModel.providerId && observedModel.modelId
            ? `${observedModel.providerId}/${observedModel.modelId}`
            : input.providerId && input.modelId
              ? `${input.providerId}/${input.modelId}`
              : undefined;
    if (
        attemptedModel &&
        reportedModelRef &&
        attemptedModel !== reportedModelRef &&
        (observedModel.providerId !== null || input.providerId !== undefined)
    ) {
        const rerouteKey = `${input.harness}\u0000${attemptedModel}\u0000${reportedModelRef}`;
        if (!loggedModelReroutes.has(rerouteKey)) {
            loggedModelReroutes.add(rerouteKey);
            sessionLog(
                input.parentSessionId,
                `subagent model rerouted by host: attempted=${attemptedModel} reported=${reportedModelRef}`,
            );
        }
    }
    warnUnknownModel(input, details, attemptedModel, modelConfigKey);
    const errorText = invocationErrorText(input, details, attemptedModel);
    try {
        return recordSubagentInvocation(input.db, {
            sessionId: input.parentSessionId,
            harness: input.harness,
            subagent: input.subagent,
            task: input.task ?? null,
            providerId: model.providerId,
            modelId: model.modelId,
            startedAt: input.startedAt,
            endedAt: input.endedAt ?? Date.now(),
            status: input.status,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cacheRead,
            cacheWriteTokens: tokens.cacheWrite,
            error: errorText,
            parentInvocationId: input.parentInvocationId ?? null,
        });
    } catch (error) {
        sessionLog(
            input.parentSessionId,
            "subagent token accounting failed:",
            describeError(error).brief,
        );
        return null;
    }
}
