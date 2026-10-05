/**
 * Real-provider acceptance of old-reasoning removal. Makes billed calls with keys from
 * CKCRED, so it is skipped unless MC_LIVE_PROVIDERS=1 and is excluded from every CI lane in
 * mode-manifest.json. See src/live-providers/runner.ts for what each scenario does.
 *
 *   MC_LIVE_PROVIDERS=1 MC_LIVE_OPENCODE=/abs/opencode-1.18.30 \
 *     bun test tests/live-providers.test.ts --timeout 3600000
 *
 * MC_LIVE_PROVIDER_IDS narrows the run to some OpenCode provider ids
 * (e.g. `amazon-bedrock,kimi-for-coding`).
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runAll } from "../src/live-providers/runner";

const live = process.env.MC_LIVE_PROVIDERS === "1";

describe.skipIf(!live)("live providers: reasoning removal acceptance", () => {
    it("every provider accepts requests after old reasoning leaves the wire", async () => {
        const opencode = process.env.MC_LIVE_OPENCODE;
        if (!opencode) throw new Error("Set MC_LIVE_OPENCODE to an OpenCode 1.18.30 binary");
        const out = join(
            process.env.TMPDIR ?? "/tmp",
            "magic-context",
            "live-providers",
            `test-${Date.now().toString(36)}`,
        );
        const results = await runAll({
            opencode,
            out,
            only: null,
            providers: process.env.MC_LIVE_PROVIDER_IDS?.split(",") ?? null,
            modelsCatalog: process.env.MC_LIVE_MODELS_CATALOG,
        });
        expect(results.length).toBeGreaterThan(0);
        for (const result of results) {
            // Every host ran inside its throwaway root, and the root (with the key) is gone.
            expect(result.isolation.rootRemoved).toBe(true);
            if (result.outcome !== "completed") continue;
            expect({ scenario: result.scenario, accepted: result.summary.acceptedAfterRemoval }).toEqual({
                scenario: result.scenario,
                accepted: result.summary.firstRemovalCall === null ? null : true,
            });
        }
    }, 3_600_000);
});
