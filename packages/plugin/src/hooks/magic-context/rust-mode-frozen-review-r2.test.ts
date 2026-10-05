/// <reference types="bun-types" />

// REVIEW FINDINGS (slice A re-review, docs/reports/slice-a-review-r2.md).
//
// Second adversarial review of the frozen last-known-good (LKG) replay changes in
// Rust mode, after their first review's fixes. Tests whose name starts with
// "FINDING" pin a defect and are red on purpose: each describes the behaviour the
// frozen-replay invariants require and fails while the defect is present. Tests
// whose name starts with "CONFIRMS" are green and record a property the review
// checked and found to hold.

import { afterEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    recordDetectedContextLimit,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { createDbLkgPersistence } from "./lkg-persist";
import { lkgReplayFits, lkgReplayLimit } from "./lkg-replay-fit";
import { registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    liveRustLkgReplayParticipantCountForTest,
    resetRustLkgReplayParticipantsForTest,
} from "./rust-lkg-freeze-registry";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";
import { firstServedDivergenceIndex } from "./transform-postprocess-phase";

type Model = { providerID: string; modelID: string };
const OPUS: Model = { providerID: "anthropic", modelID: "claude-opus-5-5" };

const databases: ContextDatabase[] = [];
const unregisters: Array<() => void> = [];
let sessionCounter = 0;

afterEach(() => {
    __resetToolDefinitionMeasurements();
    resetEmergencyRecoveryRegistryForTest();
    registerLkgPersistence(undefined);
    resetLkgSlotsForTest();
    resetRustLkgReplayParticipantsForTest();
    closeReadOnlySessionDb();
    transformDecisionTest.reset();
    clearModelsDevCache();
    for (const unregister of unregisters.splice(0)) unregister();
    for (const db of databases.splice(0)) closeQuietly(db);
});

function makeDb(): ContextDatabase {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    return db;
}

function installRawProvider(sessionId: string): void {
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    unregisters.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) =>
                !after || row.timeCreated > after.timeCreated || row.id > after.id
                    ? [row].slice(0, limit)
                    : [],
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "question" }],
                createdAt: 1,
            }),
        }),
    );
}

function user(sessionId: string, id: string, text: string, model: Model): MessageLike {
    return {
        info: { id, role: "user", sessionID: sessionId, model: { ...model } },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

function assistant(sessionId: string, id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [{ type: "text", text: `answer of ${id}` }],
    } as MessageLike;
}

function thinkingAssistant(sessionId: string, id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [
            {
                type: "reasoning",
                text: `thinking of ${id}`,
                metadata: { anthropic: { signature: `signature-${id}` } },
            },
            { type: "text", text: `answer of ${id}` },
        ],
    } as MessageLike;
}

/**
 * An assistant that edited a large file. OpenCode keeps the whole file before and
 * after the edit in the tool part's metadata for its own diff view; the provider
 * request carries only the tool input and output.
 */
function editingAssistant(sessionId: string, id: string, fileBytes: number): MessageLike {
    const before = "x".repeat(fileBytes);
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [
            {
                type: "tool",
                tool: "edit",
                callID: `call-${id}`,
                state: {
                    status: "completed",
                    input: { filePath: "/tmp/project/big.ts", oldString: "a", newString: "b" },
                    output: "Edit applied successfully.",
                    title: "big.ts",
                    metadata: {
                        diff: "@@ -1 +1 @@\n-a\n+b",
                        filediff: {
                            file: "/tmp/project/big.ts",
                            before,
                            after: `${before}b`,
                            additions: 1,
                            deletions: 1,
                        },
                    },
                    time: { start: 1, end: 2 },
                },
            },
            { type: "text", text: `edited in ${id}` },
        ],
    } as MessageLike;
}

function hasReasoning(message: unknown): boolean {
    return (message as MessageLike).parts.some(
        (part) => (part as { type?: string }).type === "reasoning",
    );
}

/** The module tags every user message the way the Rust tag overlay does. */
function tagAllUsers(input: MessageLike[]): unknown[] {
    return structuredClone(input).map((message, index) =>
        message.info.role === "user"
            ? {
                  ...message,
                  parts: message.parts.map((part) => {
                      const record = part as { type?: string; text?: string };
                      return record.type === "text" && typeof record.text === "string"
                          ? { ...record, text: `§${index + 1}§ ${record.text}` }
                          : part;
                  }),
              }
            : message,
    );
}

type Step = "throw" | string | { decision: string; response: Record<string, unknown> };

/**
 * A Rust session whose module answers each pass from a script and renders the
 * input through `moduleOutput`. Captures commit inline. `restart` is a new
 * process: a fresh adapter on the same database with the in-memory slot store
 * emptied, so the next read hydrates the durable slot.
 */
function reviewSession(label: string, model: Model = OPUS) {
    sessionCounter += 1;
    const sessionId = `rust-frozen-review-r2-${label}-${sessionCounter}-${Date.now()}`;
    const modelKey = `${model.providerID}/${model.modelID}`;
    const db = makeDb();
    installRawProvider(sessionId);
    recordDetectedContextLimit(db, sessionId, 200_000, modelKey);
    let pass = 0;
    const script: Step[] = [];
    let moduleOutput: (input: MessageLike[]) => unknown[] = (input) => structuredClone(input);
    let lastInput: MessageLike[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method !== "transform") return { ok: true };
            pass += 1;
            const step = script.shift() ?? "SOFT+";
            if (step === "throw") throw new Error("daemon unavailable");
            return {
                ...(typeof step === "string" ? {} : step.response),
                decision: typeof step === "string" ? step : step.decision,
                served_from: "transform",
                row_version: pass,
                native_messages: moduleOutput(lastInput),
            };
        },
    };
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: "/tmp/project",
        projectPath: "/tmp/project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[sessionId, { ...model }]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        historianRunner: "broca",
        getModelKey: () => modelKey,
    };
    const makeAdapter = () =>
        createRustModeTransform(deps, {
            moduleClient,
            modulePageMaxBytes: 512 * 1024,
            scheduleLkgCapture: (capture) => capture(),
            rawFallbackEstimatorForTests: (args) => estimateFinalWireInputTokens(args),
        });
    let transform = makeAdapter();
    const meta = () => {
        const sessionMeta = getOrCreateSessionMeta(db, sessionId);
        recordToolDefinition(model.providerID, model.modelID, undefined, "read", "read fixture", {
            type: "object",
        });
        if (sessionMeta.systemPromptTokens <= 0) {
            updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
            sessionMeta.systemPromptTokens = 100;
        }
        return sessionMeta;
    };
    const run = async (input: MessageLike[], step?: Step) => {
        if (step !== undefined) script.push(step);
        lastInput = input;
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, meta());
        return structuredClone(output.messages);
    };
    return {
        sessionId,
        db,
        model,
        user: (id: string, text: string) => user(sessionId, id, text, model),
        get transform() {
            return transform;
        },
        restart: () => {
            resetLkgSlotsForTest();
            resetRustLkgReplayParticipantsForTest();
            registerLkgPersistence(createDbLkgPersistence(db));
            transform = makeAdapter();
        },
        run,
        setModuleOutput: (value: (input: MessageLike[]) => unknown[]) => {
            moduleOutput = value;
        },
    };
}

describe("review r2: the admission limit of every last-known-good replay", () => {
    // GitHub Copilot's gpt-5-mini as OpenCode's catalog lists it: a 264k window, a
    // 128k prompt limit, a 64k output limit. Copilot rejects a prompt over its
    // prompt limit ("Prompt exceeds the limit of N tokens", overflow-detection.ts),
    // whatever the requested output.
    const COPILOT = { providerID: "github-copilot", modelID: "gpt-5-mini" };

    it("FINDING: a failure or wrapper replay is admitted above a provider-enforced prompt limit", async () => {
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: COPILOT.providerID,
                                models: {
                                    [COPILOT.modelID]: {
                                        limit: { context: 264_000, input: 128_000, output: 64_000 },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
        const db = makeDb();
        const sessionId = "review-r2-copilot";
        const ctx = { db, sessionID: sessionId };
        // The declared prompt limit is what the replay paths used before this slice.
        expect(resolveTrustedContextLimit(COPILOT.providerID, COPILOT.modelID, ctx)).toBe(128_000);
        const usableHard = resolveContextWindowGeometry(
            COPILOT.providerID,
            COPILOT.modelID,
            ctx,
        )?.usableHard;
        expect(lkgReplayLimit({ db, sessionId, model: COPILOT, modelKey: null })).toBe(128_000);
        const fit = lkgReplayFits({
            db,
            sessionId,
            messages: [
                {
                    info: { id: "m1", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "hello" }],
                } as MessageLike,
            ],
            model: COPILOT,
            modelKey: null,
            systemPromptTokens: 0,
            // A replay of 150k tokens: over the 128k prompt limit Copilot enforces.
            estimator: () => ({
                tokens: 150_000,
                trusted: true,
                messageTokens: { conversation: 150_000, toolCall: 0 },
                systemTokens: 0,
                toolDefinitionTokens: 0,
            }),
        });
        expect({ limit: usableHard, fits: fit.fits }).toEqual({
            limit: usableHard,
            fits: false,
        });
    });
});

describe("review r2: the four-bytes-per-token proxy over whole OpenCode messages", () => {
    it("FINDING: a failure replay whose only bulk is edit-tool metadata the wire never carries is refused", async () => {
        const s = reviewSession("proxy-metadata");
        const sid = s.sessionId;
        await s.run([s.user("m1", "question")], "HARD");
        // Two edits of a 300 KB file: about 1.2 MB of before/after file text in
        // tool metadata, over the 800 KB the proxy allows a 200k-token limit. The
        // request itself is a few hundred tokens.
        const conversation: MessageLike[] = [
            s.user("m1", "question"),
            editingAssistant(sid, "a1", 300_000),
            s.user("m2", "turn 2"),
            editingAssistant(sid, "a2", 300_000),
            s.user("m3", "turn 3"),
        ];
        const estimate = estimateFinalWireInputTokens({
            messages: conversation,
            systemPromptTokens: 100,
            providerID: OPUS.providerID,
            modelID: OPUS.modelID,
            agentName: undefined,
        });
        expect(estimate.trusted).toBe(true);
        expect(estimate.tokens).toBeLessThan(20_000);

        // The module fails. The slot plus the raw tail fits the window by the
        // trusted estimate, so the pass must replay it rather than refuse.
        let refusal: unknown = null;
        let served: unknown[] = [];
        try {
            served = await s.run([...conversation], "throw");
        } catch (error) {
            refusal = error;
        }
        expect({
            refused: refusal === null ? null : (refusal as Error).name,
            served: served.length,
        }).toEqual({ refused: null, served: conversation.length });
    });
});

describe("review r2: a restart and the count-release budget", () => {
    it("FINDING: a freeze resumed by each restart never reaches its count release", async () => {
        const s = reviewSession("restart-budget");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        await s.run([s.user("m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            s.user("m1", "question"),
            assistant(sid, "a1"),
            s.user("m2", "turn 2"),
        ];
        await s.run([...conversation], "throw");
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(true);
        let turn = 2;
        let frozenPasses = 0;
        const frozenInputCount = conversation.length;
        // Three restarts, each after six frozen healthy passes. The count release
        // ends a freeze after 8 healthy passes or 16 messages of raw tail growth.
        for (let cycle = 0; cycle < 3; cycle += 1) {
            for (let index = 0; index < 6; index += 1) {
                turn += 1;
                conversation.push(assistant(sid, `a${turn}`), s.user(`m${turn}`, `turn ${turn}`));
                await s.run([...conversation], "SOFT+");
                if (s.transform.getState(sid).lkgRepresentationFrozen) frozenPasses += 1;
            }
            s.restart();
        }
        turn += 1;
        conversation.push(assistant(sid, `a${turn}`), s.user(`m${turn}`, `turn ${turn}`));
        await s.run([...conversation], "SOFT+");
        const stillFrozen = s.transform.getState(sid).lkgRepresentationFrozen;
        // The freeze must end within the count budget whatever the restarts do.
        expect({
            frozenPasses,
            rawTailGrowth: conversation.length - frozenInputCount,
            stillFrozen,
        }).toEqual({
            frozenPasses,
            rawTailGrowth: conversation.length - frozenInputCount,
            stillFrozen: false,
        });
    });
});

describe("review r2: the restart thinking strip on every prefix-bound model", () => {
    for (const model of [
        { providerID: "anthropic", modelID: "claude-opus-5-5" },
        { providerID: "anthropic", modelID: "claude-sonnet-5-5" },
        { providerID: "anthropic", modelID: "claude-fable-5-1" },
    ]) {
        it(`CONFIRMS (${model.modelID}): a restarted trim-only SOFT strips every signed block from the first changed message`, async () => {
            const s = reviewSession(`restart-trim-only-${model.modelID}`, model);
            const sid = s.sessionId;
            await s.run([s.user("m1", "question")], "HARD");
            const conversation: MessageLike[] = [
                s.user("m1", "question"),
                thinkingAssistant(sid, "a1"),
                s.user("m2", "turn 2"),
            ];
            await s.run([...conversation], "throw");
            conversation.push(thinkingAssistant(sid, "a2"), s.user("m3", "turn 3"));
            await s.run([...conversation], "SOFT+");
            conversation.push(thinkingAssistant(sid, "a3"), s.user("m4", "turn 4"));
            const lastFrozen = await s.run([...conversation], "SOFT+");

            s.restart();
            // The module's own edit is the oldest reasoning trim (a1), and it tags
            // m2..m4, which the freeze served untagged.
            s.setModuleOutput((input) =>
                tagAllUsers(input).map((message) => {
                    const record = message as MessageLike;
                    if (record.info.id === "m1") return structuredClone(input[0]);
                    return record.info.id === "a1"
                        ? {
                              ...record,
                              parts: record.parts.filter(
                                  (part) => (part as { type?: string }).type !== "reasoning",
                              ),
                          }
                        : message;
                }),
            );
            const busted = await s.run([...conversation], {
                decision: "SOFT",
                response: { reasoning_trim_only: true },
            });
            const divergence = firstServedDivergenceIndex(busted, lastFrozen, {
                providerID: model.providerID,
            });
            expect(divergence).toBe(1);
            for (const message of busted.slice(divergence ?? 0)) {
                expect(hasReasoning(message)).toBe(false);
            }
        });
    }
});

describe("review r2: an adapter OpenCode drops without disposing it", () => {
    it("CONFIRMS: an undisposed adapter that ran a session is collected", async () => {
        resetRustLkgReplayParticipantsForTest();
        const sessionIds: string[] = [];
        await (async () => {
            const s = reviewSession("undisposed-collect");
            sessionIds.push(s.sessionId);
            await s.run([s.user("m1", "question")], "HARD");
            await s.run(
                [s.user("m1", "question"), assistant(s.sessionId, "a1"), s.user("m2", "two")],
                "throw",
            );
            expect(liveRustLkgReplayParticipantCountForTest()).toBe(1);
        })();
        // Weak references are cleared only after the job that created them ends.
        for (let attempt = 0; attempt < 50; attempt += 1) {
            await Bun.sleep(20);
            Bun.gc(true);
            if (liveRustLkgReplayParticipantCountForTest() === 0) break;
        }
        expect(liveRustLkgReplayParticipantCountForTest()).toBe(0);
    });
});
