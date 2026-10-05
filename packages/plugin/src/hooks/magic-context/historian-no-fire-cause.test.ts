/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
    HISTORIAN_NO_FIRE_CAUSES,
    RUNNER_REFUSAL_CANONICAL_CAUSES,
} from "./historian-no-fire-cause";

test("runner refusal causes extend the canonical historian taxonomy", () => {
    expect(RUNNER_REFUSAL_CANONICAL_CAUSES).toEqual([
        "credential_unavailable",
        "provider_unknown",
        "model_unknown",
        "runner_resolution_failed",
    ]);
    expect(new Set(HISTORIAN_NO_FIRE_CAUSES).size).toBe(HISTORIAN_NO_FIRE_CAUSES.length);
    for (const cause of RUNNER_REFUSAL_CANONICAL_CAUSES) {
        expect(HISTORIAN_NO_FIRE_CAUSES).toContain(cause);
    }
});
