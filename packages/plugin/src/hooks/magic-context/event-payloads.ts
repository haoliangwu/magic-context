import { isRecord } from "../../shared/record-type-guard";

export type MagicContextEventType =
    | "session.created"
    | "session.error"
    | "message.updated"
    | "message.part.updated"
    | "message.removed"
    | "session.compacted"
    | "session.deleted";

export type MagicContextEvent = {
    type: MagicContextEventType;
    properties?: unknown;
};

export interface SessionCreatedInfo {
    id: string;
    parentID: string;
    directory?: string;
    providerID?: string;
    modelID?: string;
    /**
     * Session title set at create time. Magic Context's own hidden children
     * (historian/dreamer) all use `magic-context-*`
     * titles, so this is the signal used to fully exempt them from the
     * transform + system-prompt injection pipeline.
     */
    title?: string;
}

export interface MessageUpdatedAssistantInfo {
    role: "assistant";
    finish?: string;
    sessionID: string;
    /** OpenCode assistant message id. Undefined only when the event payload
     *  doesn't include one (older SDK versions or malformed events). */
    messageID?: string;
    parentID?: string;
    completedAt?: number;
    providerID?: string;
    modelID?: string;
    tokens?: {
        input?: number;
        cache?: {
            read?: number;
            write?: number;
        };
    };
    /** Error attached to the assistant message, if any. OpenCode attaches
     *  context-overflow errors here in addition to emitting session.error. */
    error?: unknown;
}

export interface MessageUpdatedInfo {
    role: "user" | "assistant" | string;
    sessionID: string;
    messageID?: string;
    finish?: string;
    completedAt?: number;
}

export interface SessionErrorInfo {
    sessionID: string;
    error: unknown;
    providerID?: string;
    modelID?: string;
}

export interface MessageRemovedInfo {
    sessionID: string;
    messageID: string;
}

export function getSessionProperties(
    properties: unknown,
): { info?: unknown; sessionID?: string } | undefined {
    if (!isRecord(properties)) {
        return undefined;
    }

    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
    return {
        info: properties.info,
        sessionID,
    };
}

export function getSessionCreatedInfo(properties: unknown): SessionCreatedInfo | null {
    const eventProps = getSessionProperties(properties);
    if (!eventProps || !isRecord(eventProps.info)) {
        return null;
    }

    const info = eventProps.info;
    if (typeof info.id !== "string" || typeof info.parentID !== "string") {
        return null;
    }

    return {
        id: info.id,
        parentID: info.parentID,
        directory: typeof info.directory === "string" ? info.directory : undefined,
        providerID: typeof info.providerID === "string" ? info.providerID : undefined,
        modelID: typeof info.modelID === "string" ? info.modelID : undefined,
        title: typeof info.title === "string" ? info.title : undefined,
    };
}

export function getMessageUpdatedAssistantInfo(
    properties: unknown,
): MessageUpdatedAssistantInfo | null {
    const eventProps = getSessionProperties(properties);
    if (!eventProps || !isRecord(eventProps.info)) {
        return null;
    }

    const info = eventProps.info;
    if (info.role !== "assistant" || typeof info.sessionID !== "string") {
        return null;
    }

    const tokens = isRecord(info.tokens) ? info.tokens : undefined;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;
    const time = isRecord(info.time) ? info.time : undefined;

    return {
        role: "assistant",
        finish: typeof info.finish === "string" ? info.finish : undefined,
        sessionID: info.sessionID,
        messageID: typeof info.id === "string" ? info.id : undefined,
        ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
        completedAt: typeof time?.completed === "number" ? time.completed : undefined,
        providerID: typeof info.providerID === "string" ? info.providerID : undefined,
        modelID: typeof info.modelID === "string" ? info.modelID : undefined,
        tokens: {
            input: typeof tokens?.input === "number" ? tokens.input : undefined,
            cache: {
                read: typeof cache?.read === "number" ? cache.read : undefined,
                write: typeof cache?.write === "number" ? cache.write : undefined,
            },
        },
        error: info.error !== undefined ? info.error : undefined,
    };
}

export function getMessageUpdatedInfo(properties: unknown): MessageUpdatedInfo | null {
    const eventProps = getSessionProperties(properties);
    if (!eventProps || !isRecord(eventProps.info)) {
        return null;
    }

    const info = eventProps.info;
    if (typeof info.role !== "string" || typeof info.sessionID !== "string") {
        return null;
    }

    const time = isRecord(info.time) ? info.time : undefined;
    return {
        role: info.role,
        sessionID: info.sessionID,
        messageID: typeof info.id === "string" ? info.id : undefined,
        finish: typeof info.finish === "string" ? info.finish : undefined,
        completedAt: typeof time?.completed === "number" ? time.completed : undefined,
    };
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract `session.error` payloads without depending on a specific NamedError
 * variant. OpenCode normally emits only `{ sessionID, error }`, while some
 * provider errors also carry model identity at the top level or in `error.data`.
 */
export function getSessionErrorInfo(properties: unknown): SessionErrorInfo | null {
    if (!isRecord(properties)) return null;
    const sessionID = properties.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) return null;

    const error = isRecord(properties.error) ? properties.error : undefined;
    const data = error && isRecord(error.data) ? error.data : undefined;
    const model = isRecord(properties.model)
        ? properties.model
        : error && isRecord(error.model)
          ? error.model
          : data && isRecord(data.model)
            ? data.model
            : undefined;
    const providerID =
        nonEmptyString(properties.providerID) ??
        nonEmptyString(model?.providerID) ??
        nonEmptyString(model?.provider) ??
        nonEmptyString(error?.providerID) ??
        nonEmptyString(data?.providerID);
    const modelID =
        nonEmptyString(properties.modelID) ??
        nonEmptyString(model?.modelID) ??
        nonEmptyString(model?.id) ??
        nonEmptyString(error?.modelID) ??
        nonEmptyString(data?.modelID);

    return {
        sessionID,
        error: properties.error,
        ...(providerID ? { providerID } : {}),
        ...(modelID ? { modelID } : {}),
    };
}

export function getMessageRemovedInfo(properties: unknown): MessageRemovedInfo | null {
    if (!isRecord(properties)) {
        return null;
    }

    if (typeof properties.sessionID !== "string" || typeof properties.messageID !== "string") {
        return null;
    }

    return {
        sessionID: properties.sessionID,
        messageID: properties.messageID,
    };
}
