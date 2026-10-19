import { afterEach, expect, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { runMigrations } from "../src/features/magic-context/migrations";
import type { ContextDatabase } from "../src/features/magic-context/storage";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../src/features/magic-context/storage-meta";
import { recordDetectedContextLimit } from "../src/features/magic-context/storage-meta-persisted";
import { recordToolDefinition } from "../src/features/magic-context/tool-definition-tokens";
import { __test as decisions } from "../src/features/magic-context/transform-decision-log";
import { resetLkgSlotsForTest } from "../src/hooks/magic-context/lkg-slot";
import { opencode1ToModelMessages } from "../src/hooks/magic-context/opencode1-to-model-messages.fixture";
import { setRawMessageProvider } from "../src/hooks/magic-context/read-session-chunk";
import {
    createRustModeTransform,
    type RustModeModuleClient,
} from "../src/hooks/magic-context/rust-mode-transform";
import type { TransformDeps } from "../src/hooks/magic-context/transform";
import type { MessageLike } from "../src/hooks/magic-context/transform-operations";
import * as logger from "../src/shared/logger";
import { Database } from "../src/shared/sqlite";

export const route = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const cleanups: (() => void)[] = [];
if (process.env.MC_REVIEW_DEBUG)
    spyOn(logger, "sessionLog").mockImplementation((...args) => console.info(...args));
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    decisions.reset();
    resetLkgSlotsForTest();
});
export function scratch(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(path, { recursive: true, force: true }));
    return path;
}
export function database(path = ":memory:"): ContextDatabase {
    const db = new Database(path) as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    cleanups.push(() => db.close());
    return db;
}
export function user(sid: string, id: string): MessageLike {
    return {
        info: { id, sessionID: sid, role: "user", model: route },
        parts: [{ id: `${id}-text`, type: "text", text: `question ${id}` }],
    } as MessageLike;
}
export function tool(sid: string, id: string, name = "read"): MessageLike {
    return {
        info: {
            id,
            sessionID: sid,
            role: "assistant",
            finish: "tool-calls",
            providerID: route.providerID,
            modelID: route.modelID,
        },
        parts: [
            {
                id: `${id}-part`,
                type: "tool",
                tool: name,
                callID: `${id}-call`,
                state: {
                    status: "completed",
                    input: { path: `${id}.txt` },
                    time: { start: 1, end: 2 },
                    output: name === "ctx_reduce" ? "8 tags stamped." : `output ${id}`,
                },
            },
        ],
    } as MessageLike;
}
export function thinking(id: string) {
    return {
        id,
        type: "reasoning",
        text: "checking the result",
        metadata: { anthropic: { signature: "review-signature" } },
    };
}
export async function providerBody(rows: unknown[]): Promise<string> {
    const bodies: string[] = [];
    const model = createAnthropic({
        apiKey: "review-only",
        fetch: Object.assign(
            async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                bodies.push(String(init?.body));
                throw new Error("review capture: network forbidden");
            },
            { preconnect: () => {} },
        ),
    }).messages(route.modelID);
    const prompt = await opencode1ToModelMessages(rows, {
        providerID: route.providerID,
        id: route.modelID,
        api: { npm: "@ai-sdk/anthropic", id: route.modelID },
    });
    await model
        .doGenerate({
            prompt: prompt as Parameters<typeof model.doGenerate>[0]["prompt"],
            maxOutputTokens: 1,
        })
        .then(
            () => {},
            () => {},
        );
    expect(bodies).toHaveLength(1);
    return bodies.join("");
}
export function blocks(body: string): string[] {
    return JSON.parse(body).messages.flatMap((m: { role: string; content: unknown[] }) =>
        m.content.map((block) => JSON.stringify({ role: m.role, block })),
    );
}
export function probe(binary: string, directory: string, body: unknown): Record<string, unknown> {
    const result = spawnSync(binary, [directory], {
        input: JSON.stringify(body),
        encoding: "utf8",
        timeout: 120_000,
    });
    if (result.status !== 0)
        throw new Error(`Rust review probe failed: ${result.stderr} ${result.error ?? ""}`);
    return JSON.parse(result.stdout);
}
export async function hostFixture(
    sid: string,
    binary: string,
    factory = createRustModeTransform,
    baselineRoot?: string,
    midTurn = false,
    persistent: { directory: string; dbPath: string } | undefined = undefined,
) {
    const directory = persistent?.directory ?? scratch("independent-module-");
    const db = database(persistent?.dbPath);
    let input: MessageLike[] = [];
    const provider = {
        readMessages: () =>
            input.map((m, i) => ({
                id: String(m.info.id),
                timeCreated: i + 1,
                ordinal: i + 1,
                role: String(m.info.role),
                parts: m.parts,
                contributesOrdinal: true,
                hasValidInfo: true,
            })),
        readMessageOrdinalPage: (
            after: { timeCreated: number; id: string } | null,
            limit: number,
        ) =>
            provider
                .readMessages()
                .filter(
                    (r) =>
                        !after ||
                        r.timeCreated > after.timeCreated ||
                        (r.timeCreated === after.timeCreated && r.id > after.id),
                )
                .slice(0, limit),
        getStoredMessageCount: () => input.length,
        readMessagePartsById: (id: string) => {
            const index = input.findIndex((m) => m.info.id === id);
            const row = input[index];
            return row
                ? {
                      ...row.info,
                      id,
                      role: String(row.info.role),
                      parts: row.parts,
                      createdAt: index + 1,
                  }
                : null;
        },
    };
    cleanups.push(setRawMessageProvider(sid, provider));
    if (baselineRoot) {
        const baselineRaw = await import(
            `${baselineRoot}/packages/plugin/src/hooks/magic-context/read-session-chunk.ts`
        );
        cleanups.push(baselineRaw.setRawMessageProvider(sid, provider));
    }
    let response: Record<string, unknown> = {};
    let request: Record<string, unknown> = {};
    let mutate: (value: Record<string, unknown>) => void = () => {};
    const client: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method !== "transform") return { ok: true };
            request = body as Record<string, unknown>;
            response = probe(binary, directory, {
                ...(body as Record<string, unknown>),
                ...(midTurn ? { mid_turn: true } : {}),
                tool_present: true,
                auto_search_enabled: false,
                cache_ttl: "never",
            });
            mutate(response);
            return response;
        },
    };
    const deps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory,
        projectPath: "git:independent-review",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[sid, route]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: client,
        historianRunner: "broca",
        getModelKey: () => `${route.providerID}/${route.modelID}`,
    } as TransformDeps;
    const host = factory(deps, {
        moduleClient: client,
        modulePageMaxBytes: 512 * 1024,
        scheduleLkgCapture: (capture) => capture(),
    });
    cleanups.push(() => host.dispose());
    getOrCreateSessionMeta(db, sid);
    recordToolDefinition(route.providerID, route.modelID, undefined, "read", "read fixture", {
        type: "object",
    });
    recordToolDefinition(
        route.providerID,
        route.modelID,
        undefined,
        "ctx_reduce",
        "reduce fixture",
        { type: "object" },
    );
    recordDetectedContextLimit(db, sid, 200_000, `${route.providerID}/${route.modelID}`);
    updateSessionMeta(db, sid, { systemPromptTokens: 100 });
    return {
        host,
        db,
        sid,
        deps,
        directory,
        get request() {
            return request;
        },
        get response() {
            return response;
        },
        set mutate(fn: typeof mutate) {
            mutate = fn;
        },
        async run(rows: MessageLike[]) {
            input = structuredClone(rows).map((m) => ({
                ...m,
                info: { ...m.info, sessionID: sid },
            }));
            host.invalidateWireState(sid);
            const output = { messages: structuredClone(input) as unknown[] };
            await host.run(sid, input, output, getOrCreateSessionMeta(db, sid));
            return output.messages as MessageLike[];
        },
    };
}
