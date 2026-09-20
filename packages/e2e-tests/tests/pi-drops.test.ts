/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

let h: PiTestHarness;

beforeAll(async () => {
    // Pending operations apply only on a cache-busting pass. Use a supported
    // model window and a force-band uncached-input sample, then put enough real
    // message blocks after the target for it to leave the protected tail before
    // the next pass materializes the queued drop.
    h = await PiTestHarness.create({
        modelContextLimit: 20_000,
        magicContextConfig: { protected_tokens: 4_000, execute_threshold_percentage: 20 },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi drops", () => {
    it("drains pending_ops when drops are queued", async () => {
        h.mock.reset();
        h.mock.setDefault({
            content: Array.from({ length: 24 }, (_, index) => ({
                type: "text",
                text: `pi drop aging block ${index + 1}: ${h.ballast(200)}`,
            })),
            usage: { input_tokens: 18_000, output_tokens: 10, cache_creation_input_tokens: 0 },
        });

        const first = await h.sendPrompt("first pi drop target", { timeoutMs: 60_000 });
        expect(first.sessionId).toBeTruthy();
        await h.waitFor(() => h.countTags(first.sessionId!) > 0, { label: "tag ready" });

        const writable = openTestDb(h.contextDbPath());
        try {
            writable
                .prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, 'pi')",
                )
                .run(first.sessionId!, Date.now());
        } finally {
            writable.close();
        }

        h.mock.reset();
        h.mock.setDefault({
            text: "second response",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0 },
        });
        const second = await h.sendPrompt("second Pi turn force-busts and drains pending ops", {
            timeoutMs: 60_000,
            continueSession: true,
        });
        expect(second.exitCode).toBeNull();

        expect(h.countPendingOps(first.sessionId!)).toBe(0);
        expect(h.countDroppedTags(first.sessionId!)).toBeGreaterThan(0);
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("dropped §1§");
    }, 60_000);
});
