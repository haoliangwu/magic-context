import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../../hooks/magic-context/compartment-runner-types";
import { stripWellFormedLeadingTagPrefix } from "../../hooks/magic-context/tag-content-primitives";
import type { PromptArgs } from "../../shared/model-suggestion-retry";
import type { SessionContext, V2AgentDomain } from "./types";

export const HIDDEN_HISTORIAN_AGENT = "historian";
export const HIDDEN_DREAMER_AGENT = "dreamer-classifier";

export async function registerHiddenChildAgents(
    agent: Pick<V2AgentDomain, "transform">,
): Promise<void> {
    await agent.transform((editor) => {
        for (const id of [HIDDEN_HISTORIAN_AGENT, HIDDEN_DREAMER_AGENT]) {
            editor.update(id, (config) => {
                config.system = "Magic Context hidden completion carrier.";
                config.description = "Internal Magic Context hidden completion carrier.";
                config.mode = "primary";
                config.hidden = true;
                config.request.settings = {};
                config.request.headers = {};
                config.request.body = {};
                config.permissions = [{ action: "*", resource: "*", effect: "deny" }];
            });
        }
    });
}

export interface HiddenChildAttempt {
    childSessionId: string;
    identity: HiddenRunIdentity;
    request: PromptArgs;
    shaped: boolean;
}

/** Last user text on a context draft. 2.0.5 may use a string body, extra parts, or input_text. */
export function newestUserText(draft: SessionContext): string | undefined {
    const message = draft.messages.at(-1);
    if (!message || (message.role !== undefined && message.role !== "user")) return undefined;
    const content: unknown = message.content;
    if (typeof content === "string" && content.length > 0) return content;
    const parts = Array.isArray(content)
        ? content
        : Array.isArray(message.parts)
          ? message.parts
          : [];
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const record = part as { type?: unknown; text?: unknown };
        if (typeof record.text !== "string" || record.text.length === 0) continue;
        if (record.type === undefined || record.type === "text" || record.type === "input_text") {
            return record.text;
        }
    }
    return undefined;
}

function calibratedParts(attempt: HiddenChildAttempt): Array<{ type: "text"; text: string }> {
    const parts = attempt.request.body.parts;
    if (
        !Array.isArray(parts) ||
        parts.length === 0 ||
        parts.some(
            (part) =>
                !part ||
                typeof part !== "object" ||
                (part as { type?: unknown }).type !== "text" ||
                typeof (part as { text?: unknown }).text !== "string",
        )
    ) {
        throw new HiddenCompletionRefusal(
            "hidden_prompt_unrecognized",
            "Hidden completion accepts text-only calibrated prompts",
            true,
        );
    }
    return parts.map((part) => ({ type: "text", text: (part as { text: string }).text }));
}

/**
 * Owns the fail-closed bridge between a child prompt marker and the exact
 * calibrated request. Hidden children are visible root sessions in OpenCode 2,
 * so a user-selected or otherwise unregistered prompt must never inherit the
 * child's privileged internal identity.
 */
export class HiddenChildHook {
    private readonly childIDs = new Set<string>();
    private readonly attempts = new Map<string, HiddenChildAttempt>();

    registerChild(sessionID: string): void {
        this.childIDs.add(sessionID);
    }

    registerAttempt(marker: string, attempt: HiddenChildAttempt): void {
        this.registerChild(attempt.childSessionId);
        this.attempts.set(marker, attempt);
    }

    releaseAttempt(marker: string): void {
        this.attempts.delete(marker);
    }

    owns(sessionID: string): boolean {
        return this.childIDs.has(sessionID);
    }

    /** Returns false only for an ordinary user session that this bridge does not own. */
    apply(draft: SessionContext): boolean {
        if (!this.owns(draft.sessionID)) return false;

        const raw = newestUserText(draft);
        const stripped = raw === undefined ? undefined : stripWellFormedLeadingTagPrefix(raw);
        const attempt =
            (raw !== undefined ? this.attempts.get(raw) : undefined) ??
            (stripped && stripped !== raw ? this.attempts.get(stripped) : undefined);
        if (!attempt || attempt.childSessionId !== draft.sessionID) {
            throw new HiddenCompletionRefusal(
                "hidden_prompt_unrecognized",
                "Refusing an unregistered prompt on a Magic Context hidden-run session",
                true,
            );
        }
        if (attempt.request.signal?.aborted) {
            throw new Error("Hidden completion prompt aborted");
        }

        const system =
            typeof attempt.request.body.system === "string"
                ? attempt.request.body.system
                : attempt.identity.system;
        const temperature = attempt.request.body.temperature;
        draft.system = [{ type: "text", text: system }];
        draft.messages = [{ role: "user", content: calibratedParts(attempt) }];
        draft.options = {
            // OpenCode calls the public budget maxOutputTokens, while its GA
            // GenerationOptions carrier serializes the same value from maxTokens.
            maxOutputTokens: 32768,
            maxTokens: 32768,
            ...(typeof temperature === "number" && Number.isFinite(temperature)
                ? { temperature }
                : {}),
        };
        draft.tools = {};
        attempt.shaped = true;
        return true;
    }
}
