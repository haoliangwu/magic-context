/// <reference types="bun-types" />

/**
 * Real Pi host: the /ctx-status Compartments bucket counts the compartments the
 * host actually serves.
 *
 * Between m[0] folds a published compartment is served in m[1]'s
 * `<new-compartments>` block while m[0] keeps the `<session-history>` it was
 * rendered with. A session whose m[0] was first rendered before any compartment
 * existed therefore keeps an empty m[0] history for a long time, and a bucket
 * that measured only m[0] stayed at the empty wrapper's size however many
 * compartments the historian published.
 *
 * The session shape mirrors the report that found it: two short turns, then one
 * long tool-heavy turn that crosses the proactive historian threshold. The
 * historian compacts everything before the live prompt, and the next request
 * carries that compartment in m[1].
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractM0Block } from "../../plugin/src/hooks/magic-context/decay-render";
import { computeM0BlockTokens } from "../../plugin/src/hooks/magic-context/m0-token-breakdown";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import type { MockUsage } from "../src/mock-provider/server";
import { PiTestHarness } from "../src/pi-harness";
import { PI_PACKAGE_JSON } from "../src/pi-runner/spawn";

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const COMPARTMENT_TITLE = "Inspected runtime sources before implementing the plan";
const SOURCE_FILES = 40;

let h: PiTestHarness;

function isHistorianRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes(HISTORIAN_SYSTEM_MARKER);
}

function isMainRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

/** Report input usage in proportion to what was actually sent, so pressure follows the transcript. */
function usageFor(body: Record<string, unknown>): MockUsage {
    return {
        input_tokens: Math.round(JSON.stringify(body.messages ?? []).length / 4),
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };
}

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 100_000,
        magicContextConfig: {
            execute_threshold_percentage: 65,
            dreamer: { disable: true },
            compressor: { enabled: false },
        },
    });
});

afterAll(async () => {
    await h?.dispose();
});

it("counts compartments served in m[1] in the Compartments bucket", async () => {
    // The Pi host lane pins this behavior on the newest supported Pi release.
    const hostVersion = (JSON.parse(readFileSync(PI_PACKAGE_JSON, "utf8")) as { version: string }).version;
    expect(hostVersion).toBe("0.87.1");

    for (let i = 0; i < SOURCE_FILES; i += 1) {
        writeFileSync(join(h.workdir, `src-${i}.txt`), h.ballast(1_200));
    }

    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findHistorianOrdinalRange(body) ?? { start: 1, end: 1 };
        return {
            text: buildMockHistorianPayload({
                start: range.start,
                end: range.end,
                title: COMPARTMENT_TITLE,
                body: "Read production, gear and ABI record code; no implementation changes yet.",
            }),
            usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
        };
    });
    let toolCallsLeft = 0;
    let fileCursor = 0;
    h.mock.addMatcher((body) => {
        if (!isMainRequest(body)) return null;
        const usage = usageFor(body);
        if (toolCallsLeft <= 0) return { text: "Done with this step of the plan.", usage };
        toolCallsLeft -= 1;
        const path = `src-${fileCursor++ % SOURCE_FILES}.txt`;
        return {
            content: [
                { type: "text", text: `Reading ${path} to continue the inspection.` },
                {
                    type: "tool_use",
                    id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
                    name: "read",
                    input: { path },
                },
            ],
            stop_reason: "tool_use",
            usage,
        };
    });

    const sessionId = await h.createSession();
    for (const [turn, toolCalls] of [2, 2, 110].entries()) {
        toolCallsLeft = toolCalls;
        await h.sendPrompt(sessionId, `turn ${turn + 1}: implement the next part of PLAN.md`, {
            timeoutMs: 300_000,
        });
    }
    await h.waitFor(
        () => h.countCompartments(sessionId) > 0,
        { timeoutMs: 120_000, label: "historian publishes a compartment" },
    );
    // One more request so the injected prefix carries the published compartment.
    toolCallsLeft = 0;
    await h.sendPrompt(sessionId, "turn 4: continue", { timeoutMs: 300_000 });
    await h.waitForMockQuiescence({ label: "final turn" });

    const meta = h
        .contextDb()
        .prepare("SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { cached_m0_bytes: Uint8Array | null; cached_m1_bytes: Uint8Array | null } | null;
    const m0Text = meta?.cached_m0_bytes ? Buffer.from(meta.cached_m0_bytes).toString("utf8") : "";
    const m1Text = meta?.cached_m1_bytes ? Buffer.from(meta.cached_m1_bytes).toString("utf8") : "";
    const m0History = extractM0Block(m0Text, "session-history");
    const newCompartments = extractM0Block(m1Text, "new-compartments");

    // The shape that pinned the bucket: m[0] history rendered before the first
    // compartment existed, and the published compartment served from m[1].
    expect(m0History).not.toBeNull();
    expect(m0History).not.toContain(COMPARTMENT_TITLE);
    expect(newCompartments).toContain(COMPARTMENT_TITLE);
    const mains = h.mock.requests().filter((request) => isMainRequest(request.body));
    expect(JSON.stringify(mains[mains.length - 1]?.body.messages ?? [])).toContain(COMPARTMENT_TITLE);

    // /ctx-status reads the same persisted bytes through the same shared helper.
    const bucket = computeM0BlockTokens(h.contextDb() as never, sessionId, {
        m0Text,
        m1Text,
        projectIdentity: undefined,
        injectionBudgetTokens: undefined,
        memoryBlockCount: 0,
    }).compartmentTokens;
    expect(bucket).toBe(estimateTokens(m0History ?? "") + estimateTokens(newCompartments ?? ""));
    expect(bucket).toBeGreaterThan(estimateTokens(m0History ?? ""));
}, 900_000);
