import { initializeDatabase } from "../../../features/magic-context/storage-db";
import {
    setChannel1NudgeState,
    setLastNudgeUndropped,
} from "../../../features/magic-context/storage-meta-persisted";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta-session";
import { insertTag } from "../../../features/magic-context/storage-tags";
import { createTagger } from "../../../features/magic-context/tagger";
import { Database } from "../../../shared/sqlite";
import type { Channel1State } from "../ctx-reduce-nudge";
import { createToolExecuteAfterHook } from "../hook-handlers";
import type { MessageLike } from "../tag-messages";
import { runPostTransformPhase } from "../transform-postprocess-phase";

interface TailRefreshFixture {
    db: Database;
    sessionId: string;
    metadata: { interrupted: boolean; output: { progress: number }; diagnostics: string };
    messages: MessageLike[];
    states: Map<string, Channel1State>;
    args: Parameters<typeof runPostTransformPhase>[0];
    ownerMessage: MessageLike;
    state: () => Channel1State;
    serve: () => ReturnType<typeof runPostTransformPhase>;
    reduce: () => Promise<void>;
    toolResult: (text?: string) => Promise<string>;
    append: (words?: number) => void;
}

/** A synthetic context pass with the real baseline assignment and durable grace storage. */
export function tailRefreshFixture(input: {
    id: string;
    opencode2?: boolean;
    phase?: typeof runPostTransformPhase;
    hook?: typeof createToolExecuteAfterHook;
}): TailRefreshFixture {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = input.id;
    const states = new Map<string, Channel1State>();
    const metadata = { interrupted: false, output: { progress: 1 }, diagnostics: "x".repeat(1024) };
    const owner = `${sessionId}-owner`;
    const tool = (callID: string, words: number) => ({
        type: "tool",
        callID,
        tool: "edit",
        state: {
            status: "completed",
            input: { path: "synthetic.ts" },
            output: "data ".repeat(words),
            time: { start: 1, end: 2 },
        },
    });
    const messages: MessageLike[] = [
        {
            info: { id: owner, role: "assistant" },
            parts: [
                {
                    type: "tool",
                    callID: `${sessionId}-error`,
                    tool: "edit",
                    state: { status: "error", input: {}, error: "[dropped]", metadata },
                },
                tool(`${sessionId}-live`, 80_000),
            ],
        },
        {
            info: { id: `${sessionId}-user`, role: "user" },
            parts: [{ type: "text", text: "continue" }],
        },
    ];
    messages.unshift(
        ...Array.from({ length: 19 }, (_, index) => ({
            info: { id: `${sessionId}-earlier-user-${index}`, role: "user" },
            parts: [{ type: "text", text: "earlier user prompt" }],
        })),
    );
    insertTag(db, sessionId, `${sessionId}-live`, "tool", 400_000, 1, 0, "edit", 20, owner);
    const args: Parameters<typeof runPostTransformPhase>[0] = {
        sessionId,
        db,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        todowriteAvailability: { callable: false, frozen: true },
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        usableWindow: 128_000,
        schedulerDecision: "defer",
        schedulerDeferReason: "scheduler_defer",
        fullFeatureMode: false,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTagIds: new Set(),
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        protectedCount: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        channel1StateBySession: states,
        protectedTools: {},
        opencode2: input.opencode2,
    };
    const afterTool = (input.hook ?? createToolExecuteAfterHook)({
        db,
        channel1StateBySession: states,
    });
    return {
        db,
        sessionId,
        metadata,
        messages,
        states,
        args,
        ownerMessage: messages.find((message) => message.info.id === owner) as MessageLike,
        state: () => states.get(sessionId) as Channel1State,
        serve: () => (input.phase ?? runPostTransformPhase)(args),
        reduce: async () => {
            const state = states.get(sessionId);
            if (!state) throw new Error("serve before reducing");
            setLastNudgeUndropped(db, sessionId, state.baselineU + state.turnDeltaU);
            setChannel1NudgeState(db, sessionId, { level: "urgent", ordinal: 1 });
            await afterTool(
                { sessionID: sessionId, tool: "ctx_reduce" },
                { output: "synthetic reduction" },
            );
        },
        toolResult: async (text = "synthetic next result") => {
            const output = { output: text };
            await afterTool({ sessionID: sessionId, tool: "bash" }, output);
            return output.output;
        },
        append: (words = 40_000) => {
            const id = `${sessionId}-append`;
            messages.push({
                info: { id, role: "assistant" },
                parts: [tool(`${sessionId}-new`, words)],
            });
            insertTag(db, sessionId, `${sessionId}-new`, "tool", words * 5, 2, 0, "edit", 20, id);
        },
    };
}
