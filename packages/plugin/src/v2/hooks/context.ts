import { loadPluginConfigDetailed } from "../../config";
import { isCompactionEnabled } from "../../config/agent-disable";
import { getProtectedTokensTierOverrides } from "../../config/project-security";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getOrCreateSessionMeta,
    isDatabasePersisted,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { assertExecutableToolInput } from "../../hooks/magic-context/dropped-input-guard";
import {
    createChatMessageHook,
    createToolExecuteAfterHook,
} from "../../hooks/magic-context/hook-handlers";
import { materializeM0 } from "../../hooks/magic-context/inject-compartments";
import { resolveOpenCodeProtectedTailBoundary } from "../../hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { preloadTokenizer } from "../../hooks/magic-context/read-session-formatting";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import { maybeSendUpgradeReminder } from "../../hooks/magic-context/upgrade-reminder";
import { getDataDir } from "../../shared/data-path";
import { resolveHistorianModel } from "../../shared/model-resolution";
import { pushNotification } from "../../shared/rpc-notifications";
import { v2CompactionMarkerStrategy } from "../fold/markers";
import { FoldOwner, foldDigest } from "../fold/owner";
import { restoreRow } from "../fold/restore";
import { createV2HiddenCompletionExecutor } from "../hidden-completion";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { deliverPendingChannel2, isAdmittedSynthetic } from "./channel2";
import { startDreamTrigger } from "./dream-trigger";
import { adaptPayload, HEAD_IDS } from "./payload";
import { interruptBeforeProvider, V2ContextRefusal } from "./refusal";
import { rawMessages } from "./store";
import type { SessionContext, V2Context } from "./types";

export function createHostSeams(
    context: V2Context,
    read: TransformDeps["hostRawMessages"] & {},
    liveModels: NonNullable<TransformDeps["liveModelBySession"]>,
): Required<
    Pick<
        TransformDeps,
        "hostRawMessages" | "hostProtectedTailBoundary" | "hostModelFallback" | "hostRefuse"
    >
> {
    return {
        hostRawMessages: read,
        hostProtectedTailBoundary: (args) =>
            resolveOpenCodeProtectedTailBoundary({
                ...args,
                cacheNamespace: `opencode2:${args.sessionId}`,
            }),
        hostModelFallback: (sessionID) => liveModels.get(sessionID) ?? null,
        hostRefuse: (_client, sessionID) =>
            interruptBeforeProvider(context.session, sessionID as SessionContext["sessionID"]),
    };
}

export async function registerContext(context: V2Context) {
    const directory = context.location.directory;
    const config = loadPluginConfigDetailed(directory).config;
    if (!config.enabled || !isCompactionEnabled(config)) return;
    const folds = new FoldOwner(context.storage);
    const limits = new Map<string, number>();
    const queriedModels = new Set<string>();
    const liveModels: NonNullable<TransformDeps["liveModelBySession"]> = new Map();
    // Bind the host's generate once: the executor's closure runs after this
    // presence check and must call the same method with the session as receiver.
    const hostGenerate = context.session.generate?.bind(context.session);
    const hiddenCompletionExecutor = hostGenerate
        ? await createV2HiddenCompletionExecutor(
              {
                  hook: (name, callback) => context.session.hook(name, callback),
                  generate: (input, options) => hostGenerate(input, options),
              },
              (sessionID) => liveModels.get(sessionID) ?? null,
          )
        : undefined;
    const dreamTrigger =
        hiddenCompletionExecutor && config.dreamer && !config.dreamer.disable
            ? startDreamTrigger(context, {
                  config: config.dreamer,
                  executor: hiddenCompletionExecutor,
                  projectIdentity: () => resolveProjectIdentity(directory) ?? directory,
                  language: config.language,
                  mural: config.mural,
              })
            : undefined;
    const historianModels = resolveHistorianModel(config, "opencode");
    const usage: TransformDeps["contextUsageMap"] = new Map();
    const channel1: NonNullable<TransformDeps["channel1StateBySession"]> = new Map();
    const variants = new Map<string, string | undefined>();
    const agents = new Map<string, string>();
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const rawProviders = new Map<string, () => void>();
    let passDuties: ReturnType<typeof createChatMessageHook> | undefined;
    let toolDuties: ReturnType<typeof createToolExecuteAfterHook> | undefined;
    await context.tool.hook("execute.before", (draft) => assertExecutableToolInput(draft.input));
    await context.tool.hook("execute.after", async (draft) => {
        if (!db || draft.status !== "completed") return;
        try {
            toolDuties ??= createToolExecuteAfterHook({ db, channel1StateBySession: channel1 });
            const content = draft.result?.content;
            const text =
                typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("\n")
                      : "";
            const output = { output: text };
            await toolDuties({ ...draft, args: draft.input }, output);
            if (draft.result && output.output !== text) {
                if (typeof content === "string") draft.result.content = output.output;
                else if (Array.isArray(content) && output.output.startsWith(text))
                    content.push({ type: "text", text: output.output.slice(text.length) });
            }
            const baseline = channel1.get(draft.sessionID);
            await deliverPendingChannel2(context, db, draft.sessionID, baseline);
        } catch (error) {
            console.warn("[magic-context] v2 Channel 2 delivery deferred", error);
        }
    });
    const read = (sessionID: string) => {
        const reader = new V2StoreReader(
            gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
        );
        try {
            return rawMessages(reader.history(sessionID));
        } finally {
            reader.close();
        }
    };
    const pagedRead = Object.assign(read, {
        readPage: (sessionID: string, after: number, limit: number, watermark: number) =>
            read(sessionID)
                .filter((m) => m.ordinal > after && m.ordinal <= watermark)
                .slice(0, limit),
        getCount: (sessionID: string) => read(sessionID).length,
    });
    let transform: ReturnType<typeof createTransform> | undefined;
    let db: ReturnType<typeof openDatabase> | undefined;
    const refuseIfUnsafe = async (draft: SessionContext): Promise<boolean> => {
        let unsafe = false;
        try {
            db ??= openDatabase();
            if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
            getOrCreateSessionMeta(db, draft.sessionID);
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const latest = reader
                    .history(draft.sessionID)
                    .filter((row) => row.type === "assistant")
                    .at(-1);
                const tokens = latest?.data.tokens;
                const modelKey = `${draft.model.providerID}/${draft.model.id}`;
                if (!queriedModels.has(modelKey)) {
                    const catalog = await context.catalog.model.list({
                        location: context.location,
                    });
                    for (const model of catalog.data)
                        limits.set(`${model.providerID}/${model.id}`, model.limit.context);
                    queriedModels.add(modelKey);
                }
                const limit = limits.get(modelKey);
                if (tokens && limit && Number.isFinite(limit) && limit > 0) {
                    const inputTokens = tokens.input + tokens.cache.read + tokens.cache.write;
                    unsafe = inputTokens / limit >= 0.95;
                    const completed = latest?.data.time?.completed;
                    if (typeof completed === "number")
                        updateSessionMeta(db, draft.sessionID, { lastResponseTime: completed });
                    usage.set(draft.sessionID, {
                        usage: { inputTokens, percentage: (inputTokens / limit) * 100 },
                        hasUsageTokens: true,
                        updatedAt: Date.now(),
                    });
                }
            } finally {
                reader.close();
            }
        } catch {
            unsafe = true;
        }
        if (unsafe) await interruptBeforeProvider(context.session, draft.sessionID);
        return unsafe;
    };
    const materialize = (draft: SessionContext) => {
        db ??= openDatabase();
        if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
        const state = getOrCreateSessionMeta(db, draft.sessionID);
        return materializeM0({
            db,
            sessionId: draft.sessionID,
            state,
            projectPath: resolveProjectIdentity(directory) ?? directory,
            projectDirectory: directory,
            memoryEnabled: config.memory.enabled,
            memoryInjectionBudgetTokens: config.memory.injection_budget_tokens,
            hardSignals: {
                systemHash: foldDigest(JSON.stringify(draft.system)),
                toolSetHash: "",
                modelKey: `${draft.model.providerID}/${draft.model.id}`,
                cacheExpired: false,
                lastResponseTime: state.lastResponseTime,
            },
        }).m0Text;
    };
    await context.session.hook("compaction", async (draft) => {
        const reader = new V2StoreReader(
            gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
        );
        try {
            const rows = reader.history(draft.sessionID);
            const ids = new Set(draft.messages.map((message) => message.id));
            const watermark = Math.max(
                -1,
                ...rows.filter((row) => ids.has(row.id)).map((row) => row.seq),
            );
            const running = rows
                .filter((row) => row.type === "compaction" && row.data.status === "running")
                .at(-1);
            const fold = await folds.supply({
                sessionID: draft.sessionID,
                watermark,
                runningCut: running?.seq,
                materialize: () => materialize(draft),
            });
            draft.result = { summary: fold.submitted };
        } catch (cause) {
            await interruptBeforeProvider(context.session, draft.sessionID);
            throw new V2ContextRefusal("Magic Context could not preserve the host checkpoint.", {
                cause,
            });
        } finally {
            reader.close();
        }
    });
    await context.session.hook("context", async (draft) => {
        let postFold = false;
        try {
            if (await refuseIfUnsafe(draft)) return;
            if (!db) return;
            const storage = db;
            updateSessionMeta(db, draft.sessionID, {
                systemPromptHash: foldDigest(JSON.stringify(draft.system)),
            });
            await preloadTokenizer();
            passDuties ??= createChatMessageHook({
                db,
                liveModelBySession: liveModels,
                variantBySession: variants,
                agentBySession: agents,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                systemPromptRefreshSessions: new Set(),
                cacheTtlConfig: config.cache_ttl,
                upgradeReminder: (sessionID) =>
                    maybeSendUpgradeReminder(
                        {
                            db: storage,
                            client: undefined,
                            getNotificationParams: () => ({}),
                            sendStatusNotification: async (_client, id, text) => {
                                pushNotification("toast", { message: text, variant: "info" }, id);
                                return "queued";
                            },
                        },
                        sessionID,
                    ),
            });
            await passDuties({
                sessionID: draft.sessionID,
                agent: draft.agent,
                variant: draft.model.variant,
                model: { providerID: draft.model.providerID, modelID: draft.model.id },
            });
            // Background historian reads outlive the context callback. Keep its source
            // registered until plugin disposal, rather than falling back to the v1 store.
            if (!rawProviders.has(draft.sessionID))
                rawProviders.set(
                    draft.sessionID,
                    setRawMessageProvider(draft.sessionID, {
                        readMessages: () => read(draft.sessionID),
                    }),
                );
            transform ??= createTransform({
                db,
                tagger: createTagger(),
                scheduler: createScheduler({
                    executeThresholdPercentage: config.execute_threshold_percentage,
                }),
                contextUsageMap: usage,
                protectedTokens: config.protected_tokens,
                protectedTokenTierOverrides: getProtectedTokensTierOverrides(config),
                executeThresholdPercentage: config.execute_threshold_percentage,
                liveModelBySession: liveModels,
                channel1StateBySession: channel1,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                variantBySession: variants,
                clearReasoningAge: config.clear_reasoning_age,
                directory,
                projectPath: directory,
                hiddenCompletionExecutor,
                historianRunnable:
                    hiddenCompletionExecutor !== undefined && config.historian?.disable !== true,
                historianModel: historianModels.primary,
                fallbackModels: historianModels.fallbacks,
                historianTimeoutMs: config.historian_timeout_ms,
                historianMaxOutputTokens: config.historian?.maxTokens,
                historianTwoPass: config.historian?.two_pass,
                compactionMarkerStrategy: v2CompactionMarkerStrategy,
                memoryConfig: {
                    enabled: config.memory.enabled,
                    injectionBudgetTokens: config.memory.injection_budget_tokens,
                    autoPromote: config.memory.auto_promote,
                },
                ...createHostSeams(context, pagedRead, liveModels),
            });
            const admitted = new Set<string>();
            for (const message of draft.messages) {
                if (message.id && (await isAdmittedSynthetic(context, draft.sessionID, message.id)))
                    admitted.add(message.id);
            }
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            let checkpoint: SessionContext["messages"][number] | undefined;
            let submitted: string | undefined;
            try {
                const cut = reader.latestCompaction(draft.sessionID);
                const incoming = cut && draft.messages.find((message) => message.id === cut.id);
                postFold = cut !== undefined;
                if (cut && !incoming)
                    throw new Error("The host checkpoint disappeared from the context draft");
                if (cut && incoming) {
                    const identity = await folds.observe({
                        sessionID: draft.sessionID,
                        cutSeq: cut.seq,
                        summary: cut.data.summary ?? "",
                        rendered: incoming,
                        onHard: (reason) => {
                            console.warn(
                                `[magic-context] HARD reason=${reason} session=${draft.sessionID}`,
                            );
                            materialize(draft);
                            pendingMaterializationSessions.add(draft.sessionID);
                        },
                    });
                    checkpoint = structuredClone(identity.rendered ?? incoming);
                    submitted = identity.rendered
                        ? (identity.renderedSummary ?? identity.submitted)
                        : (cut.data.summary ?? "");
                    const all = reader.history(draft.sessionID);
                    const boundaryID = (
                        db
                            .prepare(
                                "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
                            )
                            .get(draft.sessionID) as { id: string | null } | null
                    )?.id;
                    const boundary = all.find((row) => row.id === boundaryID)?.seq ?? -1;
                    const present = new Set(draft.messages.map((message) => message.id));
                    const restored = all
                        .filter(
                            (row) =>
                                row.seq > boundary && row.seq <= cut.seq && !present.has(row.id),
                        )
                        .flatMap((row) => restoreRow(row, draft.model));
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        ...restored,
                        ...draft.messages.filter((message) => message !== incoming),
                    );
                }
            } finally {
                reader.close();
            }
            const mapped = adaptPayload(draft, admitted);
            await transform({}, mapped);
            mapped.commit();
            if (checkpoint && submitted !== undefined) {
                const head = draft.messages.find((message) => message.id === HEAD_IDS[0]);
                const baseline = head?.content.find((part) => part.type === "text")?.text;
                if (typeof baseline === "string") {
                    for (const part of checkpoint.content)
                        if (part.type === "text" && typeof part.text === "string") {
                            part.text = part.text.replace(
                                `<summary>\n${submitted}\n</summary>`,
                                `<summary>\n${baseline}\n</summary>`,
                            );
                        }
                    const volatile = draft.messages.find((message) => message.id === HEAD_IDS[1]);
                    if (volatile && head)
                        volatile.content.push(
                            ...head.content.filter((part) => part.type !== "text"),
                        );
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        checkpoint,
                        ...draft.messages.filter((message) => message !== head),
                    );
                }
            }
        } catch (error) {
            if (error instanceof V2ContextRefusal) throw error;
            if (postFold) {
                await interruptBeforeProvider(context.session, draft.sessionID);
                throw new V2ContextRefusal(
                    "Magic Context could not restore the unarchived host history.",
                    { cause: error },
                );
            }
            // Another plugin can poison the shared draft. Do not fail an otherwise viable turn.
            console.warn("[magic-context] v2 context unavailable", error);
        }
    });
    return {
        async dispose() {
            await dreamTrigger?.dispose();
            for (const release of rawProviders.values()) release();
            rawProviders.clear();
        },
    };
}
