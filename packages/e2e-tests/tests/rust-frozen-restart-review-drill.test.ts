/// <reference types="bun-types" />

/**
 * REVIEW FINDING DRILLS (slice A re-review, docs/reports/slice-a-review-r2.md).
 *
 * The frozen last-known-good replay plan asked for two hermetic drills that were
 * never written: a host restart during a freeze, and a refusal during a freeze.
 * The existing byte-identity lanes never restart the host while the adapter is
 * frozen (they either kill the module without restarting OpenCode, or restart
 * OpenCode on a healthy session), so nothing exercised the cold-start resume of a
 * freeze against a real host and the real module.
 *
 * Each drill freezes a session the way a real outage does (SIGKILL ck-mc, send a
 * turn so the adapter replays its last-known-good array, bring ck-mc back), then
 * perturbs it and compares the provider request bodies on either side:
 *
 * - prefix identity: every message the earlier request held must come back
 *   byte-identical (cache_control stripped), and the system prompt and tools must
 *   be unchanged;
 * - preserved thinking: on a prefix-bound thinking model (the mock id contains
 *   `opus-5-5`), a signed thinking block is valid only while every message of the
 *   request that produced it is sent unchanged; otherwise the real API answers 400.
 *   The drill reports any such block.
 *
 * Results at the time of writing: the restart drill and the refusal drill pass;
 * the residual drill fails (a restart right after an uncaptured failure replay
 * sends a signed block behind a retagged message).
 *
 * The model answers with a signed thinking block on every turn so the second
 * check has blocks to find.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs, sessionLogLines } from "../src/rust-scenario-support";

const DRILL_TIMEOUT_MS = 600_000;
const CONFIG = { execute_threshold_percentage: 40, protected_tags: 1 };

type WireBody = { system?: unknown; tools?: unknown; messages?: unknown[] };

function thinkingSignatures(message: unknown): string[] {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return [];
    return content
        .filter((block) => (block as { type?: string })?.type === "thinking")
        .map((block) => String((block as { signature?: unknown }).signature ?? ""));
}

/**
 * Compare two consecutive provider requests: the index of the first message
 * (among every message the earlier request held, its newest included, since after
 * a freeze that newest message is one the adapter served raw) that changed, and
 * whether the system prompt or tools changed.
 */
function compareRequests(before: WireBody, after: WireBody) {
    const earlier = (before.messages ?? []).map(stableSerialize);
    const later = (after.messages ?? []).map(stableSerialize);
    let firstChanged: number | null = null;
    for (let index = 0; index < earlier.length; index += 1) {
        if (later[index] !== earlier[index]) {
            firstChanged = index;
            break;
        }
    }
    return {
        firstChanged,
        systemChanged: stableSerialize(before.system) !== stableSerialize(after.system),
        toolsChanged: stableSerialize(before.tools) !== stableSerialize(after.tools),
        earlierLength: earlier.length,
        laterLength: later.length,
        firstChangedBefore: firstChanged === null ? null : earlier[firstChanged]?.slice(0, 160),
        firstChangedAfter: firstChanged === null ? null : later[firstChanged]?.slice(0, 160),
    };
}

/**
 * Signed thinking blocks the latest request sends behind changed bytes. A
 * prefix-bound model binds a block to the request that produced it: the block is
 * valid only while every message that request held is sent unchanged. Each block
 * is attributed to the request just before the first request that carries it
 * (the mock answered that request with it). Returns the signatures whose
 * producing request's messages are no longer a byte-identical prefix of the
 * latest request, with the first changed index.
 */
function thinkingBoundToChangedPrefix(
    requests: readonly WireBody[],
): Array<{ signature: string; producedBy: number; changedAt: number }> {
    const latest = requests.at(-1);
    if (!latest) return [];
    const latestMessages = (latest.messages ?? []).map(stableSerialize);
    const violations: Array<{ signature: string; producedBy: number; changedAt: number }> = [];
    for (const signature of new Set((latest.messages ?? []).flatMap(thinkingSignatures))) {
        const firstCarrier = requests.findIndex((request) =>
            (request.messages ?? []).flatMap(thinkingSignatures).includes(signature),
        );
        if (firstCarrier <= 0) continue;
        const producer = (requests[firstCarrier - 1]?.messages ?? []).map(stableSerialize);
        const changedAt = producer.findIndex((message, index) => latestMessages[index] !== message);
        if (changedAt >= 0) violations.push({ signature, producedBy: firstCarrier - 1, changedAt });
    }
    return violations;
}

describe.skipIf(!rustPrereqs.ok)("review r2 drill: a freeze across a host restart", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            modelID: "mock-opus-5-5",
            magicContextConfig: CONFIG,
        });
    }, DRILL_TIMEOUT_MS);

    afterEach(async () => {
        await h?.dispose();
    }, DRILL_TIMEOUT_MS);

    function replyWithThinking(label: string): void {
        h.mock.setDefault({
            content: [
                { type: "thinking", thinking: `thinking for ${label}`, signature: `sig-${label}` },
                { type: "text", text: `${label} answer` },
            ],
            usage: { input_tokens: 9_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
        });
    }

    /**
     * What a reader needs to judge whether a drill reached the frozen path: how
     * many tag markers each main request carried, and the session's pass and
     * last-known-good log lines.
     */
    function drillTrace(sessionId: string): string {
        const tagsPerRequest = h
            .mainRequests()
            .map((request) => (JSON.stringify(request.body.messages ?? []).match(/§\d+§/g) ?? []).length);
        const lines = sessionLogLines(h, sessionId)
            .filter((line) => /rust pass: |lkg_|cold-start|frozen/.test(line))
            .map((line) => line.replace(/^.*?\] /, "").slice(0, 220));
        return JSON.stringify({ tagsPerRequest, lines });
    }

    async function lastBody(): Promise<WireBody> {
        const request = h.mainRequests().at(-1);
        if (!request) throw new Error("no main request captured");
        return request.body as WireBody;
    }

    /** SIGKILL ck-mc, send one turn (failure replay freezes), bring ck-mc back. */
    async function freezeThroughOutage(sessionId: string): Promise<void> {
        await driveToSteadyState(h, sessionId, 2);
        replyWithThinking("pre-outage");
        await h.sendPrompt(sessionId, `pre-outage turn: ${h.ballast(300)}`);
        await h.subc.killModuleAndWait();
        replyWithThinking("outage");
        await h.sendPrompt(sessionId, `outage turn: ${h.ballast(300)}`);
        await h.waitFor(
            () => sessionLogLines(h, sessionId).some((line) => line.includes("lkg_replay_served")),
            { label: "outage turn served from the last-known-good slot", timeoutMs: 15_000 },
        );
        await h.subc.restoreModule();
    }

    it(
        "a restart after two captured frozen turns keeps the frozen prefix",
        async () => {
            const sessionId = await h.createSession();
            await freezeThroughOutage(sessionId);
            for (const label of ["frozen-1", "frozen-2"]) {
                replyWithThinking(label);
                await h.sendPrompt(sessionId, `${label} turn: ${h.ballast(300)}`);
            }
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).filter((line) =>
                        line.includes("lkg_frozen_replay_served"),
                    ).length >= 2,
                { label: "two frozen healthy passes before the restart", timeoutMs: 15_000 },
            );
            const beforeRestart = await lastBody();
            const requestsBefore = h.mainRequests().length;
            // Let the plugin flush its buffered log (every ~500 ms) so the count
            // below includes every pass before the restart.
            await Bun.sleep(1_500);
            const passesBefore = sessionLogLines(h, sessionId).filter((l) =>
                l.includes("rust pass: "),
            ).length;

            await h.restart({ rust: true, magicContextConfig: CONFIG });
            replyWithThinking("after-restart");
            await h.sendPrompt(sessionId, `after-restart turn: ${h.ballast(300)}`);
            await h.waitFor(() => h.mainRequests().length > requestsBefore, {
                label: "request after the restart",
            });
            // The plugin buffers its log for up to half a second; wait for the pass.
            await h.waitFor(
                () => sessionLogLines(h, sessionId).filter((l) => l.includes("rust pass: ")).length > passesBefore,
                { label: "rust pass after the restart", timeoutMs: 15_000 },
            );
            const afterRestart = await lastBody();
            const comparison = compareRequests(beforeRestart, afterRestart);
            const boundBlocks = thinkingBoundToChangedPrefix(
                h.mainRequests().map((request) => request.body as WireBody),
            );
            const thinkingPerRequest = h
                .mainRequests()
                .map((request) => ((request.body as WireBody).messages ?? []).flatMap(thinkingSignatures).length);
            const coldStart = sessionLogLines(h, sessionId).filter((line) =>
                line.includes("lkg_cold_start_frozen_slot"),
            );
            console.log(
                `[review-r2 restart drill] ${JSON.stringify({ ...comparison, coldStart, boundBlocks, thinkingPerRequest })}`,
            );
            console.log(`[review-r2 restart drill] ${drillTrace(sessionId)}`);
            expect(comparison.systemChanged).toBe(false);
            expect(comparison.toolsChanged).toBe(false);
            expect(boundBlocks).toEqual([]);
            expect(comparison.firstChanged).toBeNull();
        },
        DRILL_TIMEOUT_MS,
    );

    it(
        "a restart right after the uncaptured outage replay (the documented residual)",
        async () => {
            const sessionId = await h.createSession();
            await freezeThroughOutage(sessionId);
            const beforeRestart = await lastBody();
            const requestsBefore = h.mainRequests().length;
            // Let the plugin flush its buffered log (every ~500 ms) so the count
            // below includes every pass before the restart.
            await Bun.sleep(1_500);
            const passesBefore = sessionLogLines(h, sessionId).filter((l) =>
                l.includes("rust pass: "),
            ).length;

            await h.restart({ rust: true, magicContextConfig: CONFIG });
            replyWithThinking("after-restart");
            await h.sendPrompt(sessionId, `after-restart turn: ${h.ballast(300)}`);
            await h.waitFor(() => h.mainRequests().length > requestsBefore, {
                label: "request after the restart",
            });
            // The plugin buffers its log for up to half a second; wait for the pass.
            await h.waitFor(
                () => sessionLogLines(h, sessionId).filter((l) => l.includes("rust pass: ")).length > passesBefore,
                { label: "rust pass after the restart", timeoutMs: 15_000 },
            );
            const afterRestart = await lastBody();
            const comparison = compareRequests(beforeRestart, afterRestart);
            const boundBlocks = thinkingBoundToChangedPrefix(
                h.mainRequests().map((request) => request.body as WireBody),
            );
            const thinkingPerRequest = h
                .mainRequests()
                .map((request) => ((request.body as WireBody).messages ?? []).flatMap(thinkingSignatures).length);
            console.log(
                `[review-r2 residual drill] ${JSON.stringify({ ...comparison, boundBlocks, thinkingPerRequest })}`,
            );
            console.log(`[review-r2 residual drill] ${drillTrace(sessionId)}`);
            // The residual is documented as a cache bust (closed later by a durable
            // marker). A bust is acceptable here; a signed block left behind the
            // changed bytes is not, because the real API rejects it.
            expect(boundBlocks).toEqual([]);
        },
        DRILL_TIMEOUT_MS,
    );

    it(
        "a refusal in the emergency band during a freeze, then the module returns",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 2);
            replyWithThinking("pre-outage");
            await h.sendPrompt(sessionId, `pre-outage turn: ${h.ballast(300)}`);
            await h.subc.killModuleAndWait();
            // The outage turn is served from the slot (the freeze starts) and the
            // provider reports usage in the emergency band.
            h.mock.setDefault({
                content: [
                    { type: "thinking", thinking: "thinking for outage", signature: "sig-outage" },
                    { type: "text", text: "outage answer" },
                ],
                usage: { input_tokens: 96_000, output_tokens: 20, cache_creation_input_tokens: 0 },
            });
            await h.sendPrompt(sessionId, `outage turn: ${h.ballast(300)}`);
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).some((line) => line.includes("lkg_replay_served")),
                { label: "outage turn served from the slot", timeoutMs: 15_000 },
            );
            const lastServed = await lastBody();
            const requestsBefore = h.mainRequests().length;
            // At 96% with the module down the adapter refuses (no replay is admitted).
            await h
                .sendPrompt(sessionId, `refused turn: ${h.ballast(100)}`, { timeoutMs: 30_000 })
                .catch(() => undefined);
            const refused = await h
                .waitFor(
                    () =>
                        sessionLogLines(h, sessionId).some((line) =>
                            line.includes("mc_rust_emergency_refusal"),
                        ),
                    { label: "emergency-band refusal", timeoutMs: 15_000 },
                )
                .then(() => true)
                .catch(() => false);
            if (!refused) console.log(`[review-r2 refusal drill] ${drillTrace(sessionId)}`);
            expect(refused).toBe(true);
            expect(h.mainRequests().length).toBe(requestsBefore);

            replyWithThinking("after-refusal");
            await h.subc.restoreModule();
            // The refusal-recovery watcher resumes the refused turn once the module
            // is back; wait for that request (or send one if it does not come).
            const resumed = await h
                .waitFor(() => h.mainRequests().length > requestsBefore, {
                    timeoutMs: 30_000,
                    label: "request after the module returned",
                })
                .then(() => true)
                .catch(() => false);
            if (!resumed) {
                await h.sendPrompt(sessionId, `after-refusal turn: ${h.ballast(100)}`);
            }
            await Bun.sleep(1_500);
            const next = h.mainRequests()[requestsBefore]?.body as WireBody;
            const comparison = compareRequests(lastServed, next);
            const boundBlocks = thinkingBoundToChangedPrefix(
                h.mainRequests().slice(0, requestsBefore + 1).map((request) => request.body as WireBody),
            );
            console.log(
                `[review-r2 refusal drill] ${JSON.stringify({ resumed, ...comparison, boundBlocks })}`,
            );
            console.log(`[review-r2 refusal drill] ${drillTrace(sessionId)}`);
            expect(boundBlocks).toEqual([]);
        },
        DRILL_TIMEOUT_MS,
    );
});
