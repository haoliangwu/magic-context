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
    recordOverflowDetected,
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
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { clearLkgMeasuredRequest, noteLkgProviderResponse } from "./lkg-measured-request";
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
function reviewSession(label: string, model: Model = OPUS, pageBytes = 512 * 1024) {
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
    const wireRecords: Array<{ bytes: number; delta: boolean; nativeDelta: boolean }> = [];
    let outputDeltas = false;
    let moduleIngress: MessageLike[] = [];
    let previousNative: unknown[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method !== "transform") return { ok: true };
            const request = body as Record<string, unknown>;
            const delta = request.tail_delta as
                | { after: string; native_replace_from: number }
                | undefined;
            const record = {
                bytes: Buffer.byteLength(JSON.stringify(request)),
                delta: !!delta,
                nativeDelta: false,
            };
            wireRecords.push(record);
            pass += 1;
            const step = script.shift() ?? "SOFT+";
            if (step === "throw") throw new Error("daemon unavailable");
            moduleIngress = delta
                ? [
                      ...moduleIngress.slice(0, delta.native_replace_from),
                      ...(request.native_messages as MessageLike[]),
                  ]
                : structuredClone(request.native_messages as MessageLike[]);
            if (outputDeltas) expect(moduleIngress).toEqual(lastInput);
            const next = moduleOutput(outputDeltas ? moduleIngress : lastInput);
            let replaceFrom = 0;
            while (
                replaceFrom < previousNative.length &&
                replaceFrom < next.length &&
                JSON.stringify(previousNative[replaceFrom]) === JSON.stringify(next[replaceFrom])
            )
                replaceFrom++;
            const native =
                outputDeltas && delta
                    ? {
                          native_messages_delta: {
                              after: delta.after,
                              replace_from: replaceFrom,
                              messages: structuredClone(next.slice(replaceFrom)),
                          },
                      }
                    : { native_messages: structuredClone(next) };
            record.nativeDelta = "native_messages_delta" in native;
            previousNative = structuredClone(next);
            return {
                ...(typeof step === "string" ? {} : step.response),
                decision: typeof step === "string" ? step : step.decision,
                prefix_bust_permitted: ["HARD", "SOFT"].includes(
                    typeof step === "string" ? step : step.decision,
                ),
                served_from: "transform",
                row_version: pass,
                ...native,
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
            modulePageMaxBytes: pageBytes,
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
        wireRecords,
        enableOutputDeltas: () => {
            outputDeltas = true;
        },
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

describe("review r2: a restart and frozen recovery debt", () => {
    it("preserves raw-served bytes across repeated restarts until a producer rebuild", async () => {
        const s = reviewSession("restart-budget");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        await s.run([s.user("m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            s.user("m1", "question"),
            assistant(sid, "a1"),
            s.user("m2", "turn 2"),
        ];
        const replay = await s.run([...conversation], "throw");
        const frozenBytes = JSON.stringify(replay);
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(true);
        let turn = 2;
        let frozenPasses = 0;
        const frozenInputCount = conversation.length;
        // Three restarts, each after six defers. Neither healthy-pass debt nor
        // growing raw input authorizes tags on messages already served raw.
        for (let cycle = 0; cycle < 3; cycle += 1) {
            for (let index = 0; index < 6; index += 1) {
                turn += 1;
                conversation.push(assistant(sid, `a${turn}`), s.user(`m${turn}`, `turn ${turn}`));
                const served = await s.run([...conversation], "SOFT+");
                expect(JSON.stringify(served.slice(0, replay.length))).toBe(frozenBytes);
                if (s.transform.getState(sid).lkgRepresentationFrozen) frozenPasses += 1;
            }
            s.restart();
        }
        turn += 1;
        conversation.push(assistant(sid, `a${turn}`), s.user(`m${turn}`, `turn ${turn}`));
        const served = await s.run([...conversation], "SOFT+");
        expect(JSON.stringify(served.slice(0, replay.length))).toBe(frozenBytes);
        const stillFrozen = s.transform.getState(sid).lkgRepresentationFrozen;
        // Repeated restarts must not hide the raw tail's already-served bytes.
        expect({
            frozenPasses,
            rawTailGrowth: conversation.length - frozenInputCount,
            stillFrozen,
        }).toEqual({
            frozenPasses: 18,
            rawTailGrowth: 38,
            stillFrozen: true,
        });
        const rebuilt = await s.run([...conversation], "HARD");
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(false);
        expect(JSON.stringify(rebuilt)).not.toBe(JSON.stringify(served));
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

describe("frozen recovery admission", () => {
    for (const emergency of [false, true]) {
        it(`${emergency ? "CONTROL: emergency" : "REVIEW: both-over"} frozen recovery must refuse rather than send ten known-over requests`, async () => {
            const s = reviewSession(`known-over-${emergency}`, OPUS, 8 * 1024 * 1024);
            s.setModuleOutput(tagAllUsers);
            const input = [s.user("m1", "question")];
            await s.run(input, "HARD");
            await s.run(input, "throw");
            if (emergency)
                recordOverflowDetected(s.db, s.sessionId, 200_000, "anthropic/claude-opus-5-5");
            input.push(assistant(s.sessionId, "a1"), s.user("m2", "word ".repeat(300_000)));
            let sent = 0;
            const refusals: unknown[] = [];
            for (let i = 0; i < 10; i++) {
                try {
                    await s.run(input, "SOFT+");
                    sent++;
                } catch (error) {
                    refusals.push(error);
                }
            }
            expect({ sent, refused: refusals.length }).toEqual({ sent: 0, refused: 10 });
            for (const refusal of refusals) {
                expect(refusal).toBeInstanceOf(EmergencyFailClosedError);
                expect((refusal as Error).message).toContain("MC-H07");
            }
            expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
            expect(s.transform.getState(s.sessionId).failureCount).toBe(1);
        });
    }

    it("refuses known-over frozen bytes when native fit is unproven without an emergency", async () => {
        const s = reviewSession("native-unproven", OPUS, 8 * 1024 * 1024);
        const input = [s.user("m1", "question")];
        await s.run(input, "HARD");
        await s.run(input, "throw");
        input.push(assistant(s.sessionId, "a1"), s.user("m2", "word ".repeat(300_000)));
        const unknown = s.user("native", "small native output");
        unknown.parts.push({ type: "future-provider-part" } as never);
        s.setModuleOutput(() => [unknown]);
        await expect(s.run(input, "SOFT+")).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
        expect(s.transform.getState(s.sessionId).failureCount).toBe(1);
    });

    it("CONTROL: unproven frozen fit still holds even when native output fits", async () => {
        const s = reviewSession("frozen-unproven");
        const input = [s.user("m1", "question")];
        await s.run(input, "HARD");
        const frozen = await s.run(input, "throw");
        const tail = s.user("m2", "unknown tail");
        tail.parts.push({ type: "future-provider-part" } as never);
        input.push(assistant(s.sessionId, "a1"), tail);
        s.setModuleOutput(() => [s.user("m1", "small native output")]);
        expect(await s.run(input, "SOFT+")).toEqual([...frozen, ...input.slice(1)]);
        expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
    });

    it("CONTROL: frozen replay measured under the limit still sends despite an over-budget prefix estimate", async () => {
        const s = reviewSession("measured-under", OPUS, 8 * 1024 * 1024);
        const modelKey = "anthropic/claude-opus-5-5";
        const input = [s.user("m1", "word ".repeat(300_000))];
        noteLkgProviderResponse({
            sessionId: s.sessionId,
            modelKey,
            responseId: "a1",
            inputTokens: 0,
        });
        try {
            const initial = await s.run(input, "HARD");
            noteLkgProviderResponse({
                sessionId: s.sessionId,
                modelKey,
                responseId: "a1",
                inputTokens: 1_000,
                finish: "stop",
            });
            input.push(assistant(s.sessionId, "a1"), s.user("m2", "small tail"));
            const frozen = await s.run(input, "throw");
            expect(frozen).toEqual([...initial, ...input.slice(1)]);
            expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
            s.setModuleOutput(tagAllUsers);
            expect(await s.run(input, "SOFT+")).toEqual(frozen);
            expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
        } finally {
            clearLkgMeasuredRequest(s.sessionId);
        }
    });
});

describe("frozen native transport", () => {
    it("continues native input and output deltas while serving frozen bytes and adopts the native basis on rebuild", async () => {
        const s = reviewSession("native-delta");
        s.enableOutputDeltas();
        s.setModuleOutput(tagAllUsers);
        const input = [s.user("m1", "question")];
        await s.run(input, "HARD");
        const frozen = await s.run(input, "throw");
        // The module's native prefix has a different shape and nested bytes from
        // the provider-visible replay. Its deltas must never use the replay as a base.
        const native = (raw: MessageLike[]) => [
            s.user("native-only", "module prefix"),
            ...tagAllUsers(raw),
        ];
        s.setModuleOutput(native);
        for (let i = 0; i < 5; i++) {
            input.push(assistant(s.sessionId, `a${i}`), s.user(`m${i + 2}`, `tail ${i}`));
            expect(await s.run(input, "SOFT+")).toEqual([...frozen, ...input.slice(1)]);
            expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
            if (i > 0)
                expect(s.wireRecords.at(-1)).toMatchObject({ delta: true, nativeDelta: true });
        }
        // A no-append delta reuses the entire native array. The adoption seam
        // must select it, not the shorter frozen array the provider last saw.
        expect(await s.run(input, "HARD")).toEqual(native(input));
        expect(s.wireRecords.at(-1)).toMatchObject({ delta: true, nativeDelta: true });
        expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(false);
        const adopted = native(input);
        input.push(assistant(s.sessionId, "a-final"), s.user("m-final", "after adoption"));
        const continued = await s.run(input, "SOFT+");
        expect(continued).toEqual(native(input));
        expect(continued.slice(0, adopted.length)).toEqual(adopted);
        expect(s.wireRecords.at(-1)).toMatchObject({ delta: true, nativeDelta: true });
        expect(s.transform.getState(s.sessionId).consecutiveFailures).toBe(0);
    });

    it("CONTROL: measures one hundred fitting frozen defers against full transport without changing served bytes", async () => {
        const measure = async (full: boolean) => {
            const s = reviewSession(full ? "transport-full" : "transport-delta");
            s.enableOutputDeltas();
            s.setModuleOutput(tagAllUsers);
            const input = [s.user("m1", "question")];
            await s.run(input, "HARD");
            const frozen = await s.run(input, "throw");
            for (let i = 0; i < 100; i++) {
                input.push(
                    assistant(s.sessionId, `a${i}`),
                    s.user(`m${i + 2}`, "word ".repeat(100)),
                );
                if (full) s.transform.invalidateWireState(s.sessionId);
                expect(await s.run(input, "SOFT+")).toEqual([...frozen, ...input.slice(1)]);
                expect(s.transform.getState(s.sessionId).lkgRepresentationFrozen).toBe(true);
            }
            const bodies = s.wireRecords.slice(2);
            return {
                bytes: bodies.reduce((sum, r) => sum + r.bytes, 0),
                deltas: bodies.filter((r) => r.delta).length,
            };
        };
        const delta = await measure(false);
        const full = await measure(true);
        console.log(
            "FROZEN_TRANSPORT",
            JSON.stringify({ delta, full, ratio: full.bytes / delta.bytes }),
        );
        expect(full.deltas).toBe(0);
        expect(full.bytes).toBeGreaterThan(8_000_000);
        expect(delta.bytes).toBeLessThan(full.bytes / 8);
        expect(delta.deltas).toBe(99);
    });
});
