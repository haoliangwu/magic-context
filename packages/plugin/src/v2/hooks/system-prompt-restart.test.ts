/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import {
    clearCtxReduceAvailability,
    primeCtxReduceSpawnPermission,
    resolveCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "../../hooks/magic-context/ctx-reduce-availability";
import { createSystemPromptHashHandler } from "../../hooks/magic-context/system-prompt-hash";
import type { PluginContext } from "../../plugin/types";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyV2SystemPrompt } from "./context";
import type { SessionContext } from "./types";

// The system-prompt stage of the OpenCode 2 context hook, run the way the first
// passes after a host restart run it: a fresh handler and no ctx_reduce verdict in
// memory, while the session's previous hash is already stored.
//
// The OpenCode 1 session database the handler falls back to has no row for the
// session, so that fallback cannot freeze the verdict. On a real OpenCode 2 host
// the same fallback fails outright (a different store schema); both leave the
// verdict provisional, which is the condition under test.

const SESSION = "ses_restart_prompt";
const MODEL = { providerID: "openai", id: "mock-model" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dataHome = "";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalOpenCodeDb = process.env.OPENCODE_DB;

beforeEach(() => {
    dataHome = createTestTempDirFromPath(join(tmpdir(), "v2-system-prompt-restart-"));
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.OPENCODE_DB;
    resetOpenCodeDbPathStateForTesting();
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    const openCode = new Database(join(dataHome, "opencode", "opencode.db"));
    openCode.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    openCode.close();
    clearCtxReduceAvailability(SESSION);
});

afterEach(() => {
    closeDatabase();
    clearCtxReduceAvailability(SESSION);
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalOpenCodeDb;
    resetOpenCodeDbPathStateForTesting();
    rmSync(dataHome, { recursive: true, force: true });
});

/**
 * One simulated host process: a fresh system-prompt handler with its own refresh
 * signal sets, the per-process state `registerContext` creates.
 */
function hostProcess() {
    const flags = {
        historyRefreshSessions: new Set<string>(),
        systemPromptRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
    };
    const prompt = createSystemPromptHashHandler({
        db: openDatabase(),
        dreamerEnabled: false,
        memoryEnabled: false,
        lastHeuristicsTurnId: new Map(),
        ...flags,
    });
    return { prompt, flags };
}

function draft(hostPrompt: string, messages: SessionContext["messages"]) {
    return {
        sessionID: SESSION,
        model: MODEL,
        messages,
        tools: { ctx_reduce: { description: "reduce", input: {} } } as SessionContext["tools"],
        system: [{ type: "text", text: hostPrompt }] as SessionContext["system"],
    };
}

const userTurn: SessionContext["messages"] = [
    { id: "msg_user_1", role: "user", content: [{ type: "text", text: "hello" }] },
];

/**
 * Store a system-prompt hash from an earlier host process, then clear the
 * in-memory ctx_reduce verdict the way a restart does. The stored hash survives.
 */
async function previousProcess(hostPrompt: string): Promise<string> {
    const { prompt } = hostProcess();
    // In that process a message transform had already frozen the verdict.
    resolveCtxReduceAvailabilityFromMessages(SESSION, [{ info: { role: "user" } }]);
    await prompt.handler(
        { sessionID: SESSION, model: { providerID: MODEL.providerID, modelID: MODEL.id } },
        { system: [hostPrompt] },
    );
    const stored = getOrCreateSessionMeta(openDatabase(), SESSION).systemPromptHash;
    expect(stored).not.toBe("");
    // A restart starts a new process: the in-memory verdict is gone.
    clearCtxReduceAvailability(SESSION);
    return stored;
}

describe("OpenCode 2 system-prompt stage after a restart", () => {
    it("detects a changed system prompt on the first pass after a restart", async () => {
        const before = await previousProcess("Host prompt, configuration one.");
        // Precondition: the handler's fallback (the OpenCode 1 database, which has no row
        // for this session) cannot freeze the verdict on its own.
        expect(resolveCtxReduceAvailability(SESSION).frozen).toBe(false);

        const { prompt, flags } = hostProcess();
        const first = draft("Host prompt, configuration two.", userTurn);
        await applyV2SystemPrompt(prompt, first);

        const after = getOrCreateSessionMeta(openDatabase(), SESSION).systemPromptHash;
        expect(after).not.toBe(before);
        // Every refresh signal is raised on this pass, so the message transform that
        // follows in the same pass folds for the changed prompt.
        expect(flags.pendingMaterializationSessions.has(SESSION)).toBe(true);
        expect(flags.historyRefreshSessions.has(SESSION)).toBe(true);
        expect(flags.systemPromptRefreshSessions.has(SESSION)).toBe(true);
        expect(String(first.system[0]?.text)).toContain("## Magic Context");
        expect(String(first.system[0]?.text)).toContain("ctx_reduce");
    });

    it("keeps a restart with an unchanged system prompt silent", async () => {
        const before = await previousProcess("Host prompt, unchanged.");
        const { prompt, flags } = hostProcess();
        await applyV2SystemPrompt(prompt, draft("Host prompt, unchanged.", userTurn));
        expect(getOrCreateSessionMeta(openDatabase(), SESSION).systemPromptHash).toBe(before);
        expect(flags.pendingMaterializationSessions.size).toBe(0);
        expect(flags.historyRefreshSessions.size).toBe(0);
        expect(flags.systemPromptRefreshSessions.size).toBe(0);
    });

    it("leaves the verdict provisional and the stored hash untouched when the draft has no user message", async () => {
        const before = await previousProcess("Host prompt, configuration one.");
        const { prompt, flags } = hostProcess();
        await applyV2SystemPrompt(prompt, draft("Host prompt, configuration two.", []));
        expect(resolveCtxReduceAvailability(SESSION).frozen).toBe(false);
        expect(getOrCreateSessionMeta(openDatabase(), SESSION).systemPromptHash).toBe(before);
        expect(flags.pendingMaterializationSessions.size).toBe(0);
    });

    it("keeps a ctx_reduce permission deny read before the pass: no reduce guidance, verdict frozen", async () => {
        const client = {
            app: {
                agents: async () => ({
                    data: [{ name: "build", permission: { ctx_reduce: "deny" } }],
                }),
            },
            session: { get: async () => ({ data: { agent: "build" } }) },
        } as unknown as PluginContext["client"];
        await primeCtxReduceSpawnPermission(client, SESSION, "build");

        const { prompt } = hostProcess();
        const first = draft("Host prompt.", userTurn);
        await applyV2SystemPrompt(prompt, first);

        expect(resolveCtxReduceAvailability(SESSION)).toEqual({ callable: false, frozen: true });
        expect(String(first.system[0]?.text)).toContain("## Magic Context");
        expect(String(first.system[0]?.text)).not.toContain("ctx_reduce");
    });

    it("freezes ctx_reduce absence from the OC2 host tool set before system guidance", async () => {
        const { prompt } = hostProcess();
        const first = draft("Host prompt.", userTurn);
        first.tools = {};
        await applyV2SystemPrompt(prompt, first);
        expect(resolveCtxReduceAvailability(SESSION)).toEqual({ callable: false, frozen: true });
        expect(String(first.system[0]?.text)).toContain("## Magic Context");
        expect(String(first.system[0]?.text)).not.toContain("ctx_reduce");
        // A later agent switch cannot change the already served baseline.
        const second = draft("Host prompt.", userTurn);
        await applyV2SystemPrompt(prompt, second);
        expect(second.system).toEqual(first.system);
    });

    it("keeps an allowed OC2 first-pass verdict when later tools deny ctx_reduce", async () => {
        const { prompt } = hostProcess();
        const first = draft("Host prompt.", userTurn);
        await applyV2SystemPrompt(prompt, first);
        const second = draft("Host prompt.", userTurn);
        second.tools = {};
        await applyV2SystemPrompt(prompt, second);
        expect(resolveCtxReduceAvailability(SESSION)).toEqual({ callable: true, frozen: true });
        expect(second.system).toEqual(first.system);
    });

    it("sends the priced pass's system bytes unchanged on the passes after it, and records each pass's input and output", async () => {
        await previousProcess("Host prompt, configuration one. Today's date: 2026-09-24");
        const { prompt, flags } = hostProcess();
        const passes: Array<{
            input: string;
            output: string;
            storedHash: string;
            foldSignalled: boolean;
        }> = [];
        const run = async (hostPrompt: string) => {
            const pass = draft(hostPrompt, userTurn);
            await applyV2SystemPrompt(prompt, pass);
            passes.push({
                input: sha(hostPrompt),
                output: sha(pass.system.map((part) => String(part.text)).join("\n")),
                storedHash: getOrCreateSessionMeta(openDatabase(), SESSION).systemPromptHash,
                foldSignalled: flags.pendingMaterializationSessions.has(SESSION),
            });
            // Stand in for the message transform later in the pass, which consumes the
            // fold and history-refresh signals.
            flags.pendingMaterializationSessions.delete(SESSION);
            flags.historyRefreshSessions.delete(SESSION);
        };

        // Priced pass (one that rebuilds the provider cache): the first pass after the
        // restart, with the changed prompt.
        await run("Host prompt, configuration two. Today's date: 2026-09-24");
        // Next pass: it consumes the system-prompt refresh signal the priced pass left for it.
        await run("Host prompt, configuration two. Today's date: 2026-09-24");
        // Defer pass (one that must reuse the cached prefix): the host's date moved on,
        // but the prompt must not change.
        await run("Host prompt, configuration two. Today's date: 2026-09-25");

        expect(passes.map((pass) => pass.foldSignalled)).toEqual([true, false, false]);
        expect(new Set(passes.map((pass) => pass.storedHash)).size).toBe(1);
        // The defer pass's input differs from the priced pass's input...
        expect(passes[2]!.input).not.toBe(passes[0]!.input);
        // ...yet every pass after the priced one sends the priced pass's exact bytes.
        expect(passes[1]!.output).toBe(passes[0]!.output);
        expect(passes[2]!.output).toBe(passes[0]!.output);
        expect(flags.systemPromptRefreshSessions.has(SESSION)).toBe(false);
    });
});
