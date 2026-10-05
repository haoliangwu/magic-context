/// <reference types="bun-types" />

/**
 * Verify's per-batch floor on a real OpenCode 1 host.
 *
 * verify used to split its deadline evenly across every 20-memory batch in
 * scope. With 60 memories and a five-minute budget that is 100 s a batch, which
 * a batch taking two minutes can never meet: the first batch timed out, the run
 * threw, nothing was banked, and the scheduler hot-retried the same split.
 *
 * Here each verify batch takes about 120 s. The first batch now gets the 240 s
 * floor and banks its 20 verdicts; the remaining budget cannot give a second
 * batch the floor, so the run stops cleanly instead of starting it.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import {
    assertIsolatedStores,
    countBanked,
    dreamerConfig,
    isVerifyRequest,
    MOCK_USAGE,
    projectIdentity,
    readDreamerInvocations,
    readTaskState,
    seedMappedMemories,
    startDream,
    verifyPromptIds,
} from "./dreamer-timeout-support";

const TASK = "verify-broad";
/** Longer than the old even split (300 s / 3 batches), shorter than the floor. */
const BATCH_MS = 120_000;
const RUN_WAIT_MS = 6 * 60_000;

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({ magicContextConfig: { dreamer: dreamerConfig(TASK, 5) } });
    assertIsolatedStores(h);
});

afterAll(async () => {
    await h?.dispose();
});

it(
    "banks the first batch and stops before a batch that cannot get its floor",
    async () => {
        h.mock.reset();
        h.mock.setDefault({ text: "ack", usage: MOCK_USAGE });
        const verifyRequests: number[][] = [];
        h.mock.addMatcher((body) => {
            if (!isVerifyRequest(body)) return null;
            const ids = verifyPromptIds(body);
            verifyRequests.push(ids);
            return {
                text: `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`,
                usage: MOCK_USAGE,
                delayMs: BATCH_MS,
            };
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "bootstrap turn for the verify budget scenario");
        const identity = projectIdentity(h);
        const ids = seedMappedMemories(h, identity, 60);

        const startedAt = Date.now();
        const dream = startDream(h, sessionId, TASK);
        await h.waitFor(() => readTaskState(h, identity, TASK)?.last_status ?? null, {
            timeoutMs: RUN_WAIT_MS,
            intervalMs: 1_000,
            label: "verify-broad outcome recorded",
        });
        await dream;
        const elapsedMs = Date.now() - startedAt;

        const state = readTaskState(h, identity, TASK);
        const rows = readDreamerInvocations(h, sessionId);
        console.log(
            JSON.stringify({ elapsedMs, state, verifyRequests: verifyRequests.map((r) => r.length), rows }),
        );

        // One batch ran, got past the old 100 s split, and banked all 20 verdicts.
        expect(verifyRequests).toHaveLength(1);
        expect(verifyRequests[0]).toHaveLength(20);
        expect(countBanked(h, ids)).toBe(20);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("completed");
        expect((rows[0]?.ended_at ?? 0) - (rows[0]?.started_at ?? 0)).toBeGreaterThanOrEqual(
            BATCH_MS - 1_000,
        );
        // A resumable broad cycle with progress is a completed run, not a failure
        // that hot-retries the same split.
        expect(state?.last_status).toBe("completed");
        expect(state?.retry_count).toBe(0);
        // The second batch was never started, so the run ended well before the
        // five-minute budget would have run out.
        expect(elapsedMs).toBeLessThan(4 * 60_000);
    },
    RUN_WAIT_MS + 120_000,
);
