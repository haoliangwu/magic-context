import { withContentLanguageDirective } from "../../../agents/language-directive";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
} from "../../../hooks/magic-context/compartment-runner-types";
import * as shared from "../../../shared";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import type { PromptArgs } from "../../../shared/model-suggestion-retry";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import { formatRunTokenLog, runTokenLog } from "../../../shared/run-token-log";

export interface HiddenSingleShotArgs<T> {
    executor: HiddenCompletionExecutor;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    /** Agent id the carrier should answer as; carriers that own their own agent ignore it. */
    agent: string;
    system: string;
    prompt: string;
    /** Child session title, used by carriers that create a visible session. */
    title: string;
    /** Log/telemetry label, e.g. "dreamer:review-user-memories". */
    callContext: string;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    language?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    privacySensitive?: boolean;
    /** The curation task can finish after completed memory updates without a final text response. */
    allowEmpty?: boolean;
    /**
     * Turn the complete assistant text into the caller's result. Throwing here
     * rejects this model's answer and advances to the next configured fallback.
     */
    parse: (text: string, completion: HiddenCompletion) => T;
}

export interface HiddenSingleShotResult<T> {
    validated: T;
    completion: HiddenCompletion;
    childSessionId: string;
}

/**
 * Run one Dreamer prompt through a hidden completion carrier and hand the
 * caller the parsed answer. The carrier owns any tool steps for its agent.
 *
 * Every task routed through here answers with one self-contained document
 * (a JSON object or an XML manifest), so a partial answer is never safe to
 * apply. Two guards make that fail closed, matching what the memory classifier
 * already does on this same transport:
 *  - a completion the provider cut short at the output limit is rejected before
 *    the parser sees it, so a truncated prefix can never be applied; and
 *  - an empty completion is rejected rather than parsed as "nothing to do".
 * The caller's own parser is still responsible for rejecting a document whose
 * structure is incomplete — for these tasks that means a JSON object that does
 * not close, or a manifest missing its closing root tag.
 */
export async function runHiddenSingleShotPrompt<T>(
    args: HiddenSingleShotArgs<T>,
): Promise<HiddenSingleShotResult<T>> {
    const system = withContentLanguageDirective(args.system, args.language);
    const handle = await args.executor.open({
        parentSessionId: args.parentSessionId,
        agent: args.agent,
        kind: "dreamer-task",
        system,
        model: args.model,
        configuredModels: [...(args.model ? [args.model] : []), ...(args.fallbackModels ?? [])],
        timeoutMs: args.timeoutMs,
        title: args.title,
        directory: args.sessionDirectory,
        ...(args.metadata ? { metadata: args.metadata } : {}),
    });
    let promptSettled = false;
    try {
        if (!handle.id) throw new Error(`${args.callContext}: carrier returned no session id`);
        const run = await shared.promptSyncWithValidatedOutputRetry(
            // The carrier owns dispatch through `transport` and output reading
            // through `fetchOutput`, so the SDK client is never consulted; passing
            // undefined keeps a completion-only host from needing one at all.
            undefined,
            {
                path: { id: handle.id },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: args.agent,
                    system,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: args.prompt, synthetic: true }],
                },
            },
            {
                transport: Object.assign(
                    (request: PromptArgs) => args.executor.attempt(handle, request),
                    { childSessionId: handle.childSessionId },
                ),
                timeoutMs: args.timeoutMs,
                ...(args.signal ? { signal: args.signal } : {}),
                fallbackModels: args.fallbackModels,
                callContext: args.callContext,
                fetchOutput: () => args.executor.collect(handle, 50),
                validateOutput: (completion) => {
                    const tokens = completion.tokenLog ?? runTokenLog(undefined);
                    shared.sessionLog(
                        args.parentSessionId ?? "dreamer",
                        `${args.callContext} response_chars=${(completion.text ?? completion.reasoning ?? "").length} ${formatRunTokenLog(tokens)}`,
                    );
                    if (completion.lengthCapped) {
                        throw new Error(
                            completion.reasoning && !completion.text
                                ? `${args.callContext} ran out of output budget while reasoning (length-capped at ${completion.usage.output} tokens, no text; ${formatRunTokenLog(tokens)}) — set dreamer.maxTokens or use a low-reasoning model`
                                : `${args.callContext} returned length-capped output; ${formatRunTokenLog(tokens)}`,
                        );
                    }
                    const text = completion.text;
                    if (!text && !args.allowEmpty)
                        throw new Error(`${args.callContext} returned no output`);
                    return args.parse(text ?? "", completion);
                },
            },
        );
        promptSettled = true;
        return { validated: run.validated, completion: run.output, childSessionId: handle.id };
    } finally {
        await args.executor.close(handle, {
            promptSettled,
            privacySensitive: args.privacySensitive ?? true,
            context: `[dreamer] ${args.callContext}`,
            log,
        });
    }
}
