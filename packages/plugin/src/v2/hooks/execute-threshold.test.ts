/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { getProactiveCompartmentTriggerPercentage } from "../../hooks/magic-context/compartment-trigger";
import { resolveExecuteThreshold } from "../../hooks/magic-context/event-resolvers";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { resolveSchedulerDecision } from "../../hooks/magic-context/transform-context-state";
import { createHostSeams, createV2ThresholdDeps } from "./context";
import type { V2Context } from "./types";

// The OpenCode 2 context hook hands `createV2ThresholdDeps` to the shared transform.
// Each case reads those dependencies exactly as the transform reads them on a pass:
// the scheduler decision, and the threshold the transform derives its pressure bands
// from. The pass sees a 100k-token window holding 30k input tokens (30%), well inside
// the cache TTL, so only a threshold can make it execute.

const SESSION = "ses_v2_threshold";
const CONTEXT_LIMIT = 100_000;
const usage: ContextUsage = { percentage: 30, inputTokens: 30_000 };

function sessionMeta(): SessionMeta {
    return {
        sessionId: SESSION,
        lastResponseTime: Date.now(),
        cacheTtl: "5m",
        counter: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: null,
        lastTransformError: null,
        isSubagent: false,
        lastContextPercentage: 0,
        lastInputTokens: 0,
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        systemPromptHash: "",
        systemPromptTokens: 0,
        clearedReasoningThroughTag: 0,
    };
}

function pass(config: Parameters<typeof createV2ThresholdDeps>[0]) {
    const deps = createV2ThresholdDeps(config);
    return {
        decision: resolveSchedulerDecision(
            deps.scheduler,
            sessionMeta(),
            usage,
            SESSION,
            undefined,
            CONTEXT_LIMIT,
        ),
        transformThresholdPercentage: resolveExecuteThreshold(
            deps.executeThresholdPercentage ?? 65,
            undefined,
            65,
            { tokensConfig: deps.executeThresholdTokens, contextLimit: CONTEXT_LIMIT },
        ),
    };
}

describe("OpenCode 2 execute-threshold wiring", () => {
    it("selects the draft model's threshold before usage and after a model switch", () => {
        const models = new Map<string, { providerID: string; modelID: string }>();
        const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
        // Use the same host dependencies registerContext spreads into createTransform.
        // The model map is filled from the outgoing draft, not from a usage event.
        const deps: Partial<TransformDeps> = {
            ...createHostSeams({} as V2Context, read, read, models),
            ...createV2ThresholdDeps({
                execute_threshold_percentage: {
                    default: 50,
                    "opencode/mimo-v2.6-flash-free": 65,
                    "opencode/muse-spark-1.3-contributor-free": 20,
                },
            }),
        };
        const threshold = () =>
            resolveExecuteThreshold(
                deps.executeThresholdPercentage ?? 65,
                deps.getModelKey?.(SESSION),
                65,
            );
        expect(threshold()).toBe(50);
        models.set(SESSION, { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" });
        expect(deps.getModelKey?.(SESSION)).toBe("opencode/muse-spark-1.3-contributor-free");
        expect(threshold()).toBe(20);
        expect(getProactiveCompartmentTriggerPercentage(threshold())).toBe(18);
        expect(
            resolveSchedulerDecision(
                deps.scheduler!,
                sessionMeta(),
                { inputTokens: 284_298, percentage: (284_298 / 917_504) * 100 },
                SESSION,
                deps.getModelKey?.(SESSION),
                917_504,
            ),
        ).toBe("execute");
        models.set(SESSION, { providerID: "opencode", modelID: "mimo-v2.6-flash-free" });
        expect(threshold()).toBe(65);
        expect(
            resolveSchedulerDecision(
                deps.scheduler!,
                sessionMeta(),
                usage,
                SESSION,
                deps.getModelKey?.(SESSION),
                CONTEXT_LIMIT,
            ),
        ).toBe("defer");

        // Absolute token maps must receive the same current key, not the default
        // or the model that produced the preceding response.
        const tokens = createV2ThresholdDeps({
            execute_threshold_percentage: 80,
            execute_threshold_tokens: {
                default: 70_000,
                "opencode/mimo-v2.6-flash-free": 20_000,
            },
        });
        expect(
            resolveSchedulerDecision(
                tokens.scheduler,
                sessionMeta(),
                usage,
                SESSION,
                deps.getModelKey?.(SESSION),
                CONTEXT_LIMIT,
            ),
        ).toBe("execute");
    });

    it("control: at 30% under an 80% threshold with no token threshold, the pass defers", () => {
        const result = pass({ execute_threshold_percentage: 80 });
        expect(result.decision).toBe("defer");
        expect(result.transformThresholdPercentage).toBe(80);
    });

    it("executes a pass over execute_threshold_tokens.default even below the percentage threshold", () => {
        const result = pass({
            execute_threshold_percentage: 80,
            execute_threshold_tokens: { default: 20_000 },
        });
        expect(result.decision).toBe("execute");
    });

    it("gives the transform the token threshold, so its pressure bands start at 20% and not 80%", () => {
        const result = pass({
            execute_threshold_percentage: 80,
            execute_threshold_tokens: { default: 20_000 },
        });
        expect(result.transformThresholdPercentage).toBe(20);
    });
});
