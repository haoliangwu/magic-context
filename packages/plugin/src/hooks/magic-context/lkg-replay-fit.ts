import type { ContextDatabase } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { resolveTrustedContextLimit } from "./event-resolvers";
import { estimateFinalWireInputTokens, wireContentBytes } from "./final-wire-token-estimate";
import type { MessageLike } from "./transform-operations";

/**
 * The local tokenizer is telemetry-grade and can materially undercount a new
 * provider tokenizer. Four bytes of request content per context token is an
 * independent, conservative risk budget for sending an array the transform did
 * not just build (a last-known-good replay or the raw full-history fallback).
 */
export const RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN = 4;
type ReplayModel = { providerID: string; modelID: string } | null | undefined;

/**
 * The context limit every last-known-good replay is admitted against: the
 * model's trusted context limit, else the limit the provider reported for this
 * model. Undefined when none is known. Throws when the stored limits cannot be
 * read.
 *
 * The trusted limit is the window's usable soft limit (a declared prompt limit
 * when the catalog has one, else the window minus the output reserve), never the
 * larger usable hard limit: some providers enforce the declared prompt limit
 * (GitHub Copilot rejects a prompt over it), and a replay that overflows turns a
 * recoverable failure into a provider rejection.
 */
export function lkgReplayLimit(args: {
    db: ContextDatabase;
    sessionId: string;
    model: ReplayModel;
    modelKey: string | null | undefined;
}): number | undefined {
    const { db, sessionId, model } = args;
    const trusted = model
        ? resolveTrustedContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
        : undefined;
    if (trusted !== undefined && trusted > 0) return trusted;
    const detected = getOverflowState(db, sessionId, args.modelKey).detectedContextLimit;
    return detected > 0 ? detected : undefined;
}

/**
 * Where a replay candidate stands against a limit, with what the measurement saw:
 * the wire byte proxy (null when it could not be computed), whether the token
 * estimator ran, and whether its estimate was trusted.
 */
export type LkgReplayMeasure = (
    | { fit: "under"; tokens: number }
    | { fit: "over"; tokens: number | null; proxyTokens: number | null }
    | { fit: "unproven"; tokens: number | null }
) & {
    proxy: { bytes: number; aborted: boolean } | null;
    estimatorRan: boolean;
    trusted: boolean;
};

/**
 * Measure `messages` against `limit`. Over when the four-bytes-per-token proxy or
 * a trusted token estimate exceeds the limit (the proxy runs first, so an array
 * the proxy already proves over is never tokenized); under only when the proxy is
 * under and a trusted, finite, positive estimate is at or under the limit;
 * unproven otherwise (the estimate is untrusted, unusable or failed).
 *
 * The proxy counts only what the provider request carries (`wireContentBytes`):
 * OpenCode keeps fields for itself, such as an edit tool's whole file before and
 * after the edit, and a base64 image is billed by its size, so a byte count of
 * the whole stored messages would refuse replays that fit.
 */
export function measureLkgReplay(args: {
    messages: readonly MessageLike[];
    limit: number;
    estimate: () => ReturnType<typeof estimateFinalWireInputTokens>;
}): LkgReplayMeasure {
    const proxy = wireContentBytes(
        args.messages,
        args.limit * RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
        RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
    );
    const skipped = { proxy, estimatorRan: false, trusted: false };
    if (proxy === null) return { fit: "unproven", tokens: null, ...skipped };
    const proxyTokens = Math.ceil(proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN);
    if (proxy.aborted || proxyTokens > args.limit) {
        return { fit: "over", tokens: null, proxyTokens, ...skipped };
    }
    let estimate: ReturnType<typeof estimateFinalWireInputTokens>;
    try {
        estimate = args.estimate();
    } catch {
        return { fit: "unproven", tokens: null, ...skipped };
    }
    const seen = { proxy, estimatorRan: true, trusted: estimate.trusted };
    if (!estimate.trusted || !Number.isFinite(estimate.tokens) || estimate.tokens <= 0) {
        return {
            fit: "unproven",
            tokens: Number.isFinite(estimate.tokens) ? estimate.tokens : null,
            ...seen,
        };
    }
    return estimate.tokens > args.limit
        ? { fit: "over", tokens: estimate.tokens, proxyTokens, ...seen }
        : { fit: "under", tokens: estimate.tokens, ...seen };
}

export type LkgReplayFit =
    | { fits: true }
    /** `detail` is the log line explaining the decline, when there is one to log. */
    | { fits: false; detail: string | null };

/**
 * Whether a last-known-good replay of `messages` may be sent in place of a failed
 * pass: it needs a known limit (`lkgReplayLimit`) and a measurement of "under"
 * (`measureLkgReplay`). Every way of not knowing declines, because a replay that
 * overflows turns a recoverable failure into a provider rejection.
 *
 * The Rust adapter's failure replay and the outer messages-transform wrapper's
 * replay both call this. A healthy frozen pass uses the same limit and
 * measurement; it differs only in serving an unproven measurement, because its
 * alternative is a cache bust rather than a refusal.
 */
export function lkgReplayFits(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    model: ReplayModel;
    modelKey: string | null | undefined;
    systemPromptTokens: number;
    agentName?: string;
    /** Token estimator; tests substitute it. */
    estimator?: typeof estimateFinalWireInputTokens;
}): LkgReplayFit {
    let limit: number | undefined;
    try {
        limit = lkgReplayLimit(args);
    } catch {
        // A limit read failure cannot admit cached bytes whose size is now unknown.
        return { fits: false, detail: null };
    }
    if (limit === undefined) return { fits: false, detail: null };
    const estimator = args.estimator ?? estimateFinalWireInputTokens;
    const measure = measureLkgReplay({
        messages: args.messages,
        limit,
        estimate: () =>
            estimator({
                messages: args.messages,
                systemPromptTokens: args.systemPromptTokens,
                providerID: args.model?.providerID,
                modelID: args.model?.modelID,
                agentName: args.agentName,
            }),
    });
    if (measure.fit === "under") return { fits: true };
    return {
        fits: false,
        detail:
            measure.fit === "over"
                ? `lkg_over_context_limit estimated=${measure.tokens ?? "skipped"} proxy_tokens=${measure.proxyTokens ?? "unavailable"} limit=${limit}`
                : `lkg_fit_untrusted estimated=${measure.tokens ?? "unavailable"} limit=${limit}`,
    };
}
