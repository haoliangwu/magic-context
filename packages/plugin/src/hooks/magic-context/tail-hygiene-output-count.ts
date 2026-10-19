interface OutputMeasurement {
    readonly kind: string;
    readonly uTokens: number;
}

const CURRENT_OUTPUT_COUNT: unique symbol = Symbol.for(
    "magic-context.current-reclaimable-tool-output-count",
);

export function countReclaimableToolOutputs(parts: readonly OutputMeasurement[]): number {
    return parts.filter((part) => part.kind === "toolOutput" && part.uTokens > 0).length;
}

/**
 * Track current tool-output measurements with reclaimable tokens. The unchanged
 * prefix can omit eligible appends, so count the complete measurement instead.
 * An enumerable symbol carries this live number through state object spreads,
 * while JSON and stable-json omit it. No raw message data is revisited here.
 */
export function rememberCurrentToolOutputCount<T extends object>(
    baseline: T,
    measurement: { readonly parts: readonly OutputMeasurement[] },
): T {
    return Object.assign(baseline, {
        [CURRENT_OUTPUT_COUNT]: countReclaimableToolOutputs(measurement.parts),
    });
}

/** Without a current measurement, use generic copy rather than inventing a count. */
export function currentReclaimableToolOutputCount(baseline: object | undefined): number {
    if (!baseline || !Object.hasOwn(baseline, CURRENT_OUTPUT_COUNT)) return 0;
    return (baseline as { [CURRENT_OUTPUT_COUNT]: number })[CURRENT_OUTPUT_COUNT];
}
