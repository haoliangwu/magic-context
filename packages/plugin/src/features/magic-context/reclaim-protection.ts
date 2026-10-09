import {
    type DecisionCalibration,
    hasMeasuredDecisionCalibration,
    providerMass,
} from "../../hooks/magic-context/decision-calibration";
import {
    DEFAULT_PROTECTED_TOOLS,
    mergeProtectedTools,
    normalizeProtectedToolName,
} from "../../shared/protected-tools-policy";
import type { TagEntry } from "./types";

export {
    DEFAULT_PROTECTED_TOOLS,
    mergeProtectedTools,
    normalizeProtectedToolName,
} from "../../shared/protected-tools-policy";
/** Default ctx_reduce keep count, exposed so fixtures can use the shipped policy. */
export const CTX_REDUCE_KEEP = DEFAULT_PROTECTED_TOOLS.ctx_reduce;

/** Use saved keep counts until a rebuilding pass measures a new baseline; newer
 * calls still rotate through each count by tag order. */
export function adoptedProtectedToolsPolicy(
    current: Readonly<Record<string, number>> | undefined,
    previous: Readonly<Record<string, number>> | undefined,
    rebuilding: boolean,
    hasBaseline: boolean,
): Record<string, number> {
    if (rebuilding || !hasBaseline) return mergeProtectedTools(current);
    // Legacy baselines did not protect todowrite results and kept three ctx_reduce results.
    return { ...(previous ?? { todowrite: 0, ctx_reduce: 3 }) };
}

/** Snapshot once per selection, before any lane mutates status. Inactive results
 * never occupy the window, and tag ordinals make rotation deterministic. */
export function protectedToolTagNumbers(
    tags: readonly { tagNumber: number; toolName: string | null; status?: string; type?: string }[],
    protectedTools?: Readonly<Record<string, number>>,
): Set<number> {
    const counts = mergeProtectedTools(protectedTools);
    const protectedTags = new Set<number>();
    for (const tag of [...tags].sort((left, right) => right.tagNumber - left.tagNumber)) {
        if (tag.status !== undefined && tag.status !== "active") continue;
        if (tag.type !== undefined && tag.type !== "tool") continue;
        const name = normalizeProtectedToolName(tag.toolName);
        if (!Object.hasOwn(counts, name) || counts[name] <= 0) continue;
        protectedTags.add(tag.tagNumber);
        counts[name] -= 1;
    }
    return protectedTags;
}
export function protectedToolTokenCount(
    tags: readonly TagEntry[],
    counts?: Readonly<Record<string, number>>,
    calibration?: DecisionCalibration,
): number {
    const protectedTags = protectedToolTagNumbers(tags, counts);
    const tokens = tags.reduce(
        (sum, tag) => sum + (protectedTags.has(tag.tagNumber) ? (tag.tokenCount ?? 0) : 0),
        0,
    );
    // Admission decides whether a request can be sent; this subset can justify a
    // refusal only with measured calibration proving protected results alone do not fit.
    return calibration && hasMeasuredDecisionCalibration(calibration)
        ? providerMass({ tools: tokens }, calibration)
        : 0;
}
