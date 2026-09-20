import { estimateTokens } from "./read-session-formatting";

/**
 * Leave room for provider tokenizers to count slightly more than our estimator.
 * A live failure was one provider token over its context window while our estimate
 * was still on the nominal boundary, so producer admission must stay below it.
 */
export const PRODUCER_WINDOW_REFUSAL_MARGIN = 0.03;

export const HISTORIAN_TRUNCATION_MARKER =
    "[… tokens truncated by Magic Context to fit the historian window …]";

export interface ProducerWindowFailureInput {
    producerSourceTokens: number;
    contextLimitTokens?: number;
    maxOutputTokens: number;
}

export interface HistorianResultBoundary {
    ordinal: number;
    sourceOffset: number;
    bodyTokens: number;
}

export interface FittedHistorianSource {
    text: string;
    producerInputLimitTokens?: number;
    splitBoundaryOrdinal?: number;
    removedTokens: number;
}

export function producerInputTokenLimit(
    contextLimitTokens: number | undefined,
    maxOutputTokens: number,
): number | undefined {
    if (
        typeof contextLimitTokens !== "number" ||
        !Number.isFinite(contextLimitTokens) ||
        contextLimitTokens <= 0 ||
        !Number.isFinite(maxOutputTokens) ||
        maxOutputTokens < 0
    ) {
        return undefined;
    }
    const usableInputTokens = Math.max(0, Math.floor(contextLimitTokens - maxOutputTokens));
    return Math.max(0, Math.floor(usableInputTokens * (1 - PRODUCER_WINDOW_REFUSAL_MARGIN)));
}

export function producerWindowFailureReason(input: ProducerWindowFailureInput): string | null {
    const { producerSourceTokens, contextLimitTokens, maxOutputTokens } = input;
    const producerInputLimitTokens = producerInputTokenLimit(contextLimitTokens, maxOutputTokens);
    if (
        producerInputLimitTokens === undefined ||
        typeof contextLimitTokens !== "number" ||
        !Number.isFinite(producerSourceTokens) ||
        producerSourceTokens <= 0
    ) {
        return null;
    }
    const usableInputTokens = Math.max(0, Math.floor(contextLimitTokens - maxOutputTokens));
    if (producerSourceTokens <= producerInputLimitTokens) return null;

    return `producer_source_exceeds_window producer_source_tokens=${Math.round(producerSourceTokens)} usable_input_tokens=${usableInputTokens} producer_input_limit_tokens=${producerInputLimitTokens} context_limit_tokens=${Math.round(contextLimitTokens)} max_output_tokens=${Math.round(maxOutputTokens)} estimator_margin=${PRODUCER_WINDOW_REFUSAL_MARGIN}`;
}

function splitMarkerPair(): string {
    return `\n${HISTORIAN_TRUNCATION_MARKER}\n${HISTORIAN_TRUNCATION_MARKER}\n`;
}

/**
 * Pathological atomic components can contain user or assistant text larger than
 * the producer window even though tool-result bodies are omitted from historian
 * input. Keep both sides of the largest result boundary and mark both cut edges;
 * ordinal coverage remains whole while the producer can make forward progress.
 */
export function fitAtomicHistorianSourceToProducerWindow(args: {
    text: string;
    resultBoundaries?: readonly HistorianResultBoundary[];
    contextLimitTokens?: number;
    maxOutputTokens: number;
}): FittedHistorianSource {
    const producerInputLimitTokens = producerInputTokenLimit(
        args.contextLimitTokens,
        args.maxOutputTokens,
    );
    const originalTokens = estimateTokens(args.text);
    if (
        producerInputLimitTokens === undefined ||
        originalTokens < producerInputLimitTokens ||
        producerInputLimitTokens <= 0
    ) {
        return { text: args.text, producerInputLimitTokens, removedTokens: 0 };
    }

    const boundary = [...(args.resultBoundaries ?? [])]
        .filter(
            (candidate) =>
                Number.isFinite(candidate.sourceOffset) &&
                candidate.sourceOffset > 0 &&
                candidate.sourceOffset < args.text.length,
        )
        .sort((a, b) => b.bodyTokens - a.bodyTokens || a.ordinal - b.ordinal)[0];
    const splitOffset = boundary?.sourceOffset ?? Math.floor(args.text.length / 2);
    const left = args.text.slice(0, splitOffset);
    const right = args.text.slice(splitOffset);
    const markers = splitMarkerPair();
    const target = producerInputLimitTokens;

    let lo = 0;
    let hi = 1;
    let best = markers;
    for (let iteration = 0; iteration < 48; iteration++) {
        const scale = (lo + hi) / 2;
        const leftLength = Math.floor(left.length * scale);
        const rightLength = Math.floor(right.length * scale);
        const candidate =
            left.slice(0, leftLength) + markers + right.slice(right.length - rightLength);
        if (estimateTokens(candidate) <= target) {
            best = candidate;
            lo = scale;
        } else {
            hi = scale;
        }
    }

    return {
        text: best,
        producerInputLimitTokens,
        ...(boundary ? { splitBoundaryOrdinal: boundary.ordinal } : {}),
        removedTokens: Math.max(0, originalTokens - estimateTokens(best)),
    };
}
