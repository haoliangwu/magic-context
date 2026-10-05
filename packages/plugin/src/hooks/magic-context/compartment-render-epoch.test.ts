import { describe, expect, test } from "bun:test";

import {
    decodeCachedM0UpgradeIdentity,
    encodeCachedM0UpgradeIdentity,
    renderedBudgetShrinkReason,
    renderedBudgetSnapshot,
} from "./compartment-render-epoch";

describe("legacy upgrade-identity crossing (R3 F7)", () => {
    test("a legacy encoded identity without mural/budget components decodes to null components", () => {
        // Rows written before mural/budget joined the identity decode to null
        // components; the mustMaterialize comparison must adopt, not fold the
        // fleet once at upgrade.
        const legacy = encodeCachedM0UpgradeIdentity("upgrade-v2", "cre2", null, null, null);
        const decoded = decodeCachedM0UpgradeIdentity(legacy);
        expect(decoded.memoryRenderEpoch).toBeNull();
        expect(decoded.muralEnabled).toBeNull();
        expect(decoded.renderBudgetIdentity).toBeNull();
    });

    test("a recorded mural component round-trips and discriminates", () => {
        const recorded = encodeCachedM0UpgradeIdentity("upgrade-v2", "cre2", true, "m15000-h96000");
        const decoded = decodeCachedM0UpgradeIdentity(recorded);
        expect(decoded.memoryRenderEpoch).toBe("mre3");
        expect(decoded.muralEnabled).toBe(true);
        expect(decoded.renderBudgetIdentity).toBe("m15000-h96000");
    });
});

describe("rendered budget contraction", () => {
    test("round-trips numeric allowances separately from policy and keeps legacy components absent", () => {
        const value = encodeCachedM0UpgradeIdentity(
            "ready",
            "cre2",
            false,
            "m4000-hp0.15:percentage:40",
            "mre3",
            renderedBudgetSnapshot(4000, 12000),
        );
        expect(decodeCachedM0UpgradeIdentity(value)).toMatchObject({
            upgradeState: "ready",
            renderBudgetIdentity: "m4000-hp0.15:percentage:40",
            renderedBudgets: "m4000-h12000",
        });
        expect(decodeCachedM0UpgradeIdentity(null).renderedBudgets).toBeNull();
        expect(
            decodeCachedM0UpgradeIdentity(encodeCachedM0UpgradeIdentity("ready")).renderedBudgets,
        ).toBeNull();
        expect(
            decodeCachedM0UpgradeIdentity("|rendered-budgets:m4000-h12000").upgradeState,
        ).toBeNull();
    });

    test("ignores growth and noise but catches cumulative history or memory shrink", () => {
        const baseline = renderedBudgetSnapshot(4000, 12000);
        expect(renderedBudgetShrinkReason(baseline, "m8000-h24000")).toBeNull();
        expect(renderedBudgetShrinkReason(baseline, "m3936-h11880")).toBeNull();
        expect(renderedBudgetShrinkReason(baseline, "m4000-h11879")).toBe(
            "render_config:budget_shrink(m4000-h12000→m4000-h11879)",
        );
        expect(renderedBudgetShrinkReason(baseline, "m3935-h12000")).toBe(
            "render_config:budget_shrink(m4000-h12000→m3935-h12000)",
        );
        expect(renderedBudgetShrinkReason("m4000-h100000", "m4000-h99000")).toBeNull();
        expect(renderedBudgetShrinkReason("m4000-h100000", "m4000-h98999")).not.toBeNull();
        expect(renderedBudgetShrinkReason(null, "m1-h1")).toBeNull();
        expect(renderedBudgetShrinkReason("mNaN-h12000", "m1-h1")).toBeNull();
        expect(renderedBudgetShrinkReason(baseline, "m1-hInfinity")).toBeNull();
    });
});
