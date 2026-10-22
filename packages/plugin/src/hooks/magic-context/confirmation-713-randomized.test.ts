/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner } from "../../../../pi-plugin/node_modules/pi-coding-agent-087";
import * as piContext from "../../../../pi-plugin/src/context-handler";
import { persistPiPressureFromMessageEnd } from "../../../../pi-plugin/src/index";
import {
    clearPiSystemPromptSession,
    processSystemPromptForCache,
} from "../../../../pi-plugin/src/system-prompt";
import {
    assistantMessage,
    createFakePi,
    fakeContext,
    type PiMessage,
    toolResultMessage,
    userMessage,
} from "../../../../pi-plugin/src/test-utils.test";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { openDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as logger from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { StoreRow } from "../../v2/store-reader";
import * as rides from "./cache-busting-signals";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform, type TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";
import * as operations from "./transform-operations";

// Randomized cache-invariant check for automatic cleanup on Pi, OpenCode 1 and
// OpenCode 2. Each host serves REVIEW_PASSES (default 400) requests with
// restarts, degraded passes served from the last-known-good (LKG) copy, model
// switches, history refreshes, user flushes, idle expiry, pressure, prompt
// edits and (Pi) a later extension that overrides the final system prompt.
// The served request (system text plus every message) is compared with the
// previous one. A pass whose bytes change, or on which a queued drop lands,
// must have either the product's own recorded ride permission
// (hasReclaimRide) or an external cache-loss cause (first pass, model switch,
// idle expiry, changed system bytes). Degraded passes must replay the previous
// request exactly. REVIEW_NOFAULT=1 disables degraded passes as a control.
const passes = Number(process.env.REVIEW_PASSES ?? 400);
const fixedClock = 1_800_000_000_000;
const realNow = Date.now;
type HostMessage = MessageLike & { info: MessageLike["info"] & Record<string, unknown> };
let now = fixedClock;
const summaries: {
    host: string;
    signed: boolean;
    active: boolean;
    seed: number;
    ackAt: number;
    acks: number;
    counts?: Record<string, number>;
    pending: number;
    bodies: string[];
}[] = [];
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
}
function stable(value: unknown): string {
    if (value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
function _digest(value: unknown) {
    return createHash("sha256").update(stable(value)).digest("hex");
}
let recordedRides: rides.ReclaimRideSignals[] = [];
const originalRide = rides.hasReclaimRide;
const rideSpy = spyOn(rides, "hasReclaimRide").mockImplementation((signals) => {
    recordedRides.push(structuredClone(signals));
    return originalRide(signals);
});
let previousBody: any = null;
let droppedBefore = new Set<number>();
const ledger: any[] = [];
const violations: any[] = [];
let passLogs: string[] = [];
const originalLog = logger.sessionLog;
const logSpy = spyOn(logger, "sessionLog").mockImplementation((...args) => {
    passLogs.push(args.slice(1).map(String).join(" "));
    originalLog(...args);
});
function eventsFor(seed: number) {
    const rng = random(seed);
    return Array.from({ length: passes }, (_, pass) => {
        const kind = Math.floor(rng() * 12);
        const fault = pass > 0 && kind === 9 && process.env.REVIEW_NOFAULT !== "1";
        return {
            pass,
            fault,
            restart:
                process.env.REVIEW_NORESTART !== "1" && pass > 0 && (kind === 8 || pass % 37 === 0),
            edit: !fault && kind === 0,
            override: !fault && kind === 1,
            flush: !fault && (kind === 2 || pass % 20 === 19),
            history: !fault && (kind === 3 || kind === 4),
            drop: pass > 0,
            expiry: !fault && kind === 5,
            model: !fault && kind === 6,
            percent: fault ? 40 : kind === 7 ? 86 : [40, 64, 66][Math.floor(rng() * 3)]!,
            tool: true,
            append: !fault && pass % 4 === 0,
            order: rng() < 0.5 ? "system-first" : "messages-first",
        };
    });
}
function checkBody(host: string, e: any, liveBody: any, before: any[], db: any, id: string) {
    // Snapshot the served bytes now: later passes may reuse or edit the same objects.
    const body = JSON.parse(stable(liveBody));
    const current = [body.system, ...body.messages];
    const prior = previousBody ? [previousBody.system, ...previousBody.messages] : null;
    const first = prior
        ? prior.findIndex((m: any, i: number) => stable(m) !== stable(current[i]))
        : -1;
    const systemChanged = previousBody && stable(body.system) !== stable(previousBody.system);
    const realCause =
        !previousBody || e.flush || e.percent >= 85 || e.expiry || e.model || systemChanged;
    const landed = before.filter(
        (op) =>
            getTagsBySession(db, id).find((t) => t.tagNumber === op.tagId)?.status === "dropped",
    );
    const droppedNow = new Set(
        getTagsBySession(db, id)
            .filter((t) => t.status === "dropped")
            .map((t) => t.tagNumber),
    );
    const newlyDropped = [...droppedNow].filter((n) => !droppedBefore.has(n));
    droppedBefore = droppedNow;
    ledger.push({
        host,
        ...e,
        first,
        systemChanged: !!systemChanged,
        realCause: !!realCause,
        rides: recordedRides,
        landed: landed.length,
        newlyDropped,
        logs: passLogs.filter((l) => !l.startsWith("transform stage:")).map((l) => l.slice(0, 220)),
    });
    const changed = first >= 0 || landed.length > 0;
    const recorded = recordedRides.some(originalRide);
    const external = !previousBody || e.model || e.expiry || !!systemChanged;
    // V1: the served prefix changed (or a queued drop landed) with neither the
    // product's own recorded ride permission nor an external cache-loss cause.
    const unrecorded = changed && !recorded && !external;
    // V2: the product recorded a ride, but the harness supplied no flush,
    // pressure (execute >= 65%, force >= 85%), model, expiry or system change.
    const unexplainedRide = changed && recorded && !external && !e.flush && e.percent < 65;
    const faultMismatch = e.fault && previousBody && stable(body) !== stable(previousBody);
    const kind = unrecorded ? "V1" : unexplainedRide ? "V2" : faultMismatch ? "V3" : undefined;
    if (kind)
        violations.push({
            kind,
            host,
            event: e,
            rides: recordedRides,
            first,
            landed: landed.length,
            prior: prior?.[first],
            next: current[first],
            logs: [...passLogs],
        });
    previousBody = body;
}

async function openCode(host: "oc1" | "oc2", signed: boolean, seed: number, active = false) {
    const bindV2 = existsSync(join(import.meta.dir, "system-prompt-delivery.ts"))
        ? (await import("../../v2/hooks/system-prompt-response.ts")).bindV2SystemPromptResponse
        : undefined;
    const responseRows: StoreRow<"assistant">[] = [];
    const sessionId = `review-${host}-${signed}-${active ? "active-" : ""}${seed}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "delivery-review-"));
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: fixedClock });
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const project = "/nonexistent-system-delivery-review-project";
    const deps: TransformDeps = {
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: new Map(),
        protectedTokens: 1000,
        clearReasoningAge: 50,
        keepReasoningTokens: 2000,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[sessionId, model]]),
        getModelKey: () => `${model.providerID}/${model.modelID}`,
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        directory: project,
        projectPath: project,
        historianRunnable: false,
        protectedTools: { read: 0 },
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        client: {
            session: { get: async () => ({ data: { directory: project } }) },
        } as unknown as TransformDeps["client"],
        ...(host === "oc2"
            ? {
                  storeGeneration: "v2",
                  hostCleanupCompactionMarkers: () => ({
                      verified: true,
                      removedLineages: 0,
                      removedRows: 0,
                      retainedLineages: 0,
                  }),
              }
            : {}),
    };
    registerSystemDateRefresh(deps.historyRefreshSessions);
    let prepared = false;
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        memoryEnabled: false,
        resolveModel: () => model,
        historyRefreshSessions: deps.historyRefreshSessions,
        pendingMaterializationSessions: deps.pendingMaterializationSessions,
        systemPromptRefreshSessions: new Set(),
        lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
        consumeMessagesPrepared: () => prepared,
    });
    let transform = createTransform(deps);
    const wrapped = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": async (i, o) => transform(i, o) },
    });
    const source: HostMessage[] = [];
    let ordinal = 0;
    const user = () =>
        source.push({
            info: {
                id: `user-${ordinal}`,
                role: "user",
                sessionID: sessionId,
                time: { created: ++ordinal },
                model: { ...model },
            },
            parts: [{ type: "text", text: `task ${ordinal}` }],
        });
    const assistant = (tool: boolean) => {
        const id = `assistant-${++ordinal}`;
        source.push({
            info: {
                id,
                role: "assistant",
                sessionID: sessionId,
                time: { created: ordinal },
                providerID: model.providerID,
                modelID: model.modelID,
                finish: tool ? "tool-calls" : "stop",
            },
            parts: [
                ...((active || !tool) && signed
                    ? [
                          {
                              type: "reasoning",
                              text: `closed thought ${ordinal}`,
                              metadata: { anthropic: { signature: `sig-${ordinal}` } },
                          },
                      ]
                    : []),
                ...(tool
                    ? [
                          {
                              type: "tool",
                              tool: "read",
                              callID: `call-${ordinal}`,
                              state: {
                                  status: "completed",
                                  input: { path: `${ordinal}.ts` },
                                  output: `result ${ordinal} ${"payload ".repeat(200)}`,
                              },
                          },
                      ]
                    : [{ type: "text", text: `answer ${ordinal}` }]),
            ] as MessageLike["parts"],
        });
    };
    user();
    assistant(true);
    user();
    let instruction = "base instructions";
    const bodies: string[] = [];
    const errors: string[] = [];
    let ackAt = -1;
    let acks = 0;
    const counts: Record<string, number> = {};
    try {
        previousBody = null;
        droppedBefore = new Set();
        for (const e of eventsFor(seed)) {
            recordedRides = [];
            passLogs = [];
            if (e.restart) {
                deps.tagger = createTagger();
                deps.lastHeuristicsTurnId?.clear();
                deps.historyRefreshSessions?.clear();
                deps.pendingMaterializationSessions?.clear();
                deps.deferredHistoryRefreshSessions?.clear();
                deps.deferredMaterializationSessions?.clear();
                resetLkgSlotsForTest();
                transform = createTransform(deps);
            }
            now = fixedClock + e.pass * 1000;
            if (e.pass > 0) {
                if (e.model)
                    model.modelID =
                        model.modelID === "claude-opus-5-5"
                            ? "claude-sonnet-4-6"
                            : "claude-opus-5-5";
                if (e.append) assistant(true);
                if (active) {
                    // An open signed tool loop: no user closes the turn until a
                    // non-tool reply arrives, so the transform must hold the head.
                    if (!e.tool) {
                        assistant(false);
                        user();
                    }
                } else if (signed) {
                    if (e.append) {
                        assistant(false);
                        user();
                    }
                } else if (e.append) user();
                if (e.edit) instruction = `genuine instructions ${e.pass}`;
                if (e.flush)
                    requestPendingMaterialization(
                        deps.pendingMaterializationSessions,
                        sessionId,
                        "user_flush",
                    );
                if (e.history) deps.historyRefreshSessions.add(sessionId);
                if (e.model && !e.append) user();
                if (e.drop) {
                    const target = getTagsBySession(db, sessionId).find(
                        (tag) =>
                            tag.status === "active" &&
                            (tag.type === "tool" || (e.pass % 3 === 0 && tag.type === "message")),
                    );
                    if (target) queuePendingOp(db, sessionId, target.tagNumber, "drop");
                }
            }
            updateSessionMeta(db, sessionId, { lastResponseTime: e.expiry ? now - 600_000 : now });
            deps.contextUsageMap.set(sessionId, {
                usage: { percentage: e.percent, inputTokens: e.percent * 2000 },
                updatedAt: now,
            });
            const key = `${model.providerID}/${model.modelID}`;
            if (host === "oc2")
                beginV2LkgRequest(sessionId, key, `response-${e.pass - 1}`, responseRows.length);
            else
                noteLkgProviderResponse({
                    sessionId,
                    responseId: `response-${e.pass}`,
                    modelKey: key,
                    inputTokens: 0,
                });
            prepared = false;
            const output = { messages: structuredClone(source) };
            bindSystemDateRequestIdentity(output, output);
            const prompt = {
                system: [`${instruction}\n<plugin-env>\n Date: 2026-10-14\n</plugin-env>`],
            };
            const before = getPendingOps(db, sessionId);
            let restoreFault: (() => void) | undefined;
            if (e.fault) {
                const fault = spyOn(operations, "applyFlushedStatuses").mockImplementation(
                    (..._args) => {
                        fault.mockRestore();
                        throw new Error("confirmation fault before persisted replay");
                    },
                );
                restoreFault = () => fault.mockRestore();
            }
            try {
                if (e.order === "system-first")
                    await system.handler(
                        { sessionID: sessionId, model, dateRefreshRequest: output },
                        prompt,
                    );
                await wrapped({}, output as never);
                prepared = true;
                if (e.order === "messages-first")
                    await system.handler(
                        { sessionID: sessionId, model, dateRefreshRequest: output },
                        prompt,
                    );
                const body = {
                    system: prompt.system,
                    messages: output.messages.map((m) => ({ role: m.info.role, parts: m.parts })),
                };
                checkBody(host, e, body, before, db, sessionId);
                bodies.push(stable(body));
                const markerBefore = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash;
                if (host === "oc2") {
                    responseRows.push({
                        id: `response-${e.pass}`,
                        session_id: sessionId,
                        type: "assistant",
                        seq: responseRows.length + 1,
                        data: {
                            model: { providerID: model.providerID, id: model.modelID },
                            time: { created: now + 1 },
                        },
                    });
                    bindV2?.(sessionId, {
                        assistantSince: (_session, after) =>
                            responseRows.filter((row) => row.seq > after),
                    });
                }
                noteLkgProviderResponse({
                    sessionId,
                    responseId: `response-${e.pass}`,
                    modelKey: key,
                    inputTokens: 2000,
                    finish: e.tool ? "tool-calls" : "stop",
                    completedAt: now + 1,
                    createdAt: now + 1,
                    v2: host === "oc2",
                });
                // Diagnostics only: count provider replies that change the stored
                // system-prompt hash for the cached m[0] message (cachedM0SystemHash).
                if (getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash !== markerBefore) {
                    acks++;
                    if (ackAt < 0) ackAt = e.pass;
                }
            } catch (error) {
                if (
                    error instanceof Error &&
                    (error.name === "AssertionError" || String(error).includes("expect("))
                )
                    throw error;
                if (!e.fault) throw error;
                ledger.push({ host, ...e, refusal: String(error) });
                bodies.push(`ERROR:${String(error)}`);
            } finally {
                restoreFault?.();
            }
            await new Promise((resolve) => setImmediate(resolve));
            for (const event of [
                "edit",
                "flush",
                "history",
                "drop",
                "expiry",
                "model",
                "tool",
            ] as const)
                if (e[event]) counts[event] = (counts[event] ?? 0) + 1;
        }
        expect(errors).toEqual([]);
        expect(bodies).toHaveLength(passes);
        summaries.push({
            host,
            signed,
            active,
            seed,
            ackAt,
            acks,
            counts,
            pending: getPendingOps(db, sessionId).length,
            bodies,
        });
    } finally {
        clearLkgMeasuredRequest(sessionId);
        db.close();
        cleanupTestTempDir(home);
    }
}

async function pi(signed: boolean, seed: number, active = false) {
    const sessionId = `review-pi-${signed}-${active ? "active-" : ""}${seed}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "delivery-review-pi-"));
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        piStableIdScheme: 1,
        cacheTtl: "5m",
        lastResponseTime: fixedClock,
    });
    const fake = createFakePi();
    Object.assign(fake.pi, {
        getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" } }],
        getActiveTools: () => ["read"],
    });
    const register = () => {
        piContext.registerPiContextHandler(fake.pi as never, {
            db,
            protectedTokens: 1000,
            injection: { injectionBudgetTokens: 1000, memoryEnabled: false, injectDocs: false },
            protectedTools: { read: 0 },
            heuristics: { keepReasoningTokens: 2000 },
            scheduler: { executeThresholdPercentage: 65 },
        });
    };
    register();
    let model = "claude-opus-5-5";
    let ordinal = 0;
    const source: PiMessage[] = [];
    const ids: string[] = [];
    const push = (message: PiMessage) => {
        source.push(message);
        ids.push(`row-${++ordinal}`);
    };
    const user = () => push(userMessage(`task ${ordinal}`, ordinal + 1));
    const assistant = (tool: boolean) => {
        const id = `call-${ordinal}`;
        push(
            assistantMessage("", ordinal + 1, {
                provider: "anthropic",
                model,
                api: "anthropic-messages",
                stopReason: tool ? "toolUse" : "stop",
                content: [
                    ...((active || !tool) && signed
                        ? [
                              {
                                  type: "thinking",
                                  thinking: `closed thought ${ordinal}`,
                                  thinkingSignature: `sig-${ordinal}`,
                              },
                          ]
                        : []),
                    ...(tool
                        ? [
                              {
                                  type: "toolCall",
                                  id,
                                  name: "read",
                                  arguments: { path: `${ordinal}.ts` },
                              },
                          ]
                        : [{ type: "text", text: `answer ${ordinal}` }]),
                ],
            }),
        );
        if (tool)
            push(toolResultMessage(id, `result ${ordinal} ${"payload ".repeat(200)}`, ordinal + 1));
    };
    user();
    assistant(true);
    user();
    let instruction = "base instructions";
    let finalPrompt = "extension-final initial prompt";
    const runnerErrors: unknown[] = [];
    const runner = new ExtensionRunner(
        [
            {
                path: "final-override",
                handlers: new Map([
                    ["before_agent_start", [() => ({ systemPrompt: finalPrompt })]],
                ]),
            },
        ] as never,
        {} as never,
        process.cwd(),
        {} as never,
        {} as never,
    );
    runner.onError((error) => runnerErrors.push(error));
    const bodies: string[] = [];
    const errors: string[] = [];
    let ackAt = -1;
    let acks = 0;
    try {
        previousBody = null;
        droppedBefore = new Set();
        for (const e of eventsFor(seed)) {
            recordedRides = [];
            passLogs = [];
            if (e.restart) {
                piContext.clearContextHandlerSession(sessionId);
                clearPiSystemPromptSession(sessionId);
                resetLkgSlotsForTest();
                register();
            }
            now = fixedClock + e.pass * 1000;
            if (e.pass > 0) {
                if (e.append) assistant(true);
                if (active) {
                    // An open signed tool loop: no user closes the turn until a
                    // non-tool reply arrives, so the transform must hold the head.
                    if (!e.tool) {
                        assistant(false);
                        user();
                    }
                } else if (signed) {
                    if (e.append) {
                        assistant(false);
                        user();
                    }
                } else if (e.append) user();
                if (e.edit) instruction = `genuine instructions ${e.pass}`;
                if (e.flush) piContext.signalPiPendingMaterialization(sessionId, "user_flush");
                if (e.history) piContext.signalPiHistoryRefresh(sessionId);
                if (e.model)
                    model = model === "claude-opus-5-5" ? "claude-sonnet-4-6" : "claude-opus-5-5";
                if (e.drop) {
                    const target = getTagsBySession(db, sessionId).find(
                        (tag) =>
                            tag.status === "active" &&
                            (tag.type === "tool" || (e.pass % 3 === 0 && tag.type === "message")),
                    );
                    if (target) queuePendingOp(db, sessionId, target.tagNumber, "drop");
                }
            }
            updateSessionMeta(db, sessionId, { lastResponseTime: e.expiry ? now - 600_000 : now });
            piContext.recordPiLiveModel(sessionId, `anthropic/${model}`);
            const prompt = processSystemPromptForCache({
                db,
                sessionId,
                systemPrompt: instruction,
                isCacheBusting: false,
            });
            if (prompt.hashChanged) {
                const signal = (
                    piContext as unknown as {
                        signalPiSystemHashChange?: (session: string, hash: string) => void;
                    }
                ).signalPiSystemHashChange;
                if (signal) signal(sessionId, prompt.currentHash);
                else {
                    piContext.signalPiHistoryRefresh(sessionId);
                    piContext.signalPiSystemPromptRefresh(sessionId);
                    piContext.signalPiPendingMaterialization(sessionId, "system_hash");
                }
            }
            if (e.override) finalPrompt = `extension-final ${e.pass}`;
            const started = await runner.emitBeforeAgentStart("task", undefined, {
                cwd: process.cwd(),
                forceSystemPrompt: prompt.systemPrompt,
            });
            expect(runnerErrors).toEqual([]);
            const effectiveSystem = started.systemPromptOptions.forceSystemPrompt ?? "";
            const messages = structuredClone(source);
            const parentId = ids.at(-1) ?? null;
            const branch: unknown[] = ids.map((id, index) => ({
                type: "message",
                id,
                message: messages[index],
            }));
            const ctx = {
                ...fakeContext(
                    sessionId,
                    "/nonexistent-system-delivery-review-project",
                    [...ids],
                    messages,
                ),
                sessionManager: {
                    getSessionId: () => sessionId,
                    getLeafId: () => parentId,
                    getBranch: () => branch,
                },
                getSystemPrompt: () => effectiveSystem,
                model: {
                    provider: "anthropic",
                    id: model,
                    api: "anthropic-messages",
                    contextWindow: 200000,
                },
                getContextUsage: () => ({
                    tokens: e.percent * 2000,
                    percent: e.percent,
                    contextWindow: 200000,
                }),
            };
            const before = getPendingOps(db, sessionId);
            let faultReached = false;
            const restoreFault = e.fault
                ? piContext.__test.setBeforePipelineForTests(async () => {
                      faultReached = true;
                      throw new Error("confirmation fault before pipeline");
                  })
                : undefined;
            try {
                const served = (await fake.handlers.get("context")!(
                    { messages } as never,
                    ctx as never,
                )) as { messages: PiMessage[] };
                const body = {
                    system: effectiveSystem,
                    messages: served.messages.map((m) => {
                        const { timestamp, usage, ...wire } = m as any;
                        return wire;
                    }),
                };
                checkBody("pi", e, body, before, db, sessionId);
                bodies.push(stable(body));
                if (e.fault) expect(faultReached).toBe(true);
                const markerBefore = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash;
                const response = {
                    role: "assistant",
                    timestamp: now + 1,
                    provider: "anthropic",
                    model,
                    stopReason: e.tool ? "toolUse" : "stop",
                    usage: { input: 2000, output: 10, cacheRead: 2000, cacheWrite: 0 },
                };
                branch.push({
                    type: "message",
                    id: `response-${e.pass}`,
                    parentId,
                    message: response,
                });
                await persistPiPressureFromMessageEnd({
                    db,
                    sessionId,
                    piContextWindow: 200000,
                    message: response,
                });
                if (getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash !== markerBefore) {
                    acks++;
                    if (ackAt < 0) ackAt = e.pass;
                }
            } catch (error) {
                if (
                    error instanceof Error &&
                    (error.name === "AssertionError" || String(error).includes("expect("))
                )
                    throw error;
                if (!e.fault) throw error;
                ledger.push({ host: "pi", ...e, refusal: String(error), faultReached });
                bodies.push(`ERROR:${String(error)}`);
            } finally {
                restoreFault?.();
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
        expect(errors).toEqual([]);
        expect(bodies).toHaveLength(passes);
        summaries.push({
            host: "pi",
            signed,
            active,
            seed,
            ackAt,
            acks,
            pending: getPendingOps(db, sessionId).length,
            bodies,
        });
    } finally {
        piContext.clearContextHandlerSession(sessionId);
        clearPiSystemPromptSession(sessionId);
        db.close();
        cleanupTestTempDir(home);
    }
}

for (const [host, seed] of [
    ["pi", 73017],
    ["oc1", 99167],
    ["oc2", 21737],
] as const) {
    it(`confirmation independent 400-pass invariant ${host}`, async () => {
        const start = ledger.length;
        const badStart = violations.length;
        try {
            if (host === "pi") await pi(true, seed);
            else await openCode(host, false, seed);
            console.log(
                "CONFIRMATION SUMMARY",
                JSON.stringify({
                    host,
                    passes: ledger.length - start,
                    faults: ledger.slice(start).filter((e) => e.fault).length,
                    restarts: ledger.slice(start).filter((e) => e.restart).length,
                    switches: ledger.slice(start).filter((e) => e.model).length,
                    violations: violations.length - badStart,
                    cases: violations
                        .slice(badStart)
                        .map((v) => ({ pass: v.event.pass, first: v.first, landed: v.landed })),
                    faultReplays: ledger.slice(start).filter((e) => e.fault && !e.refusal).length,
                    refusals: ledger.slice(start).filter((e) => e.refusal).length,
                    finalPending: summaries.at(-1)?.pending,
                    buckets: ledger.slice(start).reduce((a, e) => {
                        for (const k of ["history", "flush", "expiry", "override", "edit"])
                            if (e[k]) a[k] = (a[k] ?? 0) + 1;
                        return a;
                    }, {} as any),
                    firstViolations: violations.slice(badStart, badStart + 1).map((v) => ({
                        ...v,
                        logs: v.logs.filter((l: string) => !l.startsWith("transform stage:")),
                    })),
                }),
            );
            const compact = (l: any) =>
                `${l.pass}${l.restart ? " RESTART" : ""}${l.fault ? " FAULT" : ""} p=${l.percent}${l.flush ? " flush" : ""}${l.history ? " hist" : ""}${l.expiry ? " expiry" : ""}${l.model ? " model" : ""}${l.edit ? " edit" : ""}${l.override ? " override" : ""} first=${l.first} cause=${l.realCause} sys=${l.systemChanged} rides=${JSON.stringify(
                    (l.rides ?? []).map((r: any) =>
                        Object.entries(r)
                            .filter(([, v]) => v)
                            .map(([k]) => k)
                            .join("+"),
                    ),
                )} newDrop=${JSON.stringify(l.newlyDropped)}${l.refusal ? " REFUSED" : ""} | ${(
                    l.logs ?? []
                )
                    .filter((x: string) =>
                        /WILL APPLY|WILL NOT APPLY|DEGRADED|HARD fold decision|hydrated|replay|frozen|recovery|LKG|lkg/.test(
                            x,
                        ),
                    )
                    .join(" ; ")
                    .slice(0, 600)}`;
            console.log(
                "VIOLATION SUMMARY",
                host,
                JSON.stringify(
                    violations
                        .slice(badStart)
                        .map((v) => `${v.kind}@${v.event.pass}${v.event.restart ? "R" : ""}`),
                ),
            );
            if (process.env.REVIEW_FULL_LOGS === "1")
                for (const v of violations.slice(badStart).filter((v) => v.kind === "V2"))
                    console.log(
                        `V2 FULL LOGS ${host} ${v.event.pass}\n    ${v.logs
                            .filter((l: string) => !l.startsWith("transform stage:"))
                            .map((l: string) => l.slice(0, 400))
                            .join("\n    ")}`,
                    );
            for (const v of violations.slice(badStart)) {
                const window = ledger
                    .slice(start)
                    .filter((l) => l.pass >= v.event.pass - 4 && l.pass <= v.event.pass);
                console.log(
                    `VIOLATION ${v.kind} ${host} ${v.event.pass} first=${v.first} prior=${JSON.stringify(v.prior)?.slice(0, 160)} next=${JSON.stringify(v.next)?.slice(0, 160)}\n  ${window.map(compact).join("\n  ")}`,
                );
            }
            // V2 (a recorded ride with no harness-visible cause, e.g. an LKG
            // recovery rebuild) is printed for review but not asserted.
            expect(
                violations
                    .slice(badStart)
                    .filter((v) => v.kind !== "V2")
                    .map((v) => ({
                        kind: v.kind,
                        pass: v.event.pass,
                        first: v.first,
                        landed: v.landed,
                    })),
            ).toEqual([]);
        } finally {
            // Diagnostics are printed above; nothing is written to disk.
        }
    }, 120000);
}
// Drive a deterministic clock only while this file's tests run.
beforeAll(() => {
    Date.now = () => now;
});
afterAll(() => {
    Date.now = realNow;
    rideSpy.mockRestore();
    logSpy.mockRestore();
});
