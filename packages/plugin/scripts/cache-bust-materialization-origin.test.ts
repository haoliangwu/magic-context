import { expect, it } from "bun:test";
import { classifyCacheBust } from "./cache-bust-attribution";

for (const [origin, expected] of [
    ["user_flush", "accounted_ctx_flush"],
    ["explicit_flush", "accounted_ctx_flush"],
    ["fit_retry", "accounted_force_band"],
    ["system_hash", "accounted_hard_system_hash"],
] as const) {
    it(`cache bust attribution separates ${origin} from user flush`, () => {
        expect(classifyCacheBust({
            divergenceIndex: 0,
            previousMessageCount: 8,
            providerComparableRead: 10_000,
            previousTotal: 12_000,
            decision: {
                timestampMs: 1,
                decision: "defer",
                materialized: true,
                materializeReason: origin,
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 12_000,
                flush: false,
                source: "fixture",
            },
        })).toBe(expected);
    });
}
