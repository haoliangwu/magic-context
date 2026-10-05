import { catalogOutputReserve } from "../../shared/window-geometry";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { estimateTokens } from "./read-session-formatting";

/**
 * Leave room for provider tokenizers to count slightly more than our estimator.
 * A live failure was one provider token over its context window while our estimate
 * was still on the nominal boundary, so producer admission must stay below it.
 */
export const PRODUCER_WINDOW_REFUSAL_MARGIN = 0.03;

export const HISTORIAN_TRUNCATION_MARKER =
    "[… tokens truncated by Magic Context to fit the historian window …]";

/**
 * Clamp one producer atom without tokenizing it. Keeping equal head/tail slices
 * matches the historian's atomic-source guard: preserve the user's request and
 * the beginning of pasted content, plus enough trailing context to identify it.
 */
export function clampProducerAtomChars(text: string, maxChars: number, marker: string): string {
    const limit = Math.max(0, Math.floor(maxChars));
    if (text.length <= limit) return text;
    if (limit <= marker.length) return marker.slice(0, limit);
    const keptChars = limit - marker.length;
    const headChars = Math.ceil(keptChars / 2);
    const tailChars = Math.floor(keptChars / 2);
    return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

export interface ProducerWindowFailureInput {
    producerSourceTokens: number;
    contextLimitTokens?: number;
    inputLimitTokens?: number;
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
    inputLimitTokens?: number,
): number | undefined {
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 0) return undefined;
    const shared =
        typeof contextLimitTokens === "number" &&
        Number.isFinite(contextLimitTokens) &&
        contextLimitTokens > 0
            ? contextLimitTokens - maxOutputTokens
            : undefined;
    const input =
        typeof inputLimitTokens === "number" &&
        Number.isFinite(inputLimitTokens) &&
        inputLimitTokens > 0
            ? inputLimitTokens
            : undefined;
    if (shared === undefined && input === undefined) return undefined;
    const usableInputTokens = Math.floor(Math.min(shared ?? Infinity, input ?? Infinity));
    if (usableInputTokens <= 0) return undefined;
    const limit = Math.floor(usableInputTokens * (1 - PRODUCER_WINDOW_REFUSAL_MARGIN));
    return limit > 0 ? limit : undefined;
}

export function historianProducerReserve(
    window: number | undefined,
    configuredOutput: number | undefined,
    catalogOutput: number | undefined,
): number {
    if (configuredOutput !== undefined) return configuredOutput;
    return window === undefined ? 0 : catalogOutputReserve(window, catalogOutput);
}

export function producerWindowFailureReason(input: ProducerWindowFailureInput): string | null {
    const { producerSourceTokens, contextLimitTokens, inputLimitTokens, maxOutputTokens } = input;
    const producerInputLimitTokens = producerInputTokenLimit(
        contextLimitTokens,
        maxOutputTokens,
        inputLimitTokens,
    );
    if (
        producerInputLimitTokens === undefined ||
        !Number.isFinite(producerSourceTokens) ||
        producerSourceTokens <= 0
    ) {
        return null;
    }
    const usableInputTokens = Math.floor(
        Math.min(
            contextLimitTokens === undefined
                ? Infinity
                : Math.max(0, contextLimitTokens - maxOutputTokens),
            inputLimitTokens ?? Infinity,
        ),
    );
    if (producerSourceTokens <= producerInputLimitTokens) return null;

    return `producer_source_exceeds_window producer_source_tokens=${Math.round(producerSourceTokens)} usable_input_tokens=${usableInputTokens} producer_input_limit_tokens=${producerInputLimitTokens} context_limit_tokens=${contextLimitTokens === undefined ? "unknown" : Math.round(contextLimitTokens)} max_output_tokens=${Math.round(maxOutputTokens)} estimator_margin=${PRODUCER_WINDOW_REFUSAL_MARGIN}`;
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
    inputLimitTokens?: number;
    maxOutputTokens: number;
    /**
     * Room left for the source once the rest of the prompt is counted. Without
     * it the source alone is fitted to the whole input limit, and the full
     * prompt can still overflow.
     */
    maxSourceTokens?: number;
}): FittedHistorianSource {
    const producerInputLimitTokens = producerInputTokenLimit(
        args.contextLimitTokens,
        args.maxOutputTokens,
        args.inputLimitTokens,
    );
    const originalTokens = estimateTokens(args.text);
    const target =
        producerInputLimitTokens === undefined
            ? undefined
            : Math.min(producerInputLimitTokens, args.maxSourceTokens ?? Infinity);
    if (target === undefined || originalTokens < target || target <= 0) {
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

/** Evaluate after instructions and references are included and the actual producer model is selected. */
export function producerPromptFailureReason(input: {
    sourceLocal: number;
    systemLocal: number;
    toolsLocal: number;
    modelKey: string | undefined;
    contextLimitTokens: number | undefined;
    inputLimitTokens?: number;
    maxOutputTokens: number;
}): string | null {
    const limit = producerInputTokenLimit(
        input.contextLimitTokens,
        input.maxOutputTokens,
        input.inputLimitTokens,
    );
    const tokens = providerMass(
        { prose: input.sourceLocal, system: input.systemLocal, tools: input.toolsLocal },
        calibrationForModelKey(input.modelKey),
        true,
    );
    if (limit === undefined) return null;
    if (!Number.isFinite(tokens) || tokens <= 0) return "producer_prompt_fit_unavailable";
    return tokens <= limit
        ? null
        : `producer_prompt_exceeds_window calibrated_tokens=${tokens} limit=${limit} estimator_margin=0.03`;
}
