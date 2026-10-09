import type { ContextDatabase } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { resolveTrustedContextLimit } from "./event-resolvers";
import {
    estimateAppendedWireTokens,
    estimateFinalWireInputTokens,
    wireContentBytes,
} from "./final-wire-token-estimate";
import { measuredLkgPrefix } from "./lkg-measured-request";
import { getSlot } from "./lkg-slot";
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
    /** Provider-measured input of this exact prefix; `messages` is only its tail. */
    measuredInputTokens?: number;
}): LkgReplayMeasure {
    const baseline = args.measuredInputTokens ?? 0;
    const tailLimit = Math.max(0, args.limit - baseline);
    const proxy = wireContentBytes(
        args.messages,
        tailLimit * RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
        RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
    );
    const skipped = { proxy, estimatorRan: false, trusted: false };
    if (proxy === null) return { fit: "unproven", tokens: null, ...skipped };
    const proxyTokens = baseline + Math.ceil(proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN);
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
    const tokens = baseline + estimate.tokens;
    if (!estimate.trusted || !Number.isFinite(tokens) || tokens <= 0 || estimate.tokens < 0) {
        return {
            fit: "unproven",
            tokens: Number.isFinite(estimate.tokens) ? estimate.tokens : null,
            ...seen,
        };
    }
    return tokens > args.limit
        ? { fit: "over", tokens, proxyTokens, ...seen }
        : { fit: "under", tokens, ...seen };
}

export type LkgReplayFit =
    | { fits: true }
    /** `detail` is the log line explaining the decline, when there is one to log. */
    | { fits: false; detail: string | null };

/** Prefer the input usage bound to this exact saved request. It already includes
 * system and tool definitions, so neither its messages nor its envelope are
 * estimated again. The byte risk budget likewise applies only to the new tail. */
export function measureLkgReplayRequest(args: {
    sessionId: string;
    messages: readonly MessageLike[];
    model: ReplayModel;
    systemPromptTokens: number;
    agentName?: string;
    limit: number;
    estimator?: typeof estimateFinalWireInputTokens;
}): LkgReplayMeasure {
    let measured: ReturnType<typeof measuredLkgPrefix>;
    try {
        measured = args.model
            ? measuredLkgPrefix({
                  ...args,
                  slot: getSlot(args.sessionId),
                  modelKey: `${args.model.providerID}/${args.model.modelID}`,
              })
            : undefined;
    } catch {
        // If the saved request can't be matched to its own usage, fall back to the
        // full estimate; the session's latest usage reading may belong to another request.
        measured = undefined;
    }
    const estimator = args.estimator ?? estimateFinalWireInputTokens;
    return measureLkgReplay({
        messages: measured?.appendedMessages ?? args.messages,
        limit: args.limit,
        measuredInputTokens: measured?.inputTokens,
        estimate: () =>
            measured
                ? estimateAppendedWireTokens({
                      messages: measured.appendedMessages,
                      providerID: args.model?.providerID,
                      modelID: args.model?.modelID,
                  })
                : estimator({
                      messages: args.messages,
                      systemPromptTokens: args.systemPromptTokens,
                      providerID: args.model?.providerID,
                      modelID: args.model?.modelID,
                      agentName: args.agentName,
                  }),
    });
}

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
    const measure = measureLkgReplayRequest({ ...args, limit });
    if (measure.fit === "under") return { fits: true };
    return {
        fits: false,
        detail:
            measure.fit === "over"
                ? `lkg_over_context_limit estimated=${measure.tokens ?? "skipped"} proxy_tokens=${measure.proxyTokens ?? "unavailable"} limit=${limit}`
                : `lkg_fit_untrusted estimated=${measure.tokens ?? "unavailable"} limit=${limit}`,
    };
}
