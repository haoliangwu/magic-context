import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedTextForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "../../features/magic-context/project-embedding-registry";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import * as bootstrap from "../../plugin/embedding-bootstrap";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import { createV2EmbeddingScope } from "./embedding-lifecycle";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

test("context disposal unregisters only projects without another live context", async () => {
    const shared = createTestTempDirFromPath(join(tmpdir(), "embedding-shared-"));
    const unshared = createTestTempDirFromPath(join(tmpdir(), "embedding-unshared-"));
    const db = openDatabase(join(shared, "context.db"))!;
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        subc: { connection_file: join(shared, "run", "subc-connection.json") },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const gate = spyOn(storageGate, "createV2StorageGate").mockReturnValue({
        current: () => db,
        require: () => db,
        probe: async () => db,
        reason: () => null,
    });
    const disposedModels: string[] = [];
    _setTestProviderFactoryForProject((embedding) => ({
        modelId: embedding.model!,
        maxInputTokens: 512,
        initialize: async () => true,
        isLoaded: () => true,
        embed: async () => new Float32Array([1, 2]),
        embedBatch: async (texts) => texts.map(() => new Float32Array([1, 2])),
        dispose: async () => {
            disposedModels.push(embedding.model!);
        },
    }));
    const create = (directory: string) =>
        registerContext({
            location: { directory },
            agent: { transform: async () => {}, reload: async () => {} },
            model: { list: () => [] },
            storage: { get: async () => undefined, set: async () => {} },
            event: { subscribe: async function* () {} },
            tool: { hook: async () => {} },
            session: {
                remove: async () => {},
                compact: async () => {},
                wait: async () => {},
                interrupt: async () => {},
                hook: async () => {},
                get: async () => ({ location: { directory } }),
            },
        } as unknown as V2Context);
    const contexts: Awaited<ReturnType<typeof registerContext>>[] = [];
    try {
        contexts.push(await create(shared), await create(shared), await create(unshared));
        expect(contexts.every(Boolean)).toBe(true);
        const sharedProject = resolveProjectIdentityForSession(shared)!;
        const unsharedProject = resolveProjectIdentityForSession(unshared)!;
        expect(sharedProject).not.toBe(unsharedProject);
        for (const [project, model, directory] of [
            [sharedProject, "shared", shared],
            [unsharedProject, "unshared", unshared],
        ]) {
            registerProjectEmbedding(
                db,
                project!,
                { provider: "local", model },
                { memoryEnabled: true, gitCommitEnabled: false },
                directory!,
            );
            expect(await embedTextForProject(project!, "load provider")).not.toBeNull();
        }
        await contexts[0]!.dispose();
        expect(getProjectEmbeddingSnapshot(sharedProject)).not.toBeNull();
        expect(disposedModels).toEqual([]);
        await contexts[2]!.dispose();
        expect(getProjectEmbeddingSnapshot(unsharedProject)).toBeNull();
        expect(getProjectEmbeddingSnapshot(sharedProject)).not.toBeNull();
        expect(disposedModels).toEqual(["unshared"]);
        await contexts[0]!.dispose();
        expect(getProjectEmbeddingSnapshot(sharedProject)).not.toBeNull();
        await contexts[1]!.dispose();
        expect(getProjectEmbeddingSnapshot(sharedProject)).toBeNull();
        expect(disposedModels).toEqual(["unshared", "shared"]);
    } finally {
        for (const context of contexts) await context?.dispose();
        load.mockRestore();
        gate.mockRestore();
        _resetProjectEmbeddingRegistryForTests();
        resetCtxReduceRegisteredGloballyForTest();
        closeDatabase();
        cleanupTestTempDir(shared);
        cleanupTestTempDir(unshared);
    }
});

test("embedding scopes release session projects and wait for late registration before disposal", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "embedding-scope-"));
    const db = openDatabase(join(dir, "context.db"))!;
    let finish!: () => void;
    const routing = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const ensure = spyOn(
        bootstrap,
        "ensureProjectRegisteredFromOpenCodeDirectory",
    ).mockImplementation(async (directory, database, options) => {
        if (directory === "late") await routing;
        registerProjectEmbedding(
            database,
            directory,
            { provider: "off" },
            { memoryEnabled: true, gitCommitEnabled: false },
            dir,
        );
        options?.onRegistered?.(directory);
    });
    const first = createV2EmbeddingScope();
    const second = createV2EmbeddingScope();
    try {
        await first.ensureRegistered("shared", db);
        await first.ensureRegistered("shared", db);
        await second.ensureRegistered("shared", db);
        await first.ensureRegistered("session-specific", db);
        const registration = first.ensureRegistered("late", db);
        const disposing = first.dispose();
        await first.ensureRegistered("after-dispose", db);
        expect(getProjectEmbeddingSnapshot("after-dispose")).toBeNull();
        finish();
        await registration;
        await disposing;
        expect(getProjectEmbeddingSnapshot("late")).toBeNull();
        expect(getProjectEmbeddingSnapshot("session-specific")).toBeNull();
        expect(getProjectEmbeddingSnapshot("shared")).not.toBeNull();
        await first.dispose();
        expect(getProjectEmbeddingSnapshot("shared")).not.toBeNull();
        await second.dispose();
        expect(getProjectEmbeddingSnapshot("shared")).toBeNull();
    } finally {
        finish();
        await first.dispose();
        await second.dispose();
        ensure.mockRestore();
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        cleanupTestTempDir(dir);
    }
});
