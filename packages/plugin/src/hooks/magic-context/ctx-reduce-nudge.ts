import { estimateTokens } from "./read-session-formatting";
import { byteSize } from "./tag-content-primitives";
import {
    stripChannel1ReminderSpans,
    type TailHygieneBaseline,
    type TailHygienePartMeasurement,
} from "./tail-hygiene-walk";

export type Channel1Level = "gentle" | "firm" | "urgent";

export interface ToolReclaimHint {
    tagNumber: number;
    toolName: string | null;
}

export interface Channel1State extends TailHygieneBaseline {
    usableWindow: number;
    /** Monotonic count of real (not Magic Context-injected) user turns in this pass. */
    realUserTurnCount: number;
    reducedSinceRefresh: boolean;
    /** Do not trigger a reduction nudge on the pass that applied queued agent drops. */
    agentDropsAppliedThisPass?: boolean;
    oldestReclaimableToolTags: ToolReclaimHint[];
}

export const CHANNEL1_SENTINEL = "<system-reminder>";
export const TOKENS_PER_BYTE = 0.25;
export const CHANNEL1_MIN_TOKENS = 60_000;
export const CHANNEL1_FLOOR_TOKENS = 25_000;
export const CHANNEL1_REFIRE_FLOOR_TOKENS = 25_000;
const S_GENTLE = 0.2;
const S_FIRM = 0.4;
const S_URGENT = 0.6;
export const CHANNEL2_SEVERITY_THRESHOLD = 0.75;
export const CHANNEL2_FLOOR_TOKENS = 50_000;
const LEVEL_RANK: Record<Channel1Level, number> = { gentle: 1, firm: 2, urgent: 3 };
const DROP_SENTINELS = ["[dropped", "[truncated"];

export function channel1RefireTokens(tailTokens: number): number {
    const scaled = Math.round(0.08 * Math.max(0, tailTokens));
    return Math.max(CHANNEL1_REFIRE_FLOOR_TOKENS, scaled);
}

export function isDroppedToolOutput(output: string): boolean {
    const head = output
        .trimStart()
        .replace(/^§\d+§\s*/, "")
        .slice(0, 16)
        .toLowerCase();
    return DROP_SENTINELS.some((sentinel) => head.startsWith(sentinel));
}

export function tailToolTokensFromStrings(outputs: readonly string[]): number {
    let bytes = 0;
    for (const output of outputs) {
        if (isDroppedToolOutput(output)) continue;
        bytes += byteSize(stripChannel1ReminderSpans(output));
    }
    return Math.round(bytes * TOKENS_PER_BYTE);
}

export function toolOutputTokens(output: string): number {
    return estimateTokens(stripChannel1ReminderSpans(output));
}

export interface TailTokenEstimate {
    tailToolTokens: number;
    liveTailTokens: number;
}

export type NudgeBand = "quiet" | "gentle" | "firm" | "urgent" | "channel2";

function channel1Band(undroppedTokens: number, tailTokens: number): Exclude<NudgeBand, "channel2"> {
    if (tailTokens < CHANNEL1_MIN_TOKENS || undroppedTokens < CHANNEL1_FLOOR_TOKENS) {
        return "quiet";
    }
    const severity = Math.min(1, Math.max(0, undroppedTokens / Math.max(tailTokens, 1)));
    if (severity >= S_URGENT) return "urgent";
    if (severity >= S_FIRM) return "firm";
    if (severity >= S_GENTLE) return "gentle";
    return "quiet";
}

export function nudgeBand(undroppedTokens: number, tailTokens: number): NudgeBand {
    const base = channel1Band(undroppedTokens, tailTokens);
    const severity = Math.min(1, Math.max(0, undroppedTokens / Math.max(tailTokens, 1)));
    return base === "urgent" &&
        undroppedTokens >= CHANNEL2_FLOOR_TOKENS &&
        severity >= CHANNEL2_SEVERITY_THRESHOLD
        ? "channel2"
        : base;
}

export type Channel1DampeningState =
    | "none"
    | "baseline-hold"
    | "post-reduce-grace"
    | "band-hysteresis"
    | "cadence"
    | "sticky-floor";

export type Channel1VerdictReason =
    | "baseline-unevaluable"
    | "recent-reduce-refresh"
    | "agent-drops-applied"
    | "post-reduce-baseline-pending"
    | "post-reduce-compliance-grace"
    | "tail-below-minimum"
    | "reclaimable-below-floor"
    | "ratio-below-gentle"
    | "band-deescalation"
    | "cadence-growth"
    | "sticky-turn-floor"
    | "band-crossing"
    | "cadence-refire"
    | "post-reduce-regrowth-reached"
    | "post-reduce-band-escalation";

export interface Channel1Decision {
    fire: boolean;
    /** Re-fires inside an already-observed band always use the calm one-line copy. */
    sticky: boolean;
    level: Channel1Level;
    band: Exclude<NudgeBand, "channel2">;
    undroppedTokens: number;
    tailTokens: number;
    severity: number;
    graceBaselineU: number | null;
    graceGrowth: number;
    growthThreshold: number;
    cadenceGrowth: number;
    stickyTurnsRemaining: number;
    dampeningState: Channel1DampeningState;
    verdictReason: Channel1VerdictReason;
    nextLastNudge: number;
    /** The currently observed band, not merely the last band that emitted copy. */
    nextLastNudgeLevel: Channel1Level | "";
    /** True once post-reduce grace has ended and its durable fields should be cleared. */
    clearPostReduceGrace: boolean;
}

export function decideChannel1(input: {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    lastNudgeUndropped: number;
    lastNudgeLevel: Channel1Level | "";
    lastFireOrdinal?: number;
    currentRealUserTurnCount?: number;
    hasRecentReduce: boolean;
    agentDropsAppliedThisPass?: boolean;
    postReduceGracePending?: boolean;
    postReduceGraceBaselineU?: number;
    postReduceGracePreLevel?: Channel1Level | "";
    evaluable?: boolean;
    generationInvalidated?: boolean;
}): Channel1Decision {
    const tailTokens = Math.max(0, input.baselineT + input.turnDeltaT);
    const undroppedTokens = Math.min(tailTokens, Math.max(0, input.baselineU + input.turnDeltaU));
    const severity = Math.min(1, Math.max(0, undroppedTokens / Math.max(tailTokens, 1)));
    const previousLevel = input.lastNudgeLevel;
    let lastNudge = Math.max(0, input.lastNudgeUndropped);
    let nextLevel = previousLevel;
    let clearPostReduceGrace = false;
    const growthThreshold = channel1RefireTokens(tailTokens);
    const graceBaselineU =
        input.postReduceGraceBaselineU === undefined
            ? null
            : Math.max(0, input.postReduceGraceBaselineU);
    const graceGrowth = graceBaselineU === null ? 0 : undroppedTokens - graceBaselineU;
    const cadenceGrowth = undroppedTokens - lastNudge;
    const currentTurn = input.currentRealUserTurnCount;
    const lastFireTurn = input.lastFireOrdinal;
    const stickyTurnsRemaining =
        currentTurn === undefined || lastFireTurn === undefined || lastFireTurn > currentTurn
            ? 0
            : Math.max(0, CHANNEL1_STICKY_REAL_USER_TURN_GAP - (currentTurn - lastFireTurn));
    const measuredBand = channel1Band(undroppedTokens, tailTokens);
    const quiet = (
        reason: Channel1VerdictReason,
        dampeningState: Channel1DampeningState,
        level: Channel1Level = measuredBand === "quiet" ? "gentle" : measuredBand,
    ): Channel1Decision => ({
        fire: false,
        sticky: false,
        level,
        band: measuredBand,
        undroppedTokens,
        tailTokens,
        severity,
        graceBaselineU,
        graceGrowth,
        growthThreshold,
        cadenceGrowth,
        stickyTurnsRemaining,
        dampeningState,
        verdictReason: reason,
        nextLastNudge: lastNudge,
        nextLastNudgeLevel: nextLevel,
        clearPostReduceGrace,
    });

    if (input.evaluable === false || input.generationInvalidated === true) {
        return quiet("baseline-unevaluable", "baseline-hold");
    }
    // The dirty in-memory baseline and a grace-pending durable blob both lack the
    // post-drop U needed to start the grace interval safely.
    if (input.hasRecentReduce) return quiet("recent-reduce-refresh", "baseline-hold");
    if (input.agentDropsAppliedThisPass) {
        return quiet("agent-drops-applied", "baseline-hold");
    }
    if (input.postReduceGracePending) {
        return quiet("post-reduce-baseline-pending", "baseline-hold");
    }

    const level: Channel1Level | "" = measuredBand === "quiet" ? "" : measuredBand;
    const previousRank = previousLevel === "" ? 0 : LEVEL_RANK[previousLevel];
    const currentRank = level === "" ? 0 : LEVEL_RANK[level];
    let graceReleaseReason: Channel1VerdictReason | null = null;
    if (graceBaselineU !== null) {
        const preReduceLevel = input.postReduceGracePreLevel ?? previousLevel;
        const preReduceRank = preReduceLevel === "" ? 0 : LEVEL_RANK[preReduceLevel];
        const regrowthReached = graceGrowth >= growthThreshold;
        const escalatedAbovePreReduceBand = currentRank > preReduceRank;
        if (!regrowthReached && !escalatedAbovePreReduceBand) {
            return quiet("post-reduce-compliance-grace", "post-reduce-grace");
        }
        clearPostReduceGrace = true;
        graceReleaseReason = regrowthReached
            ? "post-reduce-regrowth-reached"
            : "post-reduce-band-escalation";
    }

    if (level === "") {
        nextLevel = "";
        lastNudge = 0;
        if (tailTokens < CHANNEL1_MIN_TOKENS) {
            return quiet("tail-below-minimum", "none");
        }
        if (undroppedTokens < CHANNEL1_FLOOR_TOKENS) {
            return quiet("reclaimable-below-floor", "none");
        }
        return quiet("ratio-below-gentle", "none");
    }

    // A drop into a lower band is an observation, not a fresh crossing. Recording
    // it quietly lets a later upward transition render one full reminder again.
    if (currentRank < previousRank) {
        nextLevel = level;
        lastNudge = undroppedTokens;
        return quiet("band-deescalation", "band-hysteresis", level);
    }

    const crossedFromBelow = currentRank > previousRank;
    const cadenceReached = currentRank === previousRank && cadenceGrowth >= growthThreshold;
    const stickyTurnGapReached = stickyTurnsRemaining === 0;
    if (!crossedFromBelow && !cadenceReached) {
        return quiet("cadence-growth", "cadence", level);
    }
    if (!crossedFromBelow && !stickyTurnGapReached) {
        return quiet("sticky-turn-floor", "sticky-floor", level);
    }

    return {
        fire: true,
        sticky: !crossedFromBelow,
        level,
        band: measuredBand,
        undroppedTokens,
        tailTokens,
        severity,
        graceBaselineU,
        graceGrowth,
        growthThreshold,
        cadenceGrowth,
        stickyTurnsRemaining,
        dampeningState: "none",
        verdictReason:
            graceReleaseReason ?? (crossedFromBelow ? "band-crossing" : "cadence-refire"),
        nextLastNudge: undroppedTokens,
        nextLastNudgeLevel: level,
        clearPostReduceGrace,
    };
}

export type Channel2PredicateBaseline = Pick<
    TailHygieneBaseline,
    "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT" | "evaluable" | "generationInvalidated"
>;

export type Channel2VerdictReason =
    | "baseline-unavailable"
    | "baseline-unevaluable"
    | "generation-invalidated"
    | "non-finite-input"
    | "tail-below-minimum"
    | "reclaimable-below-floor"
    | "ratio-below-ceiling"
    | "ceiling-threshold-met";

export interface Channel2PredicateEvaluation {
    evaluable: boolean;
    shouldTrigger: boolean;
    reclaimableTokens: number;
    tailTokens: number;
    severity: number;
    band: NudgeBand;
    verdictReason: Channel2VerdictReason;
}

export function evaluateChannel2(
    input: Channel2PredicateBaseline | undefined,
): Channel2PredicateEvaluation {
    const unavailable = (reason: Channel2VerdictReason): Channel2PredicateEvaluation => ({
        evaluable: false,
        shouldTrigger: false,
        reclaimableTokens: 0,
        tailTokens: 0,
        severity: 0,
        band: "quiet",
        verdictReason: reason,
    });
    if (!input) return unavailable("baseline-unavailable");
    if (input.evaluable !== true) return unavailable("baseline-unevaluable");
    if (input.generationInvalidated === true) return unavailable("generation-invalidated");
    const values = [input.baselineU, input.baselineT, input.turnDeltaU, input.turnDeltaT];
    if (values.some((value) => !Number.isFinite(value))) return unavailable("non-finite-input");

    const tailTokens = Math.max(0, input.baselineT + input.turnDeltaT);
    const reclaimableTokens = Math.min(tailTokens, Math.max(0, input.baselineU + input.turnDeltaU));
    const severity = Math.min(1, Math.max(0, reclaimableTokens / Math.max(tailTokens, 1)));
    const band = nudgeBand(reclaimableTokens, tailTokens);
    let verdictReason: Channel2VerdictReason = "ceiling-threshold-met";
    if (tailTokens < CHANNEL1_MIN_TOKENS) verdictReason = "tail-below-minimum";
    else if (reclaimableTokens < CHANNEL2_FLOOR_TOKENS) {
        verdictReason = "reclaimable-below-floor";
    } else if (severity < CHANNEL2_SEVERITY_THRESHOLD) verdictReason = "ratio-below-ceiling";
    return {
        evaluable: true,
        shouldTrigger: verdictReason === "ceiling-threshold-met",
        reclaimableTokens,
        tailTokens,
        severity,
        band,
        verdictReason,
    };
}

export type Channel2LeaseState = "" | "pending" | "claimed" | "delivered";

function formatRatio(value: number): string {
    return Number.isFinite(value) ? value.toFixed(4) : "nan";
}

export function formatChannel1Evaluation(
    decision: Channel1Decision,
    ctxReduceCallable = true,
): string {
    return [
        "channel1 evaluation:",
        `ctx_reduce=${ctxReduceCallable ? "callable" : "unavailable"}`,
        `U=${decision.undroppedTokens}`,
        `T=${decision.tailTokens}`,
        `ratio=${formatRatio(decision.severity)}`,
        `band=${decision.band}`,
        `grace_baseline_u=${decision.graceBaselineU ?? "none"}`,
        `grace_growth=${decision.graceGrowth}`,
        `growth_threshold=${decision.growthThreshold}`,
        `sticky_floor_turns_remaining=${decision.stickyTurnsRemaining}`,
        `dampening=${decision.dampeningState}`,
        `verdict=${decision.fire ? "fire" : "hold"}`,
        `reason=${ctxReduceCallable ? decision.verdictReason : "ctx-reduce-unavailable"}`,
    ].join(" ");
}

export function formatChannel2Evaluation(
    evaluation: Channel2PredicateEvaluation,
    input: {
        ctxReduceCallable?: boolean;
        leaseBefore: Channel2LeaseState;
        leaseAfter?: Channel2LeaseState;
        gateHoldReason?: string;
    },
): string {
    const leaseAfter = input.leaseAfter ?? input.leaseBefore;
    let verdict = "hold";
    let reason: string = evaluation.verdictReason;
    if (input.ctxReduceCallable === false) {
        reason = "ctx-reduce-unavailable";
    } else if (input.gateHoldReason) {
        reason = input.gateHoldReason;
    } else if (evaluation.shouldTrigger) {
        if (input.leaseBefore === "" && input.leaseAfter === undefined) {
            verdict = "arm";
        } else if (leaseAfter === "pending") {
            verdict = input.leaseBefore === "" ? "arm" : "pending";
            reason = input.leaseBefore === "" ? evaluation.verdictReason : "lease-pending";
        } else if (leaseAfter === "claimed") {
            reason = "lease-claimed";
        } else if (leaseAfter === "delivered") {
            reason = "lease-delivered";
        } else {
            reason = "lease-cas-not-armed";
        }
    }
    return [
        "channel2 evaluation:",
        `ctx_reduce=${input.ctxReduceCallable === false ? "unavailable" : "callable"}`,
        `U=${evaluation.reclaimableTokens}`,
        `T=${evaluation.tailTokens}`,
        `ratio=${formatRatio(evaluation.severity)}`,
        `band=${evaluation.band}`,
        `lease=${input.leaseBefore || "empty"}->${leaseAfter || "empty"}`,
        `verdict=${verdict}`,
        `reason=${reason}`,
    ].join(" ");
}

function approxThousands(tokens: number): string {
    return `${Math.round(tokens / 1000)}k`;
}

function formatOldestReclaimableHint(hint?: readonly ToolReclaimHint[]): string {
    if (!hint || hint.length === 0) return "";
    const rendered = hint
        .slice(0, 4)
        .map((tag) => `§${tag.tagNumber}§ ${tag.toolName ?? "tool"}`)
        .join(" · ");
    return rendered.length > 0 ? `\noldest reclaimable: ${rendered}.` : "";
}

export function reclaimableToolOutputCount(parts: readonly TailHygienePartMeasurement[]): number {
    return parts.filter((part) => part.kind === "toolOutput" && part.uTokens > 0).length;
}

function formatReclaimableOutputSummary(count: number, tokens: number): string {
    const outputCount = Math.max(0, Math.floor(count));
    const outputs =
        outputCount === 0
            ? "spent tool outputs"
            : `${outputCount} spent tool output${outputCount === 1 ? "" : "s"}`;
    return `${outputs} (~${approxThousands(tokens)} tokens)`;
}

export function buildChannel2Reminder(
    undroppedTokens: number,
    reclaimableToolOutputs: number,
    hint?: readonly ToolReclaimHint[],
): string {
    const summary = formatReclaimableOutputSummary(reclaimableToolOutputs, undroppedTokens);
    const hintText = formatOldestReclaimableHint(hint);
    return (
        `<system-reminder>\n` +
        `Your next step: call ctx_reduce on the outputs you've already used (${summary}). Then continue your task.${hintText}\n` +
        `</system-reminder>`
    );
}

export const CHANNEL1_STICKY_REAL_USER_TURN_GAP = 5;

export function shouldUseStickyChannel1Reminder(input: {
    lastLevel: Channel1Level | "";
    lastOrdinal: number;
    level: Channel1Level;
    currentRealUserTurnCount: number;
}): boolean {
    // The ordinal controls whether a same-band reminder may fire; it never
    // promotes a re-fire back to imperative copy after the crossing was shown.
    return input.lastLevel === input.level;
}

export function buildChannel1Reminder(
    level: Channel1Level,
    undroppedTokens: number,
    reclaimableToolOutputs: number,
    hint?: readonly ToolReclaimHint[],
    sticky = false,
): string {
    const summary = formatReclaimableOutputSummary(reclaimableToolOutputs, undroppedTokens);
    const hintText = formatOldestReclaimableHint(hint);
    if (sticky) {
        return `\n\n<system-reminder>\nStill unstamped: ${summary}. Stamp the ones you've used with ctx_reduce now.${hintText}\n</system-reminder>`;
    }

    let body: string;
    switch (level) {
        case "gentle":
            body = `Housekeeping: ${summary} are reclaimable. Stamp each output with ctx_reduce as soon as you've taken what you need from it; don't wait for the task to finish.`;
            break;
        case "firm":
            body = `${summary} are reclaimable. Make a ctx_reduce pass now over the outputs you've already used, then continue.`;
            break;
        case "urgent":
            body = `${summary} are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used.`;
            break;
    }
    return `\n\n<system-reminder>\n${body}${hintText}\n</system-reminder>`;
}
