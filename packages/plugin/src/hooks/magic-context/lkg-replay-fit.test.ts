import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import { wireContentBytes } from "./final-wire-token-estimate";
import { lkgReplayFits, lkgReplayLimit } from "./lkg-replay-fit";
import type { MessageLike } from "./transform-operations";

// A model whose declared input limit is below its usable hard limit (a shared
// context/output window with a separate input figure), so the two limits differ.
const MODEL = { providerID: "openai-codex", modelID: "fit-model" };
const SESSION = "lkg-replay-fit-session";

function freshDb() {
    const db = new Database(":memory:");
    initializeDatabase(db as never);
    runMigrations(db as never);
    return db as never;
}

const messages: MessageLike[] = [
    {
        info: { id: "m1", role: "user", sessionID: SESSION },
        parts: [{ type: "text", text: "hello" }],
    } as MessageLike,
];

/** An estimator reporting a fixed, trusted token count. */
const estimateOf =
    (tokens: number, trusted = true) =>
    () => ({
        tokens,
        trusted,
        messageTokens: { conversation: tokens, toolCall: 0 },
        systemTokens: 0,
        toolDefinitionTokens: 0,
    });

describe("one admission limit for every last-known-good replay", () => {
    beforeEach(async () => {
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: MODEL.providerID,
                                models: {
                                    [MODEL.modelID]: {
                                        limit: {
                                            context: 400_000,
                                            input: 272_000,
                                            output: 128_000,
                                        },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
    });
    afterEach(() => clearModelsDevCache());

    it("admits every replay against the trusted limit, never the larger usable hard limit", () => {
        const db = freshDb();
        const ctx = { db, sessionID: SESSION };
        const usableHard = resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, ctx)
            ?.usableHard as number;
        const trusted = resolveTrustedContextLimit(MODEL.providerID, MODEL.modelID, ctx) as number;
        expect(trusted).toBe(272_000);
        expect(usableHard).toBeGreaterThan(trusted);
        expect(lkgReplayLimit({ db, sessionId: SESSION, model: MODEL, modelKey: null })).toBe(
            trusted,
        );

        const fits = (tokens: number) =>
            lkgReplayFits({
                db,
                sessionId: SESSION,
                messages,
                model: MODEL,
                modelKey: null,
                systemPromptTokens: 0,
                estimator: estimateOf(tokens),
            });
        // Between the trusted limit and the usable hard limit a provider that
        // enforces its declared prompt limit rejects the request, so no replay
        // (failure, wrapper or healthy frozen) is admitted there.
        expect(fits(trusted).fits).toBe(true);
        expect(fits(trusted + 1).fits).toBe(false);
        expect(fits(usableHard).fits).toBe(false);
    });

    it("the byte proxy counts what the request carries, not OpenCode's own tool metadata", () => {
        const fileText = "x".repeat(100_000);
        const editing: MessageLike = {
            info: { id: "a1", role: "assistant", sessionID: SESSION },
            parts: [
                {
                    type: "tool",
                    tool: "edit",
                    callID: "call-a1",
                    state: {
                        status: "completed",
                        input: { filePath: "/tmp/big.ts" },
                        output: "ok",
                        metadata: { filediff: { before: fileText, after: fileText } },
                    },
                },
                { type: "text", text: "done" },
            ],
        } as MessageLike;
        const measured = wireContentBytes([editing], Number.POSITIVE_INFINITY, 4);
        // The tool input and output, serialized, and the text part; not the file copies.
        expect(measured).toEqual({
            bytes: JSON.stringify({ filePath: "/tmp/big.ts" }).length + "ok".length + "done".length,
            aborted: false,
        });
    });

    it("declines an untrusted estimate", () => {
        const db = freshDb();
        const fit = lkgReplayFits({
            db,
            sessionId: SESSION,
            messages,
            model: MODEL,
            modelKey: null,
            systemPromptTokens: 0,
            estimator: estimateOf(10, false),
        });
        expect(fit).toEqual({ fits: false, detail: expect.stringContaining("lkg_fit_untrusted") });
    });

    it("declines from the byte proxy without tokenizing", () => {
        const db = freshDb();
        let estimates = 0;
        const huge: MessageLike[] = [
            {
                info: { id: "m1", role: "user", sessionID: SESSION },
                parts: [{ type: "text", text: "word ".repeat(400_000) }],
            } as MessageLike,
        ];
        const fit = lkgReplayFits({
            db,
            sessionId: SESSION,
            messages: huge,
            model: MODEL,
            modelKey: null,
            systemPromptTokens: 0,
            estimator: () => {
                estimates += 1;
                return estimateOf(10)();
            },
        });
        expect(fit.fits).toBe(false);
        expect(estimates).toBe(0);
    });
});
