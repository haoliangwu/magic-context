/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

forEachHost(import.meta.url, "tagging", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host);
    });

    afterAll(async () => {
        await h.dispose();
    });

    it("applies §N§ tags and persists them for the selected harness", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "tagged response",
            usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "please tag this message", { timeoutMs: 60_000 });

        const req = h.mock.lastRequest();
        expect(JSON.stringify(req!.body)).toMatch(/§\d+§/);

        await h.waitFor(() => h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "tags persisted",
        });
        const row = h.contextDb()
            .prepare("SELECT harness FROM tags WHERE session_id = ? LIMIT 1")
            .get(sessionId) as { harness: string } | null;
        expect(row?.harness).toBe(h.harnessId);
    }, 60_000);
});
