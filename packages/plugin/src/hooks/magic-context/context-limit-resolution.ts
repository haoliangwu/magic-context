import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";

/**
 * The proven input floor stored for a session applies only to the model whose
 * accepted request proved it. The session row keeps one floor and the model key
 * it was recorded for; a different model (or a row with no recorded key) has no
 * floor until one of its own requests is accepted.
 */
export function provenFloorForModel(
    storedFloor: number | null | undefined,
    storedModelKey: string | null | undefined,
    modelKey: string | undefined,
): number {
    if (typeof storedFloor !== "number" || !Number.isFinite(storedFloor) || storedFloor <= 0) {
        return 0;
    }
    if (!storedModelKey || !modelKey) return 0;
    return piModelRefToCanonical(storedModelKey) === piModelRefToCanonical(modelKey)
        ? storedFloor
        : 0;
}

/** Everything a usage event's context limit is resolved from, plus the result. */
export interface ContextLimitResolution {
    modelKey: string | null;
    limit: number;
    /** Output-reserved usable window from OpenCode's model catalog, if known. */
    catalog: number | null;
    /** Limit learned from a provider overflow error for this model; 0 when none. */
    detected: number;
    /** Largest accepted input proven for this model; 0 when none. */
    provenFloor: number;
}

/**
 * Name the inputs that differ between two resolutions of one session's limit.
 * Returns null when the limit did not change. A changed limit with no changed
 * input is reported as such, because that is the drift this exists to expose.
 */
export function describeContextLimitChange(
    previous: ContextLimitResolution,
    next: ContextLimitResolution,
): string | null {
    if (previous.limit === next.limit && previous.modelKey === next.modelKey) return null;
    const reasons: string[] = [];
    if (previous.modelKey !== next.modelKey) {
        reasons.push(`model ${previous.modelKey ?? "unknown"} → ${next.modelKey ?? "unknown"}`);
    }
    if (previous.catalog !== next.catalog) {
        reasons.push(`catalog ${previous.catalog ?? "unknown"} → ${next.catalog ?? "unknown"}`);
    }
    if (previous.detected !== next.detected) {
        reasons.push(`overflow-detected limit ${previous.detected} → ${next.detected}`);
    }
    if (previous.provenFloor !== next.provenFloor) {
        reasons.push(`proven accepted input ${previous.provenFloor} → ${next.provenFloor}`);
    }
    return `context limit ${previous.limit} → ${next.limit} (${
        reasons.length > 0 ? reasons.join("; ") : "no input changed"
    })`;
}

const lastResolutionBySession = new BoundedSessionMap<ContextLimitResolution>(200);

/**
 * Record this event's resolution and log once when the limit or model changes,
 * naming the inputs that moved. Steady readings log nothing.
 */
export function noteContextLimitResolution(
    sessionId: string,
    resolution: ContextLimitResolution,
): void {
    const previous = lastResolutionBySession.get(sessionId);
    lastResolutionBySession.set(sessionId, resolution);
    if (!previous) {
        sessionLog(
            sessionId,
            `context limit resolved: ${resolution.limit} for ${resolution.modelKey ?? "unknown model"} (catalog ${resolution.catalog ?? "unknown"}, overflow-detected ${resolution.detected}, proven accepted input ${resolution.provenFloor})`,
        );
        return;
    }
    const change = describeContextLimitChange(previous, resolution);
    if (change) sessionLog(sessionId, change);
}

export function resetContextLimitResolutionForTest(): void {
    lastResolutionBySession.clear();
}
