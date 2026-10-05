export const HISTORIAN_NO_FIRE_CAUSES = [
    "in_flight",
    "cheap_skip",
    "no_new_raw_history",
    "raw_history_unavailable",
    "redundancy_skip",
    "protected_tail",
    "below_proactive_floor",
    "below_min_chunk",
    "drain_budget",
    "missing_boundary_snapshot",
    "stale_boundary_snapshot",
    "invalid_chunk_coverage",
    "credential_unavailable",
    "provider_unknown",
    "model_unknown",
    "runner_resolution_failed",
] as const;

export type HistorianNoFireCause = (typeof HISTORIAN_NO_FIRE_CAUSES)[number];

export const RUNNER_REFUSAL_CANONICAL_CAUSES = [
    "credential_unavailable",
    "provider_unknown",
    "model_unknown",
    "runner_resolution_failed",
] as const satisfies readonly HistorianNoFireCause[];

export type RunnerRefusalCanonicalCause = (typeof RUNNER_REFUSAL_CANONICAL_CAUSES)[number];
