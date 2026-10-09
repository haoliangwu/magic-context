/// <reference types="bun-types" />

// Adversarial review of the frozen last-known-good (LKG) replay changes in Rust
// mode. Each test here pins a defect the review found: the test describes the
// behaviour the frozen-replay invariants require, and fails while the defect is
// present. While a session is frozen, every pass must keep serving the bytes the
// provider last saw (plus the new raw tail), and a pass that changes bytes the
// freeze served must strip every signed thinking block behind the change.

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

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
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { createDbLkgPersistence } from "./lkg-persist";
import { registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { resetRustLkgReplayParticipantsForTest } from "./rust-lkg-freeze-registry";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";
import { firstServedDivergenceIndex } from "./transform-postprocess-phase";

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const MODEL_KEY = "anthropic/claude-opus-5-5";

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

function user(sessionId: string, id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: sessionId, model: { ...MODEL } },
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

function sha(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasReasoning(message: unknown): boolean {
    return (message as MessageLike).parts.some(
        (part) => (part as { type?: string }).type === "reasoning",
    );
}

function textOf(messages: unknown[], id: string): string {
    const message = (messages as MessageLike[]).find((candidate) => candidate.info.id === id);
    return (message?.parts ?? [])
        .map((part) => (part as { text?: string }).text ?? "")
        .filter((text) => text.length > 0)
        .join("|");
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

function sqliteBusy(): Error {
    return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

/**
 * A decision string, "throw" for a module failure, or a decision with extra
 * response fields (for example `reasoning_trim_only`).
 */
type Step = "throw" | string | { decision: string; response: Record<string, unknown> };

/**
 * A Rust session on a prefix-bound model whose module answers each pass from a
 * script and renders the input through `moduleOutput`. Captures commit inline.
 * `run` calls the current adapter directly; `runWrapped` goes through the
 * production messages-transform wrapper (which always calls the current adapter),
 * whose hook can be told to fail with a SQLite busy error before the adapter runs.
 */
function reviewSession(label: string) {
    sessionCounter += 1;
    const sessionId = `rust-frozen-review-${label}-${sessionCounter}-${Date.now()}`;
    const db = makeDb();
    installRawProvider(sessionId);
    recordDetectedContextLimit(db, sessionId, 200_000, MODEL_KEY);
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
                prefix_bust_permitted: ["HARD", "SOFT"].includes(
                    typeof step === "string" ? step : step.decision,
                ),
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
        liveModelBySession: new Map([[sessionId, { ...MODEL }]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        historianRunner: "broca",
        getModelKey: () => MODEL_KEY,
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
        recordToolDefinition("anthropic", "claude-opus-5-5", undefined, "read", "read fixture", {
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
    let hookBusy = false;
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async (_input, output) => {
                if (hookBusy) {
                    hookBusy = false;
                    throw sqliteBusy();
                }
                const messages = output.messages as unknown as MessageLike[];
                await transform.run(sessionId, messages, output, meta());
            },
        },
    });
    const runWrapped = async (input: MessageLike[], step?: Step | "hook-busy") => {
        if (step === "hook-busy") hookBusy = true;
        else if (step !== undefined) script.push(step);
        lastInput = input;
        const output = { messages: [...input] };
        await handler({}, output as never);
        return structuredClone(output.messages as unknown[]);
    };
    /** Durable slot rows for this session, as a backup of context.db would hold them. */
    const backupSlotRows = () => ({
        slots: db.prepare("SELECT * FROM lkg_slots WHERE session_id = ?").all(sessionId) as Array<
            Record<string, unknown>
        >,
        chunks: db
            .prepare("SELECT * FROM lkg_slot_chunks WHERE session_id = ?")
            .all(sessionId) as Array<Record<string, unknown>>,
    });
    const restoreSlotRows = (backup: ReturnType<typeof backupSlotRows>) => {
        db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
        for (const [table, rows] of [
            ["lkg_slots", backup.slots],
            ["lkg_slot_chunks", backup.chunks],
        ] as const) {
            for (const row of rows) {
                const columns = Object.keys(row);
                db.prepare(
                    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
                ).run(...(columns.map((column) => row[column]) as never[]));
            }
        }
    };
    return {
        sessionId,
        db,
        get transform() {
            return transform;
        },
        /**
         * A new process: a fresh adapter on the same database, with the in-memory
         * slot store emptied so the next read hydrates the durable slot. The
         * process-wide replay registry starts empty in a new process as well.
         */
        restart: () => {
            resetLkgSlotsForTest();
            resetRustLkgReplayParticipantsForTest();
            registerLkgPersistence(createDbLkgPersistence(db));
            transform = makeAdapter();
        },
        /**
         * The same process builds a new adapter for the same project, as OpenCode
         * does when it disposes an instance and opens it again (Desktop runs many
         * instances in one process). Nothing tells the old adapter it is gone.
         */
        reinitInProcess: () => {
            transform = makeAdapter();
        },
        run,
        runWrapped,
        backupSlotRows,
        restoreSlotRows,
        setModuleOutput: (value: (input: MessageLike[]) => unknown[]) => {
            moduleOutput = value;
        },
    };
}

describe("a wrapper replay freezes the adapter that serves the session", () => {
    it("after an in-process adapter rebuild, the wrapper replay freezes the live adapter, not the disposed one", async () => {
        const s = reviewSession("registry-stale-participant");
        const sid = s.sessionId;
        const conversation: MessageLike[] = [user(sid, "m1", "question")];
        // The first adapter runs the session, so it holds state for it.
        await s.runWrapped([...conversation], "HARD");

        // OpenCode disposes the instance and opens it again in the same process: a
        // new adapter serves the session from here on.
        s.reinitInProcess();
        conversation.push(assistant(sid, "a1"), user(sid, "m2", "turn 2"));
        await s.runWrapped([...conversation], "SOFT+");
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(false);

        // The hook fails with a SQLite busy error and the wrapper serves the slot
        // plus the raw tail. The provider now holds those bytes.
        conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
        const replayed = await s.runWrapped([...conversation], "hook-busy");
        expect(sha(replayed)).toBe(sha(conversation));

        // The module is healthy and tags every user message. The live adapter must
        // keep serving the replayed bytes; adopting the tagged output busts the
        // cache over the replay.
        s.setModuleOutput(tagAllUsers);
        conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const served = await s.runWrapped([...conversation], "SOFT+");
        expect(textOf(served, "m3")).toBe("turn 3");
        expect(sha(served)).toBe(sha(conversation));
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(true);
    });
});

describe("a restart keeps the thinking strip a frozen session needs", () => {
    it("after a restart, a trim-only SOFT over a captured frozen slot strips the outage-tail thinking", async () => {
        const s = reviewSession("restart-trim-only");
        const sid = s.sessionId;
        await s.run([user(sid, "m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // The module fails; the replay serves [m1] plus a1 and m2 as the host sent them.
        await s.run([...conversation], "throw");
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(true);
        // Two healthy defers keep serving the frozen bytes and capture them durably.
        conversation.push(thinkingAssistant(sid, "a2"), user(sid, "m3", "turn 3"));
        await s.run([...conversation], "SOFT+");
        conversation.push(thinkingAssistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const lastFrozen = await s.run([...conversation], "SOFT+");
        expect(hasReasoning((lastFrozen as MessageLike[])[3])).toBe(true);

        // OpenCode restarts. The first pass of the new process is a module bust
        // whose own edit is the oldest reasoning trim (a1), and it tags m2..m4,
        // which the freeze served untagged. Without a restart this exact pass
        // strips a2 and a3 (the frozen trim-only case); a restart must not
        // change that, because the provider still holds the frozen bytes.
        s.restart();
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
            providerID: MODEL.providerID,
        });
        expect(divergence).toBe(1);
        // Every thinking block behind the first changed message is bound to bytes
        // the provider no longer receives, so none may be sent.
        for (const message of busted.slice(divergence ?? 0)) {
            expect(hasReasoning(message)).toBe(false);
        }
    });
});

describe("a restart resumes only a freeze the slot proves", () => {
    it("a stale healthy slot (context.db restored from an older backup) does not resume a freeze", async () => {
        const s = reviewSession("restart-stale-slot");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // A healthy HARD: the module renders a1 exactly as the host sent it.
        await s.run([...conversation], "HARD");
        const backup = s.backupSlotRows();
        expect(backup.slots.length).toBe(1);

        // A later healthy bust drops a1's text (as ctx_reduce does). From here on the
        // provider holds a1 as "[dropped]".
        const dropping = (input: MessageLike[]) =>
            tagAllUsers(input).map((message) => {
                const record = message as MessageLike;
                return record.info.id === "a1"
                    ? { ...record, parts: [{ type: "text", text: "[dropped]" }] }
                    : message;
            });
        s.setModuleOutput(dropping);
        conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
        const lastServed = await s.run([...conversation], "SOFT");
        expect(textOf(lastServed, "a1")).toBe("[dropped]");

        // context.db comes back from the older backup (the module store does not),
        // and OpenCode restarts. The slot is healthy module output, only stale: no
        // freeze ever happened, so nothing proves the provider holds the slot.
        s.restoreSlotRows(backup);
        s.restart();
        conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const served = await s.run([...conversation], "SOFT+");
        // Serving the stale slot puts a1's dropped text back mid-history and serves
        // m3 untagged, rewriting bytes the provider holds; module output keeps them.
        expect(textOf(served, "a1")).toBe("[dropped]");
        expect(sha(served.slice(0, lastServed.length))).toBe(sha(lastServed));
        expect(s.transform.getState(sid).lkgRepresentationFrozen).toBe(false);
    });
});
