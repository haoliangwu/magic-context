import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { getModelsDevCacheState, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import type { V2Context } from "./types";

let warmStarted = false;

/** True once the harness-scoped shared cache holds at least one catalog model. */
export function modelLimitCacheWarm(): boolean {
    const state = getModelsDevCacheState();
    return state.apiLoaded && state.apiCount > 0;
}

/** Test-only: clear the in-process warm latch. */
export function resetModelLimitCacheWarmForTest(): void {
    warmStarted = false;
}

/** Convert the v2 flat model catalog into the shared cache provider shape. */
export function catalogProvidersPayload(listed: unknown): Array<{
    id: string;
    models: Record<string, Record<string, unknown>>;
}> {
    const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
          ? (listed as { data: unknown[] }).data
          : [];
    const byProvider = new Map<string, Record<string, Record<string, unknown>>>();
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const entry = row as { id?: unknown; providerID?: unknown };
        if (typeof entry.id !== "string" || typeof entry.providerID !== "string") continue;
        const models = byProvider.get(entry.providerID) ?? {};
        models[entry.id] = entry as Record<string, unknown>;
        byProvider.set(entry.providerID, models);
    }
    return [...byProvider.entries()].map(([id, models]) => ({ id, models }));
}

/**
 * Seed the shared model-limit cache from the v2 host catalog. A failed early
 * warm releases its latch so a later context pass can retry after host startup.
 */
export async function warmModelLimitCacheFromCatalog(
    context: V2Context,
    options: { retries?: number; retryDelayMs?: number } = {},
): Promise<void> {
    if (warmStarted) return;
    warmStarted = true;
    try {
        await refreshModelLimitsFromApi(
            {
                config: {
                    providers: async () => ({
                        data: {
                            providers: catalogProvidersPayload(
                                await Promise.resolve(context.model.list()),
                            ),
                        },
                    }),
                },
            },
            {
                retries: options.retries ?? 3,
                retryDelayMs: options.retryDelayMs ?? 1000,
            },
        );
    } catch (error) {
        sessionLog("global", `v2 model-limit cache warm failed: ${getErrorMessage(error)}`);
    } finally {
        if (!modelLimitCacheWarm()) warmStarted = false;
    }
}
