import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    registerProjectShadowEmbedding,
} from "./project-embedding-registry";
import type { UnifiedSearchOptions, UnifiedSearchResult } from "./search";
import { recordShadowMeasurement } from "./search-measurement";
import { closeDatabase, openDatabase } from "./storage";

class FakeShadowProvider implements EmbeddingProvider {
    readonly modelId = "synapse:v1:fake";

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        _text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        return new Float32Array([1, 2]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array([1, 2]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

const synapseConfig = {
    provider: "synapse",
    model: "synapse-model",
    synapse_fingerprint: "fp-shadow",
    synapse_table_epoch: 1,
    synapse_dims: 8,
} as unknown as EmbeddingConfig;

describe("recordShadowMeasurement", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = createTestTempDirFromPath(join(tmpdir(), "search-measurement-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        return openDatabase();
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
        tempDirs.length = 0;
    });

    function makeMeasurementArgs(dbOverride: Database) {
        return {
            db: dbOverride,
            sessionId: "ses-shadow",
            projectPath: "git:shadow-measure",
            query: "queue backpressure",
            options: {} as UnifiedSearchOptions,
            primaryResults: [] as UnifiedSearchResult[],
            primaryQuery: null,
            primaryLatencyMs: 5,
            search: async () => [] as UnifiedSearchResult[],
        };
    }

    it("resolves even when the measurement corpus write throws", async () => {
        const db = useTempDb();
        _setTestProviderFactoryForProject(() => new FakeShadowProvider());
        registerProjectShadowEmbedding(db, "git:shadow-measure", synapseConfig, "/tmp/shadow");

        // A closed database makes the terminal recordEmbeddingMeasurement write
        // throw (the SQLITE_BUSY class of failure the guard must contain).
        const closedDb = new Database(":memory:");
        closedDb.close();

        await expect(
            recordShadowMeasurement(makeMeasurementArgs(closedDb)),
        ).resolves.toBeUndefined();
    });

    it("never raises an unhandled rejection when floated like the search call site", async () => {
        const db = useTempDb();
        _setTestProviderFactoryForProject(() => new FakeShadowProvider());
        registerProjectShadowEmbedding(db, "git:shadow-measure", synapseConfig, "/tmp/shadow");

        const closedDb = new Database(":memory:");
        closedDb.close();

        const rejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        process.on("unhandledRejection", onUnhandledRejection);
        try {
            // Mirrors unifiedSearch (search.ts): the measurement is void-floated
            // after results are built, so any rejection would be unhandled.
            void recordShadowMeasurement(makeMeasurementArgs(closedDb));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(rejections).toHaveLength(0);
        } finally {
            process.off("unhandledRejection", onUnhandledRejection);
        }
    });
});
