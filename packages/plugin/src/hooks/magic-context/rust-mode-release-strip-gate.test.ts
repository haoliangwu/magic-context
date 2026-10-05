/// <reference types="bun-types" />

// Adversarial checks for the proactive thinking strip on a pass that releases a
// frozen last-known-good (LKG) replay in Rust mode, on a prefix-bound thinking
// model (Opus 5.5). The strip may only remove thinking at or after the first
// message whose served bytes change; the tests below probe where the host's
// comparison against the stored snapshot could get that point wrong, and pin
// the replay and permission behaviour that must not move.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    getMergedReasoningStrippedIds,
    getOverflowState,
    recordDetectedContextLimit,
} from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    createRustModeTransform as createRustModeTransformImpl,
    type RustModeModuleClient,
} from "./rust-mode-transform";
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

function makeMeta(db: ContextDatabase, sessionId: string) {
    const meta = getOrCreateSessionMeta(db, sessionId);
    const overflow = getOverflowState(db, sessionId);
    if (overflow.detectedContextLimit <= 0) {
        recordDetectedContextLimit(db, sessionId, 200_000, MODEL_KEY);
    }
    recordToolDefinition("anthropic", "claude-opus-5-5", undefined, "read", "read fixture", {
        type: "object",
    });
    if (meta.systemPromptTokens <= 0) {
        updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
        meta.systemPromptTokens = 100;
    }
    return meta;
}

function user(sessionId: string, id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: sessionId, model: { ...MODEL } },
        parts: [{ type: "text", text }],
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

function hasReasoning(messages: unknown[], id: string): boolean {
    const message = messages.find(
        (candidate) => (candidate as MessageLike).info.id === id,
    ) as MessageLike;
    return message.parts.some((part) => (part as { type?: string }).type === "reasoning");
}

function textOf(messages: unknown[], id: string): string {
    const message = messages.find(
        (candidate) => (candidate as MessageLike).info.id === id,
    ) as MessageLike;
    return message.parts
        .map((part) => (part as { text?: string }).text ?? "")
        .filter((text) => text.length > 0)
        .join("|");
}

function sha(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The module tags each named user message the way the Rust tag overlay does. */
function tagging(tags: Record<string, number>) {
    return (input: MessageLike[]): unknown[] =>
        structuredClone(input).map((message) => {
            const tag = tags[String(message.info.id)];
            if (tag === undefined) return message;
            return {
                ...message,
                parts: message.parts.map((part) => {
                    const record = part as { type?: string; text?: string };
                    return record.type === "text" && typeof record.text === "string"
                        ? { ...record, text: `§${tag}§ ${record.text}` }
                        : part;
                }),
            };
        });
}

/** A decision string, "throw" for a module failure, or a decision with extra response fields. */
type Step = "throw" | string | { decision: string; response: Record<string, unknown> };

/**
 * A prefix-bound Rust session whose module answers each pass from `script`
 * (a decision string, or "throw" for a module failure) and renders the input
 * through `moduleOutput`.
 */
function scriptedSession(label: string) {
    sessionCounter += 1;
    const sessionId = `rust-release-gate-${label}-${sessionCounter}-${Date.now()}`;
    const db = makeDb();
    installRawProvider(sessionId);
    recordDetectedContextLimit(db, sessionId, 200_000, MODEL_KEY);
    let pass = 0;
    const script: Step[] = [];
    let fallbackDecision = "SOFT+";
    let moduleOutput: (input: MessageLike[]) => unknown[] = (input) => structuredClone(input);
    let lastInput: MessageLike[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method !== "transform") return { ok: true };
            pass += 1;
            const step = script.shift() ?? fallbackDecision;
            if (step === "throw") throw new Error("daemon unavailable");
            return {
                ...(typeof step === "string" ? { decision: step } : step.response),
                ...(typeof step === "string" ? {} : { decision: step.decision }),
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
    const transform = createRustModeTransformImpl(deps, {
        moduleClient,
        modulePageMaxBytes: 512 * 1024,
        // Captures commit inline, as setImmediate would before the next request.
        scheduleLkgCapture: (capture) => capture(),
    });
    const run = async (input: MessageLike[], step?: Step) => {
        if (step !== undefined) script.push(step);
        lastInput = input;
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));
        return structuredClone(output.messages);
    };
    return {
        sessionId,
        db,
        transform,
        run,
        frozen: () => transform.getState(sessionId).lkgRepresentationFrozen,
        setModuleOutput: (value: (input: MessageLike[]) => unknown[]) => {
            moduleOutput = value;
        },
        setFallbackDecision: (value: string) => {
            fallbackDecision = value;
        },
        strippedIds: () =>
            [...getMergedReasoningStrippedIds(db, sessionId)]
                .filter((id) => !id.includes("parts:"))
                .map((id) => id.replace(/^.*:/, ""))
                .sort(),
    };
}

function releaseLines(logSpy: ReturnType<typeof spyOn>, sessionId: string): string[] {
    return logSpy.mock.calls
        .filter(([loggedSession]) => loggedSession === sessionId)
        .map(([, message]) => String(message))
        .filter((line) => line.startsWith("lkg_frozen_replay_released"));
}

describe("release strip: the stored snapshot is not always what was served last", () => {
    // Shared shape: a HARD pass captures [m1]; the module then fails, and the
    // host serves the LKG replay with the raw tail [a1, m2]. That replay is not
    // captured, so the slot still holds [m1]. On release the module tags m2, so
    // the bytes change at index 2 and a2 (generated on the raw m2) must lose its
    // thinking.

    it("strips thinking after a tail the error replay served when the release follows it directly", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const s = scriptedSession("error-then-release");
            const sid = s.sessionId;
            await s.run([user(sid, "m1", "question")], "HARD");
            const errorInput = [
                user(sid, "m1", "question"),
                thinkingAssistant(sid, "a1"),
                user(sid, "m2", "follow-up"),
            ];
            const errorServed = await s.run(errorInput, "throw");
            expect(s.frozen()).toBe(true);
            expect(textOf(errorServed, "m2")).toBe("follow-up");

            s.setModuleOutput(tagging({ m2: 2 }));
            // a2 and a3 open one Anthropic reasoning run, which the frozen
            // replay refuses, so this very pass releases the freeze.
            const served = await s.run(
                [...errorInput, thinkingAssistant(sid, "a2"), thinkingAssistant(sid, "a3")],
                "SOFT+",
            );
            expect(releaseLines(logSpy, sid)).toEqual([
                "lkg_frozen_replay_released reason=lkg_anthropic_reasoning_run_invalid",
            ]);
            // The served bytes did change at m2 ...
            expect(textOf(served, "m2")).toBe("§2§ follow-up");
            // ... so the thinking after it is invalid and must be removed.
            expect(hasReasoning(served, "a2")).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("strips thinking after the raw tail an outage served when the first healthy pass releases on tail growth", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const s = scriptedSession("outage-growth");
            const sid = s.sessionId;
            await s.run([user(sid, "m1", "question")], "HARD");
            // Two failed passes (a third would park the module) serve the LKG
            // replay with a growing raw tail; neither is captured.
            const conversation: MessageLike[] = [user(sid, "m1", "question")];
            const turn = (index: number) => {
                conversation.push(thinkingAssistant(sid, `a${index}`));
                conversation.push(user(sid, `m${index + 1}`, `turn ${index + 1}`));
            };
            turn(1);
            await s.run([...conversation], "throw");
            for (let index = 2; index <= 6; index += 1) turn(index);
            const outageServed = await s.run([...conversation], "throw");
            expect(s.frozen()).toBe(true);
            expect(textOf(outageServed, "m2")).toBe("turn 2");

            // The module is back; the raw tail has grown past the freeze limit.
            for (let index = 7; index <= 10; index += 1) turn(index);
            s.setModuleOutput(tagging({ m2: 2, m3: 3, m4: 4, m5: 5, m6: 6, m7: 7 }));
            const served = await s.run([...conversation], "SOFT+");
            expect(releaseLines(logSpy, sid)).toEqual([
                "lkg_frozen_replay_released reason=raw_tail_growth_limit",
            ]);
            expect(textOf(served, "m2")).toBe("§2§ turn 2");
            // a2 sits after the first changed message (m2) and was served with
            // its thinking by the outage replay.
            expect(hasReasoning(served, "a2")).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("control: with one captured frozen pass between the error and the release, the same shape strips a2", async () => {
        const s = scriptedSession("error-frozen-release");
        const sid = s.sessionId;
        await s.run([user(sid, "m1", "question")], "HARD");
        const errorInput = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "follow-up"),
        ];
        await s.run(errorInput, "throw");
        await s.run(errorInput, "SOFT+");
        expect(s.frozen()).toBe(true);
        s.setModuleOutput(tagging({ m2: 2 }));
        const served = await s.run(
            [...errorInput, thinkingAssistant(sid, "a2"), thinkingAssistant(sid, "a3")],
            "SOFT+",
        );
        expect(textOf(served, "m2")).toBe("§2§ follow-up");
        expect(hasReasoning(served, "a1")).toBe(true);
        expect(hasReasoning(served, "a2")).toBe(false);
        expect(hasReasoning(served, "a3")).toBe(false);
    });
});

describe("release strip: a module bust while frozen", () => {
    it("a frozen trim-only SOFT strips outage-tail thinking", async () => {
        const s = scriptedSession("frozen-trim-only");
        const sid = s.sessionId;
        await s.run([user(sid, "m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // The module fails: the last-known-good replay serves the captured [m1] plus
        // a1 and m2 exactly as the host sent them (untagged).
        await s.run([...conversation], "throw");
        expect(s.frozen()).toBe(true);
        // Two healthy defers each append a thinking assistant and keep serving the
        // frozen bytes; each one captures exactly what it served.
        conversation.push(thinkingAssistant(sid, "a2"), user(sid, "m3", "turn 3"));
        await s.run([...conversation], "SOFT+");
        conversation.push(thinkingAssistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const lastFrozen = await s.run([...conversation], "SOFT+");
        expect(s.frozen()).toBe(true);
        expect(hasReasoning(lastFrozen, "a2")).toBe(true);
        expect(hasReasoning(lastFrozen, "a3")).toBe(true);

        // The module's bust removes the oldest reasoning (a1) and tags m2..m4, which
        // the freeze served untagged. A signed thinking block is valid only while
        // every byte before it is unchanged, so a2 and a3 become invalid even though
        // the module reports its own edit as a reasoning trim.
        const tag = tagging({ m2: 2, m3: 3, m4: 4 });
        s.setModuleOutput((input) =>
            tag(input).map((message) => {
                const record = message as MessageLike;
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
        expect(s.frozen()).toBe(false);
        const divergence = firstServedDivergenceIndex(busted, lastFrozen, {
            providerID: MODEL.providerID,
        });
        expect(divergence).toBe(1);
        for (const message of busted.slice(divergence ?? 0) as MessageLike[]) {
            expect(
                message.parts.some((part) => (part as { type?: string }).type === "reasoning"),
            ).toBe(false);
        }
        expect(s.strippedIds()).toEqual(["a2", "a3"]);

        // The stripped ids were saved, so the next defer removes the same thinking
        // and serves the same bytes.
        const defer = await s.run([...conversation], "SOFT+");
        expect(sha(defer)).toBe(sha(busted));
    });
});

describe("release strip: replay after the strip", () => {
    it("release -> defer -> defer, then error -> frozen -> second release, serve stable prefixes", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const s = scriptedSession("replay-chain");
            const sid = s.sessionId;
            await s.run([user(sid, "m1", "question")], "HARD");
            const base = [
                user(sid, "m1", "question"),
                thinkingAssistant(sid, "a1"),
                user(sid, "m2", "follow-up"),
            ];
            await s.run(base, "throw");
            const frozenServed = await s.run(base, "SOFT+");

            // First release: the module tags m2; strip from m2 onward.
            s.setModuleOutput(tagging({ m2: 2 }));
            const releaseInput = [
                ...base,
                thinkingAssistant(sid, "a2"),
                thinkingAssistant(sid, "a3"),
            ];
            const release1 = await s.run(releaseInput, "SOFT+");
            expect(sha(release1.slice(0, 2))).toBe(sha(frozenServed.slice(0, 2)));
            expect(hasReasoning(release1, "a1")).toBe(true);
            expect(hasReasoning(release1, "a2")).toBe(false);
            expect(hasReasoning(release1, "a3")).toBe(false);
            expect(s.strippedIds()).toEqual(["a2", "a3"]);
            expect(s.frozen()).toBe(false);

            // Two defers replay the release byte for byte.
            const defer1 = await s.run(releaseInput, "SOFT+");
            expect(sha(defer1)).toBe(sha(release1));
            // a4 keeps its thinking on every defer: the module decision is SOFT+ (no
            // cache bust) and no frozen replay is being released, so nothing may strip.
            const withM4 = [
                ...releaseInput,
                user(sid, "m3", "third"),
                thinkingAssistant(sid, "a4"),
                user(sid, "m4", "fourth"),
            ];
            const defer2 = await s.run(withM4, "SOFT+");
            expect(sha(defer2.slice(0, release1.length))).toBe(sha(release1));
            expect(hasReasoning(defer2, "a4")).toBe(true);

            // A module error serves the LKG replay (captured by defer2) plus a5 raw.
            const errorInput = [...withM4, thinkingAssistant(sid, "a5")];
            const errorServed = await s.run(errorInput, "throw");
            expect(sha(errorServed.slice(0, defer2.length))).toBe(sha(defer2));
            expect(hasReasoning(errorServed, "a5")).toBe(true);
            const frozen2 = await s.run(errorInput, "SOFT+");
            expect(sha(frozen2)).toBe(sha(errorServed));

            // Second release: the module now also tags m4. a2 and a3, stripped by
            // the first release, sit before the change and must compare as served;
            // a4 sits before the change too and keeps its thinking. Only a5 onward
            // may lose it.
            s.setModuleOutput(tagging({ m2: 2, m4: 4 }));
            const release2Input = [
                ...errorInput,
                thinkingAssistant(sid, "a6"),
                thinkingAssistant(sid, "a7"),
            ];
            const release2 = await s.run(release2Input, "SOFT+");
            const m4Index = withM4.length - 1;
            expect(sha(release2.slice(0, m4Index))).toBe(sha(frozen2.slice(0, m4Index)));
            expect(textOf(release2, "m4")).toBe("§4§ fourth");
            expect(hasReasoning(release2, "a1")).toBe(true);
            expect(hasReasoning(release2, "a4")).toBe(true);
            expect(hasReasoning(release2, "a5")).toBe(false);
            expect(s.strippedIds()).toEqual(["a2", "a3", "a5", "a6", "a7"]);
            expect(releaseLines(logSpy, sid)).toEqual([
                "lkg_frozen_replay_released reason=lkg_anthropic_reasoning_run_invalid",
                "lkg_frozen_replay_released reason=lkg_anthropic_reasoning_run_invalid",
            ]);

            // And the defers after it replay it exactly.
            const defer3 = await s.run(release2Input, "SOFT+");
            expect(sha(defer3)).toBe(sha(release2));
            const defer4 = await s.run([...release2Input, user(sid, "m4", "fourth")], "SOFT+");
            expect(sha(defer4.slice(0, release2.length))).toBe(sha(release2));
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe("release strip: permission comes from the module decision", () => {
    for (const decision of ["HARD", "SOFT"]) {
        it(`${decision} strips every thinking block, including ones before any changed byte`, async () => {
            const s = scriptedSession(`permission-${decision}`);
            const sid = s.sessionId;
            const input = [
                user(sid, "m1", "question"),
                thinkingAssistant(sid, "a1"),
                user(sid, "m2", "follow-up"),
                thinkingAssistant(sid, "a2"),
                user(sid, "m3", "third"),
            ];
            const deferred = await s.run(input, "SOFT+");
            expect(hasReasoning(deferred, "a1")).toBe(true);
            expect(hasReasoning(deferred, "a2")).toBe(true);
            const busted = await s.run(input, decision);
            expect(hasReasoning(busted, "a1")).toBe(false);
            expect(hasReasoning(busted, "a2")).toBe(false);
        });
    }

    it("HARD while a frozen replay is active strips everything (the module bust wins over the release)", async () => {
        const s = scriptedSession("permission-hard-frozen");
        const sid = s.sessionId;
        await s.run([user(sid, "m1", "question")], "HARD");
        const input = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "follow-up"),
        ];
        await s.run(input, "throw");
        await s.run(input, "SOFT+");
        expect(s.frozen()).toBe(true);
        const busted = await s.run(input, "HARD");
        expect(s.frozen()).toBe(false);
        expect(hasReasoning(busted, "a1")).toBe(false);
    });

    it("SOFT+ without a freeze strips nothing, even for thinking that arrives later", async () => {
        const s = scriptedSession("permission-soft-plus");
        const sid = s.sessionId;
        const input = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "follow-up"),
        ];
        await s.run(input, "SOFT+");
        s.setModuleOutput(tagging({ m2: 2 }));
        const served = await s.run(
            [...input, thinkingAssistant(sid, "a2"), user(sid, "m3", "third")],
            "SOFT+",
        );
        expect(hasReasoning(served, "a1")).toBe(true);
        expect(hasReasoning(served, "a2")).toBe(true);
        expect(s.strippedIds()).toEqual([]);
    });
});

describe("release strip: a difference the wire never sees", () => {
    it("keeps thinking when the only difference on a release is an empty text part the adapter drops", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const s = scriptedSession("late-blank");
            const sid = s.sessionId;
            await s.run([user(sid, "m1", "question")], "HARD");
            const input = [
                user(sid, "m1", "question"),
                thinkingAssistant(sid, "a1"),
                user(sid, "m2", "follow-up"),
            ];
            await s.run(input, "throw");
            const lastFrozen = await s.run(input, "SOFT+");
            expect(s.frozen()).toBe(true);
            // The harness has appended an empty text part to a1 since the last
            // serve. OpenCode's Anthropic adapter drops empty text parts, so the
            // provider sees the same bytes as the frozen pass sent. The frozen
            // replay's content check sees the new part and releases the freeze.
            const withBlank = structuredClone(input);
            withBlank[1]?.parts.push({ type: "text", text: "" });
            const served = await s.run(withBlank, "SOFT+");
            expect(releaseLines(logSpy, sid)).toEqual([
                "lkg_frozen_replay_released reason=lkg_content_mismatch",
            ]);
            expect(hasReasoning(lastFrozen, "a1")).toBe(true);
            expect(textOf(served, "m2")).toBe(textOf(lastFrozen, "m2"));
            // Nothing provider-visible changed before or at a1, so its thinking stays.
            expect(hasReasoning(served, "a1")).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe("release strip: firstServedDivergenceIndex as a wire proxy", () => {
    const assistant = (parts: unknown[], info: Record<string, unknown> = {}) => ({
        info: { id: "a1", role: "assistant", ...info },
        parts,
    });
    const reasoning = {
        type: "reasoning",
        text: "t",
        metadata: { anthropic: { signature: "s" } },
    };
    const answer = { type: "text", text: "answer" };

    it("ignores an appended empty text part the Anthropic adapter drops before the wire", () => {
        expect(
            firstServedDivergenceIndex(
                [assistant([reasoning, answer, { type: "text", text: "" }])],
                [assistant([reasoning, answer])],
                { providerID: "anthropic" },
            ),
        ).toBeNull();
    });

    it("counts an appended empty text part as a change for a provider that sends it", () => {
        // Only OpenCode's canonical Anthropic adapter filters empty parts; other
        // adapters forward them as real content blocks.
        expect(
            firstServedDivergenceIndex(
                [assistant([reasoning, answer, { type: "text", text: "" }])],
                [assistant([reasoning, answer])],
                { providerID: "openai" },
            ),
        ).toBe(0);
    });

    it("counts a changed non-wire part field (part time) as a change", () => {
        expect(
            firstServedDivergenceIndex(
                [assistant([reasoning, { ...answer, time: { start: 1, end: 3 } }])],
                [assistant([reasoning, { ...answer, time: { start: 1, end: 2 } }])],
            ),
        ).toBe(0);
    });

    it("counts info fields OpenCode reads when it builds the wire (error, providerID/modelID)", () => {
        // OpenCode skips a non-abort errored assistant and drops reasoning metadata
        // for an assistant of another model, so these differences move wire bytes.
        expect(
            firstServedDivergenceIndex(
                [assistant([reasoning, answer], { error: { name: "APIError" } })],
                [assistant([reasoning, answer])],
            ),
        ).toBe(0);
        expect(
            firstServedDivergenceIndex(
                [assistant([reasoning, answer], { providerID: "anthropic", modelID: "other" })],
                [assistant([reasoning, answer], { providerID: "anthropic", modelID: "opus" })],
            ),
        ).toBe(0);
    });

    it("treats messages past the end of the snapshot as new, whatever they contain", () => {
        expect(
            firstServedDivergenceIndex(
                [assistant([reasoning, answer]), { info: { id: "m2", role: "user" }, parts: [] }],
                [assistant([reasoning, answer])],
            ),
        ).toBeNull();
    });

    it("ignores key order and undefined fields", () => {
        expect(
            firstServedDivergenceIndex(
                [
                    {
                        parts: [{ text: "answer", type: "text", extra: undefined }],
                        info: { role: "assistant", id: "a1" },
                    },
                ],
                [assistant([answer])],
            ),
        ).toBeNull();
    });
});
