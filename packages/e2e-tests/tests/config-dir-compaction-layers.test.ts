/// <reference types="bun-types" />

import { afterEach, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { forEachHost } from "../src/scenario-hosts";

/**
 * `OPENCODE_CONFIG_DIR` adds a config directory; it does not replace the
 * global one.
 *
 * A launcher exported `OPENCODE_CONFIG_DIR` to a directory that held only
 * plugin scaffolding. OpenCode carried on reading the user's real global
 * config — `opencode debug config` showed `compaction.auto=false` — but Magic
 * Context resolved the launcher's directory INSTEAD of the global one, found
 * nothing there, fell through to a default of `auto: true`, and disabled
 * itself. Nothing was left managing the context window.
 *
 * The harness already points `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` at
 * two different directories inside one isolated tree, so it can stage the
 * reporter's shape exactly: compaction configured only in the global
 * directory, and a `$OPENCODE_CONFIG_DIR` layer that says nothing about it.
 *
 * Each case boots a real `opencode serve` and checks the plugin's own
 * observable outcome: an enabled plugin creates its context DB, a
 * conflict-disabled one never does.
 */
forEachHost(import.meta.url, null, () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
        await harness?.dispose();
        harness = undefined;
    });

    it(
        "stays enabled when compaction.auto=false lives only in the global config dir",
        async () => {
            harness = await TestHarness.create({
                omitConfigDirCompaction: true,
                // The reporter's literal config: `auto` and nothing else.
                // OpenCode serves back only the keys a user wrote, so this is
                // also the shape that must survive the resolved-config read.
                openCodeGlobalConfigExtra: { compaction: { auto: false } },
            });

            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, "hello from the global config dir arm.");

            expect(harness.hasContextDb()).toBe(true);
            harness.assertMagicContextProcessed(sessionId);
        },
        90_000,
    );

    it(
        "positive control: compaction.auto=true in the global config dir still disables the plugin",
        async () => {
            harness = await TestHarness.create({
                expectMagicContext: false,
                omitConfigDirCompaction: true,
                openCodeGlobalConfigExtra: { compaction: { auto: true } },
            });

            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, "hello from the positive control arm.");
            // The disabled path awaits no DB creation; this is slack, not a poll.
            await Bun.sleep(500);

            expect(harness.hasContextDb()).toBe(false);
        },
        90_000,
    );

    it(
        "an OPENCODE_CONFIG_DIR that does set compaction.auto=true outranks the global dir",
        async () => {
            harness = await TestHarness.create({
                expectMagicContext: false,
                // Global dir says auto=false; the launcher's directory says
                // true. OpenCode appends $OPENCODE_CONFIG_DIR last, so it wins
                // — and the conflict must fire on the value that actually took
                // effect, not on the one lower in the stack.
                openCodeGlobalConfigExtra: { compaction: { auto: false } },
                openCodeConfigExtra: { compaction: { auto: true, prune: false } },
            });

            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, "hello from the precedence arm.");
            await Bun.sleep(500);

            expect(harness.hasContextDb()).toBe(false);
        },
        90_000,
    );
});
