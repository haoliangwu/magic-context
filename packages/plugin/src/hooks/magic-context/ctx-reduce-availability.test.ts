/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    clearCtxReduceAvailability,
    clearTodowriteAvailability,
    permissionDisabled,
    primeCtxReduceSpawnPermission,
    resetCtxReduceRegisteredGloballyForTest,
    resolveCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailabilityFromMessages,
    resolveToolPermissionDenied,
    setCtxReduceRegisteredGlobally,
    spawnAgentFromMessages,
} from "./ctx-reduce-availability";

function userMsg(tools?: Record<string, unknown>) {
    return { info: { role: "user", ...(tools !== undefined ? { tools } : {}) } };
}

describe("ctx_reduce availability (spawn tools map)", () => {
    it("resolves false for an explicit allow-list without ctx_reduce", () => {
        clearCtxReduceAvailability("ses-allow");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-allow", [
            userMsg({ "*": false, read: true, grep: true }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("resolves true when ctx_reduce is explicitly allowed", () => {
        clearCtxReduceAvailability("ses-explicit");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-explicit", [
            userMsg({ "*": false, read: true, ctx_reduce: true }),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("fails open for sessions without a tools map (normal sessions)", () => {
        clearCtxReduceAvailability("ses-plain");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves false when ctx_reduce is explicitly denied", () => {
        clearCtxReduceAvailability("ses-deny");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-deny", [
            userMsg({ ctx_reduce: false }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("freezes the verdict per session — later, different tool maps cannot flap it", () => {
        clearCtxReduceAvailability("ses-frozen");
        const first = resolveCtxReduceAvailabilityFromMessages("ses-frozen", [
            userMsg({ "*": false, read: true }),
        ]);
        expect(first).toEqual({ callable: false, frozen: true });
        // Same session, contradictory map on a later pass: cached verdict wins
        // (per-turn maps can differ; a flapping verdict would bust the cache).
        const second = resolveCtxReduceAvailabilityFromMessages("ses-frozen", [
            userMsg({ "*": false, ctx_reduce: true }),
        ]);
        expect(second).toEqual({ callable: false, frozen: true });
    });

    it("ignores non-user messages and falls open when the first user message carries no signal", () => {
        clearCtxReduceAvailability("ses-nosignal");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-nosignal", [
            { info: { role: "assistant" } },
            userMsg({}),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("does not freeze a fail-open verdict from an array with no user message", () => {
        clearCtxReduceAvailability("ses-no-user-yet");
        // A pass with no user message at all fails open provisionally...
        const provisional = resolveCtxReduceAvailabilityFromMessages("ses-no-user-yet", [
            { info: { role: "assistant" } },
        ]);
        expect(provisional).toEqual({ callable: true, frozen: false });
        // ...but must NOT lock the session: the real first user message (a
        // deny-list spawn) still decides the frozen verdict.
        const final = resolveCtxReduceAvailabilityFromMessages("ses-no-user-yet", [
            { info: { role: "assistant" } },
            userMsg({ "*": false, read: true }),
        ]);
        expect(final).toEqual({ callable: false, frozen: true });
    });
});

describe("todowrite availability (generalized resolver)", () => {
    it("resolves false for an explicit allow-list without todowrite", () => {
        clearTodowriteAvailability("ses-td-allow");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-allow", [
            userMsg({ "*": false, read: true, grep: true }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("resolves true when todowrite is explicitly allowed", () => {
        clearTodowriteAvailability("ses-td-explicit");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-explicit", [
            userMsg({ "*": false, read: true, todowrite: true }),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves false when todowrite is explicitly denied", () => {
        clearTodowriteAvailability("ses-td-deny");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-deny", [
            userMsg({ todowrite: false }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("fails open for sessions without a tools map (normal sessions)", () => {
        clearTodowriteAvailability("ses-td-plain");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-plain", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves ctx_reduce and todowrite independently for the same session", () => {
        // A tools map can keep ctx_reduce but filter todowrite (or vice versa);
        // the two verdicts must not bleed into each other through the cache.
        clearCtxReduceAvailability("ses-td-mixed");
        clearTodowriteAvailability("ses-td-mixed");
        const map = userMsg({ "*": false, ctx_reduce: true });
        const reduce = resolveCtxReduceAvailabilityFromMessages("ses-td-mixed", [map]);
        const todo = resolveTodowriteAvailabilityFromMessages("ses-td-mixed", [map]);
        expect(reduce).toEqual({ callable: true, frozen: true });
        expect(todo).toEqual({ callable: false, frozen: true });
    });
});

describe("OpenCode todowrite permission evaluator", () => {
    it("denies a top-level agent rule for the whole tool", () => {
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "*", action: "deny" },
            ]),
        ).toBe(true);
    });

    it("uses findLast semantics so a later per-agent allow overrides deny", () => {
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "*", action: "deny" },
                { permission: "todowrite", pattern: "*", action: "allow" },
            ]),
        ).toBe(false);
    });

    it("applies a session overlay after the merged agent rules", () => {
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "*", action: "allow" },
                { permission: "todowrite", pattern: "*", action: "deny" },
            ]),
        ).toBe(true);
    });

    it("fails open when no rule matches", () => {
        expect(permissionDisabled("todowrite", [])).toBe(false);
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "src/**", action: "deny" },
            ]),
        ).toBe(false);
    });

    it("treats regex punctuation literally while preserving wildcard segments", () => {
        const deny = (permission: string, toolName: string): boolean =>
            permissionDisabled(toolName, [{ permission, pattern: "*", action: "deny" }]);

        expect(() => deny("to(do*", "to(doThing")).not.toThrow();
        expect(deny("to(do*", "to(doThing")).toBe(true);
        expect(deny("to(do*", "todoThing")).toBe(false);
        expect(deny("todo.rite*", "todo.riteLater")).toBe(true);
        expect(deny("todo.rite*", "todowriteLater")).toBe(false);
        expect(deny("to*write", "todowrite")).toBe(true);
        expect(deny("to*write", "to-something-write")).toBe(true);
        expect(deny("*", "todowrite")).toBe(true);
        expect(deny("todowrite", "todowrite")).toBe(true);
    });

    it("reads the active agent and session overlay through the SDK", async () => {
        const client = {
            app: {
                agents: async () => ({
                    data: [
                        {
                            name: "build",
                            permission: [
                                { permission: "todowrite", pattern: "*", action: "allow" },
                            ],
                        },
                    ],
                }),
            },
            session: {
                get: async () => ({
                    data: {
                        agent: "build",
                        permission: {
                            todowrite: "deny",
                        },
                    },
                }),
            },
        } as never;
        await expect(
            resolveToolPermissionDenied(client, "ses-permission-overlay", "todowrite"),
        ).resolves.toBe(true);
    });
});

/** Fake OpenCode SDK whose agent and session permissions can change between reads. */
function permissionClient(state: {
    agentPermission?: unknown;
    sessionPermission?: unknown;
    fail?: boolean;
}) {
    const calls = { agents: 0, sessions: 0 };
    const client = {
        app: {
            agents: async () => {
                calls.agents += 1;
                if (state.fail) throw new Error("host unavailable");
                return {
                    data: [
                        { name: "build", permission: [] },
                        { name: "reviewer", permission: state.agentPermission ?? [] },
                    ],
                };
            },
        },
        session: {
            get: async () => {
                calls.sessions += 1;
                return { data: { permission: state.sessionPermission ?? [] } };
            },
        },
    } as never;
    return { client, calls };
}

function agentUserMsg(agent: string, tools?: Record<string, unknown>) {
    return { info: { role: "user", agent, ...(tools !== undefined ? { tools } : {}) } };
}

describe("ctx_reduce availability (agent and session permissions before the freeze)", () => {
    it("freezes unavailable when the spawn agent's permissions deny ctx_reduce", async () => {
        const sessionId = "ses-agent-deny";
        clearCtxReduceAvailability(sessionId);
        const { client } = permissionClient({ agentPermission: { ctx_reduce: "deny" } });
        const messages = [agentUserMsg("reviewer"), agentUserMsg("build")];
        await primeCtxReduceSpawnPermission(client, sessionId, spawnAgentFromMessages(messages));
        expect(resolveCtxReduceAvailabilityFromMessages(sessionId, messages)).toEqual({
            callable: false,
            frozen: true,
        });
        // The DB resolver used by the system-prompt hook reads the same frozen verdict.
        expect(resolveCtxReduceAvailability(sessionId)).toEqual({ callable: false, frozen: true });
    });

    it("freezes unavailable when the session permission overlay denies ctx_reduce", async () => {
        const sessionId = "ses-session-deny";
        clearCtxReduceAvailability(sessionId);
        const { client } = permissionClient({
            sessionPermission: [{ permission: "ctx_reduce", pattern: "*", action: "deny" }],
        });
        await primeCtxReduceSpawnPermission(client, sessionId, "build");
        expect(
            resolveCtxReduceAvailabilityFromMessages(sessionId, [agentUserMsg("build")]),
        ).toEqual({ callable: false, frozen: true });
    });

    it("a permission deny wins over an explicit ctx_reduce: true tools map", async () => {
        const sessionId = "ses-deny-over-map";
        clearCtxReduceAvailability(sessionId);
        const { client } = permissionClient({ agentPermission: { ctx_reduce: "deny" } });
        await primeCtxReduceSpawnPermission(client, sessionId, "reviewer");
        expect(
            resolveCtxReduceAvailabilityFromMessages(sessionId, [
                agentUserMsg("reviewer", { ctx_reduce: true }),
            ]),
        ).toEqual({ callable: false, frozen: true });
    });

    it("keeps the fail-open callable verdict when permissions allow or the read fails", async () => {
        const allowed = "ses-permission-allow";
        clearCtxReduceAvailability(allowed);
        await primeCtxReduceSpawnPermission(permissionClient({}).client, allowed, "reviewer");
        expect(
            resolveCtxReduceAvailabilityFromMessages(allowed, [agentUserMsg("reviewer")]),
        ).toEqual({ callable: true, frozen: true });

        const failed = "ses-permission-read-fails";
        clearCtxReduceAvailability(failed);
        await primeCtxReduceSpawnPermission(
            permissionClient({ fail: true, agentPermission: { ctx_reduce: "deny" } }).client,
            failed,
            "reviewer",
        );
        expect(
            resolveCtxReduceAvailabilityFromMessages(failed, [agentUserMsg("reviewer")]),
        ).toEqual({
            callable: true,
            frozen: true,
        });
    });

    it("a deny added after the verdict froze never flips it and is not re-read", async () => {
        const sessionId = "ses-mid-session-deny";
        clearCtxReduceAvailability(sessionId);
        const state: { agentPermission?: unknown } = {};
        const { client, calls } = permissionClient(state);
        const messages = [agentUserMsg("reviewer")];
        await primeCtxReduceSpawnPermission(client, sessionId, "reviewer");
        expect(resolveCtxReduceAvailabilityFromMessages(sessionId, messages)).toEqual({
            callable: true,
            frozen: true,
        });
        const readsAtFreeze = calls.agents;

        state.agentPermission = { ctx_reduce: "deny" };
        await primeCtxReduceSpawnPermission(client, sessionId, "reviewer");
        expect(calls.agents).toBe(readsAtFreeze);
        expect(resolveCtxReduceAvailabilityFromMessages(sessionId, messages)).toEqual({
            callable: true,
            frozen: true,
        });
        // The live read used by the operator log does see the new deny.
        await expect(
            resolveToolPermissionDenied(client, sessionId, "ctx_reduce", "reviewer"),
        ).resolves.toBe(true);
        expect(resolveCtxReduceAvailability(sessionId)).toEqual({ callable: true, frozen: true });
    });

    it("reads permissions once for concurrent passes on the same session", async () => {
        const sessionId = "ses-permission-concurrent";
        clearCtxReduceAvailability(sessionId);
        const { client, calls } = permissionClient({ agentPermission: { ctx_reduce: "deny" } });
        await Promise.all([
            primeCtxReduceSpawnPermission(client, sessionId, "reviewer"),
            primeCtxReduceSpawnPermission(client, sessionId, "reviewer"),
        ]);
        await primeCtxReduceSpawnPermission(client, sessionId, "reviewer");
        expect(calls.agents).toBe(1);
    });

    it("names the spawn agent from the first user message, not the latest", () => {
        expect(
            spawnAgentFromMessages([
                { info: { role: "assistant" } },
                agentUserMsg("reviewer"),
                agentUserMsg("build"),
            ]),
        ).toBe("reviewer");
        expect(spawnAgentFromMessages([userMsg()])).toBeUndefined();
    });
});

describe("ctx_reduce process-global registration override (compaction-off #266 S4)", () => {
    // The override is process-global and boot-resolved. Reset to the
    // default-true baseline after each test so a compaction-off test cannot
    // leak a false verdict into a later test in the same bun process.
    it("when ctx_reduce is not registered globally, every session resolves callable=false frozen=true", () => {
        setCtxReduceRegisteredGlobally(false);
        try {
            // A normal session with no tools map would otherwise fail-open to
            // callable=true — the override must force false so unregistration
            // flows through to guidance, nudges, and §N§ prefix injection.
            clearCtxReduceAvailability("ses-plain-off");
            const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain-off", [userMsg()]);
            expect(verdict).toEqual({ callable: false, frozen: true });

            // Even a session that explicitly allows ctx_reduce in its spawn
            // tools map resolves false: the tool is not registered process-
            // globally, so the per-session map is irrelevant.
            clearCtxReduceAvailability("ses-allow-off");
            const verdictAllow = resolveCtxReduceAvailabilityFromMessages("ses-allow-off", [
                userMsg({ "*": false, ctx_reduce: true }),
            ]);
            expect(verdictAllow).toEqual({ callable: false, frozen: true });
        } finally {
            resetCtxReduceRegisteredGloballyForTest();
        }
    });

    it("the override is specific to ctx_reduce — todowrite is unaffected", () => {
        setCtxReduceRegisteredGlobally(false);
        try {
            clearTodowriteAvailability("ses-td-off");
            const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-off", [userMsg()]);
            expect(verdict).toEqual({ callable: true, frozen: true });
        } finally {
            resetCtxReduceRegisteredGloballyForTest();
        }
    });

    it("when ctx_reduce IS registered globally (default), the per-session tools map decides as before", () => {
        // Default state is registered=true; do not flip it. This is the
        // back-compat assertion: the override must not change today's
        // behavior for compaction-on sessions.
        clearCtxReduceAvailability("ses-plain-on");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain-on", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    // Spec #266 S4 nudge-silence acceptance: both nudge channels (Channel-1
    // append + Channel-2 trigger) gate on `ctxReduceCallable` in transform.ts
    // (line 2254: `if (ctxReduceCallable && deps.channel1StateBySession)`).
    // That value is resolved from this module. The override forces
    // callable=false in compaction-off mode, so the nudge gate is closed
    // naturally — no separate mode gate is needed at the nudge site. The
    // mutation direction: remove the override (un-gate) → a normal session
    // fails-open to callable=true → the nudge gate opens → red.
    it("nudge gate source: compaction-off resolves callable=false (Channel-1/Channel-2 stay silent)", () => {
        setCtxReduceRegisteredGlobally(false);
        try {
            clearCtxReduceAvailability("ses-nudge-off");
            const verdict = resolveCtxReduceAvailabilityFromMessages("ses-nudge-off", [userMsg()]);
            // transform.ts reads `ctxReduceAvailability.callable` and gates
            // both nudge channels on it. callable=false → no Channel-1 append,
            // no Channel-2 claim.
            expect(verdict.callable).toBe(false);
            expect(verdict.frozen).toBe(true);
        } finally {
            resetCtxReduceRegisteredGloballyForTest();
        }
    });
});
