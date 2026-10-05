import {
    CALIBRATION_TABLE_REVISION,
    hasModelCalibration,
    type ModelCalibration,
    resolveModelCalibration,
    UNKNOWN_FIT_RATIO,
} from "./tokenizer-calibration";

/** Immutable static ratios; session usage samples never change this decision policy. */
export interface DecisionCalibration extends Readonly<ModelCalibration> {
    readonly modelKey: string;
    readonly revision: string;
    readonly matchedPrefix?: string;
    readonly seeded: boolean;
    readonly source: "seed" | "family-fallback" | "model-id";
}

export function resolveDecisionCalibration(
    providerId: string | undefined,
    modelId: string | undefined,
): DecisionCalibration {
    const ratios = resolveModelCalibration(providerId, modelId);
    return Object.freeze({
        ...ratios,
        modelKey: `${providerId ?? "unknown"}/${modelId ?? "unknown"}`.toLowerCase(),
        revision: CALIBRATION_TABLE_REVISION,
        matchedPrefix:
            ratios.derivedFrom ?? (ratios as ModelCalibration & { prefix?: string }).prefix,
        seeded: hasModelCalibration(providerId, modelId),
        source: ratios.matchedByModelId
            ? "model-id"
            : ratios.derivedFrom
              ? "family-fallback"
              : "seed",
    });
}

export interface LocalMass {
    system?: number;
    tools?: number;
    prose?: number;
}

/** Accumulate fractional provider mass, then ceil once at the decision boundary. */
export function providerMass(raw: LocalMass, seed: DecisionCalibration, fit = false): number {
    const { system = 0, tools = 0, prose = 0 } = raw;
    if (
        [system, tools, prose].some((count) => !Number.isFinite(count) || count < 0) ||
        [seed.systemRatio, seed.toolsRatio, seed.proseRatio].some(
            (ratio) => !Number.isFinite(ratio) || ratio <= 0,
        )
    ) {
        return Number.POSITIVE_INFINITY;
    }
    const total =
        fit && !seed.seeded
            ? (system + tools + prose) * UNKNOWN_FIT_RATIO
            : system * seed.systemRatio + tools * seed.toolsRatio + prose * seed.proseRatio;
    return Number.isFinite(total) ? Math.ceil(total) : Number.POSITIVE_INFINITY;
}

/** Available real-token budgets round down so rendered local mass cannot overspend them. */
export function localBudget(providerTokens: number, ratio: number): number {
    if (
        !Number.isFinite(providerTokens) ||
        providerTokens <= 0 ||
        !Number.isFinite(ratio) ||
        ratio <= 0
    )
        return 0;
    return Math.floor(providerTokens / ratio);
}

/** Split provider/model at the first slash, retaining any further slashes in the model name. */
export function calibrationForModelKey(modelKey: string | null | undefined): DecisionCalibration {
    const slash = modelKey?.indexOf("/") ?? -1;
    return modelKey != null && slash > 0
        ? resolveDecisionCalibration(modelKey.slice(0, slash), modelKey.slice(slash + 1))
        : resolveDecisionCalibration(undefined, undefined);
}

/** Convert at history materialization, not in cache markers: calibration must not trigger a fold. */
export function historyLocalBudget(
    providerTokens: number,
    modelKey: string | null | undefined,
): number {
    const ratio = calibrationForModelKey(modelKey).proseRatio;
    // Neutral preserves legacy fractional budgets, which may come from decay pressure.
    return ratio === 1 ? providerTokens : localBudget(providerTokens, ratio);
}
