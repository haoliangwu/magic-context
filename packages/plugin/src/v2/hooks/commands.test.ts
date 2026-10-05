import { expect, test } from "bun:test";

import { MagicContextRpcServer } from "../../shared/rpc-server";
import { registerV2Commands } from "./commands";
import type { V2CommandDomain, V2CommandInvocation } from "./types";

interface RegisteredCommand {
    name: string;
    description?: string;
    execute: (input: V2CommandInvocation) => Promise<void>;
}

/**
 * Stands in for the host's command registry: `transform` hands an editor whose
 * `add` populates a map keyed by name, which is what the real host does before
 * `GET /api/command` lists it and `POST /api/session/:id/command` executes it.
 */
function hostCommandDomain(): { domain: V2CommandDomain; registered: RegisteredCommand[] } {
    const registered: RegisteredCommand[] = [];
    return {
        registered,
        domain: {
            async transform(callback) {
                callback({
                    add: (definition) => {
                        registered.push(definition);
                    },
                });
                return {};
            },
            async reload() {},
        },
    };
}

function invocation(text: string): V2CommandInvocation {
    return { sessionID: "session-1", prompt: { text }, delivery: "steer" };
}

function rpcWithCalls(replies: Record<string, Record<string, unknown>>): {
    rpc: MagicContextRpcServer;
    calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
    const rpc = new MagicContextRpcServer("/tmp/magic-context-test", "/repo/project");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    for (const [method, reply] of Object.entries(replies)) {
        rpc.handle(method, async (params) => {
            calls.push({ method, params });
            return reply;
        });
    }
    return { rpc, calls };
}

test("every /ctx-* command is registered with the host, with its description", async () => {
    const { domain, registered } = hostCommandDomain();
    const { rpc } = rpcWithCalls({});
    const ok = await registerV2Commands({
        command: domain,
        rpc,
        directory: "/repo/project",
        compactionEnabled: true,
    });

    expect(ok).toBe(true);
    expect(registered.map((command) => command.name)).toEqual([
        "ctx-status",
        "ctx-recomp",
        "ctx-dream",
        "ctx-flush",
        "ctx-embed",
        "ctx-wrapup",
    ]);
    // The host lists name + description; an empty description would leave the
    // command unexplained in every client's command list.
    for (const command of registered) {
        expect(command.description ?? "").not.toBe("");
    }
});

test("a registered command runs the same RPC handler the terminal UI calls", async () => {
    const { domain, registered } = hostCommandDomain();
    const { rpc, calls } = rpcWithCalls({ flush: { ok: true, message: "3 operations applied" } });
    await registerV2Commands({
        command: domain,
        rpc,
        directory: "/repo/project",
        compactionEnabled: true,
    });

    const flush = registered.find((command) => command.name === "ctx-flush");
    await flush?.execute(invocation(""));

    expect(calls).toEqual([{ method: "flush", params: { sessionId: "session-1" } }]);
});

test("command arguments reach the handler, with or without the typed command prefix", async () => {
    const { domain, registered } = hostCommandDomain();
    const { rpc, calls } = rpcWithCalls({
        dream: { ok: true },
        wrapup: { ok: true, started: true },
    });
    await registerV2Commands({
        command: domain,
        rpc,
        directory: "/repo/project",
        compactionEnabled: true,
    });

    const dream = registered.find((command) => command.name === "ctx-dream");
    await dream?.execute(invocation("classify-memories"));
    const wrapup = registered.find((command) => command.name === "ctx-wrapup");
    await wrapup?.execute(invocation("/ctx-wrapup 30"));

    expect(calls).toEqual([
        { method: "dream", params: { sessionId: "session-1", task: "classify-memories" } },
        { method: "wrapup", params: { sessionId: "session-1", messagesToKeep: 30 } },
    ]);
});

test("a bad argument is refused before any handler runs", async () => {
    const { domain, registered } = hostCommandDomain();
    const { rpc, calls } = rpcWithCalls({ embed: { ok: true, message: "unused" } });
    await registerV2Commands({
        command: domain,
        rpc,
        directory: "/repo/project",
        compactionEnabled: true,
    });

    const embed = registered.find((command) => command.name === "ctx-embed");
    await expect(embed?.execute(invocation("resume"))).rejects.toThrow("Usage: /ctx-embed");
    expect(calls).toEqual([]);
});

test("a host without a command domain leaves the commands unregistered instead of throwing", async () => {
    const { rpc } = rpcWithCalls({});
    await expect(
        registerV2Commands({
            command: undefined,
            rpc,
            directory: "/repo/project",
            compactionEnabled: true,
        }),
    ).resolves.toBe(false);
});
