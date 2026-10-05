/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

/**
 * Phase 1 smoke — verifies the harness is wired correctly:
 *   mock server reachable where the host exposes one, the real host process runs,
 *   the plugin loads from source, a prompt reaches the mock, and SQLite initializes.
 */

let h: ScenarioHarness;
let serverUrl: string | null;

const options = {
    mockDefault: {
        text: "response from mock",
        usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 0,
        },
    },
};

forEachHost(import.meta.url, "opencode e2e smoke", (host) => {
    beforeAll(async () => {
        h = await createScenarioHarness(host, options);
        serverUrl = h.serverUrl;
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("mock server and host are reachable", () => {
        if (serverUrl === null) {
            // Pi-family hosts are persistent RPC processes rather than HTTP servers.
            expect(["pi", "omp"]).toContain(h.host);
            return;
        }
        expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("sends a prompt, mock captures it, plugin initializes its DB", async () => {
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "hi there");

        // Internal small-model requests do not carry Magic Context. Select the
        // main request by excluding each host's title/summary/compaction prompts.
        await h.waitFor(
            () => {
                const hits = h.requests().filter((r) => {
                    const body = JSON.stringify(r.body);
                    if (!body.includes("hi there")) return false;
                    if (body.includes("You are a title generator")) return false;
                    if (body.includes("Generate a title for this conversation:")) return false;
                    if (body.includes("Generate a summary of the conversation")) return false;
                    if (body.includes("Compress the conversation history")) return false;
                    return true;
                });
                return hits.length > 0;
            },
            { timeoutMs: 10_000, label: "main-agent request captured" },
        );

        const requests = h.requests();
        expect(requests.length).toBeGreaterThanOrEqual(1);

        const mainAgentBody = requests
            .map((r) => JSON.stringify(r.body))
            .find(
                (b) =>
                    b.includes("hi there") &&
                    !b.includes("You are a title generator") &&
                    !b.includes("Generate a title for this conversation:") &&
                    !b.includes("Generate a summary of the conversation") &&
                    !b.includes("Compress the conversation history"),
            );
        expect(mainAgentBody, "main-agent request not captured").toBeDefined();
        expect(mainAgentBody).toMatch(/Magic Context|<session-history>/);

        await h.waitFor(() => h.hasContextDb(), { timeoutMs: 5000, label: "context.db created" });
        await h.waitFor(() => h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "tags persisted",
        });
        expect(h.countTags(sessionId)).toBeGreaterThan(0);
    }, 60_000);
});
