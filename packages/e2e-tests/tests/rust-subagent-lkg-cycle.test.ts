/// <reference types="bun-types" />

/**
 * Incident regression: a subagent session cycled between a frozen last-known-good
 * replay and a forced release every eight passes, paying a tail rewrite at each
 * release.
 *
 * The host freezes its representation and replays the last-known-good array when a
 * deferred pass attributes its first divergence to a composed frame block
 * (`mc_m0#0` / `mc_m1#0`). A subagent output carries no composed frame at all, so
 * nothing in it may claim a frame's block id, and no pass may pin the module's
 * served baseline: a subagent never reaches a repricing pass, so one pinned
 * mismatch is re-reported forever and the host can never leave the replay without
 * a forced release.
 *
 * The scenario drives a real child session (non-empty `parentID`, which is what
 * makes the plugin treat it as a subagent) through 20+ provider passes carrying
 * tool calls, tool results, and signed thinking, and interleaves the shape that
 * triggered the incident: an OpenCode notice delivery, a user message whose parts
 * are flagged synthetic. Such a message is persisted and is served on every later
 * pass like any other turn; the pass that first carries it is an ordinary tail
 * change that must never be read as a frozen-prefix mutation.
 *
 * Assertion style: the plugin's own session log (no replay entered, no divergence
 * attributed to a frame) plus sha256 identity of the retained prefix between
 * consecutive served arrays.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

/** Marker carried by every prompt this scenario sends, so its passes are identifiable. */
const PROBE = "lkgcycleprobe";
const SIGNATURE = "sig-lkg-cycle";

interface WireMessage {
    role?: string;
    content?: unknown;
}

function blocks(message: WireMessage | undefined): Array<Record<string, unknown>> {
    return Array.isArray(message?.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [];
}

function endsWithToolResult(messages: WireMessage[]): boolean {
    return blocks(messages.at(-1)).some((block) => block.type === "tool_result");
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

describe.skipIf(!rustPrereqs.ok)("rust invariant: subagent defer passes are byte-stable", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 200_000,
            // A subagent never fires the historian; keeping the producer out of the
            // stack keeps every captured provider request this session's own.
            startHistorianProducer: false,
            magicContextConfig: { execute_threshold_percentage: 60, protected_tags: 1 },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it(
        "serves 20+ subagent passes without a frozen-prefix replay or a tail rewrite",
        async () => {
            const parent = await h.createSession();
            const child = await h.createChildSession(parent, "lkg-cycle-child");
            await h.waitFor(() => h.isSubagent(child) === true, {
                timeoutMs: 15_000,
                label: "child session marked subagent",
            });

            // Every turn: signed thinking plus a read-only tool call, then a plain
            // reply once the tool result comes back. Deciding from the request's own
            // tail keeps the mock deterministic across retries.
            let toolCalls = 0;
            let toolResultsSeen = 0;
            h.mock.addMatcher((body) => {
                const messages = Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
                if (messages.length === 0) return null;
                if (endsWithToolResult(messages)) {
                    toolResultsSeen += 1;
                    return {
                        content: [
                            {
                                type: "thinking",
                                thinking: `recall checked at depth ${messages.length}`,
                                signature: `${SIGNATURE}-${messages.length}`,
                            },
                            { type: "text", text: `probe settled at depth ${messages.length}` },
                        ],
                        stop_reason: "end_turn",
                        usage: {
                            input_tokens: 9_000,
                            output_tokens: 20,
                            cache_creation_input_tokens: 1_000,
                        },
                    };
                }
                const tools = Array.isArray(body.tools) ? body.tools : [];
                const search = tools.find(
                    (tool) => (tool as { name?: unknown } | null)?.name === "ctx_search",
                ) as { name: string } | undefined;
                if (!search) return null;
                toolCalls += 1;
                return {
                    content: [
                        {
                            type: "thinking",
                            thinking: `checking recall before turn ${toolCalls}`,
                            signature: `${SIGNATURE}-call-${toolCalls}`,
                        },
                        {
                            type: "tool_use",
                            id: `toolu_lkg_cycle_${toolCalls}`,
                            name: search.name,
                            input: {
                                query: `did we record anything about ${PROBE} turn ${toolCalls}?`,
                                limit: 3,
                            },
                        },
                    ],
                    stop_reason: "tool_use",
                    usage: {
                        input_tokens: 9_000,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                };
            });

            // Interleave the notice deliveries among ordinary turns. Each turn costs two
            // provider passes (the tool call, then the reply), so this clears 20 passes.
            for (let turn = 1; turn <= 11; turn += 1) {
                await h.sendPrompt(child, `${PROBE} turn ${turn}: ${h.ballast(120)}`);
                if (turn === 4 || turn === 8) {
                    // OpenCode's own notice shape: a synthetic user part. It persists as an
                    // ordinary user row and stays on the wire from this pass onward.
                    await h.sendPrompt(
                        child,
                        `<system-reminder>\n[BACKGROUND TASK COMPLETED] ${PROBE} notice ${turn}\n</system-reminder>`,
                        { synthetic: true },
                    );
                }
            }

            expect(toolCalls).toBeGreaterThan(0);
            expect(toolResultsSeen).toBeGreaterThan(0);

            const passes = await h.waitForRustPasses(20);
            expect(passes.length).toBeGreaterThanOrEqual(20);
            expect(passes.every((pass) => pass.decision !== "error" && pass.decision !== "parked")).toBe(
                true,
            );
            // The host never entered its frozen replay: no divergence was attributed to a
            // composed frame, so no pass was served from the last-known-good array and no
            // release ever had to rewrite the tail.
            const sessionLines = h
                .diagnosticLog()
                .split("\n")
                .filter((line) => line.includes(child));
            expect(sessionLines.filter((line) => line.includes("frozen-prefix divergence"))).toEqual(
                [],
            );
            expect(sessionLines.filter((line) => line.includes("lkg_frozen_replay_served"))).toEqual(
                [],
            );
            expect(sessionLines.filter((line) => line.includes("lkg_frozen_replay_released"))).toEqual(
                [],
            );
            // Every pass served the module's own output. A single `lkg_frozen` pass means
            // the host stopped trusting the module and started replaying a frozen array,
            // which it can only leave through a forced release that rewrites the tail.
            expect(passes.map((pass) => pass.servedFrom).filter((from) => from !== "transform")).toEqual(
                [],
            );

            // The fixture must really have carried signed thinking and tool results into
            // the served array, otherwise the invariant below is vacuous.
            const served = h
                .mainRequests()
                .map((request) => (request.body.messages ?? []) as WireMessage[])
                .filter((messages) => stableSerialize(messages).includes(PROBE));
            expect(served.length).toBeGreaterThanOrEqual(20);
            const finalWire = stableSerialize(served.at(-1) ?? []);
            expect(finalWire).toContain(SIGNATURE);
            expect(finalWire).toContain("tool_result");

            // Byte identity of the settled prefix across consecutive passes: everything the
            // earlier pass served below its live tail must reproduce, hash for hash, at the
            // same index in the next pass.
            //
            // The live tail here is the last two messages: a turn can add a user message and
            // the assistant reply to it between two captures. Nothing below those two may
            // move — the incident described at the top of this file rewrote ten to fifteen
            // messages deep.
            const LIVE_TAIL_MESSAGES = 2;
            let comparedPairs = 0;
            for (let pass = 1; pass < served.length; pass += 1) {
                const earlier = served[pass - 1]!;
                const later = served[pass]!;
                const retained = earlier.length - LIVE_TAIL_MESSAGES;
                // The session's opening passes are all live tail; they settle nothing yet.
                if (retained < 1) continue;
                comparedPairs += 1;
                const earlierPrefix = earlier.slice(0, retained).map((m) => stableSerialize(m));
                const laterPrefix = later.slice(0, retained).map((m) => stableSerialize(m));
                const rewrittenAt = earlierPrefix.findIndex(
                    (message, index) => laterPrefix[index] !== message,
                );
                // Report where the rewrite landed, not just that the hashes differ: the
                // index and the two renderings are what identify the mechanism.
                expect({
                    pass,
                    rewrittenAt,
                    before: rewrittenAt < 0 ? "" : earlierPrefix[rewrittenAt]!.slice(0, 400),
                    after: rewrittenAt < 0 ? "" : (laterPrefix[rewrittenAt] ?? "").slice(0, 400),
                    hash: sha256(laterPrefix.join("\u0000")),
                }).toEqual({
                    pass,
                    rewrittenAt: -1,
                    before: "",
                    after: "",
                    hash: sha256(earlierPrefix.join("\u0000")),
                });
            }
            expect(comparedPairs).toBeGreaterThanOrEqual(20);
        },
        600_000,
    );
});
