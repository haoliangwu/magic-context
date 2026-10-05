/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import {
    createScenarioHarness,
    forEachHost,
    isPiFamily,
    type ScenarioHarness,
} from "../src/scenario-hosts";

/**
 * When OpenCode 1 has auto-compaction enabled, or a conflicting plugin is
 * installed, magic-context MUST self-disable. OpenCode 2 instead exposes a
 * compaction hook that Magic Context answers without a competing model call. This prevents double-compaction
 * behavior and guarantees that the plugin is a no-op in environments where
 * another system owns history management.
 *
 * We force conflict by setting `compaction: { auto: true }` in opencode.json.
 * Then we send a normal turn and verify the plugin never created its DB —
 * the cleanest proof that no plugin machinery ran for this session.
 */

forEachHost(import.meta.url, "conflict detection", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(
            host,
            isPiFamily(host)
                ? { magicContextConfig: { enabled: false } }
                : {
                    expectMagicContext: false,
                    // Magic Context disables on v1, but answers the native compaction hook on v2.
                    openCodeConfigExtra: {
                        compaction: { auto: true, prune: false },
                    },
                },
        );
    });

    afterAll(async () => {
        await h.dispose();
    });
    it(
        host === "opencode2" ? "answers native compaction without a competing model request" : "plugin disables itself when opencode auto-compaction is active",
        async () => {
            h.mock.reset();
            h.mock.setDefault({
                text: "ok",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 50,
                },
            });

            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "hello — should not be tagged.");

            if (h instanceof OpenCode2TestHarness) {
                expect(h.countTags(sessionId)).toBeGreaterThan(0);
                const requests = h.mock.requests().length;
                await h.compactSession(sessionId);
                expect(h.mock.requests().length).toBe(requests);
                await h.sendPrompt(sessionId, "after native compaction");
                expect(JSON.stringify(h.mock.lastRequest()?.body)).toContain("<conversation-checkpoint>");
                return;
            }

            // Give any async init a beat; 500ms is plenty because the
            // disabled path never awaits any DB creation.
            await Bun.sleep(500);

            // Invariant: context.db was never created. The plugin bailed out
            // before tagger/scheduler setup.
            expect(h.hasContextDb()).toBe(false);
        },
        60_000,
    );
});
