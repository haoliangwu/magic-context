/// <reference types="bun-types" />

/**
 * Short-context emergency-drop regression test.
 *
 * Scenario: 128K context, fast main agent, slow historian (3s delay), no user
 * pauses between turns — the autonomous-loop scenario that previously caused
 * silent overflow. Each turn adds ~8KB of assistant text plus tool-like content
 * so that heuristic cleanup and compartment drops have something to reclaim.
 *
 * ## What this verifies
 *
 * BEFORE the emergency bypass fix (transform-postprocess-phase.ts), drops
 * queued by `queueDropsForCompartmentalizedMessages` would sit in pending_ops
 * indefinitely because every transform pass saw `compartmentRunning=true`.
 * The outgoing request body grew without bound and requests failed past 100%.
 *
 * AFTER the fix, when usage crosses `forceMaterializationPercentage` (85%
 * default), pending drops and heuristic cleanup run EVEN WHEN historian is
 * active. This is safe because historian reads raw opencode.db messages and
 * writes to compartments/facts/memories tables, while drops mutate tags and
 * pending_ops — disjoint data.
 *
 * ## Expected behavior
 *
 *   - Drops materialize promptly once pressure crosses 85%
 *   - Peak request stays under 100% of context
 *   - Session survives 20+ back-to-back turns with slow historian
 *
 * ## Known residual limit (not a regression)
 *
 * The plugin's protected tail (last `protected_tags` messages, default 20)
 * is never dropped because recent messages are essential context. In
 * pathological workflows where the protected tail alone exceeds context
 * (e.g., 20 messages × 60KB each > 128K), the plugin cannot prevent
 * overflow. Real workflows stay well under this limit.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { buildMockHistorianPayload } from "../src/mock-historian";

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    // Unique records carry real content mass without tripping OMP's repeated-cycle guard.
    const records: string[] = [];
    let length = header.length;
    for (let record = 0; length < targetBytes; record++) {
        const text = `Record ${turn}-${record}: inspected boundary ${record * 7919} and retained decision ${record * 104729}.\n`;
        records.push(text);
        length += text.length;
    }
    return (header + records.join("")).slice(0, targetBytes);
}

forEachHost(import.meta.url, "short context accumulating overflow", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: 128_000,
            magicContextConfig: {
                execute_threshold_percentage: 40,
                dreamer: { disable: true },
                // This drill measures emergency pressure, not embedding startup latency.
                memory: { auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
                embedding: { provider: "off" },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });
    it(
        "emergency bypass keeps 128K session under 100% with slow historian",
        async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (!isHistorian(body)) return null;
                const msgs = body.messages as Array<{ content?: unknown }> | undefined;
                const flat = JSON.stringify(msgs ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 0;
                const end = rangeHdr ? Number(rangeHdr[2]) : 0;
                return {
                    text: buildMockHistorianPayload({
                        start,
                        end,
                        title: "Build-up",
                        body: "Summary.",
                    }),
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: 3_000,
                };
            });

            let mainCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                mainCalls++;
                const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
                // ~20KB per turn — enough growth to cross 85% within 25 turns
                // so the emergency bypass path is actually exercised.
                const reply = bigReplyText(mainCalls, 20_000);
                return {
                    text: reply,
                    usage: {
                        input_tokens: approxInputTokens,
                        output_tokens: Math.floor(reply.length / 4),
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            const sessionId = await h.createSession();
            const turnUsage: number[] = [];
            const turnErrors: Array<{ turn: number; error: string }> = [];
            const TURNS = 30;
            for (let i = 1; i <= TURNS; i++) {
                const reqBefore = h.mock.requests().length;
                try {
                    await h.sendPrompt(sessionId, `user turn ${i}: continue.`, {
                        timeoutMs: 60_000,
                    });
                } catch (err) {
                    // Track so the test fails if overflow (or any other failure)
                    // kills a turn — previously we silently swallowed this, which
                    // made the test unable to detect the very regression it claims
                    // to guard against.
                    turnErrors.push({
                        turn: i,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                const reqs = h.mock.requests().slice(reqBefore);
                const mainReq = reqs.find((r) => !isHistorian(r.body) &&
                    JSON.stringify(r.body.messages).includes(`user turn ${i}: continue.`));
                if (!mainReq) turnErrors.push({ turn: i, error: "No mock provider request for submitted user turn" });
                const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
                turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
            }

            const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
            const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
            console.log(`[OVERFLOW-GUARD] peak: ${peakObservedPct}% final: ${finalPct}% of 128K`);
            console.log(`[OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
            if (turnErrors.length > 0) {
                console.log(
                    `[OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                    turnErrors
                        .map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`)
                        .join(" | "),
                );
            }

            // The overflow guard is meaningless if prompts were allowed to fail
            // silently. Require all 30 turns to succeed. If this assertion fires,
            // inspect `turnErrors` in the log above to see which turn(s) overflowed
            // or timed out.
            expect(turnErrors).toEqual([]);
            expect(h.mock.requests().filter((r) => isHistorian(r.body)).length).toBeGreaterThan(0);
            h.assertHistorianRequestsUseMock();

            // Verify drops actually materialized in the DB — this is the core
            // fix: pending ops apply even when compartmentRunning at emergency.
            const ctx = h.contextDb();
            const row = ctx
                .prepare("SELECT COUNT(*) AS c FROM tags WHERE status='dropped'")
                .get() as { c: number } | undefined;
            const droppedCount = row?.c ?? 0;
            console.log(`[OVERFLOW-GUARD] dropped tags: ${droppedCount}`);
            expect(droppedCount).toBeGreaterThan(0);

            // Peak should stay under context limit with a margin.
            expect(peakObservedPct).toBeLessThan(100);
        },
        // Bumped from 240s → 600s for CI: this test does ~30 escalating-load
        // turns to drive a 128K-context session past 95% pressure. On idle local
        // hardware this finishes in ~30s, but on GitHub-hosted runners with CPU
        // contention it can take longer.
        600_000,
    );
});
