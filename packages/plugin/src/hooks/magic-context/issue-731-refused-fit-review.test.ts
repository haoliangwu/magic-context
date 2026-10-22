import { expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { recordToolDefinition } from "../../features/magic-context/tool-definition-tokens";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { clearInjectionCache } from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

interface Outcome {
    /** The first over-window pass refused. */
    refused: boolean;
    /** What that first pass served (empty when it refused). */
    served: string;
    /** Set when the retry of a refused pass refused again. */
    retryError?: unknown;
    /** The retry's final-wire estimate, when it served. */
    retryTokens?: number;
}

/**
 * One over-window pass at 70% usage, then a retry of the same input. `heavy`
 * gives the turn's step 1,600 reasoning tokens, so on a prefix-bound model the
 * bounded hold applies (70% is below the 75% cap); otherwise the turn is unheld.
 */
async function scenario(
    host: "oc1" | "oc2",
    subagent: boolean,
    modelID: string,
    heavy: boolean,
): Promise<Outcome> {
    const home = createTestTempDir("issue-731-refused-fit-review-");
    const db = openDatabase(`${home.dir}/context.db`)!;
    const sessionId = `issue-731-refused-fit-review-${host}-${subagent}-${modelID}-${heavy}`;
    const route = { providerID: "anthropic", modelID };
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        cacheTtl: "never",
        lastResponseTime: Date.now(),
        systemPromptTokens: 100,
        systemPromptHash: "review-system",
        isSubagent: subagent,
    });
    recordDetectedContextLimit(db, sessionId, 16_000, `anthropic/${modelID}`);
    recordToolDefinition("anthropic", route.modelID, undefined, "read", "Read", {
        type: "object",
    });
    let decision: "execute" | "defer" = "defer";
    const usage = new Map([
        [
            sessionId,
            {
                usage: { percentage: 70, inputTokens: 11_200 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const deferred = new Set<string>();
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        contextUsageMap: usage,
        liveModelBySession: new Map([[sessionId, route]]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: deferred,
        lastHeuristicsTurnId: new Map(),
        directory: home.dir,
        protectedTokens: 4000,
        clearReasoningAge: 0,
        historianRunnable: false,
        injectDocs: false,
        memoryConfig: { enabled: false },
        ...(host === "oc2"
            ? {
                  storeGeneration: "v2" as const,
                  hostCleanupCompactionMarkers: () => ({
                      verified: true,
                      removedLineages: 0,
                      removedRows: 0,
                      retainedLineages: 0,
                  }),
              }
            : {}),
    });
    const msg = (id: string, role: "user" | "assistant", parts: unknown[]) =>
        ({
            info: {
                id,
                role,
                sessionID: sessionId,
                ...(role === "assistant" ? { ...route, finish: "stop" } : {}),
            },
            parts,
        }) as MessageLike;
    let output = "small result";
    const source = () => [
        msg("msg01", "user", [{ type: "text", text: "start" }]),
        msg("msg02", "assistant", [{ type: "text", text: "done" }]),
        msg("msg03", "user", [{ type: "text", text: "continue" }]),
        msg("msg04", "assistant", [
            {
                type: "reasoning",
                text: "Covered thought",
                metadata: { anthropic: { signature: "old-signature" } },
            },
        ]),
        msg("msg05", "user", [{ type: "text", text: "continue work" }]),
        {
            ...msg("msg06", "assistant", [
                {
                    type: "reasoning",
                    text: "Active thought",
                    metadata: { anthropic: { signature: "active-signature" } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: "read-call",
                    state: { status: "completed", input: {}, output },
                },
            ]),
            info: {
                ...msg("msg06", "assistant", []).info,
                finish: "tool-calls",
                ...(heavy ? { tokens: { input: 0, output: 1_600, reasoning: 1_600 } } : {}),
            },
        },
    ];
    const compartment = (sequence: number, start: number, end: number) => ({
        sequence,
        startMessage: start,
        endMessage: end,
        startMessageId: `msg0${start}`,
        endMessageId: `msg0${end}`,
        title: "Covered",
        content: `History ${sequence}`,
    });
    try {
        appendCompartments(db, sessionId, [compartment(0, 1, 2)]);
        await transform({}, { messages: source().slice(0, 5) });
        await transform({}, { messages: source() });
        appendCompartments(db, sessionId, [compartment(1, 3, 4)]);
        deferred.add(sessionId);
        decision = "execute";
        output = "RECLAIMABLE tool result words ".repeat(30_000);
        let refused = false;
        const first = source();
        try {
            await transform({}, { messages: first });
        } catch (error) {
            expect(error).toMatchObject({ name: "EmergencyFailClosedError" });
            refused = true;
        }
        if (!refused) return { refused, served: JSON.stringify(first) };
        const retry = source();
        let retryError: unknown;
        try {
            await transform({}, { messages: retry });
        } catch (error) {
            retryError = error;
        }
        if (retryError) return { refused, served: "", retryError };
        const estimate = estimateFinalWireInputTokens({
            messages: retry,
            systemPromptTokens: 100,
            ...route,
        });
        return { refused, served: "", retryTokens: estimate.refusalTokens ?? estimate.tokens };
    } finally {
        clearInjectionCache(sessionId);
        closeReadOnlySessionDb();
        closeDatabase();
        home.cleanup();
    }
}

for (const host of ["oc1", "oc2"] as const)
    for (const subagent of [false, true]) {
        // Issue 731's guarantee holds for a turn the bounded hold keeps: the signed
        // fit may refuse, and a retry of the same input never serves the same
        // over-window result.
        test(`review issue 731 ${host} ${subagent ? "subagent" : "primary"}: retry after refused signed fit must not serve the same over-window result`, async () => {
            const outcome = await scenario(host, subagent, "claude-opus-5-5", true);
            // A pass can fit by deleting the result. If it refuses instead,
            // retrying unchanged input must still check it against the context limit.
            if (!outcome.refused) {
                expect(outcome.served).not.toContain("RECLAIMABLE tool result words");
                return;
            }
            if (outcome.retryError)
                expect(outcome.retryError).toMatchObject({ name: "EmergencyFailClosedError" });
            else
                expect(
                    outcome.retryTokens,
                    "a returned retry must actually fit",
                ).toBeLessThanOrEqual(16_000);
        }, 30_000);
        // An unheld signed turn (no recent heavy reasoning) is not the held case the
        // signed fit exists for: it must behave like a model without prefix-bound
        // thinking in the same situation, refusing exactly when that model refuses
        // and otherwise serving the same reclaimed content.
        test(`review issue 731 ${host} ${subagent ? "subagent" : "primary"}: an unheld signed turn over the window behaves like a model without prefix-bound thinking`, async () => {
            const unheld = await scenario(host, subagent, "claude-opus-5-5", false);
            const other = await scenario(host, subagent, "claude-sonnet-5", false);
            expect(unheld.refused).toBe(other.refused);
            expect(unheld.served.includes("RECLAIMABLE tool result words")).toBe(
                other.served.includes("RECLAIMABLE tool result words"),
            );
        }, 60_000);
    }
