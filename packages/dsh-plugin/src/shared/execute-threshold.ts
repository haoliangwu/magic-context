/**
 * shared/execute-threshold — resolve the effective default execute threshold
 * percentage from the shared `magic-context.jsonc`.
 *
 * `execute_threshold_percentage` is either a scalar number or a model-keyed
 * map (`{ default: 65, "provider/model": 70 }`). DSH has no per-model
 * resolution (no live model-config surface), so the model keys are ignored
 * and the scalar (or the map's `default`) is the effective percentage.
 *
 * Consumers: the agent-plane config bridge (`agent/index.ts`) and the host
 * sidebar snapshot (`host/remote.ts`) so the Context tab displays the same
 * threshold the historian trigger enforces.
 */
import type { MagicContextPluginConfig } from "@magic-context/core/config";

/** Runtime default when nothing is configured (matches the OpenCode default). */
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;

/** The config slice this resolver reads. */
export type ExecuteThresholdConfig = Pick<
  MagicContextPluginConfig,
  "execute_threshold_percentage"
>;

/**
 * Resolve the configured default execute-threshold percentage, or `undefined`
 * when unset/unusable (callers apply their own default).
 */
export function resolveExecuteThresholdPercentage(
  config: ExecuteThresholdConfig | undefined,
): number | undefined {
  const raw = config?.execute_threshold_percentage;
  if (typeof raw === "number") return raw;
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { default?: unknown }).default === "number"
  ) {
    return (raw as { default: number }).default;
  }
  return undefined;
}
