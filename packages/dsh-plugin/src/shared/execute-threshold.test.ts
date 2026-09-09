/**
 * shared/execute-threshold — the dsh surfaces have no per-model threshold
 * resolution, so a model-keyed map must contribute only its `default` and
 * the sidebar snapshot must reflect the configured value instead of the
 * hardcoded 65.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
  resolveExecuteThresholdPercentage,
  type ExecuteThresholdConfig,
} from "./execute-threshold";

describe("resolveExecuteThresholdPercentage", () => {
  it("returns undefined for a missing/undefined config", () => {
    expect(resolveExecuteThresholdPercentage(undefined)).toBeUndefined();
    expect(resolveExecuteThresholdPercentage({} as ExecuteThresholdConfig)).toBeUndefined();
  });

  it("returns the scalar directly", () => {
    const config: ExecuteThresholdConfig = { execute_threshold_percentage: 55 };
    expect(resolveExecuteThresholdPercentage(config)).toBe(55);
  });

  it("takes .default from a model-keyed map and ignores per-model keys", () => {
    const config: ExecuteThresholdConfig = {
      execute_threshold_percentage: { default: 70, "anthropic/claude": 80 },
    };
    expect(resolveExecuteThresholdPercentage(config)).toBe(70);
  });

  it("falls back to undefined on a map without a numeric default", () => {
    const config = {
      execute_threshold_percentage: { "anthropic/claude": 80 },
    } as unknown as ExecuteThresholdConfig;
    expect(resolveExecuteThresholdPercentage(config)).toBeUndefined();
  });

  it("default constant matches the runtime fallback", () => {
    expect(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE).toBe(65);
  });
});
