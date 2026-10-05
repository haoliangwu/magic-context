/// <reference types="bun-types" />

/**
 * An OpenCode agent whose permissions deny ctx_reduce (issue 519).
 *
 * OpenCode keeps agent and session permissions on the agent config and the
 * session, never in the first user message's tools map. Magic Context used to
 * read only that map, so a session driven by such an agent still received §N§
 * tags and the ctx_reduce guidance for a tool the host had removed. This suite
 * boots a real `opencode serve` with an agent that denies ctx_reduce and
 * checks every main-agent request the provider sees, for a primary session and
 * a child (subagent) session. A session on the default agent in the same server
 * is the control: it must still carry tags, guidance, and the tool.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

const DENYING_AGENT = "reviewer";
const TAG = /§\d+§/;
const REDUCE_GUIDANCE = "`ctx_reduce` with its tag";

type CapturedRequest = { body: Record<string, unknown> };

let h: TestHarness;

function requestsCarrying(marker: string): CapturedRequest[] {
    return (h.mock.requests() as CapturedRequest[]).filter((request) => {
        const systemText = JSON.stringify(request.body.system ?? "");
        return (
            JSON.stringify(request.body.messages ?? []).includes(marker) &&
            !systemText.includes("title generator")
        );
    });
}

function toolNames(request: CapturedRequest): string[] {
    const tools = request.body.tools;
    return Array.isArray(tools)
        ? tools.map((tool) => String((tool as { name?: unknown }).name ?? ""))
        : [];
}

async function drive(sessionId: string, marker: string, agent?: string): Promise<CapturedRequest[]> {
    for (let turn = 1; turn <= 2; turn += 1) {
        await h.sendPrompt(sessionId, `${marker} turn ${turn}`, agent ? { agent } : {});
    }
    await h.waitForMockQuiescence({ label: marker });
    return requestsCarrying(marker);
}

describe("ctx_reduce denied by OpenCode agent permissions (issue 519)", () => {
    beforeAll(async () => {
        h = await TestHarness.create({
            openCodeConfigExtra: {
                agent: {
                    [DENYING_AGENT]: {
                        mode: "all",
                        description: "Read-only reviewer that must not reduce context",
                        permission: { ctx_reduce: "deny" },
                    },
                },
            },
        });
    }, 120_000);

    afterAll(async () => {
        await h?.dispose();
    });

    it("a default-agent session still gets tags, reduce guidance, and the tool", async () => {
        const sessionId = await h.createSession();
        const requests = await drive(sessionId, "[[control-default-agent]]");
        expect(requests.length).toBeGreaterThanOrEqual(2);
        const last = requests.at(-1)!;
        expect(toolNames(last)).toContain("ctx_reduce");
        expect(JSON.stringify(last.body.messages)).toMatch(TAG);
        expect(JSON.stringify(last.body.system)).toContain(REDUCE_GUIDANCE);
    }, 180_000);

    it("a primary session on the denying agent never gets tags or reduce guidance", async () => {
        const sessionId = await h.createSession();
        const requests = await drive(sessionId, "[[denied-primary]]", DENYING_AGENT);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        for (const request of requests) {
            // The host removed the tool; Magic Context must not advertise it.
            expect(toolNames(request)).not.toContain("ctx_reduce");
            expect(JSON.stringify(request.body.messages)).not.toMatch(TAG);
            const system = JSON.stringify(request.body.system);
            expect(system).toContain("## Magic Context");
            expect(system).not.toContain(REDUCE_GUIDANCE);
        }
    }, 180_000);

    it("a child session on the denying agent never gets tags or Magic Context guidance", async () => {
        const parentId = await h.createSession();
        const childId = await h.createChildSession(parentId, "denied child");
        await h.waitFor(() => h.isSubagent(childId) === true, {
            timeoutMs: 10_000,
            label: "child session registered as subagent",
        });
        const requests = await drive(childId, "[[denied-child]]", DENYING_AGENT);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        for (const request of requests) {
            expect(toolNames(request)).not.toContain("ctx_reduce");
            expect(JSON.stringify(request.body.messages)).not.toMatch(TAG);
            // A subagent without callable ctx_reduce gets no Magic Context guidance at all.
            expect(JSON.stringify(request.body.system)).not.toContain("## Magic Context");
        }
    }, 180_000);
});
