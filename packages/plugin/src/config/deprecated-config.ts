/**
 * `mural.model` used to name one cue-compressor model shared by every harness.
 * Model ids differ per harness (OpenCode and Pi spell the same model with
 * different provider prefixes), so a single string could not name a working
 * model on every host. compress-cues now resolves through each harness's
 * dreamer settings like every other dreamer task, and the key is ignored.
 */
export const MURAL_MODEL_DEPRECATION_WARNING =
    "mural.model is deprecated and ignored; compress-cues now uses the dreamer model for each harness, like every other dreamer task. To override it, set dreamer.opencode.tasks.compress-cues.model (or the pi/omp equivalent). This key no longer does anything; remove it.";

export const WINDOW_OVERLAY_PATH_DEPRECATION_WARNING =
    "models.window_overlay_path is deprecated and ignored; Fusiform no longer publishes window-overlay data, so this setting no longer changes model window geometry. Remove this key.";

/**
 * Pushes the deprecation warning when the config still sets `mural.model`.
 * Call it after the legacy experimental migration so the pre-graduation
 * `experimental.mural.model` spelling is reported the same way.
 */
export function warnDeprecatedMuralModel(
    config: Record<string, unknown>,
    warnings: string[],
): void {
    const mural = config.mural;
    if (typeof mural === "object" && mural !== null && Object.hasOwn(mural, "model")) {
        warnings.push(MURAL_MODEL_DEPRECATION_WARNING);
    }
}

/** Pushes one warning when a config still sets the retired Fusiform path. */
export function warnDeprecatedWindowOverlayPath(
    config: Record<string, unknown>,
    warnings: string[],
): void {
    const models = config.models;
    if (
        typeof models === "object" &&
        models !== null &&
        Object.hasOwn(models, "window_overlay_path") &&
        !warnings.includes(WINDOW_OVERLAY_PATH_DEPRECATION_WARNING)
    ) {
        warnings.push(WINDOW_OVERLAY_PATH_DEPRECATION_WARNING);
    }
}
