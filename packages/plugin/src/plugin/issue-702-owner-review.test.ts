import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MagicContextConfigSchema } from "../config/schema/magic-context";
import { createLiveSessionState } from "../hooks/magic-context/live-session-state";
import { MagicContextRpcClient } from "../shared/rpc-client";
import { MagicContextRpcServer } from "../shared/rpc-server";
import { createTestTempDir } from "../shared/test-temp-dir";
import { registerRpcHandlers } from "./rpc-handlers";

test("issue 702 control: authenticated real RPC handoff rechecks ownership and never opens the stale project", async () => {
    const root = createTestTempDir("issue-702-rpc-");
    const oldDir = join(root.dir, "old");
    const newDir = join(root.dir, "new");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    const servers = [
        new MagicContextRpcServer(root.dir, oldDir),
        new MagicContextRpcServer(root.dir, newDir),
    ];
    const reads: string[] = [];
    const owners = new Map([
        ["moved", newDir],
        ["elsewhere", join(root.dir, "unreachable")],
    ]);
    for (const [index, server] of servers.entries()) {
        const directory = index === 0 ? oldDir : newDir;
        registerRpcHandlers(server, {
            directory,
            storageDir: root.dir,
            config: MagicContextConfigSchema.parse({}),
            liveSessionState: createLiveSessionState(),
            client: undefined,
            readSessionDirectory: async (id) => owners.get(id) ?? null,
            // A real database is unnecessary: observing this callback proves
            // which bound project would open state, before session history is read.
            getDatabase: () => {
                reads.push(directory);
                return null;
            },
        });
    }
    try {
        const ports = await Promise.all(servers.map((server) => server.start()));
        for (const token of [undefined, "wrong-token"]) {
            for (const method of ["recomp", "wrapup"]) {
                const response = await fetch(`http://127.0.0.1:${ports[1]}/rpc/${method}`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify({ sessionId: "moved" }),
                });
                expect(response.status).toBe(401);
            }
        }
        expect(reads).toEqual([]);
        const oldClient = new MagicContextRpcClient(root.dir, oldDir);
        for (const method of ["recomp", "wrapup"]) {
            reads.length = 0;
            const reply = await oldClient.call(method, {
                sessionId: "moved",
                directory: join(root.dir, "attacker-selected"),
            });
            expect(reply).toMatchObject({ ok: false, error: "db unavailable" });
            expect(reads).toEqual([newDir]);
            reads.length = 0;
            const nonOwner = await oldClient.call(method, {
                sessionId: "elsewhere",
                directory: oldDir,
            });
            expect(nonOwner.ok).toBe(false);
            expect(reads).toEqual([]);
            const unknown = await oldClient.call(method, {
                sessionId: "unknown",
                directory: oldDir,
            });
            expect(unknown.ok).toBe(false);
            expect(reads).toEqual([]);
            const bounced = await oldClient.call(method, {
                sessionId: "moved",
                directory: oldDir,
                historyHandoff: true,
            });
            expect(bounced.ok).toBe(false);
            expect(reads).toEqual([]);
        }
        // Once discovery cannot reach the new owner, the stale instance must
        // not fall back to its own project state.
        servers[1]!.stop();
        reads.length = 0;
        expect((await oldClient.call("recomp", { sessionId: "moved" })).ok).toBe(false);
        expect(reads).toEqual([]);
    } finally {
        for (const server of servers) server.stop();
        root.cleanup();
    }
});
