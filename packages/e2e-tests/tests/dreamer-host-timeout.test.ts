/// <reference types="bun-types" />

/**
 * The host fetch `TimeoutError` against a real OpenCode 1 host.
 *
 * Some OpenCode 1 builds give plugins an SDK client whose fetch is plain
 * `globalThis.fetch`, so Bun's default request timer applies and a synchronous
 * `session.prompt` held open for a long agent loop rejects after 300-360 s with
 * `TimeoutError: The operation timed out.` while the host keeps running the
 * child (docs/reports/dreamer-host-fetch-timeout.md).
 *
 * This drives the plugin's shared prompt-retry chain with exactly such a client
 * against the real host, with a model that never answers and a fallback model
 * configured. The real Bun timer fires; the chain must file it as
 * `provider_timeout`, must not send the fallback into the same still-running
 * child, and must abort the child so its loop stops.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    getPromptFailureDetail,
    promptSyncWithValidatedOutputRetry,
} from "../../plugin/src/shared/model-suggestion-retry";
import { TestHarness } from "../src/harness";
import {
    assertIsolatedStores,
    busySessions,
    MOCK_USAGE,
    requestText,
    userMessagesContaining,
} from "./dreamer-timeout-support";

const PROBE = "HOST_FETCH_TIMEOUT_PROBE";
/** Our own slice is far longer than the host timer, so only the host timer can fire. */
const OWN_SLICE_MS = 15 * 60_000;
const RUN_WAIT_MS = 10 * 60_000;

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create();
    assertIsolatedStores(h);
});

afterAll(async () => {
    await h?.dispose();
});

it(
    "a host fetch TimeoutError is provider_timeout, stops the chain and aborts the child",
    async () => {
        h.mock.reset();
        h.mock.setDefault({ text: "ack", usage: MOCK_USAGE });
        const probePrompts: number[] = [];
        h.mock.addMatcher((body) => {
            if (!requestText(body).includes(PROBE)) return null;
            probePrompts.push(userMessagesContaining(body, PROBE));
            return { text: "never delivered", usage: MOCK_USAGE, delayMs: 30 * 60_000 };
        });

        const parentId = await h.createSession();
        const childId = await h.createChildSession(parentId, "host timeout probe child");

        // The client shape those builds hand to plugins: plain fetch, Bun's timer on.
        const sdk = await import("@opencode-ai/sdk");
        const client = sdk.createOpencodeClient({
            baseUrl: h.serverUrl,
            fetch: (request: Request) => globalThis.fetch(request),
        });

        const startedAt = Date.now();
        let caught: unknown;
        try {
            await promptSyncWithValidatedOutputRetry(
                client as never,
                {
                    path: { id: childId },
                    query: { directory: h.workdir },
                    body: {
                        model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                        parts: [{ type: "text", text: `${PROBE}: take as long as you need.` }],
                    },
                },
                {
                    timeoutMs: OWN_SLICE_MS,
                    fallbackModels: ["mock-anthropic/mock-sonnet"],
                    callContext: "e2e:host-timeout",
                    fetchOutput: async () => "unused",
                    validateOutput: (output: string) => output,
                },
            );
        } catch (error) {
            caught = error;
        }
        const elapsedMs = Date.now() - startedAt;

        // Give a wrongly retried fallback time to reach the mock before counting.
        await Bun.sleep(5_000);
        const busy = await busySessions(h);
        const detail = getPromptFailureDetail(caught);
        console.log(
            JSON.stringify({
                elapsedMs,
                name: (caught as Error | undefined)?.name,
                message: (caught as Error | undefined)?.message,
                detail,
                probePrompts,
                busy,
            }),
        );

        // The real Bun timer fired, well before our own slice.
        expect((caught as Error | undefined)?.name).toBe("TimeoutError");
        expect(elapsedMs).toBeLessThan(OWN_SLICE_MS);
        expect(detail?.failureClass).toBe("provider_timeout");
        expect(detail?.modelsTried).toHaveLength(1);
        // No fallback was sent into the child that was still running. The host may
        // re-send the same step when its own provider-request timer fires, so the
        // mock can see more than one request, but each carries the one prompt.
        expect(probePrompts.length).toBeGreaterThanOrEqual(1);
        expect(Math.max(...probePrompts)).toBe(1);
        // The child's loop was aborted rather than left calling the model.
        expect(busy).not.toContain(childId);
    },
    RUN_WAIT_MS + 60_000,
);
