import type { ModelInput } from "../../shared/model-resolution";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";

/** Register the windows of mock transports without changing their captured request bodies. */
export async function observeProducerModelsForTest(
    models: readonly (ModelInput | undefined)[],
    contextLimit = 1_000_000,
): Promise<void> {
    const providers = new Map<
        string,
        Record<string, { limit: { context: number; output: number } }>
    >();
    for (const model of models) {
        const key = typeof model === "string" ? model : model?.model;
        if (!key) continue;
        const split = key.indexOf("/");
        if (split < 1) throw new Error(`fixture model is not provider-qualified: ${key}`);
        const provider = key.slice(0, split);
        const entries = providers.get(provider) ?? {};
        entries[key.slice(split + 1)] = { limit: { context: contextLimit, output: 32000 } };
        providers.set(provider, entries);
    }
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: { providers: [...providers].map(([id, models]) => ({ id, models })) },
            }),
        },
    });
}

export async function prepareProducerFixture<
    T extends {
        model?: ModelInput;
        historianContextLimit?: number;
        fallbackModels?: readonly ModelInput[];
        fallbackModelId?: string;
    },
>(deps: T): Promise<T & { model: ModelInput }> {
    const model = deps.model ?? "test/fixture-historian";
    await observeProducerModelsForTest(
        [model, ...(deps.fallbackModels ?? []), deps.fallbackModelId],
        deps.historianContextLimit ?? 1_000_000,
    );
    return { ...deps, model };
}

export const clearProducerModelObservations = clearModelsDevCache;
