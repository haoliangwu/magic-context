export type CacheBustDivergenceClass =
    | "no_mc_pass_row"
    | "system_row_shift"
    | "accounted_hard_model_change"
    | "accounted_hard_system_hash"
    | "accounted_hard_epoch"
    | "accounted_hard_pressure_refold"
    | "accounted_hard_marker_drain"
    | "accounted_hard_fold"
    | "accounted_execute_published_history"
    | "accounted_soft_m1_execute"
    | "accounted_ctx_reduce"
    | "accounted_ctx_flush"
    | "accounted_force_band"
    | "accounted_drop_applied"
    | "accounted_provider_system_prompt_change"
    | "usage_missing"
    | "provider_full_miss"
    | "provider_short_read_identical_bytes"
    | "self_inflicted_epoch"
    | "unfaulted_epoch"
    | "unaccounted_defer_pass"
    | "unaccounted_double_bust"
    | "unaccounted_tail_rewrite"
    | "unaccounted_rewrite";

export interface AnalyzedCacheRequest {
    session: string;
    at: string;
    timestampMs: number;
    verdict: "BASE" | "BUST" | "STABLE" | "LATENCY" | "UNMETERED";
    rewrittenTokens?: number;
    divergenceClass?: CacheBustDivergenceClass;
    firstDivergence: string;
    analyzerCmd: string;
    /** Render-identity components the matched pass reported as changed, when it logged them. */
    identityDelta?: string[];
}

export interface CacheBustSessionAnalysis {
    requests: AnalyzedCacheRequest[];
    highWaterMarkMs: number | null;
    directory?: string;
}

export interface CacheBustDecisionAttribution {
    timestampMs: number;
    requestObservedAtMs?: number;
    messageId?: string;
    decision: string;
    canonicalDecision?: string;
    deferReason?: string | null;
    /**
     * The reclaim ride the pass logged when it applied queued work, for example
     * "publishedHistory". Names why the pass was allowed to mutate, which the
     * scheduler decision alone does not say.
     */
    appliedRide?: string;
    materialized: boolean;
    materializeReason: string | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    /** Raw OpenCode message count observed by the Rust pass, when logged. */
    inputCount?: number;
    /** A restart, deploy, or explicit configuration epoch independently explains epoch_change. */
    externalEpoch?: boolean;
    /** Names the render-identity components changed during transformation. The `mur` entry
     * represents mural content; other entries show that an independent identity also changed. */
    identityDelta?: string[];
    flush: boolean;
    source: string;
    /**
     * Set on log markers that are not passes: a module fault, a full-array retry, a
     * fallback serve, or an adapter restart. Names the kind. Such records never
     * join a request; they only explain an epoch HARD that follows them.
     */
    disruption?: string;
}

export interface CacheBustAttributionInput {
    divergenceIndex: number;
    previousMessageCount: number;
    previousBustDivergenceIndex?: number;
    previousProvider?: string;
    currentProvider?: string;
    firstDivergenceRole?: string;
    firstDivergenceSize?: number;
    rewrittenTokens?: number;
    cacheCreationTokens?: number;
    promptTokens?: number;
    contentEvidence?: string;
    compactionSeam?: boolean;
    inheritedFold?: boolean;
    /** Provider cache-read component, excluding Anthropic direct input tokens. */
    providerComparableRead?: number;
    /** Direct/uncached input component of the current request. */
    directInput?: number;
    /** Total provider meter on the preceding request. */
    previousTotal?: number;
    previousModel?: string;
    currentModel?: string;
    /** The meter read short while the reusable byte prefix was unchanged. */
    providerShortReadWithIdenticalPrefix?: boolean;
    /** Current raw OpenCode message count divided by the preceding pass count. */
    ocInputStepRatio?: number;
    decision?: CacheBustDecisionAttribution;
    /** The last session pass that rebuilt the cached prefix after its rendering identity changed. */
    previousEpochHard?: CacheBustDecisionAttribution;
    /**
     * The newest disruption in the 60 s before the matched pass. `undefined` means the
     * disruption markers were not available (no adapter log for the session); `null`
     * means the log was read and nothing disrupted the session in that window.
     */
    precedingDisruption?: string | null;
}

export interface CacheBustRule {
    divergenceClass: CacheBustDivergenceClass;
    accounted: boolean;
    rule: string;
}

export const CACHE_BUST_RULE_TABLE: readonly CacheBustRule[] = [
    {
        divergenceClass: "system_row_shift",
        accounted: true,
        rule: "message[0]/system divergence rewrites less than 5% of the prompt",
    },
    {
        divergenceClass: "no_mc_pass_row",
        accounted: false,
        rule: "no MC pass record in [request - 30 s, request + 5 s]",
    },
    {
        divergenceClass: "accounted_ctx_flush",
        accounted: true,
        rule: "matched pass records an explicit /ctx-flush",
    },
    {
        divergenceClass: "accounted_force_band",
        accounted: true,
        rule: "matched pass records a forced emergency drop batch",
    },
    {
        divergenceClass: "accounted_hard_marker_drain",
        accounted: true,
        rule: "matched HARD/m0 pass records marker_drain or a compaction-marker seam",
    },
    {
        divergenceClass: "accounted_hard_model_change",
        accounted: true,
        rule: "matched HARD/m0 pass records materialize_reason=model_change",
    },
    {
        divergenceClass: "accounted_hard_system_hash",
        accounted: true,
        rule: "matched HARD/m0 pass records system_hash, or a large system-prompt replacement",
    },
    {
        divergenceClass: "accounted_hard_epoch",
        accounted: true,
        rule: "matched HARD/m0 pass records a project, render, or session epoch change",
    },
    {
        divergenceClass: "accounted_hard_pressure_refold",
        accounted: true,
        rule: "matched HARD/m0 pass records materialize_reason=pressure_refold",
    },
    {
        divergenceClass: "accounted_hard_fold",
        accounted: true,
        rule: "matched pass records another materialized HARD/m0 fold; tiny mid-history defer/first_render seams are excluded",
    },
    {
        divergenceClass: "accounted_ctx_reduce",
        accounted: true,
        rule: "matched pass applies drops at an agent ctx_reduce landing",
    },
    {
        divergenceClass: "accounted_drop_applied",
        accounted: true,
        rule: "matched pass records applied drops",
    },
    {
        divergenceClass: "accounted_execute_published_history",
        accounted: true,
        rule: "matched execute pass drained queued work on a publishedHistory reclaim ride",
    },
    {
        divergenceClass: "accounted_soft_m1_execute",
        accounted: true,
        rule: "matched canonical execute pass refreshes m1",
    },
    {
        divergenceClass: "usage_missing",
        accounted: true,
        rule: "provider cache read and direct input are both 0 or usage is absent; the pass is in flight/unmetered and never becomes a bust baseline",
    },
    {
        divergenceClass: "provider_full_miss",
        accounted: true,
        rule: "provider cache read is exactly 0 with prevTotal ≥ 10,000; ordinary short reads stay unaccounted; show wire model prev → cur when it changes",
    },
    {
        divergenceClass: "provider_short_read_identical_bytes",
        accounted: true,
        rule: "provider read fell short while the reusable byte prefix was unchanged; provider-side latency or eviction, not a prompt rewrite",
    },
    {
        divergenceClass: "self_inflicted_epoch",
        accounted: false,
        rule: "epoch_change has no restart/deploy/config epoch and either only mur: changed or raw OpenCode input stepped by at least 4×",
    },
    {
        divergenceClass: "unfaulted_epoch",
        accounted: false,
        rule: "epoch_change has no restart/deploy/config epoch and the adapter log shows no module fault, full-array retry, fallback serve, or adapter restart in the preceding 60 s; the wake names identity_delta",
    },
    {
        divergenceClass: "unaccounted_defer_pass",
        accounted: false,
        rule: "matched canonical defer pass, including a tiny mid-history first_render seam, diverges",
    },
    {
        divergenceClass: "accounted_provider_system_prompt_change",
        accounted: true,
        rule: "matched non-defer pass has a user-visible provider change",
    },
    {
        divergenceClass: "unaccounted_double_bust",
        accounted: false,
        rule: "matched otherwise-unattributed pass repeats the previous divergence offset",
    },
    {
        divergenceClass: "unaccounted_tail_rewrite",
        accounted: false,
        rule: "matched otherwise-unattributed pass rewrites the previous request tail",
    },
    {
        divergenceClass: "unaccounted_rewrite",
        accounted: false,
        rule: "matched pass has no accounted attribution",
    },
] as const;

const ACCOUNTED_CLASSES = new Set(
    CACHE_BUST_RULE_TABLE.filter((row) => row.accounted).map((row) => row.divergenceClass),
);
const EPOCH_REASONS = new Set(["project_memory_epoch", "epoch_change", "compartment_render_epoch"]);

export function isUnaccountedCacheBustClass(divergenceClass: string): boolean {
    return !ACCOUNTED_CLASSES.has(divergenceClass as CacheBustDivergenceClass);
}

export function nearestCacheBustDecision(
    decisions: readonly CacheBustDecisionAttribution[],
    requestTimestampMs: number,
    messageId?: string,
): CacheBustDecisionAttribution | undefined {
    const timeDelta = (decision: CacheBustDecisionAttribution): number =>
        (decision.requestObservedAtMs ?? decision.timestampMs) - requestTimestampMs;
    const withinJoinWindow = (decision: CacheBustDecisionAttribution): boolean => {
        const delta = timeDelta(decision);
        return delta >= -30_000 && delta <= 5_000;
    };
    // A transform pass runs before the request it shapes is put on the wire, so
    // the pass that SERVED a request is the latest one at or before it. Ranking
    // purely by absolute distance let a later pass — the one preparing the NEXT
    // request — win whenever it happened to be closer in time: a request sent 9 s
    // after its execute pass, with the next turn's defer pass 4 s after it, was
    // attributed to that defer and reported as an unaccounted defer bust.
    const byServeOrder = (
        left: CacheBustDecisionAttribution,
        right: CacheBustDecisionAttribution,
    ): number => {
        const leftDelta = timeDelta(left);
        const rightDelta = timeDelta(right);
        const leftServed = leftDelta <= 0;
        const rightServed = rightDelta <= 0;
        if (leftServed !== rightServed) return leftServed ? -1 : 1;
        return Math.abs(leftDelta) - Math.abs(rightDelta);
    };
    const exact = messageId
        ? decisions
              .filter((decision) => decision.messageId === messageId && withinJoinWindow(decision))
              .sort(byServeOrder)[0]
        : undefined;
    if (exact) return exact;
    return decisions.filter(withinJoinWindow).sort(byServeOrder)[0];
}

export function classifyCacheBust(input: CacheBustAttributionInput): CacheBustDivergenceClass {
    // No transform pass can explain a short provider read when the reusable bytes
    // are unchanged, so this case is settled before joining any pass row.
    if (input.providerShortReadWithIdenticalPrefix) return "provider_short_read_identical_bytes";
    const isSystemRow = input.divergenceIndex === 0 && input.firstDivergenceRole === "system";
    const rewrittenRatio =
        input.rewrittenTokens !== undefined && input.promptTokens && input.promptTokens > 0
            ? input.rewrittenTokens / input.promptTokens
            : Number.POSITIVE_INFINITY;
    const creationRatio =
        input.cacheCreationTokens !== undefined && input.promptTokens && input.promptTokens > 0
            ? input.cacheCreationTokens / input.promptTokens
            : 0;
    if (isSystemRow && rewrittenRatio < 0.05 && creationRatio < 0.05) return "system_row_shift";

    // Provider-side signals are read before the pass-row join: a request whose
    // provider read is exactly zero is a cold miss on their side (a wire model
    // swap, an expired prefix, a billing-header rotation) whatever MC did or did
    // not record for it. Classifying it "no_mc_pass_row" made the sentinel wake
    // the operator for a rotation of the auth plugin's billing header on a
    // subagent session with no decision row (2026-09-21).
    const previousTotal = input.previousTotal ?? input.promptTokens;
    const usageMissing = input.providerComparableRead === 0 && input.directInput === 0;
    const providerFullMiss =
        input.providerComparableRead === 0 &&
        previousTotal !== undefined &&
        previousTotal >= 10_000;

    const decision = input.decision;
    if (!decision) {
        if (usageMissing) return "usage_missing";
        if (providerFullMiss) return "provider_full_miss";
        return "no_mc_pass_row";
    }

    const canonicalDecision = (decision.canonicalDecision ?? decision.decision).toLowerCase();
    const materializeReason = decision.materializeReason?.toLowerCase() ?? null;
    const isTinyFirstRenderDefer =
        materializeReason === "first_render" &&
        canonicalDecision === "defer" &&
        !input.inheritedFold &&
        input.firstDivergenceSize !== undefined &&
        input.firstDivergenceSize <= 256 &&
        input.divergenceIndex < Math.max(0, input.previousMessageCount - 2);
    if (decision.flush || materializeReason === "explicit_flush") return "accounted_ctx_flush";
    if (decision.emergency && decision.droppedCount > 0) return "accounted_force_band";
    if (isTinyFirstRenderDefer && (usageMissing || providerFullMiss)) {
        return usageMissing ? "usage_missing" : "provider_full_miss";
    }
    if (isTinyFirstRenderDefer) return "unaccounted_defer_pass";
    // A scheduler-only defer does not show that a compaction actually ran. Nearby
    // old marker text or a changed billing header cannot prove that mutation.
    if (decision.source === "transform scheduler log" && canonicalDecision === "defer") {
        if (usageMissing) return "usage_missing";
        if (providerFullMiss) return "provider_full_miss";
        return "unaccounted_defer_pass";
    }
    // A pass that logged its reclaim ride states outright why it was allowed to
    // mutate, so it outranks the compaction-marker seam below, which only infers
    // a cause from nearby content. A fold the pass explicitly recorded, and the
    // provider-side zero-read facts, still win over it.
    if (
        !decision.materialized &&
        !usageMissing &&
        !providerFullMiss &&
        canonicalDecision === "execute" &&
        (decision.appliedRide ?? "").includes("publishedHistory")
    ) {
        return "accounted_execute_published_history";
    }
    if (
        materializeReason === "marker_drain" ||
        input.compactionSeam ||
        (input.contentEvidence ?? "").includes("[Compacted by magic-context")
    ) {
        return "accounted_hard_marker_drain";
    }
    if (usageMissing) return "usage_missing";
    if (decision.materialized) {
        if (materializeReason === "model_change") return "accounted_hard_model_change";
        if (materializeReason === "system_hash") return "accounted_hard_system_hash";
        const muralOnlyIdentityDelta =
            decision.identityDelta?.length === 1 && decision.identityDelta[0] === "mur";
        const repeatedEpochHard = input.previousEpochHard !== undefined &&
            input.previousEpochHard.materialized &&
            input.previousEpochHard.materializeReason?.toLowerCase() === "epoch_change" &&
            !input.previousEpochHard.externalEpoch &&
            decision.timestampMs > input.previousEpochHard.timestampMs &&
            decision.timestampMs - input.previousEpochHard.timestampMs <= 60_000;
        if (
            materializeReason === "epoch_change" &&
            !decision.externalEpoch &&
            (repeatedEpochHard || muralOnlyIdentityDelta || (input.ocInputStepRatio ?? 0) >= 4)
        ) {
            return "self_inflicted_epoch";
        }
        // A render identity that changes with nothing around it to explain the change
        // (no fault, retry, fallback, or restart) is the spontaneous case; the wake
        // carries identity_delta so it names the component that moved.
        if (
            materializeReason === "epoch_change" &&
            !decision.externalEpoch &&
            input.precedingDisruption === null
        ) {
            return "unfaulted_epoch";
        }
        if (materializeReason && EPOCH_REASONS.has(materializeReason)) {
            return "accounted_hard_epoch";
        }
        if (materializeReason === "pressure_refold") {
            return "accounted_hard_pressure_refold";
        }
        return "accounted_hard_fold";
    }

    if (decision.droppedCount > 0 || decision.droppedTokens > 0) {
        return /\bctx_reduce\b/.test(input.contentEvidence ?? "")
            ? "accounted_ctx_reduce"
            : "accounted_drop_applied";
    }
    if (canonicalDecision === "execute") return "accounted_soft_m1_execute";
    if (isSystemRow) return "accounted_hard_system_hash";
    if (usageMissing) return "usage_missing";
    if (providerFullMiss) return "provider_full_miss";
    if (canonicalDecision === "defer") return "unaccounted_defer_pass";
    if (
        input.previousProvider &&
        input.currentProvider &&
        input.previousProvider !== input.currentProvider
    ) {
        return "accounted_provider_system_prompt_change";
    }
    if (
        input.previousBustDivergenceIndex !== undefined &&
        input.previousBustDivergenceIndex === input.divergenceIndex
    ) {
        return "unaccounted_double_bust";
    }
    if (input.divergenceIndex >= Math.max(0, input.previousMessageCount - 2)) {
        return "unaccounted_tail_rewrite";
    }
    return "unaccounted_rewrite";
}
