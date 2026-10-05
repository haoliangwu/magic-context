import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { formatEmbedStatusText } from "../../hooks/magic-context/format-embed-status";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    buildCanonicalChunkTextFromFts,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import type { GitCommit } from "./git-commits/git-log-reader";
import {
    countEmbeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { upsertCommits } from "./git-commits/storage-git-commits";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import { insertMemory } from "./memory/storage-memory";
import { loadAllEmbeddings, saveEmbedding } from "./memory/storage-memory-embeddings";
import { backfillMessageFtsRowidMapBatch, recordMessageFtsRowid } from "./message-fts-rowid-map";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setShadowBackfillNowForTests,
    _setTestProviderFactoryForProject,
    embedUnembeddedCompartmentChunksForProject,
    flushShadowEmbeddingBacklog,
    formatShadowBackfillStall,
    getEmbeddingCoverageStatus,
    getProjectEmbeddingSnapshot,
    getShadowBackfillRemaining,
    getShadowBackfillStopReason,
    getShadowEmbeddingMeasurementCohort,
    listShadowBackfillStalls,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectShadowEmbedding,
    sweepStaleEmbeddingIdentitiesForProject,
} from "./project-embedding-registry";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { closeDatabase, openDatabase } from "./storage";

class FakeEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    constructor(
        modelId: string,
        private readonly embedBatchImpl?: (texts: string[]) => Array<Float32Array | null>,
    ) {
        this.modelId = modelId;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        return new Float32Array([text.length, 1]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Array<Float32Array | null>> {
        return (
            this.embedBatchImpl?.(texts) ?? texts.map((text) => new Float32Array([text.length, 1]))
        );
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function localConfig(model: string, maxInputTokens?: number): EmbeddingConfig {
    return {
        provider: "local",
        model,
        ...(maxInputTokens === undefined ? {} : { max_input_tokens: maxInputTokens }),
    };
}

/** Two fingerprints yield two distinct Synapse shadow identities (modelIds). */
function synapseConfig(fingerprint: string): EmbeddingConfig {
    return {
        provider: "synapse",
        model: "synapse-model",
        synapse_fingerprint: fingerprint,
        synapse_table_epoch: 1,
        synapse_dims: 8,
        max_input_tokens: 8192,
    } as unknown as EmbeddingConfig;
}

function makeGitCommit(shaSeed: string, committedAtMs: number): GitCommit {
    const sha = shaSeed.padEnd(40, shaSeed);
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `commit ${shaSeed}`,
        author: "dev@example.com",
        committedAtMs,
    };
}

function primaryModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
}

function primaryChunkModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
}

/** The shadow lane's current modelId (a Synapse identity), distinct from primary. */
function shadowModelId(projectIdentity: string): string {
    return getShadowEmbeddingMeasurementCohort(projectIdentity)?.modelId ?? "off";
}

function shadowChunkModelId(projectIdentity: string): string {
    return getShadowEmbeddingMeasurementCohort(projectIdentity)?.chunkModelId ?? "off";
}

function countShadowMemoryRows(
    db: ReturnType<typeof openDatabase>,
    projectIdentity: string,
    modelId: string,
): number {
    return loadAllEmbeddings(db, projectIdentity, modelId).size;
}

describe("shadow embedding historical backfill", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = createTestTempDirFromPath(join(tmpdir(), "shadow-backfill-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        // These fixtures model upgraded stores; do not depend on startup completing synchronously.
        if (db) backfillMessageFtsRowidMapBatch(db);
        return db;
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

    function useFakeProviders(
        embedBatchImpl?: (config: EmbeddingConfig, texts: string[]) => Array<Float32Array | null>,
    ) {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(
                    config.provider === "local" ? config.model : "shadow",
                    embedBatchImpl ? (texts) => embedBatchImpl(config, texts) : undefined,
                ),
        );
    }

    function seedPrimaryMemories(
        db: ReturnType<typeof openDatabase>,
        projectIdentity: string,
        count: number,
    ): void {
        const modelId = primaryModelId(projectIdentity);
        for (let i = 0; i < count; i++) {
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: `historical memory ${i}`,
            });
            saveEmbedding(db, memory.id, new Float32Array([i, 1]), modelId);
        }
    }

    it("re-embeds the historical corpus under the new identity after a rotation, in bounded chunks", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-rotate";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-rotate",
        );
        // 150 > SHADOW_MAX_ITEMS_PER_TICK (64), so a single-transaction dump is
        // impossible: the drain must span multiple bounded worker passes.
        seedPrimaryMemories(db, projectIdentity, 150);

        // Pre-rotation state: the corpus was already mirrored under identity A.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-rotate",
        );
        const shadowA = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countShadowMemoryRows(db, projectIdentity, shadowA)).toBe(150);

        // Rotation: a new fingerprint registers a brand-new shadow identity. The
        // historical corpus now lacks rows under it and must be re-embedded.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-rotate",
        );
        const shadowB = shadowModelId(projectIdentity);
        expect(shadowB).not.toBe(shadowA);
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(150);

        let passes = 0;
        const remainingSeen: number[] = [];
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
            remainingSeen.push(getShadowBackfillRemaining(db, projectIdentity).memory);
        });

        // Drained to completion under the new identity...
        expect(countShadowMemoryRows(db, projectIdentity, shadowB)).toBe(150);
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(0);
        // ...incrementally (more than one bounded pass), never one big dump...
        expect(passes).toBeGreaterThanOrEqual(2);
        // ...with the outstanding count monotonically falling to zero.
        expect(remainingSeen[remainingSeen.length - 1]).toBe(0);
        for (let i = 1; i < remainingSeen.length; i++) {
            expect(remainingSeen[i]).toBeLessThanOrEqual(
                remainingSeen[i - 1] ?? Number.MAX_SAFE_INTEGER,
            );
        }
        // The old identity's rows coexist until the 14-day GC ages them out.
        expect(countShadowMemoryRows(db, projectIdentity, shadowA)).toBe(150);
    });

    it("backfills commits alongside memories on rotation", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-rotate-commits";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-rotate-commits",
        );
        upsertCommits(db, projectIdentity, [
            makeGitCommit("c-a", 1000),
            makeGitCommit("c-b", 2000),
        ]);
        const modelId = primaryModelId(projectIdentity);
        saveCommitEmbedding(db, "c-a".padEnd(40, "c-a"), new Float32Array([1, 1]), modelId);
        saveCommitEmbedding(db, "c-b".padEnd(40, "c-b"), new Float32Array([1, 1]), modelId);

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-rotate-commits",
        );
        const shadowA = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowA)).toBe(2);

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-rotate-commits",
        );
        const shadowB = shadowModelId(projectIdentity);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(2);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowB)).toBe(2);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(0);
    });

    it("arms the backfill on a first registration over an existing primary corpus (rotation while down)", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-cold-start";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-cold-start",
        );
        seedPrimaryMemories(db, projectIdentity, 5);

        // No prior shadow registration exists in-memory (e.g. the plugin was down
        // when the fingerprint rotated), but historical primary rows do. Registering
        // the current shadow identity must still detect the gap and backfill it.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-current"),
            "/tmp/shadow-cold-start",
        );
        const shadowModel = shadowModelId(projectIdentity);
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(5);

        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countShadowMemoryRows(db, projectIdentity, shadowModel)).toBe(5);
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(0);
    });

    it("does not enqueue a backfill when the shadow identity is unchanged", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-unchanged";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-unchanged",
        );
        seedPrimaryMemories(db, projectIdentity, 5);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-same"),
            "/tmp/shadow-unchanged",
        );
        const shadowModel = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countShadowMemoryRows(db, projectIdentity, shadowModel)).toBe(5);

        // Re-registering the SAME identity (a routine boot/config reload) must not
        // re-arm a backfill: the corpus is already covered under it.
        let passes = 0;
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-same"),
            "/tmp/shadow-unchanged",
        );
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
        });
        expect(passes).toBe(0);
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(0);
        expect(countShadowMemoryRows(db, projectIdentity, shadowModel)).toBe(5);
    });

    it("does not enqueue a backfill while the project's config load is untrusted", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-untrusted";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-untrusted",
        );
        seedPrimaryMemories(db, projectIdentity, 5);

        // A degraded config load latches the project after the trusted primary
        // registration; the shadow backfill must respect that latch and not enqueue.
        markProjectLoadUntrusted(projectIdentity);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-untrusted",
        );
        const shadowModel = shadowModelId(projectIdentity);

        let passes = 0;
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
        });
        expect(passes).toBe(0);
        expect(countShadowMemoryRows(db, projectIdentity, shadowModel)).toBe(0);
        // The gap is still outstanding; a later trusted registration would clear it.
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(5);
    });

    it("is idempotent: re-detecting after a completed backfill enqueues no duplicates", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-idempotent";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-idempotent",
        );
        seedPrimaryMemories(db, projectIdentity, 5);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-idempotent",
        );
        const shadowModel = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countShadowMemoryRows(db, projectIdentity, shadowModel)).toBe(5);

        // Simulate a process restart: in-memory registrations are gone but the DB
        // (with the completed backfill) persists. Re-registering the same identity
        // runs detection again and must find nothing missing → no enqueue.
        _resetProjectEmbeddingRegistryForTests();
        useFakeProviders();
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-idempotent",
        );
        let passes = 0;
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-idempotent",
        );
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
        });
        expect(passes).toBe(0);
        expect(countShadowMemoryRows(db, projectIdentity, shadowModel)).toBe(5);
        expect(getShadowBackfillRemaining(db, projectIdentity).memory).toBe(0);
    });

    it("GC protects the new shadow identity while the old one ages out", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-gc";
        const now = Date.now();
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-gc",
        );
        seedPrimaryMemories(db, projectIdentity, 3);

        // Mirror under identity A, then rotate to B and backfill it.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-gc",
        );
        const shadowA = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-gc",
        );
        const shadowB = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countShadowMemoryRows(db, projectIdentity, shadowA)).toBe(3);
        expect(countShadowMemoryRows(db, projectIdentity, shadowB)).toBe(3);

        // Age the OLD shadow identity past the 14-day grace. The new identity is
        // the live shadow registration and must stay protected.
        db.prepare(
            "UPDATE embedding_identity_active SET last_active_at = ? WHERE project_path = ? AND model_id = ?",
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, shadowA);

        const swept = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(swept.memoryRowsDeleted).toBe(3);
        // Old identity aged out; new identity (current shadow) is protected.
        expect(countShadowMemoryRows(db, projectIdentity, shadowA)).toBe(0);
        expect(countShadowMemoryRows(db, projectIdentity, shadowB)).toBe(3);
    });

    it("declares shadow chunks drained only after missing keys and stale hashes are repaired", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-hash-complete";
        const sessionId = "ses-shadow-hash-complete";
        const shadowConfig = synapseConfig("fp-hash-complete");
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-hash-complete",
        );
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-hash-complete",
        );
        recordSessionProjectIdentity(db, sessionId, projectIdentity);
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "u1",
                endMessageId: "u1",
                title: "Missing shadow window",
                content: "missing",
                p1: "missing",
            },
            {
                sequence: 1,
                startMessage: 2,
                endMessage: 2,
                startMessageId: "u2",
                endMessageId: "u2",
                title: "Stale shadow hash",
                content: "stale",
                p1: "stale",
            },
            {
                sequence: 2,
                startMessage: 3,
                endMessage: 3,
                startMessageId: "u3",
                endMessageId: "u3",
                title: "Clean shadow row",
                content: "clean",
                p1: "clean",
            },
        ]);
        for (const [ordinal, content] of [
            [1, "missing shadow transcript"],
            [2, "stale shadow transcript"],
            [3, "clean shadow transcript"],
        ] as const) {
            const result = db
                .prepare(
                    "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)",
                )
                .run(sessionId, ordinal, `u${ordinal}`, content) as {
                lastInsertRowid: number | bigint;
            };
            recordMessageFtsRowid(db, sessionId, ordinal, result.lastInsertRowid);
        }

        const compartments = getCompartments(db, sessionId);
        const primaryChunk = primaryChunkModelId(projectIdentity);
        const shadowChunk = shadowChunkModelId(projectIdentity);
        const windows = new Map(
            compartments.map((compartment) => [
                compartment.id,
                chunkCanonicalText(
                    buildCanonicalChunkTextFromFts(
                        db,
                        sessionId,
                        compartment.startMessage,
                        compartment.endMessage,
                    ) ?? "",
                    compartment.startMessage,
                    compartment.endMessage,
                    10_000,
                ),
            ]),
        );
        const write = (
            compartmentId: number,
            modelId: string,
            rows: ReturnType<typeof chunkCanonicalText>,
        ) =>
            replaceCompartmentChunkEmbeddings(
                db,
                rows.map((window) => ({
                    compartmentId,
                    sessionId,
                    projectPath: projectIdentity,
                    window,
                    modelId,
                    vector: new Float32Array([1, 0]),
                })),
            );
        for (const compartment of compartments) {
            write(compartment.id, primaryChunk, windows.get(compartment.id) ?? []);
        }
        const [missing, stale, clean] = compartments;
        write(
            stale.id,
            shadowChunk,
            (windows.get(stale.id) ?? []).map((window) => ({
                ...window,
                chunkHash: `old-${window.chunkHash}`,
            })),
        );
        write(clean.id, shadowChunk, windows.get(clean.id) ?? []);

        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(2);
        expect(getShadowBackfillStopReason(projectIdentity, "chunk")).toBeUndefined();

        // Verify both predicates independently: a stale hash remains outstanding
        // after the missing row is repaired, and the missing row remains outstanding
        // after the stale hash is repaired. An existence-only predicate would
        // incorrectly report no remaining work in the stale-only state.
        write(missing.id, shadowChunk, windows.get(missing.id) ?? []);
        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(1);
        db.prepare(
            "DELETE FROM compartment_chunk_embeddings WHERE compartment_id = ? AND model_id = ?",
        ).run(missing.id, shadowChunk);
        write(stale.id, shadowChunk, windows.get(stale.id) ?? []);
        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(1);

        // Restore both defects, then verify that the normal bounded worker uses
        // its rotation-aware selection to discover and replace both rows during
        // routine backfill.
        write(
            stale.id,
            shadowChunk,
            (windows.get(stale.id) ?? []).map((window) => ({
                ...window,
                chunkHash: `old-again-${window.chunkHash}`,
            })),
        );
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-hash-complete",
        );
        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(2);
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(0);
        expect(getShadowBackfillStopReason(projectIdentity, "chunk")).toBe("drained");
        for (const compartment of compartments) {
            expect(
                chunkEmbeddingWindowsAreCurrent(
                    db,
                    compartment.id,
                    shadowChunk,
                    windows.get(compartment.id) ?? [],
                    projectIdentity,
                ),
            ).toBe(true);
        }
    });

    it("writes a production-seeded primary chunk through the shadow window contract", async () => {
        let primaryCalls = 0;
        let shadowCalls = 0;
        useFakeProviders((config, texts) => {
            if (config.provider === "synapse") shadowCalls += 1;
            else primaryCalls += 1;
            return texts.map((text) => new Float32Array([text.length, 1]));
        });
        const db = useTempDb();
        const projectIdentity = "git:shadow-production-chunk";
        const sessionId = "ses-shadow-production-chunk";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary", 512),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-production-chunk",
        );
        recordSessionProjectIdentity(db, sessionId, projectIdentity);
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "a1",
                endMessageId: "a1",
                title: "Production-sized chunk",
                content: "large transcript",
                p1: "large transcript",
            },
        ]);
        const content = Array.from({ length: 2_000 }, (_, index) => `token-${index}`).join(" ");
        const result = db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, 1, 'a1', 'assistant', ?)",
            )
            .run(sessionId, content) as { lastInsertRowid: number | bigint };
        recordMessageFtsRowid(db, sessionId, 1, result.lastInsertRowid);

        expect(await embedUnembeddedCompartmentChunksForProject(db, projectIdentity, 8)).toBe(1);
        expect(primaryCalls).toBeGreaterThan(0);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-production-chunk"),
            "/tmp/shadow-production-chunk",
        );
        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(1);

        await flushShadowEmbeddingBacklog(projectIdentity);

        const writes = (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE project_path = ? AND model_id = ?",
                )
                .get(projectIdentity, shadowChunkModelId(projectIdentity)) as { count: number }
        ).count;
        expect(shadowCalls).toBe(1);
        expect(writes).toBeGreaterThan(0);
        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(0);
        expect(getShadowBackfillStopReason(projectIdentity, "chunk")).toBe("drained");
    });

    it("durably latches an unchanged no-progress batch across registrations", async () => {
        let shadowCalls = 0;
        const installProviders = () =>
            useFakeProviders((config, texts) => {
                if (config.provider === "synapse") {
                    shadowCalls += 1;
                    return texts.map(() => null);
                }
                return texts.map((text) => new Float32Array([text.length, 1]));
            });
        installProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-durable-stall";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-durable-stall",
        );
        seedPrimaryMemories(db, projectIdentity, 1);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-durable-stall"),
            "/tmp/shadow-durable-stall",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(shadowCalls).toBe(1);
        expect(listShadowBackfillStalls(db, projectIdentity)).toMatchObject([
            { scope: "memory", writeRefusalReason: "provider_returned_no_vectors" },
        ]);
        const status = formatEmbedStatusText(
            getEmbeddingCoverageStatus(db, projectIdentity, "ses-no-history"),
            { status: "idle" },
        );
        expect(status).toContain(
            "Shadow memory: stalled_no_progress — the provider returned no vectors.",
        );

        _resetProjectEmbeddingRegistryForTests();
        installProviders();
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-durable-stall",
        );
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-durable-stall"),
            "/tmp/shadow-durable-stall",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(shadowCalls).toBe(1);
        expect(getShadowBackfillStopReason(projectIdentity, "memory")).toBe("stalled_no_progress");

        const added = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "new corpus row changes the durable candidate signature",
        });
        saveEmbedding(db, added.id, new Float32Array([2, 1]), primaryModelId(projectIdentity));
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-durable-stall"),
            "/tmp/shadow-durable-stall",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(shadowCalls).toBe(2);
    });

    it("surfaces the write guard that rejected an otherwise valid vector", async () => {
        const db = useTempDb();
        const projectIdentity = "git:shadow-write-guard";
        let mutated = false;
        useFakeProviders((config, texts) => {
            if (config.provider === "synapse" && !mutated) {
                mutated = true;
                db.prepare(
                    "UPDATE memories SET normalized_hash = 'changed-in-flight' WHERE project_path = ?",
                ).run(projectIdentity);
            }
            return texts.map((text) => new Float32Array([text.length, 1]));
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-write-guard",
        );
        seedPrimaryMemories(db, projectIdentity, 1);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-write-guard"),
            "/tmp/shadow-write-guard",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        const [stall] = listShadowBackfillStalls(db, projectIdentity);
        expect(stall).toMatchObject({
            scope: "memory",
            writeRefusalReason: "memory_hash_guard_rejected",
        });
        expect(formatShadowBackfillStall(stall!)).toContain(
            "memory normalized-hash guard rejected vectors",
        );
        const coverage = getEmbeddingCoverageStatus(db, projectIdentity, "ses-no-history");
        expect(formatEmbedStatusText(coverage, { status: "idle" })).toContain(
            "the memory normalized-hash guard rejected vectors",
        );
        expect(
            formatEmbedStatusText(
                {
                    ...coverage,
                    shadowBackfillStalls: [
                        {
                            ...stall!,
                            writeRefusalReason: "registration_retired_during_embed",
                        },
                    ],
                },
                { status: "idle" },
            ),
        ).toContain(
            "the shadow registration was retired or replaced while the provider call was in flight",
        );
    });

    it("does not resubmit the same shadow bytes within one hour", async () => {
        let now = Date.now();
        let shadowCalls = 0;
        const installProviders = () => {
            _setShadowBackfillNowForTests(() => now);
            useFakeProviders((config, texts) => {
                if (config.provider === "synapse") {
                    shadowCalls += 1;
                    return texts.map(() => null);
                }
                return texts.map((text) => new Float32Array([text.length, 1]));
            });
        };
        installProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-hourly-budget";
        const register = (manualBackfill = false) => {
            registerProjectEmbedding(
                db,
                projectIdentity,
                localConfig("model-primary"),
                { memoryEnabled: true, gitCommitEnabled: false },
                "/tmp/shadow-hourly-budget",
            );
            registerProjectShadowEmbedding(
                db,
                projectIdentity,
                synapseConfig("fp-hourly-budget"),
                "/tmp/shadow-hourly-budget",
                { manualBackfill },
            );
        };
        register();
        seedPrimaryMemories(db, projectIdentity, 1);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-hourly-budget"),
            "/tmp/shadow-hourly-budget",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(shadowCalls).toBe(1);

        _resetProjectEmbeddingRegistryForTests();
        now += 30 * 60 * 1000;
        installProviders();
        register(true);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(shadowCalls).toBe(1);
        expect(listShadowBackfillStalls(db, projectIdentity)).toMatchObject([
            { scope: "memory", writeRefusalReason: "duplicate_submission_budget" },
        ]);

        _resetProjectEmbeddingRegistryForTests();
        now += 31 * 60 * 1000;
        installProviders();
        register(true);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(shadowCalls).toBe(2);
    });
});
