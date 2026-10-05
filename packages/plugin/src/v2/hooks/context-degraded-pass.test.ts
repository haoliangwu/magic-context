import { expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

for (const compactionOff of [false, true]) {
    test(`v2 ordinary setup failure ${compactionOff ? "passes through with compaction off" : "refuses before the provider"}`, async () => {
        const { dir } = createTestTempDir("mc-v2-degraded-");
        const db = openDatabase(join(dir, "context.db"));
        if (!db) throw new Error("throwaway test store unavailable");
        const config = MagicContextConfigSchema.parse({
            compaction: { enabled: !compactionOff },
            historian: { disable: true },
            dreamer: { disable: true },
            memory: { enabled: false },
        });
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
            expect(hook).toBeDefined();
            let reached = 0;
            const draft: SessionContext = {
                sessionID: "ses-v2-ordinary-failure",
                model: { providerID: "anthropic", id: "mock", limit: { context: 200000 } },
                agent: "build",
                system: [],
                options: {},
                messages: [
                    { id: "u1", role: "user", content: [{ type: "text", text: "small request" }] },
                ],
                tools: {
                    poison: {
                        description: "test tool",
                        get input() {
                            reached++;
                            throw new TypeError("tool definitions unavailable");
                        },
                    },
                },
            };
            const before = JSON.stringify(draft.messages);
            if (compactionOff) await hook!(draft);
            else {
                const failure = await hook!(draft).catch((error) => error);
                expect(failure).toMatchObject({
                    cause: {
                        name: "DegradedPassRefusalError",
                        site: "v2-context-failed",
                        cause: new TypeError("tool definitions unavailable"),
                    },
                });
            }
            expect(reached).toBeGreaterThan(0);
            expect(interrupt).toHaveBeenCalledTimes(compactionOff ? 0 : 1);
            expect(JSON.stringify(draft.messages)).toBe(before);
        } finally {
            await duties?.dispose();
            probe.mockRestore();
            load.mockRestore();
            closeDatabase();
            resetCtxReduceRegisteredGloballyForTest();
            cleanupTestTempDir(dir);
        }
    });
}
