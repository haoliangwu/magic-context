import type { MagicContextPluginConfig } from "../../config";
import {
    userObservationCollectionEnabled,
    userObservationsRequested,
} from "../../features/magic-context/dreamer/task-config";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    getAutoEmbeddingSessionCoverage,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/project-embedding-registry";
import { cavemanWordRulesForLanguage } from "../../hooks/magic-context/caveman";
import {
    type EmbedHistoryDeps,
    runEmbedHistoryDrain,
} from "../../hooks/magic-context/embed-history-runner";
import {
    autoEmbedAttemptedBySession,
    autoEmbedIdentityBySession,
    embedPauseBySession,
    invalidateAutoEmbedSession,
} from "../../hooks/magic-context/embed-session-state";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import { isEmbeddingHostBusy } from "../../shared/embedding-activity";
import { log } from "../../shared/logger";

/** Use the same boot-resolved feature controls as the OpenCode 1 transform. */
export function createV2TransformFeatureDeps(
    config: MagicContextPluginConfig,
    compactionOff: boolean,
    directory: string,
) {
    return {
        protectedTools: config.protected_tools,
        commitClusterTrigger: config.commit_cluster_trigger,
        allowHomeProject: config.allow_home_project,
        injectDocs: config.dreamer?.inject_docs !== false,
        memoryConfig: {
            enabled: config.memory.enabled,
            injectionBudgetTokens: config.memory.injection_budget_tokens,
            autoPromote: config.memory.auto_promote,
        },
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        historyBudgetPercentage: config.history_budget_percentage,
        experimentalUserMemories: userObservationCollectionEnabled(config.dreamer),
        userObservationsRequested: userObservationsRequested(config.dreamer),
        experimentalTemporalAwareness: config.temporal_awareness === true,
        muralEnabled: config.mural?.enabled === true,
        autoSearch: {
            enabled: config.memory.auto_search?.enabled ?? true,
            scoreThreshold: config.memory.auto_search?.score_threshold ?? 0.6,
            minPromptChars: config.memory.auto_search?.min_prompt_chars ?? 20,
            directory,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
            wordRules: cavemanWordRulesForLanguage(config.language),
        },
        cavemanTextCompression: compactionOff
            ? undefined
            : config.caveman_text_compression?.enabled === true
              ? {
                    enabled: true,
                    minChars: config.caveman_text_compression.min_chars ?? 500,
                    wordRules: cavemanWordRulesForLanguage(config.language),
                }
              : undefined,
    } satisfies Partial<TransformDeps>;
}

/** Silent active-session backfill, with the same identity/attempt/pause gates as OC1. */
export function createV2AutoEmbedSession(deps: EmbedHistoryDeps): (sessionId: string) => void {
    return (sessionId) => {
        if (isEmbeddingHostBusy()) return;
        const directory = deps.resolveDirectory(sessionId);
        const identity = resolveProjectIdentityForSession(directory, deps.allowHomeProject);
        const snapshot = identity ? getProjectEmbeddingSnapshot(identity) : undefined;
        const embedIdentity = snapshot
            ? JSON.stringify([
                  snapshot.providerIdentity,
                  snapshot.chunkModelId,
                  snapshot.runtimeFingerprint,
              ])
            : "off";
        if (autoEmbedIdentityBySession.get(sessionId) !== embedIdentity)
            invalidateAutoEmbedSession(sessionId);
        if (autoEmbedAttemptedBySession.has(sessionId) || embedPauseBySession.has(sessionId))
            return;
        autoEmbedAttemptedBySession.add(sessionId);
        autoEmbedIdentityBySession.set(sessionId, embedIdentity);
        void (async () => {
            try {
                // Registration can do synchronous DB work; yield before leaving the transform.
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (isEmbeddingHostBusy()) {
                    invalidateAutoEmbedSession(sessionId);
                    return;
                }
                await ensureProjectRegisteredFromOpenCodeDirectory(directory, deps.db);
                const project = resolveProjectIdentityForSession(directory, deps.allowHomeProject);
                if (!project) {
                    invalidateAutoEmbedSession(sessionId);
                    return;
                }
                const coverage = await getAutoEmbeddingSessionCoverage(deps.db, project, sessionId);
                if (!coverage.enabled) {
                    invalidateAutoEmbedSession(sessionId);
                    return;
                }
                if (coverage.total <= coverage.embedded) return;
                await runEmbedHistoryDrain(deps, sessionId, { silent: true });
            } catch (error) {
                log("[magic-context] auto-embed drain failed:", error);
            }
        })();
    };
}
