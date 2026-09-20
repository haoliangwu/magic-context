import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    getProjectEmbeddingSnapshot,
    getShadowEmbeddingMeasurementCohort,
    registerProjectShadowEmbedding,
} from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeUserConfig(configHome: string, config: Record<string, unknown>): void {
    mkdirSync(join(configHome, "cortexkit"), { recursive: true });
    writeFileSync(join(configHome, "cortexkit", "magic-context.json"), JSON.stringify(config));
}

function installShadowProvider(onDispose: () => void): void {
    _setTestProviderFactoryForProject(() => ({
        modelId: "shadow",
        initialize: async () => true,
        embed: async () => new Float32Array([1, 0]),
        embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])),
        dispose: async () => {
            onDispose();
        },
        isLoaded: () => true,
    }));
}

function seedShadowCohort(
    db: ReturnType<typeof openDatabase>,
    identity: string,
    directory: string,
): void {
    registerProjectShadowEmbedding(
        db,
        identity,
        {
            provider: "synapse",
            model: "shadow",
            synapse_fingerprint: "fixture",
        } as unknown as EmbeddingConfig,
        directory,
    );
}

afterEach(() => {
    _resetProjectEmbeddingRegistryForTests();
    closeDatabase();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("ensureProjectRegisteredFromOpenCodeDirectory", () => {
    it("reads the legacy config and registers the real identity (not observation) when only legacy config exists", async () => {
        const projectDir = tempDir("mc-legacy-boot-");
        process.env.HOME = tempDir("mc-legacy-home-");
        process.env.XDG_CONFIG_HOME = tempDir("mc-legacy-config-");
        process.env.XDG_DATA_HOME = tempDir("mc-legacy-data-");
        // Read-legacy-on-conflict: the CortexKit base is absent but THIS harness's
        // legacy project config exists, so it is read and trusted — NOT treated as
        // an untrusted/observation load that would suppress registration. The real
        // embedding identity is registered so the project is fully functional
        // before the user consolidates.
        writeFileSync(
            join(projectDir, "magic-context.jsonc"),
            '{"embedding":{"provider":"openai-compatible","model":"qwen3","endpoint":"http://localhost:1234/v1"}}',
        );
        const db = openDatabase();
        const projectIdentity = resolveProjectIdentity(projectDir);

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
        expect(snapshot?.enabled).toBe(true);
        expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
    });

    it("retires a disabled shadow without removing the primary lane", async () => {
        const projectDir = tempDir("mc-shadow-disable-");
        process.env.HOME = tempDir("mc-shadow-disable-home-");
        const configHome = tempDir("mc-shadow-disable-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-shadow-disable-data-");
        let disposed = false;
        installShadowProvider(() => {
            disposed = true;
        });
        writeUserConfig(configHome, {
            embedding: { provider: "off" },
            shadow_embedding: { enabled: false },
        });
        const db = openDatabase();
        const identity = resolveProjectIdentity(projectDir);
        seedShadowCohort(db, identity, projectDir);
        expect(getShadowEmbeddingMeasurementCohort(identity)?.fingerprint).toBe("fixture");

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        expect(getShadowEmbeddingMeasurementCohort(identity)).toBeNull();
        expect(getProjectEmbeddingSnapshot(identity)?.provider).toBe("off");
        expect(disposed).toBe(true);
    });

    it("retires a shadow lane that becomes unavailable without removing the primary lane", async () => {
        const projectDir = tempDir("mc-shadow-unavailable-");
        process.env.HOME = tempDir("mc-shadow-unavailable-home-");
        const configHome = tempDir("mc-shadow-unavailable-config-");
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = tempDir("mc-shadow-unavailable-data-");
        let disposed = false;
        installShadowProvider(() => {
            disposed = true;
        });
        writeUserConfig(configHome, {
            embedding: {
                provider: "openai-compatible",
                model: "qwen3",
                endpoint: "http://127.0.0.1:9/v1",
            },
            shadow_embedding: { enabled: true },
            subc: { connection_file: join(configHome, "absent-subc.json") },
        });
        const db = openDatabase();
        const identity = resolveProjectIdentity(projectDir);
        seedShadowCohort(db, identity, projectDir);
        expect(getShadowEmbeddingMeasurementCohort(identity)?.fingerprint).toBe("fixture");

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        expect(getShadowEmbeddingMeasurementCohort(identity)).toBeNull();
        expect(getProjectEmbeddingSnapshot(identity)?.provider).toBe("openai-compatible");
        expect(disposed).toBe(true);
    });
});
