/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { computeSyntheticCallId } from "../../plugin/src/hooks/magic-context/todo-view";
import { TestHarness } from '../src/harness';
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import type { MockUsage } from "../src/mock-provider/server";
import { openTestDb } from "../src/test-db";

type Todo = { content: string; status: string; priority: string };

type SessionMetaTodoRow = {
    last_todo_state: string | null;
    todo_synthetic_call_id: string | null;
    todo_synthetic_anchor_message_id: string | null;
    todo_synthetic_state_json: string | null;
    is_subagent: number | null;
};

type WireMessage = { role?: string; content?: unknown };

const LOW_USAGE: MockUsage = {
    input_tokens: 1_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1_000,
};

const HIGH_USAGE: MockUsage = {
    input_tokens: 75_000,
    output_tokens: 20,
    cache_creation_input_tokens: 75_000,
    cache_read_input_tokens: 0,
};

const STATE_X_TODOS: Todo[] = [
    { content: "Build feature", status: "in_progress", priority: "high" },
    { content: "Write tests", status: "pending", priority: "medium" },
];

const STATE_Y_TODOS: Todo[] = [
    { content: "Review cache safety", status: "in_progress", priority: "high" },
    { content: "Ship regression", status: "pending", priority: "low" },
];

const TERMINAL_TODOS: Todo[] = [
    { content: "Build feature", status: "completed", priority: "high" },
    { content: "Write tests", status: "cancelled", priority: "medium" },
];

let h: ScenarioHarness;

function normalizedJson(todos: Todo[]): string {
    return JSON.stringify(todos.map(({ content, status, priority }) => ({ content, status, priority })));
}

function isMagicContextRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

function findTodoToolName(body: Record<string, unknown>): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string" && /todo.*write|write.*todo/i.test(name)) {
            return name;
        }
    }
    return null;
}

function mainRequests(): Array<{ body: Record<string, unknown> }> {
    return h.mock.requests().filter((r) => isMagicContextRequest(r.body));
}

function emitTodoOnce(todos: Todo[], usage: MockUsage = LOW_USAGE): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !isMagicContextRequest(body)) return null;
        const toolName = findTodoToolName(body);
        if (!toolName) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_todo_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name: toolName,
                    input: { todos },
                },
            ],
            stop_reason: "tool_use",
            usage,
        };
    });
}

function setDefaultText(text: string, usage: MockUsage = LOW_USAGE): void {
    h.mock.setDefault({ text, usage });
}

function readTodoMeta(sessionId: string): SessionMetaTodoRow | null {
    return h
        .contextDb()
        .prepare(
            `SELECT last_todo_state, todo_synthetic_call_id, todo_synthetic_anchor_message_id,
                    todo_synthetic_state_json, is_subagent
               FROM session_meta
              WHERE session_id = ?`,
        )
        .get(sessionId) as SessionMetaTodoRow | null;
}

function contextDbPath(): string {
    return h.contextDbPath();
}

function updateTodoMeta(sessionId: string, sql: string): void {
    const db = openTestDb(contextDbPath());
    try {
        db.prepare(sql).run(sessionId);
    } finally {
        db.close();
    }
}

async function waitForLastTodoState(sessionId: string, stateJson: string): Promise<void> {
    await h.waitFor(() => readTodoMeta(sessionId)?.last_todo_state === stateJson, {
        // Wraps a full opencode-serve prompt round-trip: ~1s locally, 7-12s on
        // loaded CI runners — budget must absorb runner latency, not gate it.
        timeoutMs: 60_000,
        label: "last_todo_state captured",
    });
}

async function waitForHighPressure(sessionId: string): Promise<void> {
    await h.waitFor(
        () => {
            const row = h
                .contextDb()
                .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { last_context_percentage: number } | null;
            return (row?.last_context_percentage ?? 0) >= 65;
        },
        // Same prompt-round-trip dependency as above: 60s for CI runner latency.
        { timeoutMs: 60_000, label: "session crosses execute threshold" },
    );
}

async function captureTodoState(sessionId: string, todos: Todo[]): Promise<void> {
    h.mock.reset();
    emitTodoOnce(todos);
    setDefaultText("after todo", LOW_USAGE);
    await h.sendPrompt(sessionId, `write todos: ${todos.map((t) => t.content).join(", ")}`);
    await waitForLastTodoState(sessionId, normalizedJson(todos));
}

async function primeNextTurnAsCacheBust(sessionId: string): Promise<void> {
    h.mock.reset();
    setDefaultText("pressure", HIGH_USAGE);
    await h.sendPrompt(sessionId, "pressure turn to cross the execute threshold");
    await waitForHighPressure(sessionId);
}

async function sendAndCaptureMainRequest(sessionId: string, prompt: string): Promise<Record<string, unknown>> {
    h.mock.reset();
    setDefaultText("ok", LOW_USAGE);
    await h.sendPrompt(sessionId, prompt);
    const requests = mainRequests();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    return requests[0]!.body;
}

async function prepareCacheBustState(sessionId: string, todos: Todo[] = STATE_X_TODOS) {
    const stateJson = normalizedJson(todos);
    await captureTodoState(sessionId, todos);
    await primeNextTurnAsCacheBust(sessionId);
    const body = await sendAndCaptureMainRequest(sessionId, "cache-bust turn");
    const pair = findSyntheticPair(body, computeSyntheticCallId(stateJson));
    expect(pair).not.toBeNull();
    const meta = readTodoMeta(sessionId);
    expect(meta?.todo_synthetic_call_id).toBe(computeSyntheticCallId(stateJson));
    expect(meta?.todo_synthetic_state_json).toBe(stateJson);
    return { body, pair: pair!, stateJson, callId: computeSyntheticCallId(stateJson) };
}

function contentBlocks(content: unknown): unknown[] {
    return Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function findToolUseId(message: WireMessage, expectedCallId?: string): string | null {
    if (message.role !== "assistant") return null;
    for (const block of contentBlocks(message.content)) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; id?: unknown; name?: unknown };
        if (b.type !== "tool_use") continue;
        if (typeof b.name !== "string" || !["mcp_Todowrite", "todowrite", "_todowrite"].includes(b.name)) continue;
        if (typeof b.id !== "string") continue;
        if (expectedCallId && b.id !== expectedCallId) continue;
        return b.id;
    }
    return null;
}

function findSyntheticPair(
    body: Record<string, unknown>,
    expectedCallId?: string,
): { index: number; callId: string; bytes: string } | null {
    const messages = body.messages as WireMessage[] | undefined;
    if (!Array.isArray(messages)) return null;
    for (let i = 0; i < messages.length - 1; i += 1) {
        const callId = findToolUseId(messages[i]!, expectedCallId);
        if (!callId) continue;
        const toolResult = findToolResultBlock(messages[i + 1]!, callId);
        if (!toolResult) continue;
        const toolUse = contentBlocks(messages[i]!.content).find((block) => {
            if (!block || typeof block !== "object") return false;
            const b = block as { type?: unknown; id?: unknown };
            return b.type === "tool_use" && b.id === callId;
        });
        // Provider adapters may move the transport-only `cache_control` field based
        // on the request tail. Compare the logical synthetic tool-use/tool-result
        // blocks generated by Magic Context, not that cache annotation.
        const bytes = JSON.stringify([toolUse, toolResult], (key, value) =>
            key === "cache_control" ? undefined : value,
        );
        return { index: i, callId, bytes };
    }
    return null;
}

function findToolResultBlock(message: WireMessage, callId: string): unknown | null {
    if (message.role !== "user") return null;
    for (const block of contentBlocks(message.content)) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; tool_use_id?: unknown };
        if (b.type === "tool_result" && b.tool_use_id === callId) return block;
    }
    return null;
}

function syntheticPairBytes(body: Record<string, unknown>, callId: string): string {
    const pair = findSyntheticPair(body, callId);
    if (!pair) throw new Error(`synthetic pair missing for ${callId}`);
    return pair.bytes;
}

forEachHost(import.meta.url, "synthetic todowrite e2e", (host) => {
    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: 100_000,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                dreamer: { disable: true },
                // Pi only registers Magic Context's todowrite tool when it is enabled;
                // it is off by default. OpenCode ignores this setting.
                todowrite: { enabled: true },
            },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

    afterEach(() => {
        h.mock.reset();
    });
    if (host === "opencode2") {
        it("declares the GA host's missing native todo surface without fabricating state", async () => {
            const sessionId = await h.createSession();
            setDefaultText("no native todo tool", LOW_USAGE);
            await h.sendPrompt(sessionId, "inspect the available tools");
            const requests = mainRequests();
            expect(requests.length).toBeGreaterThan(0);
            const names = (requests.at(-1)!.body.tools as Array<{ name: string }>).map((tool) => tool.name);
            expect(names).toContain("ctx_note");
            expect(names.some((name) => /todo.*write|write.*todo/i.test(name))).toBe(false);
            expect(readTodoMeta(sessionId)?.last_todo_state).toBe("");
        });
        return;
    }
    it("captures todowrite args into last_todo_state", async () => {
        const sessionId = await h.createSession();
        const stateJson = normalizedJson(STATE_X_TODOS);

        await captureTodoState(sessionId, STATE_X_TODOS);

        const meta = readTodoMeta(sessionId);
        expect(meta?.last_todo_state).toBe(stateJson);
    }, 60_000);

    it("injects a synthetic todowrite pair on a cache-busting pass", async () => {
        const sessionId = await h.createSession();
        const { body, stateJson, callId } = await prepareCacheBustState(sessionId);

        const pair = findSyntheticPair(body, callId);
        expect(pair?.callId).toBe(callId);
        expect(callId).toBe(computeSyntheticCallId(stateJson));

        const meta = readTodoMeta(sessionId);
        expect(meta?.todo_synthetic_call_id).toBe(callId);
        expect(meta?.todo_synthetic_anchor_message_id ?? "").not.toBe("");
        expect(meta?.todo_synthetic_state_json).toBe(stateJson);
        expect(meta?.last_todo_state).toBe(stateJson);
    }, 90_000);

    it("replays the persisted synthetic pair logically byte-identically on defer passes", async () => {
        const sessionId = await h.createSession();
        const { callId } = await prepareCacheBustState(sessionId);

        const t0Body = await sendAndCaptureMainRequest(sessionId, "defer replay t0");
        const t0Bytes = syntheticPairBytes(t0Body, callId);
        const metaT0 = readTodoMeta(sessionId);

        const t1Body = await sendAndCaptureMainRequest(sessionId, "defer replay t1");
        const t1Bytes = syntheticPairBytes(t1Body, callId);
        const metaT1 = readTodoMeta(sessionId);

        expect(t1Bytes).toBe(t0Bytes);
        expect(metaT1?.todo_synthetic_call_id).toBe(metaT0?.todo_synthetic_call_id);
        expect(metaT1?.todo_synthetic_anchor_message_id).toBe(
            metaT0?.todo_synthetic_anchor_message_id,
        );
        expect(metaT1?.todo_synthetic_state_json).toBe(metaT0?.todo_synthetic_state_json);
    }, 120_000);

    it("defer replay ignores a newer real todowrite until the next cache-bust", async () => {
        const sessionId = await h.createSession();
        const { callId: oldCallId } = await prepareCacheBustState(sessionId, STATE_X_TODOS);

        const baselineBody = await sendAndCaptureMainRequest(sessionId, "baseline defer");
        const baselineBytes = syntheticPairBytes(baselineBody, oldCallId);

        h.mock.reset();
        emitTodoOnce(STATE_Y_TODOS);
        setDefaultText("after second todo", LOW_USAGE);
        await h.sendPrompt(sessionId, "write a different todo list");
        await waitForLastTodoState(sessionId, normalizedJson(STATE_Y_TODOS));

        const deferBody = await sendAndCaptureMainRequest(sessionId, "defer after changed todos");
        const deferPair = findSyntheticPair(deferBody, oldCallId);
        expect(deferPair?.bytes).toBe(baselineBytes);

        const meta = readTodoMeta(sessionId);
        expect(meta?.todo_synthetic_call_id).toBe(oldCallId);
        expect(meta?.todo_synthetic_state_json).toBe(normalizedJson(STATE_X_TODOS));
        expect(meta?.last_todo_state).toBe(normalizedJson(STATE_Y_TODOS));
    }, 120_000);

    it("self-heals legacy anchors with empty stateJson and replays their logical bytes on defer", async () => {
        const sessionId = await h.createSession();
        const { callId } = await prepareCacheBustState(sessionId, STATE_X_TODOS);

        updateTodoMeta(
            sessionId,
            "UPDATE session_meta SET todo_synthetic_state_json = '' WHERE session_id = ?",
        );
        expect(readTodoMeta(sessionId)?.todo_synthetic_state_json).toBe("");

        await primeNextTurnAsCacheBust(sessionId);
        const cacheBustBody = await sendAndCaptureMainRequest(sessionId, "legacy self-heal cache bust");
        const cacheBustBytes = syntheticPairBytes(cacheBustBody, callId);

        const after = readTodoMeta(sessionId);
        expect(after?.todo_synthetic_state_json).toBe(normalizedJson(STATE_X_TODOS));

        const deferBody = await sendAndCaptureMainRequest(sessionId, "legacy self-heal defer");
        const deferBytes = syntheticPairBytes(deferBody, callId);
        expect(deferBytes).toBe(cacheBustBytes);
    }, 120_000);

    it("skips todowrite capture and synthetic injection for subagents", async () => {
        if (!(h instanceof TestHarness)) {
            // Only OpenCode 1 exposes parent-linked test session creation.
            expect(h.host).not.toBe("opencode");
            return;
        }
        const openCodeHarness = h;
        const parentId = await openCodeHarness.createSession();
        const childId = await openCodeHarness.createChildSession(parentId, "todo-synthesis-child");
        await openCodeHarness.waitFor(() => openCodeHarness.isSubagent(childId) === true, {
            // Same CI-runner-latency class as the waits above.
            timeoutMs: 60_000,
            label: "child is_subagent=true",
        });

        h.mock.reset();
        emitTodoOnce(STATE_X_TODOS);
        setDefaultText("child after todo", LOW_USAGE);
        await h.sendPrompt(childId, "child writes todos");

        const meta = readTodoMeta(childId);
        expect(meta?.is_subagent).toBe(1);
        expect(meta?.last_todo_state ?? "").toBe("");
        expect(meta?.todo_synthetic_call_id ?? "").toBe("");
        expect(meta?.todo_synthetic_anchor_message_id ?? "").toBe("");
        expect(meta?.todo_synthetic_state_json ?? "").toBe("");
    }, 90_000);

    it("clears the persisted synthetic anchor when the latest todo state is terminal-only", async () => {
        const sessionId = await h.createSession();
        const { callId } = await prepareCacheBustState(sessionId, STATE_X_TODOS);
        expect(readTodoMeta(sessionId)?.todo_synthetic_call_id).toBe(callId);

        await captureTodoState(sessionId, TERMINAL_TODOS);
        await primeNextTurnAsCacheBust(sessionId);
        const body = await sendAndCaptureMainRequest(sessionId, "terminal cache-bust turn");

        expect(findSyntheticPair(body, callId)).toBeNull();
        const meta = readTodoMeta(sessionId);
        expect(meta?.last_todo_state).toBe(normalizedJson(TERMINAL_TODOS));
        expect(meta?.todo_synthetic_call_id ?? "").toBe("");
        expect(meta?.todo_synthetic_anchor_message_id ?? "").toBe("");
        expect(meta?.todo_synthetic_state_json ?? "").toBe("");
    }, 120_000);
});
