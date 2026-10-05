import type { RecompProgress } from "./compartment-runner-types";

/** Per-session user pause for embedding drain (in-memory only). */
export const embedPauseBySession = new Set<string>();

/** AbortController for the active embed drain per session. */
export const embedRunStateBySession = new Map<string, AbortController>();

/** Completed auto-drains, plus temporary in-flight claims, per session and process. */
export const autoEmbedAttemptedBySession = new Set<string>();
/** Identity of the provider contract used by the last auto-drain attempt. */
export const autoEmbedIdentityBySession = new Map<string, string>();

export function invalidateAutoEmbedSession(sessionId: string): void {
    autoEmbedAttemptedBySession.delete(sessionId);
    autoEmbedIdentityBySession.delete(sessionId);
}

export type EmbedDrainUiStatus = "idle" | "running" | "paused" | "stopped";

export function getEmbedDrainUiStatus(
    sessionId: string,
    progress: Pick<RecompProgress, "kind" | "phase" | "message"> | undefined,
): { status: EmbedDrainUiStatus; detail?: string } {
    if (embedPauseBySession.has(sessionId)) {
        return { status: "paused" };
    }
    const activeRun = embedRunStateBySession.get(sessionId);
    if (
        (activeRun && !activeRun.signal.aborted) ||
        (progress?.kind === "embed" && progress.phase === "recomp")
    ) {
        return { status: "running" };
    }
    if (
        progress?.kind === "embed" &&
        (progress.phase === "failed" || progress.phase === "skipped") &&
        progress.message
    ) {
        if (/provider/i.test(progress.message)) {
            return { status: "stopped", detail: progress.message };
        }
    }
    return { status: "idle" };
}

export function clearEmbedSessionState(sessionId: string): void {
    embedPauseBySession.delete(sessionId);
    const ctrl = embedRunStateBySession.get(sessionId);
    if (ctrl) {
        ctrl.abort();
        embedRunStateBySession.delete(sessionId);
    }
    invalidateAutoEmbedSession(sessionId);
}
