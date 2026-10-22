import { afterEach, expect, spyOn, test } from "bun:test";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { _resetHarnessForTesting } from "../../shared/harness";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import * as hiddenCompletion from "../hidden-completion";
import { setup } from "../server";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

/**
 * The plugin disposer is what OpenCode 2 runs when it reloads the plugin. It
 * must cancel the instance's hidden runs before anything else, and must not
 * close the store reader pool under a run that still holds it.
 */

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    _resetDreamTimerForTests();
    closeDatabase();
    resetCtxReduceRegisteredGloballyForTest();
    _resetHarnessForTesting();
    for (const dir of directories.splice(0)) cleanupTestTempDir(dir);
});

function projectDirectory(): string {
    const { dir } = createTestTempDir("mc-v2-hidden-dispose-");
    directories.push(dir);
    return dir;
}

function fakeHost(directory: string): V2Context {
    return {
        location: { directory },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async () => {},
            get: async () => ({ location: { directory } }),
        },
    } as unknown as V2Context;
}

test("the disposer cancels hidden runs first and leaves the reader pool to a run that holds it", async () => {
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        embedding: { provider: "off" },
    });
    const detailed = configLoader.loadPluginConfigDetailed(projectDirectory(), false);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        ...detailed,
        config,
    });
    const db = openDatabase();
    if (!db) throw new Error("throwaway test store unavailable");
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    const order: string[] = [];
    let wired: hiddenCompletion.V2HiddenCompletionOptions | undefined;
    const original = hiddenCompletion.createV2HiddenCompletionExecutor;
    const create = spyOn(hiddenCompletion, "createV2HiddenCompletionExecutor").mockImplementation(
        async (host, options) => {
            wired = options;
            const executor = await original(host, options);
            return {
                ...executor,
                dispose: async () => {
                    order.push("hidden-runs-cancelled");
                    await executor.dispose();
                },
            };
        },
    );
    cleanups.push(() => {
        load.mockRestore();
        probe.mockRestore();
        create.mockRestore();
    });

    const dispose = await setup(fakeHost(projectDirectory()));
    expect(wired?.holdStore).toBeDefined();
    if (!wired?.holdStore) return;
    const options = wired;
    // A hidden run in flight holds the pool from open to close.
    const release = wired.holdStore();
    const readFailure = (): string => {
        try {
            options.openReader().close?.();
            return "opened";
        } catch (error) {
            return String(error);
        }
    };

    await dispose();
    expect(order).toEqual(["hidden-runs-cancelled"]);
    // Still open for the holder: a read fails only because this throwaway
    // data directory has no OpenCode store, never because the pool closed.
    expect(readFailure()).not.toContain("Store reader pool is closed");
    release();
    expect(readFailure()).toContain("Store reader pool is closed");
});
