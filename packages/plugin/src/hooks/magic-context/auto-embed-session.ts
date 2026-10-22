import {
    embedSessionCompartmentChunks,
    getAutoEmbeddingSessionCoverage,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/project-embedding-registry";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    activeEmbeddingSessions,
    autoEmbedAttemptedBySession,
    autoEmbedIdentityBySession,
    autoEmbedRetryAfterBySession,
    embedPauseBySession,
    embedRunStateBySession,
    invalidateAutoEmbedSession,
} from "./embed-session-state";

interface AutoEmbedSessionDeps {
    db: Database;
    projectIdentity: string;
    ensureRegistered: () => Promise<unknown>;
}

function embeddingIdentity(projectIdentity: string): string {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    return JSON.stringify([
        projectIdentity,
        snapshot?.providerIdentity,
        snapshot?.chunkModelId,
        snapshot?.runtimeFingerprint,
    ]);
}

/** Only active context passes request background history embedding; inactive sessions do not start it. */
export function maybeAutoEmbedSessionBackfill(deps: AutoEmbedSessionDeps, sessionId: string): void {
    const markActive = () =>
        activeEmbeddingSessions.set(sessionId, {
            project: deps.projectIdentity,
            model: getProjectEmbeddingSnapshot(deps.projectIdentity)?.chunkModelId ?? "off",
        });
    markActive();
    const identity = embeddingIdentity(deps.projectIdentity);
    if (autoEmbedIdentityBySession.get(sessionId) !== identity) {
        invalidateAutoEmbedSession(sessionId);
        autoEmbedIdentityBySession.set(sessionId, identity);
    }
    if (
        autoEmbedAttemptedBySession.has(sessionId) ||
        embedPauseBySession.has(sessionId) ||
        embedRunStateBySession.has(sessionId) ||
        Date.now() < (autoEmbedRetryAfterBySession.get(sessionId) ?? 0)
    )
        return;

    // Claim before yielding so repeated passes cannot queue duplicate scans.
    const controller = new AbortController();
    embedRunStateBySession.set(sessionId, controller);
    void (async () => {
        let complete = false;
        let retryDelay = 1_000;
        let started = false;
        let reason = "error";
        let registeredIdentity = identity;
        try {
            // Registration reads config synchronously; defer it off the context-transform return path.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (controller.signal.aborted) return;
            await deps.ensureRegistered();
            if (controller.signal.aborted) return;
            markActive();
            registeredIdentity = embeddingIdentity(deps.projectIdentity);
            autoEmbedIdentityBySession.set(sessionId, registeredIdentity);
            const coverage = await getAutoEmbeddingSessionCoverage(
                deps.db,
                deps.projectIdentity,
                sessionId,
            );
            if (controller.signal.aborted || !coverage.enabled) return;
            if (coverage.embedded === coverage.total) {
                complete = true;
                return;
            }
            const model = getProjectEmbeddingSnapshot(deps.projectIdentity)?.model;
            log(
                `[magic-context] session backfill start session=${sessionId} missing=${coverage.total - coverage.embedded} model=${model}`,
            );
            started = true;
            const outcome = await embedSessionCompartmentChunks(
                deps.db,
                deps.projectIdentity,
                sessionId,
                { signal: controller.signal, automatic: true },
            );
            reason = outcome.status;
            // A zero-candidate result can mean persisted backoff, not full coverage.
            // Only actual coverage may latch completion; lease contention, busy
            // interruptions and provider circuit breaks must remain retryable.
            const after = await getAutoEmbeddingSessionCoverage(
                deps.db,
                deps.projectIdentity,
                sessionId,
            );
            complete = after.enabled && after.embedded === after.total;
            if (!complete && outcome.status !== "busy" && outcome.status !== "aborted") {
                retryDelay = 60_000;
                if (outcome.status === "nothing" || outcome.status === "done") reason = "deferred";
            }
        } catch (error) {
            log("[magic-context] auto-embed drain failed:", error);
            retryDelay = 60_000;
        } finally {
            if (started)
                log(
                    `[magic-context] session backfill ${complete ? "complete" : "stop"} session=${sessionId} reason=${reason}`,
                );
            if (embedRunStateBySession.get(sessionId) === controller) {
                embedRunStateBySession.delete(sessionId);
            }
            if (
                !controller.signal.aborted &&
                autoEmbedIdentityBySession.get(sessionId) === registeredIdentity &&
                embeddingIdentity(deps.projectIdentity) === registeredIdentity
            ) {
                if (complete) autoEmbedAttemptedBySession.add(sessionId);
                else autoEmbedRetryAfterBySession.set(sessionId, Date.now() + retryDelay);
            }
        }
    })();
}
