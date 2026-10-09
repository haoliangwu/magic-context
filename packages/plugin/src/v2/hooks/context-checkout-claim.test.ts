import { expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import {
    type FakeSubcDaemon,
    fakeFleetResponder,
    startFakeSubcDaemon,
} from "../../features/magic-context/checkout-claim-fake-subc.test-support";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

/**
 * OpenCode 2's context hook against a wire-level fake of the fleet: ALF maps
 * the session to an agent and engram reports that agent's claim.
 */
async function runTurn(sessionID: string, heldElsewhere: boolean) {
    const { dir } = createTestTempDir("mc-v2-checkout-claim-");
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("throwaway test store unavailable");
    let daemon: FakeSubcDaemon | undefined;
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        subc: { connection_file: join(dir, "run", "subc-connection.json") },
    });
    daemon = await startFakeSubcDaemon(
        join(dir, "run", "subc-connection.json"),
        fakeFleetResponder({
            agents: { [sessionID]: "agent_v2" },
            claims: {
                agent_v2: heldElsewhere
                    ? { epoch: 3, held_here: false, held_elsewhere: true, holder: "feed01" }
                    : { epoch: 3, held_here: true, held_elsewhere: false, holder: "here01" },
            },
        }),
    );
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
    const interrupt = mock(async () => ({ interrupted: true }));
    const host = {
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt,
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                if (name === "context") hook = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    let duties: Awaited<ReturnType<typeof registerContext>>;
    try {
        duties = await registerContext(host);
        const draft: SessionContext = {
            sessionID,
            model: { providerID: "anthropic", id: "mock", limit: { context: 200000 } },
            agent: "build",
            system: [],
            options: {},
            messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }],
            tools: {},
        };
        const before = JSON.stringify(draft.messages);
        const failure = await hook!(draft).then(
            () => null,
            (error: unknown) => error,
        );
        const metaRows = (
            db
                .prepare("SELECT COUNT(*) AS n FROM session_meta WHERE session_id = ?")
                .get(sessionID) as { n: number }
        ).n;
        return {
            failure,
            interrupts: interrupt.mock.calls.length,
            metaRows,
            messagesUnchanged: JSON.stringify(draft.messages) === before,
            methods: daemon.calls.map((call) => call.method),
        };
    } finally {
        await duties?.dispose();
        await daemon?.close();
        probe.mockRestore();
        load.mockRestore();
        closeDatabase();
        resetCtxReduceRegisteredGloballyForTest();
        cleanupTestTempDir(dir);
    }
}

test("v2 refuses a turn whose agent another machine holds, before any write", async () => {
    const outcome = await runTurn("ses-v2-claim-moved", true);
    expect(outcome.failure).toMatchObject({
        name: "V2ContextRefusal",
        cause: { name: "CheckoutClaimRefusalError", holder: "feed01", epoch: 3 },
    });
    expect((outcome.failure as Error).message).toContain("(MC-C16)");
    expect(outcome.interrupts).toBe(1);
    expect(outcome.metaRows).toBe(0);
    expect(outcome.messagesUnchanged).toBe(true);
    expect(outcome.methods).toEqual(["agent.for_host_session", "claim.read"]);
});

test("v2 admits a turn whose agent is held here and the pass goes on to write", async () => {
    const outcome = await runTurn("ses-v2-claim-here", false);
    // This fake host has no OpenCode store, so the pass may still stop later for
    // its own reasons; what matters here is that the claim check let it through.
    expect(outcome.failure).toBeNull();
    expect(outcome.metaRows).toBe(1);
    expect(outcome.methods).toEqual(["agent.for_host_session", "claim.read"]);
});
