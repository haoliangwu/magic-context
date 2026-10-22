/// <reference types="bun-types" />
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageExecutable } from "../../../../e2e-tests/src/rust-runner/executable-staging";
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
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { recordToolDefinition } from "../../features/magic-context/tool-definition-tokens";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { bindV2SystemPromptResponse } from "../../v2/hooks/system-prompt-response";
import type { StoreRow } from "../../v2/store-reader";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { requestPendingMaterialization } from "./pending-materialization";
import { setRawMessageProvider } from "./read-session-chunk";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform, type TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

const route = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const modelKey = `${route.providerID}/${route.modelID}`;
const fixtureBinary = process.env.MC_SYSTEM_DELIVERY_FIXTURE_BINARY;
const rustIt = fixtureBinary ? it : it.skip;
const rustDescribe = fixtureBinary ? describe : describe.skip;
let bridge: ChildProcessWithoutNullStreams | undefined;
let waiting:
    | { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    | undefined;
let output = "";
let sequence = 0;
const root = resolve(import.meta.dir, "../../../../..");

if (!fixtureBinary)
    console.info(
        "Skipping Rust-backed system-delivery cases: set MC_SYSTEM_DELIVERY_FIXTURE_BINARY to a prebuilt mc-module test binary.",
    );

beforeAll(async () => {
    if (!fixtureBinary) return;
    let ready: () => void = () => {};
    let failed: (error: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
    });
    const stagedFixture = stageExecutable(
        fixtureBinary,
        "mc-module-system-delivery-fixture",
        "com.cortexkit.magic-context.system-delivery-fixture",
    );
    const child = spawn(
        stagedFixture,
        ["tests::system_delivery_adapter_fixture", "--exact", "--ignored", "--nocapture"],
        { cwd: root, windowsHide: true },
    );
    bridge = child;
    let lines = "";
    child.stdout.on("data", (chunk) => {
        lines += String(chunk);
        output = (output + String(chunk)).slice(-2000);
        let end: number;
        while ((end = lines.indexOf("\n")) !== -1) {
            const line = lines.slice(0, end);
            lines = lines.slice(end + 1);
            if (line === "running 1 test") ready();
            if (line.startsWith("SYSTEM_DELIVERY_RESPONSE ")) {
                const current = waiting;
                waiting = undefined;
                current?.resolve(JSON.parse(line.slice("SYSTEM_DELIVERY_RESPONSE ".length)));
            }
        }
    });
    child.stderr.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-2000);
    });
    child.on("exit", (code) => {
        const error = new Error(`module bridge exited ${code}: ${output}`);
        waiting?.reject(error);
        failed(error);
    });
    await started;
}, 120_000);
afterAll(async () => {
    const runningBridge = bridge;
    if (!runningBridge || runningBridge.exitCode !== null) return;
    runningBridge.stdin.end();
    await new Promise<void>((done) => runningBridge.on("exit", () => done()));
});

function rpc(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const runningBridge = bridge;
    if (!runningBridge || runningBridge.exitCode !== null) return Promise.reject(new Error(output));
    return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        runningBridge.stdin.write(`${JSON.stringify(body)}\n`);
    });
}

async function fixture(mode: "rust" | "ts" = "rust", generation: "v1" | "v2" = "v1") {
    const sessionId = `system-delivery-${++sequence}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "system-delivery-"));
    const project = join(home, "project");
    mkdirSync(project);
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    recordDetectedContextLimit(db, sessionId, 200_000, modelKey);
    recordToolDefinition(route.providerID, route.modelID, undefined, "read", "Read", {
        type: "object",
    });
    const user = (id: string, text: string): MessageLike => ({
        info: { id, sessionID: sessionId, role: "user", model: route },
        parts: [{ type: "text", text }],
    });
    const source: MessageLike[] = [
        user("old-prompt", "earlier task"),
        {
            info: {
                id: "old-answer",
                sessionID: sessionId,
                role: "assistant",
                providerID: route.providerID,
                modelID: route.modelID,
                finish: "stop",
            },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "read-old",
                    state: {
                        status: "completed",
                        input: { path: "old.ts" },
                        output: "historical answer to drop",
                    },
                },
            ],
        },
        user("prompt", "current task"),
    ];
    for (let i = 0; i < 12; i++)
        source.splice(source.length - 1, 0, {
            info: {
                id: `old-tool-${i}`,
                sessionID: sessionId,
                role: "assistant",
                providerID: route.providerID,
                modelID: route.modelID,
                finish: "stop",
            },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: `read-old-${i}`,
                    state: {
                        status: "completed",
                        input: { path: `old-${i}.ts` },
                        output: i >= 9 ? "earlier result ".repeat(8000) : "earlier result",
                    },
                },
            ],
        });
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () =>
            source.map((m, i) => ({
                id: m.info.id!,
                ordinal: i + 1,
                timeCreated: i + 1,
                createdAt: i + 1,
                role: m.info.role,
                parts: m.parts,
                contributesOrdinal: true,
                hasValidInfo: true,
            })),
        getStoredMessageCount: () => source.length,
        readMessagePartsById: (id) => {
            const m = source.find((m) => m.info.id === id)!;
            return { id, role: m.info.role, parts: m.parts, createdAt: source.indexOf(m) + 1 };
        },
    });
    if (mode === "rust")
        await rpc({
            method: "test.init",
            data_home: home,
            session_id: sessionId,
            project_root: project,
        });
    const requests: Record<string, unknown>[] = [];
    const responses: Record<string, unknown>[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            const wire = { ...body, method, project_root: project };
            if (method === "transform") requests.push(wire);
            const result = await rpc(wire);
            if (method === "transform") responses.push(result);
            return result;
        },
    };
    const deps: TransformDeps = {
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: new Map(),
        protectedTokens: 4000,
        clearReasoningAge: 50,
        keepReasoningTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: project,
        projectPath: project,
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[sessionId, route]]),
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        transformMode: mode === "rust" ? "rust" : "typescript",
        historianRunner: "broca",
        rustModeModuleClient: mode === "rust" ? moduleClient : undefined,
        historianRunnable: false,
        protectedTools: { read: 0 },
        client: {
            session: { get: async () => ({ data: { directory: project } }) },
        } as TransformDeps["client"],
    };
    registerSystemDateRefresh(deps.historyRefreshSessions);
    let messagesPrepared = false;
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        memoryEnabled: false,
        resolveModel: () => deps.liveModelBySession!.get(sessionId),
        historyRefreshSessions: deps.historyRefreshSessions,
        pendingMaterializationSessions: deps.pendingMaterializationSessions,
        systemPromptRefreshSessions: new Set(),
        lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
        consumeMessagesPrepared: () => messagesPrepared,
    });
    const transform = createRustModeTransform(deps, {
        moduleClient,
        scheduleLkgCapture: (capture) => capture(),
    });
    const tsTransform = mode === "ts" ? createTransform(deps) : undefined;
    let reply = 0;
    const responseRows: StoreRow<"assistant">[] = [];
    const serve = async (text = "base", order = "system-first", date = "2026-10-13") => {
        const responseId = `reply-${++reply}`;
        messagesPrepared = false;
        const activeModel = deps.liveModelBySession!.get(sessionId)!;
        const key = `${activeModel.providerID}/${activeModel.modelID}`;
        if (generation === "v2")
            beginV2LkgRequest(sessionId, key, `reply-${reply - 1}`, responseRows.length);
        else noteLkgProviderResponse({ sessionId, responseId, modelKey: key, inputTokens: 0 });
        const input = structuredClone(source);
        const output = { messages: structuredClone(input) as unknown[] };
        bindSystemDateRequestIdentity(output, output);
        const outputSystem = { system: [`${text}\n<plugin-env>\n  Date: ${date}\n</plugin-env>`] };
        const responseCount = responses.length;
        if (order === "system-first")
            await system.handler(
                { sessionID: sessionId, dateRefreshRequest: output, model: activeModel },
                outputSystem,
            );
        if (tsTransform) await tsTransform({}, output as never);
        else await transform.run(sessionId, input, output, getOrCreateSessionMeta(db, sessionId));
        if (mode === "rust") expect(responses.length).toBeGreaterThan(responseCount);
        messagesPrepared = true;
        if (order === "messages-first")
            await system.handler(
                { sessionID: sessionId, dateRefreshRequest: output, model: activeModel },
                outputSystem,
            );
        return {
            messages: output.messages,
            system: outputSystem.system,
            response: responses.at(-1)!,
            request: requests.at(-1)!,
            accept: (finish = "tool-calls") => {
                const createdAt = Date.now() + 1;
                if (generation === "v2") {
                    responseRows.push({
                        id: responseId,
                        session_id: sessionId,
                        type: "assistant",
                        seq: responseRows.length + 1,
                        data: {
                            model: { providerID: activeModel.providerID, id: activeModel.modelID },
                            time: { created: createdAt },
                            finish,
                        },
                    });
                    bindV2SystemPromptResponse(sessionId, {
                        assistantSince: (_session, after) =>
                            responseRows.filter((row) => row.seq > after),
                    });
                }
                noteLkgProviderResponse({
                    sessionId,
                    responseId,
                    modelKey: key,
                    inputTokens: 1000,
                    completedAt: Date.now(),
                    finish,
                    v2: generation === "v2",
                    createdAt,
                });
            },
        };
    };
    // A heavy signed step (1,600 reasoning tokens): the bounded hold keeps the
    // turn's prefix while usage stays below the cap (65% + 10).
    const hold = () =>
        source.push({
            info: {
                id: "thinking",
                sessionID: sessionId,
                role: "assistant",
                providerID: route.providerID,
                modelID: route.modelID,
                finish: "tool-calls",
                tokens: { input: 0, output: 1_600, reasoning: 1_600 },
            },
            parts: [
                {
                    type: "reasoning",
                    text: "signed plan",
                    metadata: { anthropic: { signature: "signed-plan" } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: "read-current",
                    state: {
                        status: "completed",
                        input: { path: "current.ts" },
                        output: "current result ".repeat(8000),
                    },
                },
            ],
        });
    return {
        sessionId,
        db,
        deps,
        source,
        user,
        serve,
        hold,
        rpc: (method: string, extra: Record<string, unknown> = {}) =>
            rpc({
                ...extra,
                v: 1,
                method,
                session_id: sessionId,
                project_root: project,
                command_id: `test-${++reply}`,
            }),
        close: () => {
            unregister();
            clearLkgMeasuredRequest(sessionId);
            closeQuietly(db);
            rmSync(home, { recursive: true, force: true });
        },
    };
}

const head = (messages: unknown[]) => JSON.stringify(messages.slice(0, 2));

rustDescribe("accepted external system delivery through Rust mode", () => {
    it("already_delivered_system_change_does_not_hard_after_signed_head_hold", async () => {
        const f = await fixture();
        try {
            (await f.serve()).accept("stop");
            f.hold();
            const baseline = await f.serve();
            baseline.accept();
            await f.rpc("test.queue");
            const held = await f.serve("genuine new instruction");
            expect(head(held.messages)).toBe(head(baseline.messages));
            expect(held.response.prefix_bust_permitted).toBe(false);
            expect((await f.rpc("test.status")).pending).toBe(1);
            const hash = getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash;
            expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).not.toBe(hash);
            held.accept();
            const next = await f.serve("genuine new instruction");
            expect(
                (next.request.pass_inputs as Record<string, unknown>).adopted_system_prompt_hash,
            ).toBe(hash);
            expect((await f.rpc("test.status")).system_hash).toBe(hash);
            expect(next.response.prefix_bust_permitted).toBe(false);
            expect(head(next.messages)).toBe(head(baseline.messages));
            next.accept();
            f.source.push(f.user("wake", "continue"));
            const wake = await f.serve("genuine new instruction");
            expect(wake.response.decision).not.toBe("HARD");
            expect(wake.response.materialize_reason).not.toBe("epoch_change");
            expect(wake.response.identity_delta ?? []).not.toEqual(["base"]);
            expect(wake.response.prefix_bust_permitted).toBe(false);
            expect(head(wake.messages)).toBe(head(baseline.messages));
            expect(JSON.stringify(wake.messages)).not.toContain("[dropped");
            expect((await f.rpc("test.status")).pending).toBe(1);
            f.source.push(f.user("flush-command", "flush queued work"));
            expect((await f.rpc("session.flush")).armed).toBe(true);
            const flushAttempt = await f.serve("genuine new instruction");
            console.log(
                "RUST_FLUSH_OBSERVATION",
                JSON.stringify({
                    response: {
                        action: flushAttempt.response.action,
                        prefix_bust_permitted: flushAttempt.response.prefix_bust_permitted,
                    },
                    status: await f.rpc("test.status"),
                }),
            );
            const flushed = await f.serve("independent content rebuild");
            expect(flushed.response.prefix_bust_permitted).toBe(true);
            expect((await f.rpc("test.status")).pending).toBe(0);
            expect(JSON.stringify(flushed.messages)).toContain("[dropped");
            const after = await f.serve("independent content rebuild");
            expect(after.messages).toEqual(flushed.messages);
        } finally {
            f.close();
        }
    }, 120_000);
});

for (const mode of ["rust", "ts"] as const) {
    const test = mode === "rust" ? rustIt : it;
    for (const finish of ["aborted", "error", "unaccepted"]) {
        test(`${mode}: ${finish} system delivery is not acknowledged`, async () => {
            const f = await fixture(mode);
            try {
                (await f.serve()).accept("stop");
                f.hold();
                (await f.serve()).accept();
                const before = getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash;
                const held = await f.serve("changed instruction");
                if (finish !== "unaccepted") held.accept(finish);
                expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(before);
                f.source.push(f.user("wake", "continue"));
                const wake = await f.serve("changed instruction");
                if (mode === "rust") expect(wake.response.decision).toBe("HARD");
                else
                    expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).not.toBe(
                        before,
                    );
            } finally {
                f.close();
            }
        }, 120_000);
    }
    for (const order of ["system-first", "messages-first"]) {
        test(`${mode}: plugin_env_date_only_change_stays_frozen_through_signed_head_hold (${order})`, async () => {
            const f = await fixture(mode);
            try {
                (await f.serve()).accept("stop");
                f.hold();
                const before = await f.serve("base", order);
                before.accept();
                const oldHash = getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash;
                const after = await f.serve("base", order, "2026-10-14");
                expect(after.system).toEqual(before.system);
                expect(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash).toBe(oldHash);
                expect(head(after.messages)).toBe(head(before.messages));
                if (mode === "rust") expect(after.response.prefix_bust_permitted).toBe(false);
            } finally {
                f.close();
            }
        }, 120_000);
    }
    test(`${mode}: a real unheld system-first edit folds on its first request`, async () => {
        const f = await fixture(mode);
        try {
            const before = await f.serve();
            before.accept("stop");
            if (mode === "rust") await f.rpc("test.queue");
            const changed = await f.serve("changed instruction");
            if (mode === "rust") {
                expect(changed.response.decision).toBe("HARD");
                expect(changed.response.prefix_bust_permitted).toBe(true);
                expect((await f.rpc("test.status")).pending).toBe(0);
            } else
                expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(
                    getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash,
                );
        } finally {
            f.close();
        }
    }, 120_000);
}

it("TypeScript: already_delivered_system_change_does_not_hard_after_signed_head_hold", async () => {
    const f = await fixture("ts");
    try {
        (await f.serve()).accept("stop");
        f.hold();
        const before = await f.serve();
        before.accept();
        const target = getTagsBySession(f.db, f.sessionId).find(
            (tag) => tag.type === "tool" && tag.messageId === "read-old",
        )!;
        expect(target).toBeDefined();
        queuePendingOp(f.db, f.sessionId, target.tagNumber, "drop");
        const held = await f.serve("changed instruction");
        expect(head(held.messages)).toBe(head(before.messages));
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        held.accept();
        const next = await f.serve("changed instruction");
        next.accept();
        expect(head(next.messages)).toBe(head(before.messages));
        f.source.push(f.user("wake", "continue"));
        const wake = await f.serve("changed instruction");
        expect(head(wake.messages)).toBe(head(before.messages));
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        expect(f.deps.deferredMaterializationSessions!.has(f.sessionId)).toBe(true);
        requestPendingMaterialization(
            f.deps.pendingMaterializationSessions,
            f.sessionId,
            "user_flush",
        );
        await f.serve("changed instruction");
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
        const flushed = await f.serve("changed instruction");
        const after = await f.serve("changed instruction");
        expect(after.messages).toEqual(flushed.messages);
    } finally {
        f.close();
    }
}, 120_000);

for (const input of ["model", "renderer", "workspace"]) {
    rustIt(
        `rust: delivered system identity cannot waive a simultaneous ${input} change`,
        async () => {
            const f = await fixture();
            try {
                (await f.serve()).accept("stop");
                // Give the stored head a previous model, renderer or workspace input.
                // Receipt of new system instructions must not hide that difference:
                // the unchanged-other-inputs comparison must still require rebuilding.
                await f.rpc("test.other_identity", { input });
                f.hold();
                const held = await f.serve("changed instruction");
                held.accept();
                const next = await f.serve("changed instruction");
                expect(
                    (next.request.pass_inputs as Record<string, unknown>)
                        .adopted_system_prompt_hash,
                ).toBe(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash);
                next.accept();
                f.source.push(f.user("wake", "continue"));
                const wake = await f.serve("changed instruction");
                expect(wake.response.decision).toBe("HARD");
                expect(wake.response.materialize_reason).toBe("epoch_change");
            } finally {
                f.close();
            }
        },
        120_000,
    );
}

for (const [input, patch] of [
    ["model", { cachedM0ModelKey: "anthropic/claude-opus-5-4" }],
    ["renderer", { cachedM0UpgradeState: "previous-renderer" }],
] as const) {
    it(`TypeScript: delivered system identity cannot waive a simultaneous ${input} change`, async () => {
        const f = await fixture("ts");
        try {
            (await f.serve()).accept("stop");
            f.hold();
            (await f.serve()).accept();
            updateSessionMeta(f.db, f.sessionId, patch);
            const held = await f.serve("changed instruction");
            held.accept();
            expect(
                getOrCreateSessionMeta(f.db, f.sessionId)[
                    input === "model" ? "cachedM0ModelKey" : "cachedM0UpgradeState"
                ],
            ).toBe(Object.values(patch)[0]);
            f.source.push(f.user("wake", "continue"));
            await f.serve("changed instruction");
            expect(
                getOrCreateSessionMeta(f.db, f.sessionId)[
                    input === "model" ? "cachedM0ModelKey" : "cachedM0UpgradeState"
                ],
            ).not.toBe(Object.values(patch)[0]);
        } finally {
            f.close();
        }
    }, 120_000);
}

for (const mode of ["rust", "ts"] as const) {
    const test = mode === "rust" ? rustIt : it;
    test(`${mode}: OpenCode2 already_delivered_system_change_does_not_hard_after_signed_head_hold`, async () => {
        const f = await fixture(mode, "v2");
        try {
            (await f.serve()).accept("stop");
            f.hold();
            const before = await f.serve();
            before.accept();
            if (mode === "rust") await f.rpc("test.queue");
            else {
                const target = getTagsBySession(f.db, f.sessionId).find(
                    (tag) => tag.type === "tool" && tag.messageId === "read-old",
                );
                if (!target) throw new Error("missing drop target");
                queuePendingOp(f.db, f.sessionId, target.tagNumber, "drop");
            }
            const held = await f.serve("changed instruction");
            held.accept();
            const next = await f.serve("changed instruction");
            next.accept();
            expect(head(next.messages)).toBe(head(before.messages));
            if (mode === "rust")
                expect(
                    (next.request.pass_inputs as Record<string, unknown>)
                        .adopted_system_prompt_hash,
                ).toBe(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash);
            f.source.push(f.user("wake", "continue"));
            const wake = await f.serve("changed instruction");
            expect(head(wake.messages)).toBe(head(before.messages));
            if (mode === "rust") {
                expect(wake.response.action).toBe("SOFT+");
                expect(wake.response.prefix_bust_permitted).toBe(false);
                expect((await f.rpc("test.status")).pending).toBe(1);
            } else expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            await f.serve("independent content rebuild");
            if (mode === "rust") expect((await f.rpc("test.status")).pending).toBe(0);
            else expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
        } finally {
            f.close();
        }
    }, 120_000);

    test(`${mode}: unheld provider-byte differential`, async () => {
        const f = await fixture(mode);
        try {
            const bodies: unknown[] = [];
            for (const text of [
                "base",
                "base",
                "independent unheld edit",
                "independent unheld edit",
            ]) {
                const served = await f.serve(text);
                served.accept("stop");
                bodies.push({
                    system: served.system,
                    messages: (served.messages as MessageLike[]).map((m) => ({
                        role: m.info.role,
                        parts: m.parts.map((part) => {
                            const p = part as Record<string, unknown>;
                            return {
                                type: p.type,
                                text: p.text,
                                tool: p.tool,
                                callID: p.callID,
                                state: p.state,
                                metadata: p.metadata,
                            };
                        }),
                    })),
                });
            }
            console.log(
                `UNHELD_PROVIDER_SHA ${mode} ${createHash("sha256").update(JSON.stringify(bodies)).digest("hex")}`,
            );
            expect(bodies).toHaveLength(4);
        } finally {
            f.close();
        }
    }, 120_000);
}

for (const mode of ["rust", "ts"] as const) {
    const test = mode === "rust" ? rustIt : it;
    test(`${mode}: aborted messages-first delivery is not acknowledged`, async () => {
        const f = await fixture(mode);
        try {
            (await f.serve()).accept("stop");
            f.hold();
            (await f.serve()).accept();
            const before = getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash;
            const held = await f.serve("changed instruction", "messages-first");
            held.accept("aborted");
            expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(before);
            f.source.push(f.user("wake", "continue"));
            const wake = await f.serve("changed instruction");
            if (mode === "rust") expect(wake.response.action).toBe("HARD");
            else
                expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).not.toBe(
                    before,
                );
        } finally {
            f.close();
        }
    }, 120_000);
}
