import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSessionHooksAsync } from "../../plugin/hooks/create-session-hooks";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { createToolRegistry } from "../../plugin/tool-registry";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createV2StorageGate, probeV2StorageAtBoot } from "../../v2/hooks/storage-gate";
import {
    clearHookInitFailure,
    createFailClosedController,
    getLastHookInitFailure,
    isFailClosedBlockingError,
} from "./fail-closed-block";
import { __setMigrationWorkerEntryForTests } from "./migration-worker-client";
import { getMainThreadMigrationBodyCount } from "./migrations";
import { closeDatabase, resolveDatabasePath } from "./storage-db";

let root: string;
const old = { ...process.env };
beforeEach(() => {
    root = createTestTempDir("worker-host-refusal-").dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
    process.env.XDG_DATA_HOME = root;
    closeDatabase();
    clearHookInitFailure();
    __setMigrationWorkerEntryForTests(pathToFileURL(join(root, "missing-worker.mjs")));
});
afterEach(() => {
    __setMigrationWorkerEntryForTests(null);
    closeDatabase();
    clearHookInitFailure();
    process.env = { ...old };
    rmSync(root, { recursive: true, force: true });
});

test("OpenCode 1 async boot records worker-load failure and refuses the primary transform", async () => {
    const before = getMainThreadMigrationBodyCount();
    const hooks = await createSessionHooksAsync({
        ctx: { client: {}, directory: root },
        pluginConfig: { enabled: true },
        liveSessionState: {},
    } as never);
    expect(hooks.magicContext).toBeNull();
    expect(
        Object.keys(
            createToolRegistry({
                ctx: { client: {}, directory: root },
                pluginConfig: { enabled: true },
            } as never),
        ),
    ).toEqual([]);
    const failure = getLastHookInitFailure();
    expect(failure?.type).toBe("storage");
    if (failure?.type !== "storage") throw new Error("storage refusal missing");
    const controller = createFailClosedController();
    controller.arm(failure.reason);
    const handler = createMessagesTransformHandler({
        magicContext: hooks.magicContext,
        failClosed: controller,
        failClosedBlockingEnabled: true,
    });
    const output = {
        messages: [
            {
                info: { role: "user", id: "m", sessionID: "s" },
                parts: [{ type: "text", text: "unmanaged must not send" }],
            },
        ],
    } as never;
    await expect(handler({}, output)).rejects.toThrow("migration worker could not start");
    expect(getMainThreadMigrationBodyCount()).toBe(before);
});

test("OpenCode 2 boot gate refuses worker-load failure before any unmanaged request", async () => {
    const before = getMainThreadMigrationBodyCount();
    const gate = createV2StorageGate();
    expect(await probeV2StorageAtBoot(gate)).toBeUndefined();
    expect(gate.reason()?.kind).toBe("storage_failure");
    let error: unknown;
    try {
        gate.require();
    } catch (e) {
        error = e;
    }
    expect(isFailClosedBlockingError(error)).toBe(true);
    expect(String(error)).toContain("reinstall or rebuild the plugin");
    expect(getMainThreadMigrationBodyCount()).toBe(before);
    expect(resolveDatabasePath().dbPath.startsWith(root)).toBe(true);
});
