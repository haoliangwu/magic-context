/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import {
    type EmergencyDropTag,
    estimateEmergencyDropReclaimTokens,
    planEmergencyDrop,
    resolveToolTier,
    TARGET_FRACTION,
} from "./emergency-drop";

// Most tests exercise selection/latch logic where the floor set equals the
// candidate set; planWithFloor keeps them on the old single-set shape. The
// floorTags/tags split itself is covered by the dedicated regression test.
function planWithFloor(
    input: Omit<Parameters<typeof planEmergencyDrop>[0], "floorTags"> & {
        floorTags?: readonly EmergencyDropTag[];
    },
) {
    return planEmergencyDrop({ ...input, floorTags: input.floorTags ?? input.tags });
}

function tag(
    tagNumber: number,
    toolName: string | null,
    byteSize: number,
    opts: Partial<EmergencyDropTag> = {},
): EmergencyDropTag {
    return {
        tagNumber,
        type: "tool",
        status: "active",
        toolName,
        byteSize,
        inputByteSize: 0,
        reasoningByteSize: 0,
        ...opts,
    };
}

describe("resolveToolTier", () => {
    it("classifies T1 navigation/structure tools", () => {
        for (const name of ["read", "todowrite", "task", "aft_outline", "aft_zoom"]) {
            expect(resolveToolTier(name)).toBe(1);
        }
    });

    it("classifies T2 edit/search tools", () => {
        for (const name of ["edit", "write", "apply_patch", "grep", "glob", "aft_search"]) {
            expect(resolveToolTier(name)).toBe(2);
        }
    });

    it("classifies everything else as T3 (drop-first default)", () => {
        for (const name of ["bash", "ctx_reduce", "aft_inspect", "webfetch", "unknown_tool"]) {
            expect(resolveToolTier(name)).toBe(3);
        }
    });

    it("normalizes mcp_ prefix and case so prefixed names still tier correctly", () => {
        expect(resolveToolTier("mcp_read")).toBe(1);
        expect(resolveToolTier("MCP_Edit")).toBe(2);
        expect(resolveToolTier("Bash")).toBe(3);
    });

    it("treats null tool name as T3", () => {
        expect(resolveToolTier(null)).toBe(3);
    });
});

describe("planEmergencyDrop — guards", () => {
    const base = {
        maxTag: 10,
        protectedCutoff: null,
        hasPriorDrop: false,
        priorInputSample: 0,
    };

    it("skips when the ceiling is unknown/invalid", () => {
        const plan = planWithFloor({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 100_000,
            ceilingTokens: 0,
        });
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toBe("unknown-ceiling");
    });

    it("no-ops when already at/under target (reclaim <= min)", () => {
        const plan = planWithFloor({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 1_000,
            ceilingTokens: 100_000,
        });
        expect(plan.shouldDrop).toBe(false);
    });
});

describe("planEmergencyDrop — floorTags/tags split", () => {
    it("reclaims to the true target when substantial non-tool tail exists (audit repro)", () => {
        // Audit repro: 170k total, 130k ceiling, live tail = 60k active
        // non-tool (conversation/reasoning) + 80k droppable tool; true fixed
        // overhead = 30k. Correct: floor=30k → target=60k → reclaim=110k →
        // ALL tool tags must go. The old tool-only floor computed floor=90k →
        // target=102k → reclaim=68k and left tool output behind.
        const TOKENS_PER_BYTE = 0.25; // mirror of emergency-drop internal ratio
        const toTokens = (bytes: number) => Math.round(bytes * TOKENS_PER_BYTE);

        // 80k tokens of droppable tool output across 8 tags (10k tokens each).
        const toolTags = Array.from({ length: 8 }, (_, i) =>
            tag(i + 1, "bash", 10_000 / TOKENS_PER_BYTE),
        );
        // 60k tokens of active message/file tail — floor accounting only.
        const messageTags = Array.from({ length: 6 }, (_, i) =>
            tag(i + 101, null, 10_000 / TOKENS_PER_BYTE, { type: "message" }),
        );
        expect(toolTags.reduce((s, t) => s + toTokens(t.byteSize), 0)).toBe(80_000);
        expect(messageTags.reduce((s, t) => s + toTokens(t.byteSize), 0)).toBe(60_000);

        const plan = planEmergencyDrop({
            tags: toolTags,
            floorTags: [...toolTags, ...messageTags],
            maxTag: 200,
            protectedCutoff: null,
            currentTotalInputTokens: 170_000,
            ceilingTokens: 130_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });

        expect(plan.shouldDrop).toBe(true);
        // floor = 170k − 140k = 30k; target = 30k + 0.3·100k = 60k; reclaim 110k.
        expect(plan.reclaimTokens).toBe(110_000);
        // Reclaim need (110k) exceeds the whole droppable pile (80k) → every
        // tool tag is selected; non-tool tags are never selected.
        expect(plan.tagNumbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("never selects non-tool tags even when they dominate the floor set", () => {
        const toolTags = [tag(1, "bash", 40_000)];
        const messageTags = [
            tag(50, null, 400_000, { type: "message" }),
            tag(51, null, 400_000, { type: "file" }),
        ];
        const plan = planEmergencyDrop({
            tags: toolTags,
            floorTags: [...toolTags, ...messageTags],
            maxTag: 60,
            protectedCutoff: null,
            currentTotalInputTokens: 300_000,
            ceilingTokens: 200_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1]);
    });
});

describe("planEmergencyDrop — target math", () => {
    it("turns a converted 1.09M provider sample into a non-empty emergency batch", () => {
        const toolTags = Array.from({ length: 3 }, (_, index) =>
            tag(index + 1, "read", 1, {
                servedTokens: 315_000,
                reclaimableTokens: 315_000,
            }),
        );
        const base = {
            tags: toolTags,
            floorTags: toolTags,
            maxTag: 3,
            protectedCutoff: null,
            ceilingTokens: 681_574,
            priorInputSample: 0,
            hasPriorDrop: false,
            usagePercentage: 104,
        };

        const underestimated = planEmergencyDrop({
            ...base,
            currentTotalInputTokens: 56_180,
        });
        const providerSized = planEmergencyDrop({
            ...base,
            currentTotalInputTokens: 1_091_002,
        });

        expect(underestimated.tagNumbers).toHaveLength(0);
        expect(underestimated.reason).toContain("reclaim<=min");
        expect(providerSized.shouldDrop).toBe(true);
        expect(providerSized.tagNumbers).toHaveLength(3);
        expect(providerSized.reclaimTokens).toBeGreaterThan(700_000);
    });

    it("computes target = fixedFloor + 0.30 × (ceiling − fixedFloor)", () => {
        // 10 tags × 4000 bytes × 0.25 = 10000 tail tokens; usage 30000 →
        // fixedFloor = 30000 - 10000 = 20000. ceiling 160000 →
        // workingSpan 140000, target = 20000 + 0.30×140000 = 62000,
        // reclaim = 30000 - 62000 < 0 → no-op (under target).
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 4000));
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 30_000,
            ceilingTokens: 160_000,
        });
        expect(TARGET_FRACTION).toBe(0.3);
        expect(plan.shouldDrop).toBe(false); // already under the 62k target
    });

    it("reclaims down toward target, dropping oldest T3 first", () => {
        // 20 tags × 2000 bytes × 0.25 = 10000 tail tokens; usage 10000,
        // fixedFloor ≈ 0, ceiling 6000 → target 1800 → reclaim ≈ 8200.
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 2000));
        const plan = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: 19,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 6_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // oldest first
        expect(plan.tagNumbers[0]).toBe(1);
        // never drops the protected tail (19, 20)
        expect(plan.tagNumbers).not.toContain(19);
        expect(plan.tagNumbers).not.toContain(20);
    });

    it("latches the whole force-pressure episode across fresh usage samples", () => {
        // 20 T3 tags × 1000 bytes (≈250 tokens each). currentTotal 100k, ceiling
        // 60k. First pass drops down to target and latches the usage sample.
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 1000));
        const first = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: null,
            currentTotalInputTokens: 100_000,
            ceilingTokens: 60_000,
            hasPriorDrop: false,
            priorInputSample: 0,
        });
        expect(first.shouldDrop).toBe(true);
        // Second ≥85% pass BEFORE the provider re-measures: same stale
        // currentTotalInputTokens, sample latched. Must NO-OP — not re-derive
        // and drop the rest of the tail (which would bust the cache again).
        const second = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: null,
            currentTotalInputTokens: 100_000, // unchanged — provider hasn't re-measured
            ceilingTokens: 60_000,
            hasPriorDrop: true,
            priorInputSample: 100_000, // latched from the first drop
        });
        expect(second.shouldDrop).toBe(false);
        expect(second.reason).toContain("pressure-episode-latched");
        // A fresh provider sample is still the same pressure LEVEL, not a new
        // application edge. The caller explicitly rearms only after force-band
        // exit or an independent provider-visible mutation.
        const third = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: null,
            currentTotalInputTokens: 95_000,
            ceilingTokens: 60_000,
            hasPriorDrop: true,
            priorInputSample: 100_000,
        });
        expect(third.shouldDrop).toBe(false);
        expect(third.reason).toContain("pressure-episode-latched");
    });

    it("counts tool input + reasoning bytes in BOTH floor and reclaim (no under-evict)", () => {
        // A single huge-input/tiny-output tool (e.g. write/apply_patch): output
        // is 400 bytes but the invocation args are 40000 bytes. The drop removes
        // all of it, so reclaim must count input bytes — otherwise the planner
        // sees ~no droppable tail and no-ops into overflow.
        const big = tag(1, "write", 400, { inputByteSize: 40_000, reasoningByteSize: 8_000 });
        const small = tag(2, "bash", 800);
        const plan = planWithFloor({
            tags: [big, small],
            maxTag: 2,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            // tail = (400+40000+8000 + 800) × 0.25 = 12300; floor = 20000-12300
            // = 7700; ceiling 12000 → target 7700+0.3×4300 = 8990 →
            // reclaim ≈ 11010. Dropping `big` alone reclaims (48400)×0.25 = 12100
            // ≥ reclaim → met without touching `small`.
            currentTotalInputTokens: 20_000,
            ceilingTokens: 12_000,
            // At 95% the T1/T2 recency reserve yields, so `big` is selectable.
            // Below it, `big` is the reserved newest T2 and `small` alone would
            // reclaim 200 tokens, which the minimum achievable reclaim rejects.
            usagePercentage: 95,
        });
        expect(plan.shouldDrop).toBe(true);
        // `big` (T2) is NOT dropped before T3 `small` — tier order wins — but
        // the key assertion is that the plan reclaims enough: it must include
        // `small` (T3, dropped first) and the math must recognize `big`'s value.
        expect(plan.tagNumbers).toContain(2); // T3 dropped first
        // The reclaim target (~11010) exceeds what output-only accounting would
        // see for these tags (300 tokens), proving input/reasoning are counted.
        expect(plan.reclaimTokens).toBeGreaterThan(10_000);
    });
});

describe("planEmergencyDrop — tier ordering", () => {
    it("protects newest ctx_reduce exemplars in the emergency band instead of evicting them as T3", () => {
        const tags = Array.from({ length: 5 }, (_, index) => tag(index + 1, "ctx_reduce", 4_000));
        const plan = planWithFloor({
            tags,
            maxTag: 5,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1, 2]);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("drops T3 before T2 before T1", () => {
        // Mix of tiers, all same size. reclaim forces dropping several.
        const tags = [
            tag(1, "read", 4000), // T1
            tag(2, "edit", 4000), // T2
            tag(3, "bash", 4000), // T3
            tag(4, "read", 4000), // T1
            tag(5, "edit", 4000), // T2
            tag(6, "bash", 4000), // T3
        ];
        // tail = 6×1000 = 6000 tokens; usage 6000, ceiling 1000 →
        // target 300 → reclaim ≈ 5700 → must drop almost everything.
        const plan = planWithFloor({
            tags,
            maxTag: 6,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // T3 (3, 6) come first in eviction order.
        const firstTwo = plan.tagNumbers.slice(0, 2).sort((a, b) => a - b);
        expect(firstTwo).toEqual([3, 6]);
    });

    it("reserves the newest 20% of T1/T2 tiers (ceil), never T3", () => {
        // 10 T2 edits. reserve = ceil(0.2×10) = 2 newest (tags 9,10).
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "edit", 8000));
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000, // tail = 10×2000 = 20000
            ceilingTokens: 1_000, // target ≈ 300 → reclaim huge
        });
        expect(plan.shouldDrop).toBe(true);
        // newest 2 of the T2 tier are reserved.
        expect(plan.tagNumbers).not.toContain(9);
        expect(plan.tagNumbers).not.toContain(10);
        // older ones are evictable.
        expect(plan.tagNumbers).toContain(1);
    });

    it("a tiny T1/T2 tier reserves all of it (ceil keeps >=1)", () => {
        const tags = [tag(1, "read", 8000), tag(2, "bash", 8000)];
        // tail 4000 tokens, usage 4000, ceiling 500 → reclaim huge.
        const plan = planWithFloor({
            tags,
            maxTag: 2,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 4_000,
            ceilingTokens: 500,
        });
        // T1 read (tag 1) is the entire T1 tier → reserved (ceil(0.2×1)=1).
        expect(plan.tagNumbers).not.toContain(1);
        // T3 bash is fully depletable.
        expect(plan.tagNumbers).toContain(2);
    });
});

describe("planEmergencyDrop — idempotence via status='active' (no scalar watermark)", () => {
    it("re-considers ALL still-active tags (no scalar-watermark exclusion of lower tags)", () => {
        // The regression the scalar watermark caused: after a prior pass dropped
        // high-numbered tags, lower-numbered tags that are STILL active must
        // remain eligible. Here tags 6-10 are active and droppable; tags 1-5 were
        // dropped in a prior pass (status='dropped') so they're naturally skipped.
        const tags = [
            ...Array.from({ length: 5 }, (_, i) =>
                tag(i + 1, "bash", 4000, { status: "dropped" as const }),
            ),
            ...Array.from({ length: 5 }, (_, i) => tag(i + 6, "bash", 4000)),
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: null,
            hasPriorDrop: false,
            // The caller reset the episode latch to 0 because another mutation
            // already priced this pass, so newly eligible tags may ride it.
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        // dropped tags are never reselected (status guard)…
        for (const n of [1, 2, 3, 4, 5]) expect(plan.tagNumbers).not.toContain(n);
        // …but every still-ACTIVE tag is eligible, oldest-first.
        expect(plan.tagNumbers[0]).toBe(6);
    });

    it("no-ops when every active tag is already dropped", () => {
        const tags = Array.from({ length: 5 }, (_, i) =>
            tag(i + 1, "bash", 4000, { status: "dropped" as const }),
        );
        const plan = planWithFloor({
            tags,
            maxTag: 5,
            protectedCutoff: null,
            hasPriorDrop: true,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        // No active tail → no-ops (whether via reclaim<=min or no-candidates).
        expect(plan.shouldDrop).toBe(false);
        expect(plan.tagNumbers).toEqual([]);
    });

    it("ignores already-dropped tags (status='dropped' is the re-selection guard)", () => {
        const tags = [
            tag(1, "bash", 4000, { status: "dropped" }),
            tag(2, "bash", 4000),
            tag(3, "bash", 4000),
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 3,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 3_000,
            ceilingTokens: 200,
        });
        expect(plan.tagNumbers).not.toContain(1);
    });
});

describe("planEmergencyDrop — token protection window cutoff & >=95% yield (#423 parity)", () => {
    it("consumes exact tag-number cutoff directly in tag-number coordinate space", () => {
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 2000));
        // Cutoff = 8 in tag-number coordinate space. Tags 8, 9, 10 are protected.
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: 8,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 2_000,
            usagePercentage: 85,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toContain(1);
        expect(plan.tagNumbers).not.toContain(8);
        expect(plan.tagNumbers).not.toContain(9);
        expect(plan.tagNumbers).not.toContain(10);
    });

    it("branches on absent cutoff (null) applying no tag-number threshold (empty window)", () => {
        const tags = [tag(1, "bash", 10_000), tag(2, "bash", 10_000)];
        const plan = planWithFloor({
            tags,
            maxTag: 2,
            protectedCutoff: null, // absent cutoff
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 10_000,
            usagePercentage: 85,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toContain(1);
        expect(plan.tagNumbers).toContain(2);
    });

    it("yields the window at >=95% usage (#423 parity)", () => {
        const tags = [tag(1, "bash", 10_000), tag(2, "bash", 10_000), tag(3, "bash", 10_000)];
        // Cutoff 1 would normally protect tags 1, 2, 3
        const plan = planWithFloor({
            tags,
            maxTag: 3,
            protectedCutoff: 1,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 10_000,
            usagePercentage: 95, // absolute emergency >= 95% -> window yields
        });

        expect(plan.shouldDrop).toBe(true);
        // Window yielded -> tags are dropped
        expect(plan.tagNumbers.length).toBeGreaterThan(0);
    });

    it("at 94% a fully-protected candidate set degrades to noop('no-candidates') without consuming episode latch", () => {
        const tags = [tag(10, "bash", 10_000), tag(11, "bash", 10_000)];
        // Cutoff 10 protects all candidate tags
        const plan = planWithFloor({
            tags,
            maxTag: 11,
            protectedCutoff: 10,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 10_000,
            usagePercentage: 94, // 94% < 95% -> window does NOT yield
        });

        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason.startsWith("no-candidates")).toBe(true);
        // The fixed floor (15000) alone exceeds the 10000 ceiling; the reason says so.
        expect(plan.reason).toContain("already exceeds ceiling 10000");
        // Episode latch remains unconsumed (plan returned shouldDrop: false)
    });
});

it("reclaim measurement charges retained skeleton tokens instead of original tag bytes", () => {
    expect(
        estimateEmergencyDropReclaimTokens({
            tagNumber: 1,
            type: "tool",
            status: "active",
            toolName: "read",
            byteSize: 400000,
            inputByteSize: 0,
            reasoningByteSize: 0,
            servedTokens: 15516.39,
            reclaimableTokens: 13964.751,
        }),
    ).toBe(13964.751);
});

describe("planEmergencyDrop — minimum achievable reclaim", () => {
    // Shape of the live worker that sat at 100% for an hour: the fixed floor
    // (~326K) is already above the ceiling (~251K), almost every tool output is
    // dropped, and the only candidate is a fresh result worth ~149 tokens.
    const workerShape = (extra: Partial<Parameters<typeof planEmergencyDrop>[0]> = {}) => {
        const fresh = tag(330, "bash", 596); // 596 bytes x 0.25 = 149 tokens
        const conversation = tag(1, null, 36_204, { type: "message" }); // ~9,051 tokens
        return planEmergencyDrop({
            tags: [fresh],
            floorTags: [fresh, conversation],
            maxTag: 330,
            protectedCutoff: null,
            usagePercentage: 100,
            currentTotalInputTokens: 335_200,
            ceilingTokens: 251_000,
            priorInputSample: 0,
            hasPriorDrop: false,
            ...extra,
        });
    };

    it("skips a pass whose selection reclaims less than the minimum, and says the floor is above the ceiling", () => {
        const plan = workerShape();
        expect(plan.shouldDrop).toBe(false);
        expect(plan.tagNumbers).toEqual([]);
        expect(plan.reason).toContain("achievable reclaim below minimum");
        expect(plan.reason).toContain("reclaim≈149 < 2000");
        expect(plan.reason).toContain("already exceeds ceiling 251000");
    });

    it("lets the same small selection ride a pass another mutation already prices", () => {
        const plan = workerShape({ passAlreadyPriced: true });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([330]);
    });

    it("commits a selection that reaches the minimum", () => {
        const big = tag(10, "bash", 12_000); // 3,000 tokens
        const fresh = tag(330, "bash", 596);
        const conversation = tag(1, null, 36_204, { type: "message" });
        const plan = planEmergencyDrop({
            tags: [big, fresh],
            floorTags: [big, fresh, conversation],
            maxTag: 330,
            protectedCutoff: null,
            usagePercentage: 100,
            currentTotalInputTokens: 338_200,
            ceilingTokens: 251_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([10, 330]);
        expect(plan.reason).toContain("already exceeds ceiling 251000");
    });
});
