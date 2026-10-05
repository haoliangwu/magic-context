import type { Scheduler } from "../../features/magic-context/scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { loadPersistedUsage, type PersistedUsageState } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";

type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
};

function loadPersistedUsageWatermark(db: ContextDatabase, sessionId: string): number | null {
    const result = db
        .prepare("SELECT last_response_time FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    if (result === null || typeof result !== "object") return null;
    const lastResponseTime = (result as { last_response_time?: unknown }).last_response_time;
    return typeof lastResponseTime === "number" ? lastResponseTime : null;
}

export interface ContextUsagePassSnapshot {
    lastResponseTime: number;
    persistedUsage: PersistedUsageState | null;
}

export function contextUsagePassSnapshot(sessionMeta: SessionMeta): ContextUsagePassSnapshot {
    const hasPersistedUsage =
        sessionMeta.lastContextPercentage !== 0 || sessionMeta.lastInputTokens !== 0;
    return {
        lastResponseTime: sessionMeta.lastResponseTime,
        persistedUsage: hasPersistedUsage
            ? {
                  usage: {
                      percentage: sessionMeta.lastContextPercentage,
                      inputTokens: sessionMeta.lastInputTokens,
                  },
                  updatedAt: sessionMeta.lastResponseTime || Date.now(),
                  lastObservedModelKey: sessionMeta.lastObservedModelKey,
                  lastUsageContextLimit: sessionMeta.lastUsageContextLimit,
              }
            : null,
    };
}

export function resolveUnknownUsageFromWireEstimate(input: {
    usage: ContextUsage;
    pricedPass: boolean;
    wireEstimateTokens: number | undefined;
    wireEstimateTrusted?: boolean;
    providerProvenInputTokens?: number;
    providerProvenLimitTokens?: number;
    usableHardLimit: number | undefined;
}): ContextUsage {
    if (input.usage.inputTokens > 0 || !input.pricedPass) return input.usage;
    const wireTokens = input.wireEstimateTokens;
    if (typeof wireTokens !== "number" || !Number.isFinite(wireTokens) || wireTokens <= 0) {
        return input.usage;
    }
    const providerTokens = input.providerProvenInputTokens;
    const providerLimit = input.providerProvenLimitTokens;
    const canUseProviderMass =
        input.wireEstimateTrusted === false &&
        typeof providerTokens === "number" &&
        Number.isFinite(providerTokens) &&
        providerTokens > 0 &&
        typeof providerLimit === "number" &&
        Number.isFinite(providerLimit) &&
        providerLimit > 0;
    const tokens = canUseProviderMass ? Math.max(wireTokens, providerTokens) : wireTokens;
    const limit = input.usableHardLimit;
    const estimatedPercentage =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? (tokens / limit) * 100
            : input.usage.percentage;
    return {
        inputTokens: tokens,
        percentage: Math.max(input.usage.percentage, estimatedPercentage),
    };
}

export function loadContextUsage(
    contextUsageMap: Map<string, ContextUsageCacheEntry>,
    db: ContextDatabase,
    sessionId: string,
    passSnapshot?: ContextUsagePassSnapshot,
): ContextUsage {
    const contextUsageEntry = contextUsageMap.get(sessionId);
    // message.updated owns the live map entry and replaces it whenever provider
    // usage changes. That event is the cache's invalidation signal, so a live
    // token-bearing entry needs no validating SELECT on each transform pass.
    if (contextUsageEntry?.hasUsageTokens === true) return contextUsageEntry.usage;
    try {
        const persistedLastResponseTime =
            passSnapshot?.lastResponseTime ?? loadPersistedUsageWatermark(db, sessionId);
        const cachedLastResponseTime =
            contextUsageEntry?.lastResponseTime ?? contextUsageEntry?.updatedAt;
        if (
            contextUsageEntry &&
            contextUsageEntry.lastResponseTime === undefined &&
            (persistedLastResponseTime === null || persistedLastResponseTime === 0)
        ) {
            return contextUsageEntry.usage;
        }
        if (contextUsageEntry && cachedLastResponseTime === persistedLastResponseTime) {
            return contextUsageEntry.usage;
        }

        const persisted = passSnapshot
            ? passSnapshot.persistedUsage
            : loadPersistedUsage(db, sessionId);
        if (persisted) {
            contextUsageMap.set(sessionId, {
                ...persisted,
                lastResponseTime: persistedLastResponseTime ?? persisted.updatedAt,
                // last_response_time also advances on provider errors that carry no usage.
                // A persisted percentage therefore has no process-local freshness proof.
                hasUsageTokens: false,
            });
            return persisted.usage;
        }

        contextUsageMap.delete(sessionId);
    } catch (error) {
        sessionLog(sessionId, "transform failed loading persisted usage:", error);
        return contextUsageEntry?.usage ?? { percentage: 0, inputTokens: 0 };
    }
    return { percentage: 0, inputTokens: 0 };
}

export function resolveSchedulerDecision(
    scheduler: Scheduler,
    sessionMeta: SessionMeta,
    contextUsage: ContextUsage,
    sessionId: string,
    modelKey?: string,
    contextLimit?: number,
): "execute" | "defer" {
    try {
        const schedulerDecision = scheduler.shouldExecute(
            sessionMeta,
            contextUsage,
            undefined,
            sessionId,
            modelKey,
            contextLimit,
        );
        sessionLog(
            sessionId,
            `transform scheduler: percentage=${contextUsage.percentage.toFixed(1)}% inputTokens=${contextUsage.inputTokens} cacheTtl=${sessionMeta.cacheTtl} lastResponseTime=${sessionMeta.lastResponseTime} decision=${schedulerDecision}`,
        );
        return schedulerDecision;
    } catch (error) {
        sessionLog(sessionId, "transform scheduler failed; defaulting to defer:", error);
        return "defer";
    }
}
