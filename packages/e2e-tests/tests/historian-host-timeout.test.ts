/// <reference types="bun-types" />

/**
 * A historian prompt that runs longer than Bun's default fetch timer on a real
 * OpenCode 1 host.
 *
 * Some OpenCode 1 builds give plugins an SDK client whose fetch is plain
 * `globalThis.fetch`, so Bun's default request timer (300-360 s) applies to every
 * plugin request (docs/reports/dreamer-host-fetch-timeout.md). A historian that
 * held one synchronous `session.prompt` open for its whole run therefore failed
 * with `TimeoutError: The operation timed out.` after about five minutes, however
 * long `historian_timeout_ms` was.
 *
 * Two children of the same parent run against one slow model that keeps its
 * stream alive and answers after seven minutes:
 * - the historian's OpenCode 1 executor, driven by the retry chain with a
 *   ten-minute historian timeout, must finish with the model's answer;
 * - the held synchronous prompt the historian used before, as a control, must
 *   still meet the Bun timer, which shows the timer was live in this run.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { createV1HiddenCompletionExecutor } from "../../plugin/src/hooks/magic-context/compartment-runner-historian";
import {
    type PromptArgs,
    promptSyncWithModelSuggestionRetry,
} from "../../plugin/src/shared/model-suggestion-retry";
import { TestHarness } from "../src/harness";
import {
    assertIsolatedStores,
    busySessions,
    MOCK_USAGE,
    requestText,
} from "./dreamer-timeout-support";

const ASYNC_PROBE = "HISTORIAN_SLOW_MODEL_ASYNC_PROBE";
const HELD_PROBE = "HISTORIAN_SLOW_MODEL_HELD_PROBE";
/** Longer than Bun's default fetch timer, which fires 300-360 s into a request. */
const MODEL_ANSWER_MS = 7 * 60_000;
/** The configured historian timeout: the only limit the run should meet. */
const HISTORIAN_TIMEOUT_MS = 10 * 60_000;
const ANSWER = "<compartment>slow model answer</compartment>";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create();
    assertIsolatedStores(h);
});

afterAll(async () => {
    await h?.dispose();
});

it(
    "a historian run held seven minutes by a slow model completes under historian_timeout_ms",
    async () => {
        h.mock.reset();
        h.mock.setDefault({ text: "ack", usage: MOCK_USAGE });
        const probeRequests = { [ASYNC_PROBE]: 0, [HELD_PROBE]: 0 };
        h.mock.addMatcher((body) => {
            const text = requestText(body);
            const probe = text.includes(ASYNC_PROBE)
                ? ASYNC_PROBE
                : text.includes(HELD_PROBE)
                  ? HELD_PROBE
                  : null;
            if (!probe) return null;
            probeRequests[probe] += 1;
            return { text: ANSWER, usage: MOCK_USAGE, streamHoldMs: MODEL_ANSWER_MS };
        });

        const parentId = await h.createSession();
        const asyncChild = await h.createChildSession(parentId, "historian async probe");
        const heldChild = await h.createChildSession(parentId, "historian held probe");

        // The client shape those builds hand to plugins: plain fetch, Bun's timer on.
        const sdk = await import("@opencode-ai/sdk");
        const client = sdk.createOpencodeClient({
            baseUrl: h.serverUrl,
            fetch: (request: Request) => globalThis.fetch(request),
        });
        const request = (childId: string, probe: string): PromptArgs => ({
            path: { id: childId },
            query: { directory: h.workdir },
            body: {
                model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                parts: [{ type: "text", text: `${probe}: summarize this session.` }],
            },
        });

        // The executor only uses its database when it opens a child; this test
        // opens both children through the harness instead.
        const executor = createV1HiddenCompletionExecutor(client as never, undefined as never, h.workdir);
        const handle = { id: asyncChild, childSessionId: asyncChild };

        const timed = async (run: () => Promise<unknown>) => {
            const startedAt = Date.now();
            try {
                await run();
                return { ok: true as const, elapsedMs: Date.now() - startedAt };
            } catch (error) {
                return { ok: false as const, elapsedMs: Date.now() - startedAt, error };
            }
        };
        const [viaExecutor, held] = await Promise.all([
            timed(() =>
                promptSyncWithModelSuggestionRetry(client as never, request(asyncChild, ASYNC_PROBE), {
                    transport: Object.assign((args: PromptArgs) => executor.attempt(handle, args), {
                        childSessionId: asyncChild,
                    }),
                    timeoutMs: HISTORIAN_TIMEOUT_MS,
                    callContext: "e2e:historian-host-timeout",
                }),
            ),
            timed(() =>
                promptSyncWithModelSuggestionRetry(client as never, request(heldChild, HELD_PROBE), {
                    transport: Object.assign(
                        async (args: PromptArgs) => {
                            await client.session.prompt(args as never);
                        },
                        { childSessionId: heldChild },
                    ),
                    timeoutMs: HISTORIAN_TIMEOUT_MS,
                    callContext: "e2e:historian-held-control",
                }),
            ),
        ]);
        const completion = viaExecutor.ok ? await executor.collect(handle, 50) : null;
        const busy = await busySessions(h);
        console.log(
            JSON.stringify({
                viaExecutor: {
                    ok: viaExecutor.ok,
                    elapsedMs: viaExecutor.elapsedMs,
                    error: viaExecutor.ok ? null : String(viaExecutor.error),
                    text: completion?.text ?? null,
                },
                held: {
                    ok: held.ok,
                    elapsedMs: held.elapsedMs,
                    name: held.ok ? null : (held.error as Error | undefined)?.name,
                    message: held.ok ? null : (held.error as Error | undefined)?.message,
                },
                probeRequests,
                busy,
            }),
        );

        // The historian's run outlived the Bun timer and ended with the model's answer.
        expect(viaExecutor.ok).toBe(true);
        expect(viaExecutor.elapsedMs).toBeGreaterThanOrEqual(MODEL_ANSWER_MS);
        expect(completion?.text).toBe(ANSWER);
        expect(probeRequests[ASYNC_PROBE]).toBe(1);
        // Control: a held request on the same client met Bun's timer, well before
        // both the model's answer and the historian timeout.
        expect(held.ok).toBe(false);
        expect((held.error as Error | undefined)?.name).toBe("TimeoutError");
        expect(held.elapsedMs).toBeLessThan(MODEL_ANSWER_MS);
        // The chain aborted the control child after the timer, so nothing is left running.
        expect(busy).not.toContain(heldChild);
        expect(busy).not.toContain(asyncChild);
        assertIsolatedStores(h);
    },
    HISTORIAN_TIMEOUT_MS + 60_000,
);
