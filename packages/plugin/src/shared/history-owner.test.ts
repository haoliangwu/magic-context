import { expect, test } from "bun:test";
import { handoffHistoryWork } from "./history-owner";
import type { MagicContextRpcClient } from "./rpc-client";

test("moved-session recomp is handed to the current directory before local work starts", async () => {
    const calls: unknown[] = [];
    const result = await handoffHistoryWork({
        storageDir: "/isolated/mc",
        directory: "/old",
        sessionId: "session",
        method: "recomp",
        params: { sessionId: "session" },
        readDirectory: async () => "/new",
        findOwner: async () =>
            ({
                call: async (...args: unknown[]) => {
                    calls.push(args);
                    return { ok: true };
                },
            }) as unknown as MagicContextRpcClient,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
        ["recomp", { sessionId: "session", directory: "/new", historyHandoff: true }],
    ]);
});

test("moved-session recovery explains how to load a missing owner and stops handoff loops", async () => {
    for (const historyHandoff of [false, true]) {
        const result = await handoffHistoryWork({
            storageDir: "/isolated/mc",
            directory: "/old",
            sessionId: "session",
            method: "wrapup",
            params: { sessionId: "session", historyHandoff },
            readDirectory: async () => "/new",
            findOwner: async () => null,
        });
        expect(result?.ok).toBe(false);
        expect(result?.error).toContain(
            "Reopen this session in its current project directory (/new)",
        );
    }
});

test("history recovery remains local when the host still reports this directory", async () => {
    expect(
        await handoffHistoryWork({
            storageDir: "/isolated/mc",
            directory: "/project",
            sessionId: "session",
            method: "recomp",
            params: {},
            readDirectory: async () => "/project",
            findOwner: async () => {
                throw new Error("must not discover");
            },
        }),
    ).toBeUndefined();
});
