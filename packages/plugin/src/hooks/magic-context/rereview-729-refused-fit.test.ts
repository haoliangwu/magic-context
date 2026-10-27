/// <reference types="bun-types" />
// Bounded signed-thinking hold (issue 729): how an over-window request is
// retried or refused once its signed thinking cannot be kept (the signed fit).
// Copy into another checkout to compare.
//
// Setup as in issue-731-refused-fit-review.test.ts: a 16k learned window, one
// over-window tool result at 70% usage. The cases print what each pass did:
// - a held turn refuses, a restart is simulated (the database is reopened and
//   the transform rebuilt), and the same input is retried: the durable
//   refusal marker must make it refuse again or fit, never serve it unchanged;
// - after that refusal the turn becomes unheld (usage above the cap) and is
//   still over the window: whether that unheld pass refuses on the estimate.
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

async function run(host: "oc1" | "oc2", modelID: string) {
    const home = createTestTempDir("rr729-fit-");
    let db = openDatabase(`${home.dir}/context.db`)!;
    const sessionId = `rr729-fit-${host}-${modelID}`;
    const route = { providerID: "anthropic", modelID };
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        cacheTtl: "never",
        lastResponseTime: Date.now(),
        systemPromptTokens: 100,
        systemPromptHash: "review-system",
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
    const build = () =>
        createTransform({
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
    let transform = build();
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
                tokens: { input: 0, output: 1_600, reasoning: 1_600 },
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
    const attempt = async (label: string) => {
        const messages = source();
        try {
            await transform({}, { messages });
        } catch (error) {
            return `${label}: refused ${(error as Error).name}`;
        }
        const estimate = estimateFinalWireInputTokens({
            messages,
            systemPromptTokens: 100,
            ...route,
        });
        const text = JSON.stringify(messages);
        return `${label}: served tokens=${estimate.refusalTokens ?? estimate.tokens} keepsResult=${text.includes("RECLAIMABLE")} keepsActiveThinking=${text.includes("active-signature")}`;
    };
    try {
        appendCompartments(db, sessionId, [compartment(0, 1, 2)]);
        await transform({}, { messages: source().slice(0, 5) });
        await transform({}, { messages: source() });
        appendCompartments(db, sessionId, [compartment(1, 3, 4)]);
        deferred.add(sessionId);
        decision = "execute";
        output = "RECLAIMABLE tool result words ".repeat(30_000);
        const lines: string[] = [];
        lines.push(await attempt("held 70%"));
        // A restart: the process-local retry flag is gone; the durable marker stays.
        clearInjectionCache(sessionId);
        closeReadOnlySessionDb();
        closeDatabase();
        db = openDatabase(`${home.dir}/context.db`)!;
        transform = build();
        lines.push(await attempt("held 70% after restart"));
        // The same turn above the cap (75%): unheld.
        usage.set(sessionId, {
            usage: { percentage: 80, inputTokens: 12_800 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        lines.push(await attempt("unheld 80%"));
        return lines;
    } finally {
        clearInjectionCache(sessionId);
        closeReadOnlySessionDb();
        closeDatabase();
        home.cleanup();
    }
}

for (const host of ["oc1", "oc2"] as const)
    test(`${host}: signed-fit refusal across a restart and after the hold lifts`, async () => {
        const opus = await run(host, "claude-opus-5-5");
        const sonnet = await run(host, "claude-sonnet-5");
        console.log(`[rereview-729] fit ${host} opus: ${opus.join(" | ")}`);
        console.log(`[rereview-729] fit ${host} sonnet: ${sonnet.join(" | ")}`);
        // After a restart, a held retry never serves the same over-window result.
        expect(opus[1]).not.toMatch(/keepsResult=true/);
        // On the unheld pass Opus must refuse exactly when Sonnet (a model
        // without prefix-bound thinking) refuses.
        expect(opus[2]!.startsWith("unheld 80%: refused")).toBe(
            sonnet[2]!.startsWith("unheld 80%: refused"),
        );
    }, 60_000);
