import { casChannel2NudgeState } from "../../features/magic-context/storage-meta-persisted";
import type { Database } from "../../shared/sqlite";
import { CHANNEL1_FLOOR_TOKENS, type Channel2PredicateBaseline } from "./ctx-reduce-nudge";
import { effectiveTailHygiene } from "./tail-hygiene-walk";

export function rearmChannel2AfterCoverageAdvancingHardFold(input: {
    db: Database;
    sessionId: string;
    foldExecuted: boolean;
    compactionOff: boolean;
    previousCoverage: number | null;
    currentCoverage: number | null;
}): boolean {
    if (
        input.compactionOff ||
        !input.foldExecuted ||
        input.previousCoverage === null ||
        input.currentCoverage === null ||
        input.currentCoverage <= input.previousCoverage
    ) {
        return false;
    }
    return casChannel2NudgeState(input.db, input.sessionId, "delivered", "");
}

export function rearmChannel2AfterMeasuredCollapse(input: {
    db: Database;
    sessionId: string;
    baseline: Channel2PredicateBaseline;
    rebuilding: boolean;
    previous?: Channel2PredicateBaseline;
}): boolean {
    // An unchanged replay below the reminder floor is not a new reduction. A real
    // queued drop can reduce actionable content and still rearm the reminder.
    if (
        !input.rebuilding &&
        (!input.previous ||
            effectiveTailHygiene(input.baseline).u >= effectiveTailHygiene(input.previous).u)
    )
        return false;
    if (!input.baseline.evaluable || input.baseline.generationInvalidated) return false;
    if (effectiveTailHygiene(input.baseline).u >= CHANNEL1_FLOOR_TOKENS) return false;
    return casChannel2NudgeState(input.db, input.sessionId, "delivered", "");
}
