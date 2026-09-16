import {
    type HiddenCompletion,
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
    type HiddenRunHandle,
    type HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import type { PromptArgs } from "../shared/model-suggestion-retry";
import { toModelEntry } from "../shared/resolve-fallbacks";
import type { SessionContext } from "./hooks/types";

export interface GenerateHost {
    hook(name: "generate", callback: (draft: SessionContext) => Promise<void>): Promise<unknown>;
    generate(
        input: { sessionID: string; prompt: string },
        options?: { signal?: AbortSignal },
    ): Promise<{ text: string }>;
}

type Model = { providerID: string; modelID: string };
interface RunState {
    identity: HiddenRunIdentity;
    completion?: HiddenCompletion;
    usage?: HiddenCompletion["usage"];
}
interface PendingAttempt {
    run: RunState;
    request: PromptArgs;
    model: Model;
    shaped: boolean;
}

/** GA generate has no usage rows; these are local tokenizer estimates, not provider billing totals. */
function meter(system: string, prompt: string, text: string) {
    return {
        input: estimateTokens(system) + estimateTokens(prompt),
        output: estimateTokens(text),
        cacheRead: 0,
        cacheWrite: 0,
    };
}

export async function createV2HiddenCompletionExecutor(
    host: GenerateHost,
    currentModel: (sessionID: string) => Model | null | Promise<Model | null>,
): Promise<HiddenCompletionExecutor> {
    const runs = new WeakMap<HiddenRunHandle, RunState>();
    const pending = new Map<string, PendingAttempt>();
    const modelKey = (model: Model) => `${model.providerID}/${model.modelID}`;
    const requireModel = async (sessionID: string | undefined): Promise<Model> => {
        const model = sessionID ? await currentModel(sessionID) : null;
        if (!model)
            throw new HiddenCompletionRefusal(
                "hidden_model_unsupported",
                "Hidden completion requires an existing session with a resolved current model",
                true,
            );
        return model;
    };
    const refuseModel = (requested: string, actual: string, terminal = false): never => {
        throw new HiddenCompletionRefusal(
            "hidden_model_unsupported",
            `Hidden completion model ${requested} is unavailable on opencode2; use the session model ${actual} in historian.model or dreaming task model configuration, or unset the configured model`,
            terminal,
        );
    };
    await host.hook("generate", async (draft) => {
        const last = draft.messages.at(-1);
        if (last?.role !== "user" || last.content.length !== 1) return;
        const part = last.content[0];
        if (part?.type !== "text" || typeof part.text !== "string") return;
        const attempt = pending.get(part.text);
        if (!attempt || draft.sessionID !== attempt.run.identity.parentSessionId) return;
        const actual = `${draft.model.providerID}/${draft.model.id}`;
        if (modelKey(attempt.model) !== actual) refuseModel(modelKey(attempt.model), actual);
        if (attempt.request.signal?.aborted) throw new Error("Hidden completion prompt aborted");
        const body = attempt.request.body;
        if (typeof body.variant === "string" && body.variant !== draft.model.variant) {
            refuseModel(
                `${actual} (${body.variant})`,
                `${actual} (${draft.model.variant ?? "default variant"})`,
            );
        }
        const parts = body.parts;
        if (
            !Array.isArray(parts) ||
            parts.some((item) => item.type !== "text" || typeof item.text !== "string")
        ) {
            throw new HiddenCompletionRefusal(
                "hidden_prompt_unrecognized",
                "Hidden completion accepts text-only calibrated prompts",
                true,
            );
        }
        draft.system = [
            {
                type: "text",
                text: typeof body.system === "string" ? body.system : attempt.run.identity.system,
            },
        ];
        draft.messages = [
            { role: "user", content: parts.map((item) => ({ type: "text", text: item.text })) },
        ];
        draft.tools = {};
        if (attempt.run.identity.maxOutputTokens !== undefined)
            draft.options.maxOutputTokens = attempt.run.identity.maxOutputTokens;
        attempt.shaped = true;
    });
    return {
        capabilities: { tools: false, harness: "opencode2" },
        async open(identity) {
            const model = await requireModel(identity.parentSessionId);
            const configured = (
                identity.configuredModels ?? (identity.model ? [identity.model] : [])
            )
                .map(toModelEntry)
                .filter((entry) => entry !== undefined);
            if (configured.length && !configured.some((entry) => entry.model === modelKey(model))) {
                refuseModel(
                    configured.map((entry) => entry.model).join(", "),
                    modelKey(model),
                    true,
                );
            }
            const handle = { id: `mc:hidden:${crypto.randomUUID()}` };
            runs.set(handle, { identity });
            return handle;
        },
        async attempt(handle, request) {
            const run = runs.get(handle);
            if (!run) throw new Error("Unknown hidden completion run");
            // requireModel refuses an absent session id, so after it returns the id
            // is known; carry the narrowed value into the host call.
            const sessionID = run.identity.parentSessionId;
            const actual = await requireModel(sessionID);
            if (sessionID === undefined) throw new Error("Hidden completion session id missing");
            const requested = request.body.model ?? actual;
            if (modelKey(requested) !== modelKey(actual))
                refuseModel(modelKey(requested), modelKey(actual));
            if (request.signal?.aborted) throw new Error("Hidden completion prompt aborted");
            const marker = `${handle.id}:${crypto.randomUUID()}`;
            const state: PendingAttempt = { run, request, model: actual, shaped: false };
            pending.set(marker, state);
            try {
                const generation = host.generate(
                    { sessionID, prompt: marker },
                    { signal: request.signal },
                );
                // Keep the sentinel registered until the host settles even if our caller
                // times out, so a delayed hook refuses rather than leaking session history.
                const result = await new Promise<{ text: string }>((resolve, reject) => {
                    const abort = () => reject(new Error("Hidden completion prompt aborted"));
                    request.signal?.addEventListener("abort", abort, { once: true });
                    generation.then(resolve, reject).finally(() => {
                        request.signal?.removeEventListener("abort", abort);
                        pending.delete(marker);
                    });
                    if (request.signal?.aborted) abort();
                });
                if (!state.shaped)
                    throw new HiddenCompletionRefusal(
                        "hidden_prompt_unrecognized",
                        "Host did not dispatch the hidden generate hook",
                        true,
                    );
                const prompt = (request.body.parts as Array<{ text: string }>)
                    .map((part) => part.text)
                    .join("\n");
                const system =
                    typeof request.body.system === "string"
                        ? request.body.system
                        : run.identity.system;
                const usage = meter(system, prompt, result.text);
                usage.input += run.usage?.input ?? 0;
                usage.output += run.usage?.output ?? 0;
                run.usage = usage;
                run.completion = {
                    text: result.text,
                    usage,
                    lengthCapped: false,
                    providerId: actual.providerID,
                    modelId: actual.modelID,
                };
            } finally {
                if (!request.signal?.aborted) pending.delete(marker);
            }
        },
        async collect(handle) {
            const completion = runs.get(handle)?.completion;
            if (!completion) throw new Error("Hidden completion has no settled output");
            return completion;
        },
        async close() {},
    };
}
