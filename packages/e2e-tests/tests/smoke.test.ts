/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import type { HostHarness } from "../src/host-harness";
import { OpenCode2TestHarness } from "../src/opencode2-harness";

/**
 * Phase 1 smoke — verifies the harness is wired correctly:
 *   mock server reachable, opencode serve runs with isolated config, plugin loads
 *   from source, a prompt reaches the mock and returns, and the plugin initializes
 *   its SQLite DB.
 */

const selectedHost = process.env.MC_E2E_HOST ?? "opencode";
if (selectedHost !== "opencode" && selectedHost !== "opencode2") {
    throw new Error(`smoke.test.ts requires MC_E2E_HOST=opencode|opencode2, got ${selectedHost}`);
}

let h: HostHarness;
let serverUrl: string;

beforeAll(async () => {
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
    const created = selectedHost === "opencode2"
        ? await OpenCode2TestHarness.create(options)
        : await TestHarness.create(options);
    h = created;
    serverUrl = created.opencode.url;
});

afterAll(async () => {
    await h?.dispose();
});

describe(`${selectedHost} e2e smoke`, () => {
    it("mock server and host are reachable", () => {
        expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("sends a prompt, mock captures it, plugin initializes its DB", async () => {
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "hi there");

        // The plugin intentionally SKIPS prompt injection for OpenCode's
        // internal small-model agents (title generator, summary, compaction)
        // as of v0.16.2 — they don't have our tools and were just paying the
        // token cost. The first captured request is typically the title
        // generator firing in parallel with the user's first turn, so we
        // need to wait for the MAIN agent's request and assert on that one.
        //
        // Identify the main-agent request: it's the one whose system prompt
        // does NOT match an OpenCode internal agent signature. We use the
        // negation of "title generator" / "Generate a summary" / etc. to
        // distinguish.
        await h.waitFor(
            () => {
                const hits = h.requests().filter((r) => {
                    const body = JSON.stringify(r.body);
                    if (!body.includes("hi there")) return false;
                    // Skip OpenCode's internal small-model agents.
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

        // The assertion that matters is that the PLUGIN touched the outgoing
        // request, not that the harness transported our text. Magic-context
        // injects a system-prompt block describing its tools and guidance —
        // this exact phrase comes from
        // packages/plugin/src/agents/magic-context-prompt.ts and is stable
        // across the default agent-prompt variants.
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

        // Plugin created its DB and ran the transform (at least one tag persisted).
        await h.waitFor(() => h.hasContextDb(), { timeoutMs: 5000, label: "context.db created" });
        await h.waitFor(() => h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "tags persisted",
        });
        expect(h.countTags(sessionId)).toBeGreaterThan(0);
    }, 60_000);
});
