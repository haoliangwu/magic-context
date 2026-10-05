import { describe, expect, test } from "bun:test";
import { MagicContextConfigSchema } from "../../../config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "./task-config";
import { DREAM_TOOL_LOOP_TOKEN_BUDGETS } from "./task-registry";
import { createDreamTokenBudget, TOKEN_BUDGET_FINALIZE_MESSAGE } from "./token-budget";

describe("dreamer prompt-token budget", () => {
    test("uses per-task defaults and validates explicit overrides", () => {
        const config = MagicContextConfigSchema.parse({
            dreamer: { tasks: { verify: { token_budget: 750_000 } } },
        });
        const tasks = buildDreamTaskRuntimeConfigs(config.dreamer, "opencode");
        expect(tasks.find((task) => task.task === "verify")?.tokenBudget).toBe(750_000);
        expect(tasks.find((task) => task.task === "map-memories")?.tokenBudget).toBe(
            DREAM_TOOL_LOOP_TOKEN_BUDGETS["map-memories"],
        );
        expect(
            tasks.find((task) => task.task === "classify-memories")?.tokenBudget,
        ).toBeUndefined();
        expect(() =>
            MagicContextConfigSchema.parse({ dreamer: { tasks: { verify: { token_budget: 0 } } } }),
        ).toThrow();
    });
    test("sizes memory tool-loop defaults for twenty-memory batches without changing other budgets", () => {
        const tasks = buildDreamTaskRuntimeConfigs(
            MagicContextConfigSchema.parse({}).dreamer,
            "opencode",
        );
        expect(tasks.find((task) => task.task === "verify")?.tokenBudget).toBe(2_500_000);
        expect(tasks.find((task) => task.task === "verify-broad")?.tokenBudget).toBe(3_000_000);
        expect(tasks.find((task) => task.task === "map-memories")?.tokenBudget).toBe(2_500_000);
        expect(tasks.find((task) => task.task === "curate")?.tokenBudget).toBe(1_500_000);
        expect(tasks.find((task) => task.task === "retrospective")?.tokenBudget).toBe(300_000);
        expect(tasks.find((task) => task.task === "maintain-docs")?.tokenBudget).toBe(1_600_000);
        expect(tasks.find((task) => task.task === "refresh-primers")?.tokenBudget).toBe(350_000);
    });
    test("does not finalize work under the soft limit", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(30, 40, 9)).toBe("continue");
        expect(guard.snapshot()).toMatchObject({ spent: 79, finalizeFired: false });
        expect(guard.refuseTool()).toBeNull();
    });

    test("fires once at the soft limit", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(10, 70, 0)).toBe("finalize");
        expect(TOKEN_BUDGET_FINALIZE_MESSAGE).toContain("no more tool calls");
        expect(guard.charge(1, 0, 0)).toBe("continue");
        expect(guard.snapshot().finalizeFired).toBe(true);
    });

    test("refuses tools after finalize and stops after the second refusal", () => {
        const guard = createDreamTokenBudget(100);
        guard.charge(80, 0, 0);
        expect(guard.refuseTool()).toMatchObject({ hardStopped: false });
        expect(guard.refuseTool()).toMatchObject({ hardStopped: true });
    });

    test("hard-stops at soft threshold without claiming a finalize when tools cannot be intercepted", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(81, 0, 0, false, false)).toBe("stop");
        expect(guard.snapshot()).toMatchObject({
            spent: 81,
            finalizeFired: false,
            hardStopped: true,
        });
    });

    test("keeps a completed finalize answer even when its usage exceeds the budget", () => {
        const guard = createDreamTokenBudget(1_400_000);
        for (let step = 0; step < 9; step++)
            expect(guard.charge(20_000, 100_000, 0)).toBe("continue");
        expect(guard.charge(20_000, 100_000, 0)).toBe("finalize");
        expect(guard.charge(120_000, 120_000, 0, true)).toBe("continue");
        expect(guard.snapshot()).toMatchObject({ spent: 1_440_000, hardStopped: true });
        expect(guard.refuseTool()).toMatchObject({ hardStopped: true });
    });

    test("keeps an already completed answer when coarse usage skips the soft limit", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(110, 0, 0, true)).toBe("continue");
        expect(guard.snapshot()).toMatchObject({ hardStopped: true, finalizeFired: false });
        expect(guard.refuseTool()).toMatchObject({ hardStopped: true });
    });

    test("stops at 100 percent even without two refusals", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(90, 0, 0)).toBe("finalize");
        expect(guard.charge(0, 5, 5)).toBe("stop");
        expect(guard.snapshot()).toMatchObject({ spent: 100, hardStopped: true });
    });
});
