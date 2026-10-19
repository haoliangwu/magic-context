import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import {
    clearModelsDevCache,
    getSdkInputLimit,
    refreshModelLimitsFromApi,
} from "../../shared/models-dev-cache";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { estimateTokens } from "./read-session-formatting";
import { createTransform } from "./transform";

type Message = {
    info: { id: string; role: string; sessionID: string; providerID?: string; modelID?: string };
    parts: Array<Record<string, unknown>>;
};

// The last provider signature binds every preceding tool result. Reclaiming
// those results must therefore omit all thinking first. The returned request
// must fit the 100,000-input-token window or throw a visible refusal.
for (const { subagent, percent, measured } of [
    { subagent: false, percent: 85, measured: true },
    { subagent: false, percent: 95, measured: true },
    { subagent: true, percent: 85, measured: true },
    { subagent: true, percent: 95, measured: true },
    { subagent: false, percent: 95, measured: false },
]) {
    test.skipIf(process.env.MC_665_R3 !== "1")(
        measured
            ? `r3 OpenCode ${subagent ? "subagent" : "primary"} ${percent}% long loop fits or visibly refuses`
            : "r3 OpenCode unpriced reset persists nine omissions and replays original ingress",
        async () => {
            const temp = createTestTempDir("r3-oc-pressure-").dir;
            const oldData = process.env.XDG_DATA_HOME;
            const oldCache = process.env.XDG_CACHE_HOME;
            process.env.XDG_CACHE_HOME = temp;
            process.env.XDG_DATA_HOME = temp;
            const db = openDatabase();
            const sessionId = `r3-oc-pressure-${subagent}-${percent}`;
            const model = {
                providerID: "anthropic",
                modelID: measured ? "claude-opus-5-5" : "r3-opus-5-5",
            };
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "anthropic",
                                    models: {
                                        [model.modelID]: {
                                            limit: {
                                                context: 100000,
                                                input: 100000,
                                                output: 0,
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                    }),
                },
            } as never);
            expect(getSdkInputLimit(model.providerID, model.modelID)).toBe(100000);
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, {
                isSubagent: subagent,
                cacheTtl: "13h",
                lastResponseTime: Date.now(),
                systemPromptTokens: measured ? 20 : null,
            });
            if (measured)
                recordToolDefinition(
                    model.providerID,
                    model.modelID,
                    undefined,
                    "read",
                    "Read a file",
                    { type: "object", properties: { path: { type: "string" } } },
                );
            const usage = new Map([
                [
                    sessionId,
                    {
                        usage: { percentage: 20, inputTokens: 20000 },
                        updatedAt: Date.now(),
                        hasUsageTokens: true,
                    },
                ],
            ]);
            const transform = createTransform({
                db,
                directory: temp,
                tagger: createTagger(),
                scheduler: createScheduler({ executeThresholdPercentage: 65 }),
                liveModelBySession: new Map([[sessionId, model]]),
                contextUsageMap: usage,
                protectedTokens: 0,
                protectedTools: { read: 0 },
                clearReasoningAge: 1000,
                historianRunnable: false,
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
            });
            const source: Message[] = [
                {
                    info: { id: "user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "read files" }],
                },
            ];
            const serve = async () => {
                const messages = structuredClone(source);
                await transform({}, { messages } as never);
                return messages;
            };
            try {
                await serve();
                for (let n = 0; n < 8; n++)
                    source.push({
                        info: {
                            id: `assistant-${n}`,
                            role: "assistant",
                            sessionID: sessionId,
                            ...model,
                        },
                        parts: [
                            {
                                type: "reasoning",
                                text: `thought-${n}`,
                                metadata: { anthropic: { signature: `sig-${n}` } },
                            },
                            {
                                type: "tool",
                                tool: "read",
                                callID: `call-${n}`,
                                state: {
                                    status: "completed",
                                    input: { path: `${n}.txt` },
                                    output: "RECLAIMABLE ".repeat(6000),
                                },
                            },
                        ],
                    });
                source.push({
                    info: { id: "last", role: "assistant", sessionID: sessionId, ...model },
                    parts: [
                        {
                            type: "reasoning",
                            text: "last boundary",
                            metadata: { anthropic: { signature: "sig-last" } },
                        },
                    ],
                });
                expect(JSON.stringify(source).length / 4).toBeGreaterThan(100000);
                usage.set(sessionId, {
                    usage: { percentage: percent, inputTokens: percent * 1000 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
                let output: Message[];
                try {
                    await serve();
                    for (const tag of getTagsBySession(db, sessionId).filter(
                        (t) => t.type === "tool",
                    ))
                        queuePendingOp(db, sessionId, tag.tagNumber, "drop");
                    output = await serve();
                } catch (error) {
                    if (!measured) throw error;
                    expect(error).toMatchObject({ name: "EmergencyFailClosedError" });
                    console.log(
                        `r3 OpenCode ${subagent}/${percent}: visible EmergencyFailClosedError`,
                    );
                    return;
                }
                const bytes = JSON.stringify(output);
                const servedTokens = output
                    .flatMap((m) => m.parts)
                    .reduce((sum, part) => {
                        const state = part.state as
                            | { output?: unknown; input?: unknown }
                            | undefined;
                        return (
                            sum +
                            estimateTokens(String(part.text ?? "")) +
                            estimateTokens(String(state?.output ?? "")) +
                            (state?.input === undefined
                                ? 0
                                : estimateTokens(JSON.stringify(state.input)))
                        );
                    }, 0);
                const reasoningCount = output
                    .flatMap((m) => m.parts)
                    .filter((p) => p.type === "reasoning").length;
                console.log(
                    `r3 OpenCode ${subagent}/${percent}: ${bytes.length} served bytes, ${servedTokens} content tokens, ${reasoningCount} reasoning blocks, ${getPendingOps(db, sessionId).length} pending`,
                );
                expect(servedTokens).toBeLessThanOrEqual(100000);
                expect(reasoningCount).toBe(0);
                if (percent === 95) expect(getPendingOps(db, sessionId)).toHaveLength(0);
                const omissions = [...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
                    id.startsWith("binding_mismatch:"),
                );
                expect(omissions.length).toBeGreaterThanOrEqual(9);
                expect(
                    (await serve()).flatMap((m) => m.parts).filter((p) => p.type === "reasoning"),
                ).toHaveLength(0);
                console.log(
                    `r3 OpenCode ${subagent}/${percent}: reset, ${bytes.length} served bytes, ${servedTokens} estimated tokens, ${omissions.length} durable omissions`,
                );
            } finally {
                resetLkgSlotsForTest();
                __resetToolDefinitionMeasurements();
                closeDatabase();
                clearModelsDevCache();
                if (oldData === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = oldData;
                if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
                else process.env.XDG_CACHE_HOME = oldCache;
                rmSync(temp, { recursive: true, force: true });
            }
        },
        60000,
    );
}
