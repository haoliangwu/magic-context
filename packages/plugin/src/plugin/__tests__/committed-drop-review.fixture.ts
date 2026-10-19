import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import { captureLkgSlot } from "../../hooks/magic-context/lkg-replay";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import { requestPendingMaterialization } from "../../hooks/magic-context/pending-materialization";
import { createTransform } from "../../hooks/magic-context/transform";
import { adaptPayload } from "../../v2/hooks/payload";
import { createMessagesTransformHandler } from "../messages-transform";

const [root, lane, mode, positionArg = "2", seedArg = "719", signedArg = "plain"] =
    process.argv.slice(2);
const position = Number(positionArg);
let seed = Number(seedArg) >>> 0;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const signed = signedArg === "signed";
const sessionId = "independent-committed-subset";
const payload = "independent tool result ".repeat(1200);
let decision: "execute" | "defer" = "defer";
let recoveryCount: number | undefined = lane === "pi" ? undefined : 0;
let tick = 0;
const records: unknown[] = [];
const piPath = (file: string) => join(import.meta.dir, "../../../../pi-plugin/src", file);
const piUtils = lane === "pi" ? await import(piPath("test-utils.test.ts")) : undefined;
const piHandler = lane === "pi" ? await import(piPath("context-handler.ts")) : undefined;
const db = lane === "pi" ? piUtils!.createTestDb(join(root, "context.db")) : openDatabase();
if (!db) throw new Error("disposable database did not open");
db.exec("PRAGMA busy_timeout=0");
const pending = new Set<string>();
let handler: any;
if (lane === "pi") {
    const fake = piUtils!.createFakePi();
    Object.assign(fake.pi, { getActiveTools: () => [], getAllTools: () => [] });
    piHandler!.registerPiContextHandler(fake.pi, {
        db,
        protectedTokens: 0,
        protectedTags: 0,
        heuristics: {},
        scheduler: { executeThresholdPercentage: 65 },
    });
    handler = fake.handlers.get("context");
} else {
    handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": createTransform({
                db,
                tagger: createTagger(),
                scheduler: { shouldExecute: () => decision },
                contextUsageMap: new Map(),
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: pending,
                lastHeuristicsTurnId: new Map(),
                protectedTokens: 1,
                protectedTags: 0,
                directory: root,
                memoryConfig: { enabled: false },
                injectDocs: false,
            }),
        },
        rustReplayParticipant: () => null,
        onLkgReplay: () => {
            recoveryCount = (recoveryCount ?? 0) + 1;
        },
    });
}
function rawPi(count = 8): any[] {
    const u = piUtils!;
    const messages = [
        u.userMessage("start", 1),
        ...Array.from({ length: count }, (_, i) => [
            u.assistantToolCall(
                `call-${i}`,
                mode === "healthy" ? "read" : "ctx_reduce",
                { filePath: `f-${i}` },
                10 + i * 2,
            ),
            {
                ...u.toolResultMessage(`call-${i}`, payload, 11 + i * 2),
                toolName: mode === "healthy" ? "read" : "ctx_reduce",
            },
        ]).flat(),
        // Age this probe's outputs past the three-turn threshold before injecting a write failure.
        ...(signed
            ? Array.from({ length: 3 }, (_, i) => [
                  u.userMessage(`follow-up ${i + 1}`, 30 + i * 2),
                  u.assistantMessage(`response ${i + 1}`, 31 + i * 2),
              ]).flat()
            : []),
        u.assistantMessage("answered", 100),
        u.userMessage(`continue ${tick}`, signed ? 103 : 101),
    ];
    if (signed)
        messages.splice(
            messages.length - 1,
            0,
            u.assistantMessage("signed answer", 102, {
                api: "anthropic-messages",
                provider: "anthropic",
                model: "claude-sonnet-4",
                content: [
                    {
                        type: "thinking",
                        thinking: "kept reasoning",
                        thinkingSignature: "independent-signature",
                    },
                    { type: "text", text: "signed answer" },
                ],
            }),
        );
    for (const message of messages) {
        if (message.role === "assistant")
            Object.assign(message, {
                api: "anthropic-messages",
                provider: "anthropic",
                model: "claude-sonnet-4",
            });
    }
    return messages;
}
function native(): any[] {
    const messages: any[] = [
        { id: "start", role: "user", content: [{ type: "text", text: "start" }] },
        ...Array.from({ length: 8 }, (_, i) => [
            {
                id: `owner-${i}`,
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: `call-${i}`,
                        name: "read",
                        input: { filePath: `f-${i}` },
                    },
                ],
            },
            {
                id: `result-${i}`,
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: `call-${i}`,
                        name: "read",
                        result: { type: "text", value: payload },
                    },
                ],
            },
        ]).flat(),
        { id: "answer", role: "assistant", content: [{ type: "text", text: "answered" }] },
        { id: "continue", role: "user", content: [{ type: "text", text: `continue ${tick}` }] },
    ];
    if (signed)
        messages.splice(messages.length - 1, 0, {
            id: "signed",
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "kept reasoning",
                    providerOptions: { anthropic: { signature: "independent-signature" } },
                },
                { type: "text", text: "signed answer" },
            ],
        });
    return messages;
}
const warm = () =>
    updateSessionMeta(db, sessionId, {
        lastResponseTime: Date.now(),
        cacheTtl: "59m",
        lastInputTokens: 1000,
        lastContextPercentage: 1,
    });
async function pass(establish = false, piCount = 8): Promise<string> {
    if (lane === "pi") {
        const messages = rawPi(piCount);
        const result = await handler(
            { messages },
            {
                ...piUtils!.fakeContext(
                    sessionId,
                    root,
                    messages.map((m) => `entry-${m.timestamp}`),
                    messages,
                ),
                getSystemPrompt: () => "Independent fixed system.",
                model: {
                    provider: "anthropic",
                    id: "claude-sonnet-4",
                    api: "anthropic-messages",
                    contextWindow: 100000,
                },
                getContextUsage: () => ({ tokens: 1000, percent: 1, contextWindow: 100000 }),
            },
        );
        return JSON.stringify(result.messages);
    }
    const draft = {
        sessionID: sessionId,
        model: { providerID: "anthropic", id: "claude-sonnet-4" },
        agent: "build",
        messages: native(),
        system: [],
        tools: {},
        options: {},
    };
    const bridge = adaptPayload(draft as never);
    const messages =
        lane === "oc1" ? bridge.messages.filter((m) => m.info.role !== "tool") : bridge.messages;
    const raw = structuredClone(messages);
    await handler({}, { messages } as never);
    if (establish) {
        if (
            !captureLkgSlot({
                sessionId,
                input: raw,
                output: messages,
                modelKey: "anthropic/claude-sonnet-4",
                providerKey: "anthropic",
                completeOutput: true,
            })
        )
            throw new Error("capture failed");
        if (!saveLkgSlotToDb(db, sessionId, getSlot(sessionId)!, undefined, { rebuild: true }))
            throw new Error("save failed");
    }
    if (lane === "oc1") return JSON.stringify(messages);
    bridge.commit();
    return JSON.stringify(draft.messages);
}
const state = () => ({
    tags: getTagsBySession(db, sessionId).map((t) => [
        t.tagNumber,
        t.messageId,
        t.toolOwnerMessageId,
        t.status,
        t.dropMode,
    ]),
    pending: getPendingOps(db, sessionId).map((o) => [o.tagId, o.operation]),
});
try {
    if (mode === "restart") {
        warm();
        let wire: string | undefined, error: string | undefined;
        try {
            wire = await pass();
        } catch (e) {
            error = String(e);
        }
        const before = readFileSync(join(root, "recovered.json"), "utf8");
        console.log(
            "REVIEW_RESULT " +
                JSON.stringify({
                    wire,
                    error,
                    equal: wire === before,
                    state: state(),
                    recoveryCount,
                }),
        );
    } else if (mode === "healthy") {
        for (let i = 0; i < 48; i++) {
            tick = i;
            decision = i % 3 === 0 ? "execute" : "defer";
            if (i > 0 && i % 4 === 0) {
                const active = getTagsBySession(db, sessionId).filter(
                    (t) => t.type === "tool" && t.status === "active",
                );
                if (active.length)
                    queuePendingOp(
                        db,
                        sessionId,
                        active[Math.floor(random() * active.length)]!.tagNumber,
                        "drop",
                    );
                if (lane === "pi") piHandler!.signalPiPendingMaterialization(sessionId);
                else requestPendingMaterialization(pending, sessionId, "user_flush");
            }
            warm();
            records.push({ wire: await pass(), state: state() });
        }
        writeFileSync(join(root, "records.json"), JSON.stringify(records));
        console.log(
            "REVIEW_RESULT " +
                JSON.stringify({
                    passes: records.length,
                    recoveryCount,
                    drops: getTagsBySession(db, sessionId).filter((t) => t.status === "dropped")
                        .length,
                }),
        );
    } else {
        if (lane === "pi") {
            await pass(false, 3);
            warm();
        }
        const before = await pass(true);
        warm();
        const tags = getTagsBySession(db, sessionId).filter((t) => t.type === "tool");
        if (tags.length !== 8) throw new Error(`expected 8 tool tags, got ${tags.length}`);
        if (lane !== "pi")
            for (const t of tags.slice(0, 3)) queuePendingOp(db, sessionId, t.tagNumber, "drop");
        db.exec(
            `CREATE TEMP TRIGGER independent_abort BEFORE UPDATE OF status ON tags WHEN NEW.tag_number=${tags[position - 1]!.tagNumber} AND NEW.status='dropped' BEGIN SELECT RAISE(ABORT,'independent partial write fault'); END`,
        );
        decision = "execute";
        if (lane === "pi") piHandler!.signalPiPendingMaterialization(sessionId);
        else requestPendingMaterialization(pending, sessionId, "user_flush");
        let wire: string | undefined, error: string | undefined;
        try {
            wire = await pass();
        } catch (e) {
            error = String(e);
        }
        writeFileSync(join(root, "recovered.json"), wire ?? "REFUSED");
        writeFileSync(join(root, "before.json"), before);
        console.log(
            "REVIEW_RESULT " +
                JSON.stringify({ wire, before, error, state: state(), recoveryCount }),
        );
        if (mode === "kill") process.kill(process.pid, "SIGKILL");
    }
} finally {
    if (lane === "pi") {
        piHandler!.clearContextHandlerSession(sessionId);
        db.close();
    } else closeDatabase();
}
