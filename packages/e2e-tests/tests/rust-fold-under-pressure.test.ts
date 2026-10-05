/// <reference types="bun-types" />

/**
 * Invariant #6: fold under pressure — the exact assertion that would have caught
 * today's incident.
 *
 * When a session grows past the execute threshold, a fold must actually LAND: the
 * served wire shrinks and a materialized m0 (the frozen history head) is present,
 * rather than usage climbing unbounded with zero folds. Today's incident was
 * precisely a session that climbed past threshold while every fold silently
 * failed — this invariant is the guard against that whole class.
 *
 * The hermetic stack supplies a deterministic Broca producer, so this scenario
 * runs in the Rust group and asserts the real fold outcome rather than a skip.
 *
 * Assertion style: wire-size shrink across the fold and presence of the frozen
 * m0 marker, from the fake provider's full request bodies.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust invariant: fold under pressure", () => {

    let h: RustTestHarness;

    beforeEach(async () => {
        // Small context limit + a small execute threshold so a session of tens of
        // real-content turns crosses the fold trigger quickly. The module measures
        // TRUE-RAW content, so pressure must come from real ballast, not mock usage.
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            // The historian gets its own 128k mock model: the 30k session window
            // builds pressure quickly but cannot hold a historian prompt.
            historianModelContextLimit: 128_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "lands a fold when the session grows past the execute threshold (wire shrinks, m0 present)",
        async () => {
            const sessionId = await h.createSession();


            // Grow past the execute threshold with real content mass. Track the
            // peak wire size so the post-fold shrink can be asserted against it.
            let peakWireBytes = 0;
            for (let i = 1; i <= 10; i += 1) {
                h.mock.setDefault({
                    text: `assistant ${i}`,
                    usage: {
                        input_tokens: 3_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `fold-under-pressure turn ${i}: ${h.ballast(2_500)}`);
                peakWireBytes = Math.max(peakWireBytes, h.lastMainWireBytes());
                await Bun.sleep(200);
            }

            // A fold must land: a cache-busting decision (HARD/EXECUTE) appears
            // rather than an unbroken SOFT+ climb.
            const passes = await h.waitForRustPasses(5);
            const foldPass = passes.find((p) =>
                ["HARD", "EXECUTE", "MIGRATE_HARD"].includes(p.decision.toUpperCase()),
            );
            expect(foldPass).toBeDefined();

            // Drive a couple more passes so the post-fold defer wire settles.
            for (let i = 11; i <= 13; i += 1) {
                h.mock.setDefault({
                    text: `post-fold ${i}`,
                    usage: {
                        input_tokens: 8_000,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `fold-under-pressure turn ${i}: ${h.ballast(300)}`);
                await Bun.sleep(200);
            }
            await Bun.sleep(500);

            const foldedWire = h.lastMainWireSerialized();
            const foldedWireBytes = h.lastMainWireBytes();

            // Invariant 1: the wire shrank across the fold — usage did NOT climb
            // unbounded. The post-fold wire is materially smaller than the peak.
            expect(foldedWireBytes).toBeLessThan(peakWireBytes);

            // Invariant 2: a materialized m0 (frozen history head) is present,
            // carrying the folded compartment summary rather than raw turns.
            expect(foldedWire).toContain("Rust fold e2e chunk");
            // The first (synthetic) message is the history head, not a raw turn.
            const firstMessage = h.lastMainMessages()[0];
            expect(JSON.stringify(firstMessage)).toContain("<session-history>");
        },
        300_000,
    );
});
