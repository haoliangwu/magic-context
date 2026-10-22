import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    recordDetectedContextLimit,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import * as injection from "./inject-compartments";
import { opencode1ToModelMessages } from "./opencode1-to-model-messages.fixture";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

const fixtureRoot = new URL("./__fixtures__/anthropic-3.0.111/", import.meta.url);
const fixtureHashes = {
    "convert-to-anthropic-messages-prompt.ts.txt":
        "5e975773398571c61d5b13bd99efddcf5e2662f9c0fe3549a5a951637936d04b",
    "anthropic-messages-api.ts.txt":
        "50033c72eacb6e8deb70c01d64c61990aeaf63e7eecd0ebf355b14bde51a1846",
    "anthropic-messages-options.ts.txt":
        "d9dafb5714115c01e0b3bf1c88d2e2a9be441a40b94423f0dcdf889915d61b6b",
    "get-cache-control.ts.txt": "82ef31af4f69e43dbd407d7f6e3fd48f374c17310d7a17823f0918b1cf6bf5ab",
    "tool/advisor_20260301.ts.txt":
        "3100075c29ce970849887638d409729b465735cb87915fb473460ae68bd8564e",
    "tool/code-execution_20250522.ts.txt":
        "cdf59e171f633d48165edca287843add868768cf7e44045e0ef29e6654fcdda3",
    "tool/code-execution_20250825.ts.txt":
        "eb048a8918ecc2e51970d0f6c102e2c75e85b2737449bf029e74f6a07e9aa548",
    "tool/code-execution_20260120.ts.txt":
        "4a4b4abeb976db8673627a602d050cc6fb3dcd5b021de9548381c7e82bdb38a5",
    "tool/tool-search-regex_20251119.ts.txt":
        "634cdc1e5f28f0c30779500e8c403e6ea6ebe51de314c207b4fce7553d470573",
    "tool/web-fetch-20250910.ts.txt":
        "5aba8c2fb0e21c4a9b3eca3fcf71804bf9060741342aedce01a39436f5295273",
    "tool/web-search_20250305.ts.txt":
        "7b4cb9d54cea9c97bf61283006b180ba0a579619f9b394ae5461ae90f6249887",
    LICENSE: "b4f9adb7c568904834d0dd6cc98d16c390d21ca32fc17ae7a267715269bd5529",
};

it("MOTOR: Anthropic 3.0.111 conversion fixture matches the npm source hashes", () => {
    const sdkRequire = createRequire(import.meta.url);
    const installedPackage = JSON.parse(
        readFileSync(
            join(dirname(sdkRequire.resolve("@ai-sdk/anthropic")), "../package.json"),
            "utf8",
        ),
    ) as { version: string };
    expect(installedPackage.version).toBe("3.0.82");
    for (const [path, hash] of Object.entries(fixtureHashes)) {
        expect(
            createHash("sha256")
                .update(readFileSync(new URL(path, fixtureRoot)))
                .digest("hex"),
        ).toBe(hash);
    }
});

type ProviderPrompt = Parameters<
    ReturnType<ReturnType<typeof createAnthropic>["messages"]>["doGenerate"]
>[0]["prompt"];
type WirePrompt = {
    system?: unknown;
    messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
};
type PinnedConverter = (options: {
    prompt: ProviderPrompt;
    sendReasoning: boolean;
    warnings: unknown[];
    toolNameMapping: {
        toProviderToolName: (name: string) => string;
        toCustomToolName: (name: string) => string;
    };
}) => Promise<{ prompt: WirePrompt }>;
let pinnedConverter: Promise<PinnedConverter> | undefined;

function loadPinnedConverter(): Promise<PinnedConverter> {
    pinnedConverter ??= (async () => {
        // Bundle the verbatim source as test data. No production module imports this fixture.
        const bundle = await Bun.build({
            entrypoints: [
                fileURLToPath(new URL("convert-to-anthropic-messages-prompt.ts.txt", fixtureRoot)),
            ],
            target: "node",
            format: "cjs",
            external: ["@ai-sdk/provider", "@ai-sdk/provider-utils", "zod/v4"],
            plugins: [
                {
                    name: "anthropic-npm-fixture",
                    setup(build) {
                        build.onResolve({ filter: /^\./ }, (args) => ({
                            path: resolve(dirname(args.importer), `${args.path}.ts.txt`),
                        }));
                        build.onLoad({ filter: /\.ts\.txt$/ }, (args) => ({
                            contents: readFileSync(args.path, "utf8"),
                            loader: "ts",
                        }));
                    },
                },
            ],
        });
        if (!bundle.success) throw new AggregateError(bundle.logs, "Pinned provider bundle failed");
        const module = { exports: {} as { convertToAnthropicMessagesPrompt: PinnedConverter } };
        new Function("require", "module", "exports", await bundle.outputs[0]!.text())(
            createRequire(createRequire(import.meta.url).resolve("@ai-sdk/anthropic")),
            module,
            module.exports,
        );
        return module.exports.convertToAnthropicMessagesPrompt;
    })();
    return pinnedConverter;
}

const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const survivorText = "Windows remote jobs keep their original output — surviving §6094 equivalent.";
const liveTailText = "LIVE TAIL: continue with the next task.";

async function providerWire(
    rows: MessageLike[],
): Promise<{ pinned: WirePrompt; installed: WirePrompt }> {
    const prompt = (await opencode1ToModelMessages(rows, {
        providerID: model.providerID,
        id: model.modelID,
        api: { npm: "@ai-sdk/anthropic", id: model.modelID },
    })) as ProviderPrompt;
    const convert = await loadPinnedConverter();
    const pinned = (
        await convert({
            prompt,
            sendReasoning: false,
            warnings: [],
            toolNameMapping: {
                toProviderToolName: (name) => name,
                toCustomToolName: (name) => name,
            },
        })
    ).prompt;
    const bodies: WirePrompt[] = [];
    const installed = createAnthropic({
        apiKey: "fixture-only",
        fetch: Object.assign(
            async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                const body = JSON.parse(String(init?.body)) as WirePrompt;
                bodies.push({ system: body.system, messages: body.messages });
                throw new Error("request captured; no network");
            },
            { preconnect: () => {} },
        ),
    }).messages(model.modelID);
    await Promise.resolve(installed.doGenerate({ prompt, maxOutputTokens: 1 })).catch(
        () => undefined,
    );
    expect(bodies).toHaveLength(1);
    return { pinned, installed: bodies[0]! };
}

type TrimObservation = {
    boundary: string | null | undefined;
    status: string | undefined;
    sourceIds: readonly string[] | undefined;
    liveIds: Array<string | undefined>;
    coveredPlaceholders: string[];
};

async function runRebuildThenDefer(boundaryAbsent = false) {
    const root = createTestTempDir("motor-double-bust-");
    const originalDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root.dir;
    const sessionId = boundaryAbsent ? "motor-absent-boundary" : "motor-double-bust";
    const coveredIds = Array.from(
        { length: 50 },
        (_, i) => `msg-covered-${String(i).padStart(2, "0")}`,
    );
    const boundaryId = "msg-boundary";
    const markerId = "msg-old-marker";
    const summaryId = "msg-old-summary";
    const msg = (id: string, role: "user" | "assistant", parts: unknown[]): MessageLike =>
        ({
            info: {
                id,
                role,
                sessionID: sessionId,
                ...(role === "assistant" ? { ...model, finish: "stop" } : {}),
            },
            parts,
        }) as MessageLike;
    let tailOutput = "Small live result";
    const source = () => [
        msg(markerId, "user", [{ type: "compaction", auto: true }]),
        {
            ...msg(summaryId, "assistant", [{ type: "text", text: MARKER_SUMMARY_TEXT }]),
            info: { ...msg(summaryId, "assistant", []).info, summary: true, parentID: markerId },
        },
        ...coveredIds.map((id) =>
            msg(id, "user", [{ type: "text", text: `Covered old request ${id}` }]),
        ),
        msg(boundaryId, "assistant", [
            {
                type: "reasoning",
                text: "Boundary reasoning to remove",
                metadata: { anthropic: { signature: "old-signature" } },
            },
            // Blank text is also reduced away when the last tool is removed. A large
            // real input selects a full drop rather than a recent-call skeleton.
            { type: "text", text: " \n\t " },
            {
                type: "tool",
                tool: "read",
                callID: "covered-read",
                state: {
                    status: "completed",
                    input: { filePath: "covered-file-".repeat(200) },
                    output: "Covered tool result",
                    time: { start: 1, end: 2 },
                },
            },
        ]),
        msg("msg-survivor", "assistant", [{ type: "text", text: survivorText }]),
        msg("msg-live-tail", "user", [{ type: "text", text: liveTailText }]),
        ...(!boundaryAbsent
            ? [
                  {
                      ...msg("msg-live-tool", "assistant", [
                          {
                              type: "reasoning",
                              text: "Active tail reasoning",
                              metadata: { anthropic: { signature: "active-signature" } },
                          },
                          {
                              type: "tool",
                              tool: "read",
                              callID: "live-read",
                              state: {
                                  status: "completed",
                                  input: {},
                                  output: tailOutput,
                                  time: { start: 3, end: 4 },
                              },
                          },
                      ]),
                      // A heavy step: below the 75% cap the bounded hold keeps the
                      // turn, so the signed fit owns the over-window pass at 35%.
                      info: {
                          ...msg("msg-live-tool", "assistant", []).info,
                          finish: "tool-calls",
                          tokens: { input: 0, output: 1_600, reasoning: 1_600 },
                      },
                  },
              ]
            : []),
    ];
    const db = openDatabase(`${root.dir}/context.db`)!;
    const observations: TrimObservation[] = [];
    const originalInject = injection.injectM0M1;
    const spy = spyOn(injection, "injectM0M1").mockImplementation((options) => {
        const liveIds = options.messages?.map((row) => row.info.id);
        const coveredPlaceholders =
            options.messages
                ?.filter((row) => coveredIds.includes(row.info.id ?? ""))
                .flatMap((row) =>
                    row.parts.map((part) =>
                        typeof part === "object" &&
                        part !== null &&
                        "text" in part &&
                        typeof part.text === "string"
                            ? part.text
                            : "",
                    ),
                ) ?? [];
        const result = originalInject(options);
        if (liveIds)
            observations.push({
                boundary: result.preparedTrimBoundaryId,
                status: result.prefixTrimStatus,
                sourceIds: options.prefixTrimSourceOrder?.messageIds,
                liveIds,
                coveredPlaceholders,
            });
        return result;
    });
    const logs = spyOn(logger, "sessionLog");
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T15:53:50Z"));
    try {
        // A private host store prevents both marker reconciliation and raw-history
        // reads from falling through to a developer's real OpenCode sessions.
        mkdirSync(join(root.dir, "opencode"), { recursive: true });
        const host = new Database(join(root.dir, "opencode", "opencode.db"));
        try {
            host.exec(
                "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
            );
            for (const [index, row] of source().entries()) {
                host.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                    row.info.id!,
                    sessionId,
                    index,
                    index,
                    JSON.stringify(row.info),
                );
                for (const [partIndex, part] of row.parts.entries()) {
                    host.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
                        `${row.info.id}-p${partIndex}`,
                        row.info.id!,
                        sessionId,
                        index,
                        index,
                        JSON.stringify(part),
                    );
                }
            }
        } finally {
            host.close();
        }
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
        recordDetectedContextLimit(db, sessionId, 16_000, `${model.providerID}/${model.modelID}`);
        updateSessionMeta(db, sessionId, {
            systemPromptTokens: 100,
            systemPromptHash: "motor-system",
        });
        recordToolDefinition(model.providerID, model.modelID, undefined, "read", "Read a file", {
            type: "object",
        });
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: markerId,
            summaryMessageId: summaryId,
            compactionPartId: `${markerId}-p0`,
            summaryPartId: `${summaryId}-p0`,
            boundaryOrdinal: 1,
            targetEndMessageId: markerId,
        });
        resolveCtxReduceAvailabilityFromMessages(sessionId, source() as never);
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: markerId,
                endMessageId: markerId,
                title: "Old marker",
                content: "History behind the old OpenCode marker.",
            },
        ]);
        const historyRefresh = new Set<string>();
        const pendingMaterialization = new Set<string>();
        const deferredHistory = new Set<string>();
        const deferredMaterialization = new Set<string>();
        let decision: "execute" | "defer" = "defer";
        const usage = new Map([
            [
                sessionId,
                {
                    usage: { percentage: 35, inputTokens: 5_600 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                },
            ],
        ]);
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision },
            contextUsageMap: usage,
            liveModelBySession: new Map([[sessionId, model]]),
            historyRefreshSessions: historyRefresh,
            pendingMaterializationSessions: pendingMaterialization,
            deferredHistoryRefreshSessions: deferredHistory,
            deferredMaterializationSessions: deferredMaterialization,
            lastHeuristicsTurnId: new Map(),
            directory: root.dir,
            sessionDirectoryBySession: new Map([[sessionId, root.dir]]),
            protectedTokens: 0,
            clearReasoningAge: 0,
            historianRunnable: false,
        });
        await transform(
            {},
            { messages: source().filter((row) => row.info.id !== "msg-live-tool") },
        );
        if (!boundaryAbsent) await transform({}, { messages: source() });
        const tags = getTagsBySession(db, sessionId).filter(
            (tag) =>
                coveredIds.some((id) => tag.messageId.startsWith(`${id}:`)) ||
                (tag.type === "tool" && tag.messageId === "covered-read"),
        );
        expect(tags).toHaveLength(51);
        for (const tag of tags) queuePendingOp(db, sessionId, tag.tagNumber, "drop");
        appendCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 3,
                endMessage: 53,
                startMessageId: coveredIds[0]!,
                endMessageId: boundaryId,
                title: "Covered requests",
                content: "New history covers all fifty old users and the boundary assistant.",
            },
        ]);
        // Published history waits for a rebuilding pass. The over-window retry
        // supplies its own materialization request; the absent-boundary control
        // instead exercises an explicit rebuild without an active tool loop.
        deferredHistory.add(sessionId);
        deferredMaterialization.add(sessionId);
        if (boundaryAbsent) pendingMaterialization.add(sessionId);
        decision = "execute";
        const at = Date.parse("2026-10-14T15:54:02Z");
        clock.mockReturnValue(at);
        usage.set(sessionId, {
            usage: { percentage: 35, inputTokens: 5_600 },
            updatedAt: at,
            hasUsageTokens: true,
        });
        observations.length = 0;
        logs.mockClear();
        tailOutput = "RECLAIMABLE live tool result words ".repeat(30_000);
        let refusedTrim: TrimObservation | undefined;
        if (!boundaryAbsent) {
            // A fit rebuild cannot yield the protected live output below 95%.
            // Once real usage reaches that wall, recovery may reclaim it.
            await expect(transform({}, { messages: source() })).rejects.toMatchObject({
                name: "EmergencyFailClosedError",
            });
            refusedTrim = observations.at(-1);
            expect(
                getTagsBySession(db, sessionId).find((tag) => tag.messageId === "live-read")
                    ?.status,
            ).toBe("active");
            usage.set(sessionId, {
                usage: { percentage: 96, inputTokens: 15_360 },
                updatedAt: at,
                hasUsageTokens: true,
            });
        }
        const rebuild = source().filter((row) => !boundaryAbsent || row.info.id !== boundaryId);
        await transform({}, { messages: rebuild });
        const rebuildTrim = observations.at(-1)!;
        const rebuildLogs = logs.mock.calls.map((call) => call.slice(1).join(" ")).join("\n");
        const remainingCauses = {
            history: historyRefresh.has(sessionId),
            pending: pendingMaterialization.has(sessionId),

            pendingDrops: getPendingOps(db, sessionId).length,
        };
        decision = "defer";
        clock.mockReturnValue(at + 5_000);
        usage.set(sessionId, {
            usage: { percentage: 20, inputTokens: 3_200 },
            updatedAt: at + 5_000,
            hasUsageTokens: true,
        });
        observations.length = 0;
        logs.mockClear();
        const replay = source().filter((row) => !boundaryAbsent || row.info.id !== boundaryId);
        await transform({}, { messages: replay });
        const replayTrim = observations.at(-1)!;
        const replayLogs = logs.mock.calls.map((call) => call.slice(1).join(" ")).join("\n");
        return {
            rebuild,
            replay,
            refusedTrim,
            rebuildTrim,
            replayTrim,
            rebuildLogs,
            replayLogs,
            remainingCauses,
            coveredIds,
            boundaryId,
        };
    } finally {
        clock.mockRestore();
        logs.mockRestore();
        spy.mockRestore();
        injection.clearInjectionCache(sessionId);
        clearCtxReduceAvailability(sessionId);
        closeReadOnlySessionDb();
        closeDatabase();
        __resetToolDefinitionMeasurements();
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
        root.cleanup();
    }
}

it("MOTOR: rebuild and five-second defer have byte-identical Anthropic history", async () => {
    const run = await runRebuildThenDefer();
    const rebuild = await providerWire(run.rebuild);
    const replay = await providerWire(run.replay);
    // Compare the provider's UTF-8 JSON, not host arrays or a hand-written role
    // grouper. The unchanged tail lets the whole request serve as the prefix oracle.
    expect(Buffer.from(JSON.stringify(replay.pinned))).toEqual(
        Buffer.from(JSON.stringify(rebuild.pinned)),
    );
    expect(Buffer.from(JSON.stringify(rebuild.installed))).toEqual(
        Buffer.from(JSON.stringify(rebuild.pinned)),
    );
    expect(Buffer.from(JSON.stringify(replay.installed))).toEqual(
        Buffer.from(JSON.stringify(replay.pinned)),
    );
    expect(run.rebuildTrim.boundary).toBe(run.boundaryId);
    expect(run.replayTrim.boundary).toBe(run.rebuildTrim.boundary);
    expect(run.rebuildTrim.status).toBe("applied");
    expect(run.rebuildTrim.sourceIds).toContain(run.boundaryId);
    expect(run.rebuildTrim.liveIds).not.toContain(run.boundaryId);
    // The fit attempt refuses the oversized protected output, but applies drops
    // for messages covered by the new history summary. Real-pressure recovery
    // then replays those drops behind the history boundary.
    expect(run.refusedTrim!.coveredPlaceholders).toHaveLength(50);
    expect(run.rebuildTrim.coveredPlaceholders).toHaveLength(0);
    expect(
        run.refusedTrim!.coveredPlaceholders.every((text) => /^\[dropped §\d+§\]$/.test(text)),
    ).toBe(true);
    expect(run.remainingCauses).toEqual({
        history: false,
        pending: false,

        pendingDrops: 0,
    });
    expect(JSON.stringify(rebuild.pinned)).toContain("New history covers all fifty old users");
    expect(run.rebuildLogs).toContain("origin=fit_retry");
    expect(run.replayLogs).toMatch(/transform scheduler: .*decision=defer/);
    expect(run.replayLogs).not.toContain("heuristics WILL RUN");
    expect(run.rebuild.filter((row) => run.coveredIds.includes(row.info.id ?? ""))).toHaveLength(0);
    expect(run.rebuild.filter((row) => row.info.id === "msg-survivor")).toHaveLength(1);
    const assistant = rebuild.pinned.messages.find((message) => message.role === "assistant")!;
    expect(
        assistant.content.filter((part) => part.text?.includes(MARKER_SUMMARY_TEXT)),
    ).toHaveLength(1);
    expect(assistant.content.filter((part) => part.text?.includes(survivorText))).toHaveLength(1);
    expect(JSON.stringify(rebuild.pinned).split(survivorText)).toHaveLength(2);
    for (const placeholder of run.refusedTrim!.coveredPlaceholders) {
        expect(JSON.stringify(rebuild.pinned)).not.toContain(placeholder);
    }
    expect(
        rebuild.pinned.messages.some((message) =>
            message.content.some((part) => part.text?.includes(liveTailText)),
        ),
    ).toBe(true);
}, 30_000);

it("MOTOR: rebuild reanchors an invisible boundary by persisted order and replays identical wire bytes", async () => {
    const run = await runRebuildThenDefer(true);
    expect(run.rebuildTrim.boundary).toBe(run.boundaryId);
    expect(run.rebuildTrim.sourceIds).not.toContain(run.boundaryId);
    // The host omitted this boundary from the array, but its store still holds
    // the row. That stored position proves the same cut on rebuild and replay.
    expect(run.rebuildTrim.status).toBe("applied");
    expect(run.rebuild.filter((row) => run.coveredIds.includes(row.info.id ?? ""))).toHaveLength(0);
    const rebuild = await providerWire(run.rebuild);
    const replay = await providerWire(run.replay);
    expect(Buffer.from(JSON.stringify(replay.pinned))).toEqual(
        Buffer.from(JSON.stringify(rebuild.pinned)),
    );
}, 30_000);
