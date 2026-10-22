import { expect, test } from "bun:test";
import {
    getTagsBySession,
    insertTag,
    queuePendingOp,
    updateSessionMeta,
} from "../features/magic-context/storage";
import { closeDatabase, openDatabase } from "../features/magic-context/storage-db";
import { createTagger } from "../features/magic-context/tagger";
import { DegradedPassRefusalError } from "../hooks/magic-context/degraded-pass-refusal";
import { saveLkgSlotToDb } from "../hooks/magic-context/lkg-persist";
import { captureLkgSlot } from "../hooks/magic-context/lkg-replay";
import { dropSlot, getSlot } from "../hooks/magic-context/lkg-slot";
import { requestPendingMaterialization } from "../hooks/magic-context/pending-materialization";
import { createTransform } from "../hooks/magic-context/transform";
import { adaptPayload } from "../v2/hooks/payload";
import { createMessagesTransformHandler } from "./messages-transform";

for (const lane of ["oc1", "oc2"] as const) {
    for (const position of [1, 2, 3]) {
        test(`partial-drop LKG ${lane}: chunk ${position} serves committed drops before defer restart`, async () => {
            const sessionId = `partial-lkg-${lane}-${position}`;
            let db = openDatabase();
            if (!db) throw new Error("throwaway database unavailable");
            const model = { providerID: "anthropic", modelID: "claude-sonnet-4" };
            let decision: "execute" | "defer" = "defer";
            const pending = new Set<string>();
            let replays = 0;
            const buildHandler = () =>
                createMessagesTransformHandler({
                    magicContext: {
                        "experimental.chat.messages.transform": createTransform({
                            db: db!,
                            tagger: createTagger(),
                            scheduler: { shouldExecute: () => decision },
                            contextUsageMap: new Map(),
                            historyRefreshSessions: new Set(),
                            pendingMaterializationSessions: pending,
                            lastHeuristicsTurnId: new Map(),
                            protectedTokens: 1,
                            protectedTags: 0,
                            directory: process.cwd(),
                        }),
                    },
                    rustReplayParticipant: () => null,
                    onLkgReplay: () => {
                        replays++;
                    },
                });
            let handler = buildHandler();
            const native = () => [
                { id: "start", role: "user", content: [{ type: "text", text: "start" }] },
                ...Array.from({ length: 12 }, (_, i) => [
                    {
                        id: `call-${i}`,
                        role: "assistant",
                        content: [
                            {
                                type: "tool-call",
                                id: `tool-${i}`,
                                name: "read",
                                input: { filePath: `file-${i}.ts` },
                            },
                        ],
                    },
                    {
                        id: `result-${i}`,
                        role: "tool",
                        content: [
                            {
                                type: "tool-result",
                                id: `tool-${i}`,
                                name: "read",
                                result: { type: "text", value: "result ".repeat(4000) },
                            },
                        ],
                    },
                ]).flat(),
                { id: "answer", role: "assistant", content: [{ type: "text", text: "answered" }] },
                { id: "continue", role: "user", content: [{ type: "text", text: "continue" }] },
            ];
            const pass = async (establish = false) => {
                const draft = {
                    sessionID: sessionId,
                    model: { providerID: model.providerID, id: model.modelID },
                    agent: "build",
                    messages: native(),
                    system: [],
                    tools: {},
                    options: {},
                };
                const mapped = adaptPayload(draft as never);
                const raw = structuredClone(mapped.messages);
                const capture = (messages: typeof mapped.messages) => {
                    if (!establish) return;
                    expect(
                        captureLkgSlot({
                            sessionId,
                            input: raw,
                            output: messages,
                            modelKey: "anthropic/claude-sonnet-4",
                            providerKey: "anthropic",
                            completeOutput: true,
                        }),
                    ).toBe(true);
                    expect(
                        saveLkgSlotToDb(db!, sessionId, getSlot(sessionId)!, undefined, {
                            rebuild: true,
                        }),
                    ).toBe(true);
                };
                if (lane === "oc1") {
                    // OpenCode 1 carries a completed invocation and output in one part.
                    const messages = mapped.messages.filter((m) => m.info.role !== "tool");
                    await handler({}, { messages } as never);
                    capture(messages);
                    return JSON.stringify(messages);
                }
                await handler({}, { messages: mapped.messages } as never);
                capture(mapped.messages);
                mapped.commit();
                return JSON.stringify(draft.messages);
            };
            try {
                await pass(true);
                const tags = getTagsBySession(db, sessionId).filter((tag) => tag.type === "tool");
                expect(tags).toHaveLength(12);
                for (const [index, tag] of tags.slice(0, 3).entries()) {
                    queuePendingOp(db, sessionId, tag.tagNumber, "drop");
                    // Fill the rest of each 64-operation chunk with stale queue entries.
                    // The next real drop then tests recovery after an earlier chunk committed.
                    for (let offset = 0; offset < 63; offset++) {
                        const number = 100_000 + index * 63 + offset;
                        insertTag(db, sessionId, `stale-${number}`, "message", 1, number);
                        db.prepare(
                            "UPDATE tags SET status='compacted' WHERE session_id=? AND tag_number=?",
                        ).run(sessionId, number);
                        queuePendingOp(db, sessionId, number, "drop");
                    }
                }
                db.exec(
                    `CREATE TEMP TRIGGER partial_drop_abort BEFORE UPDATE OF status ON tags WHEN NEW.tag_number=${tags[position - 1]!.tagNumber} AND NEW.session_id='${sessionId}' AND NEW.status='dropped' BEGIN SELECT RAISE(ABORT,'partial lkg fault'); END`,
                );
                decision = "execute";
                requestPendingMaterialization(pending, sessionId, "user_flush");
                const recovered = await pass();
                expect(replays).toBe(1);
                expect(
                    getTagsBySession(db, sessionId).filter(
                        (tag) => tag.type === "tool" && tag.status === "dropped",
                    ),
                ).toHaveLength(position - 1);
                expect(recovered.split("result ".repeat(4000))).toHaveLength(13 - (position - 1));
                closeDatabase();
                db = openDatabase();
                if (!db) throw new Error("reopened database unavailable");
                decision = "defer";
                pending.clear();
                updateSessionMeta(db, sessionId, {
                    lastResponseTime: Date.now(),
                    cacheTtl: "59m",
                    lastInputTokens: 1000,
                    lastContextPercentage: 1,
                });
                handler = buildHandler();
                expect(await pass()).toBe(recovered);
            } finally {
                dropSlot(sessionId);
                closeDatabase();
            }
        });
    }
}

for (const lane of ["oc1", "oc2"] as const) {
    for (const beforeThinking of [true, false]) {
        test(`text-drop LKG ${lane}: ${beforeThinking ? "refuses before" : "allows after"} kept signed reasoning`, async () => {
            const sessionId = `text-prefix-${lane}-${beforeThinking}`;
            const db = openDatabase()!;
            const draft = {
                sessionID: sessionId,
                model: { providerID: "anthropic", id: "claude-sonnet-4" },
                messages: [
                    {
                        id: "old",
                        role: "user",
                        content: [
                            { type: "text", text: beforeThinking ? "§907§ old text" : "old text" },
                        ],
                    },
                    {
                        id: "signed",
                        role: "assistant",
                        content: [
                            {
                                type: "reasoning",
                                text: "keep",
                                providerOptions: {
                                    anthropic: { signature: "text-prefix-signature" },
                                },
                            },
                            { type: "text", text: "answer" },
                        ],
                    },
                    {
                        id: "tail",
                        role: "user",
                        content: [{ type: "text", text: beforeThinking ? "next" : "§907§ next" }],
                    },
                ],
                system: [],
                tools: {},
                options: {},
            };
            const bridge = adaptPayload(draft as never);
            const messages =
                lane === "oc1"
                    ? bridge.messages.filter((m) => m.info.role !== "tool")
                    : bridge.messages;
            let replays = 0;
            const handler = createMessagesTransformHandler({
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        throw new Error("text drop failed pass");
                    },
                },
                rustReplayParticipant: () => null,
                onLkgReplay: () => {
                    replays++;
                },
            });
            try {
                expect(
                    captureLkgSlot({
                        sessionId,
                        input: messages,
                        output: messages,
                        modelKey: "anthropic/claude-sonnet-4",
                        providerKey: "anthropic",
                        completeOutput: true,
                    }),
                ).toBe(true);
                expect(
                    saveLkgSlotToDb(db, sessionId, getSlot(sessionId)!, undefined, {
                        rebuild: true,
                    }),
                ).toBe(true);
                insertTag(
                    db,
                    sessionId,
                    `${beforeThinking ? "old" : "tail"}:p0`,
                    "message",
                    100,
                    907,
                );
                db.prepare("UPDATE tags SET status='dropped' WHERE session_id=?").run(sessionId);
                const original = structuredClone(messages);
                if (beforeThinking) {
                    await expect(handler({}, { messages } as never)).rejects.toBeInstanceOf(
                        DegradedPassRefusalError,
                    );
                    expect(messages).toEqual(original);
                    expect(replays).toBe(0);
                } else {
                    await handler({}, { messages } as never);
                    expect(replays).toBe(1);
                    expect(JSON.stringify(messages)).toContain("[dropped §907§]");
                    expect(JSON.stringify(messages)).toContain("text-prefix-signature");
                    if (lane === "oc2") {
                        bridge.commit();
                        expect(JSON.stringify(draft.messages)).toContain("[dropped §907§]");
                    }
                }
            } finally {
                dropSlot(sessionId);
                closeDatabase();
            }
        });
    }
}
