import type { Channel1State } from "../hooks/magic-context/ctx-reduce-nudge";
import type { TailHygieneStatus } from "./rpc-types";

export interface WireTailHygieneBaseline {
    u?: number;
    t?: number;
    severity?: number;
    evaluable?: boolean;
    generation_invalidated?: boolean;
    baseline_generation?: number;
    computed_at_ms?: number;
    reclaimable_tool_output_count?: number;
}

function finiteNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Normalize either renderer authority's persisted baseline without dropping valid zeros. */
export function resolveTailHygieneStatus(
    tsBaseline: Channel1State | undefined,
    rustBaseline?: WireTailHygieneBaseline | null,
): TailHygieneStatus | undefined {
    if (rustBaseline !== undefined && rustBaseline !== null) {
        const t = Math.max(0, finiteNumber(rustBaseline.t));
        const u = Math.min(t, Math.max(0, finiteNumber(rustBaseline.u)));
        return {
            u,
            t,
            severity: Math.min(
                1,
                Math.max(0, finiteNumber(rustBaseline.severity, u / Math.max(t, 1))),
            ),
            evaluable: rustBaseline.evaluable === true,
            generationInvalidated: rustBaseline.generation_invalidated === true,
            baselineGeneration: Math.max(0, finiteNumber(rustBaseline.baseline_generation)),
            computedAt: Math.max(0, finiteNumber(rustBaseline.computed_at_ms)),
            reclaimableToolOutputCount: Math.max(
                0,
                Math.floor(finiteNumber(rustBaseline.reclaimable_tool_output_count)),
            ),
        };
    }
    if (tsBaseline === undefined) return undefined;
    const t = Math.max(0, tsBaseline.baselineT + tsBaseline.turnDeltaT);
    const u = Math.min(t, Math.max(0, tsBaseline.baselineU + tsBaseline.turnDeltaU));
    return {
        u,
        t,
        severity: Math.min(1, Math.max(0, u / Math.max(t, 1))),
        evaluable: tsBaseline.evaluable && !tsBaseline.generationInvalidated,
        generationInvalidated: tsBaseline.generationInvalidated,
        baselineGeneration: Math.max(0, tsBaseline.baselineGeneration),
        computedAt: Math.max(0, tsBaseline.computedAt),
        reclaimableToolOutputCount: tsBaseline.baselineParts.filter(
            (part) => part.kind === "toolOutput" && part.uTokens > 0,
        ).length,
    };
}

/**
 * The reclaimable share and the two masses it is computed from.
 *
 * The tokenizer calibration makes `u` and `t` fractional, but a token count is
 * a whole number to the reader: `63,063.522 tok` reads as a measurement error,
 * not as precision. Both masses are rounded here, at the one formatter every
 * host prints, so the dialog, the sidebar and Pi cannot disagree.
 */
export function formatTailHygiene(status: TailHygieneStatus): string {
    const percentage = (status.severity * 100).toFixed(1);
    const state = status.evaluable ? "" : " · held until baseline refresh";
    return `${percentage}% · ${Math.round(status.u).toLocaleString()} / ${Math.round(status.t).toLocaleString()} tok${state}`;
}
