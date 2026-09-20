import { escalationBands } from "../../shared/escalation-bands";

export interface DeferredConsumptionArgs {
    schedulerDecision: "execute" | "defer";
    contextPercentage: number;
    /** True when this pass awaited a run that actually published new compartment state. */
    justAwaitedPublication: boolean;
    /** Legacy caller observation; published-work consumption does not depend on it. */
    activeRunBlocksMaterialization: boolean;
    forceMaterializationPercentage?: number;
}

export function canConsumeDeferredOnThisPass(args: DeferredConsumptionArgs): boolean {
    if (args.justAwaitedPublication) return true;
    // Published rows are immutable input to rendering. The historian reads raw
    // harness history, so an in-flight run cannot veto draining published work.

    return (
        args.schedulerDecision === "execute" ||
        args.contextPercentage >=
            (args.forceMaterializationPercentage ??
                escalationBands(65).forceMaterializationPercentage)
    );
}

export interface MaterializationPassSignals {
    /** True when this transform pass successfully wrote fresh cached m[0] bytes. */
    m0RematerializedThisPass: boolean;
    /** True when retry exhaustion forced fallback to a previous cached m[0]. */
    materializationContentionRetryExhausted: boolean;
    /** True when postprocess observed newer m0_mutation_log ids than cached m[0]. */
    m0MutationDriftDetected: boolean;
}

/** Automatic reductions ride independently priced work, never pressure alone. */
export function hasReclaimRide(signals: {
    hardFold: boolean;
    force: boolean;
    explicitFlush: boolean;
    publishedHistory: boolean;
}): boolean {
    return signals.hardFold || signals.force || signals.explicitFlush || signals.publishedHistory;
}
