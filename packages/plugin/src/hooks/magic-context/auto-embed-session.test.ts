import { afterEach, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "../../features/magic-context/compartment-chunk-embedding";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import * as sweepLease from "../../features/magic-context/git-commits/sweep-coordinator";
import {
    acquireGitSweepLease,
    releaseGitSweepLease,
} from "../../features/magic-context/git-commits/sweep-coordinator";
import type { EmbeddingProvider } from "../../features/magic-context/memory/embedding-provider";
import {
    backfillMessageFtsRowidMapBatch,
    recordMessageFtsRowid,
} from "../../features/magic-context/message-fts-rowid-map";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedUnembeddedCompartmentChunksForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "../../features/magic-context/project-embedding-registry";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    resetEmbeddingActivityForTests,
    setEmbeddingSessionBusy,
} from "../../shared/embedding-activity";
import * as logger from "../../shared/logger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { maybeAutoEmbedSessionBackfill } from "./auto-embed-session";
import {
    autoEmbedAttemptedBySession,
    autoEmbedRetryAfterBySession,
    clearEmbedSessionState,
    embedPauseBySession,
    embedRunStateBySession,
} from "./embed-session-state";

const project = "git:auto-backfill-test";
const active = "active-history";
const inactive = "inactive-history";
const originalXdg = process.env.XDG_DATA_HOME;
let dir = "";
let now = 1_800_000_000_000;
let failures = 0;
let calls = 0;
let maxBatch = 0;
let onCall = () => {};
let logs: string[] = [];

function fixture(count = 27) {
    dir = createTestTempDirFromPath(join(tmpdir(), "auto-backfill-"));
    process.env.XDG_DATA_HOME = dir;
    let db = openDatabase();
    backfillMessageFtsRowidMapBatch(db);
    calls = 0;
    failures = 0;
    maxBatch = 0;
    onCall = () => {};
    logs = [];
    spyOn(logger, "log").mockImplementation((...args) => {
        logs.push(args.join(" "));
    });
    const provider: EmbeddingProvider = {
        modelId: "fixture-provider",
        initialize: async () => true,
        isLoaded: () => true,
        dispose: async () => {},
        embed: async () => new Float32Array(1024).fill(1),
        embedBatch: async (texts) => {
            calls++;
            maxBatch = Math.max(maxBatch, texts.length);
            onCall();
            if (failures > 0) {
                failures--;
                // Model a timed-out provider call without sleeping through its timeout.
                now += 10_001;
                return texts.map(() => null);
            }
            return texts.map(() => {
                const backing = new Float32Array(1030).fill(-9);
                return backing.subarray(3, 1027).fill(1);
            });
        },
    };
    _setTestProviderFactoryForProject(() => provider);
    const register = (model: string) => {
        _setTestProviderFactoryForProject(() => provider);
        return registerProjectEmbedding(
            db,
            project,
            { provider: "local", model },
            { memoryEnabled: false, gitCommitEnabled: false },
            dir,
        );
    };
    register("qwen-old");
    for (const [sessionId, n] of [
        [active, count],
        [inactive, 3],
    ] as const) {
        recordSessionProjectIdentity(db, sessionId, project);
        db.transaction(() => {
            appendCompartments(
                db,
                sessionId,
                Array.from({ length: n }, (_, i) => ({
                    sequence: i,
                    startMessage: i + 1,
                    endMessage: i + 1,
                    startMessageId: `u${i}`,
                    endMessageId: `u${i}`,
                    title: `History ${i}`,
                    content: `History ${i}`,
                    p1: `History ${i}`,
                })),
            );
            for (const compartment of getCompartments(db, sessionId)) {
                const ordinal = compartment.startMessage!;
                const text = `History ${ordinal} of ${sessionId}: bounded catch-up survives busy turns.`;
                const row = db
                    .prepare(
                        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)",
                    )
                    .run(sessionId, ordinal, `u${ordinal}`, text);
                recordMessageFtsRowid(db, sessionId, ordinal, row.lastInsertRowid);
                replaceCompartmentChunkEmbeddings(
                    db,
                    chunkCanonicalText(`[${ordinal}] U: ${text}`, ordinal, ordinal, 512).map(
                        (window) => ({
                            compartmentId: compartment.id,
                            sessionId,
                            projectPath: project,
                            window,
                            modelId: getProjectEmbeddingSnapshot(project)!.chunkModelId,
                            vector: new Float32Array(4096).fill(1),
                        }),
                    ),
                );
            }
        })();
    }
    const pass = () =>
        maybeAutoEmbedSessionBackfill(
            {
                db,
                projectIdentity: project,
                ensureRegistered: async () => {},
            },
            active,
        );
    const coverage = (sessionId = active) =>
        (
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM compartment_chunk_embeddings WHERE session_id = ? AND model_id = ?",
                )
                .get(sessionId, getProjectEmbeddingSnapshot(project)!.chunkModelId) as { n: number }
        ).n;
    const restart = () => {
        clearEmbedSessionState(active);
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        db = openDatabase();
        register("voyage-new");
    };
    const expireBackoff = () =>
        db
            .prepare(
                "UPDATE schema_migrations_meta SET value = json_set(value, '$.retryAt', 0) WHERE key LIKE 'chunk_embed_backoff:%'",
            )
            .run();
    return { db, register, pass, coverage, restart, expireBackoff };
}

async function settle(pass: () => void) {
    pass();
    const deadline = performance.now() + 90_000;
    while (embedRunStateBySession.has(active) && performance.now() < deadline) {
        pass();
        await Bun.sleep(5);
    }
    expect(embedRunStateBySession.has(active)).toBe(false);
}

afterEach(() => {
    clearEmbedSessionState(active);
    clearEmbedSessionState(inactive);
    resetEmbeddingActivityForTests();
    _resetProjectEmbeddingRegistryForTests();
    closeDatabase();
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    if (dir) rmSync(dir, { recursive: true, force: true });
    spyOn(Date, "now").mockRestore();
    spyOn(logger, "log").mockRestore();
});

it("re-embeds 1600 old chunks under busy active passes without draining inactive sessions or blocking a turn", async () => {
    const { pass, register, coverage, db } = fixture(1600);
    await settle(pass);
    expect(logs.filter((line) => line.includes("failed"))).toEqual([]);
    expect(autoEmbedAttemptedBySession.has(active), JSON.stringify(logs)).toBe(true);
    calls = 0;
    register("voyage-new");
    setEmbeddingSessionBusy(active, true);
    let last = performance.now();
    let maxBlock = 0;
    let passes = 0;
    const heartbeat = setInterval(() => {
        const time = performance.now();
        maxBlock = Math.max(maxBlock, time - last);
        last = time;
        passes++;
        pass();
    }, 1);
    try {
        const start = performance.now();
        for (let i = 0; i < 40; i++) {
            pass();
            await Bun.sleep(1);
        }
        await settle(pass);
        const elapsed = performance.now() - start;
        expect(coverage()).toBe(1600);
        expect(coverage(inactive)).toBe(0);
        expect(calls).toBe(800);
        expect(maxBatch).toBe(2);
        expect(passes).toBeGreaterThan(100);
        expect(maxBlock).toBeLessThan(50);
        expect(
            db
                .prepare(
                    "SELECT DISTINCT dims FROM compartment_chunk_embeddings WHERE model_id = ?",
                )
                .all(getProjectEmbeddingSnapshot(project)!.chunkModelId),
        ).toEqual([{ dims: 1024 }]);
        const saved = db
            .prepare("SELECT vector FROM compartment_chunk_embeddings WHERE model_id = ? LIMIT 1")
            .get(getProjectEmbeddingSnapshot(project)!.chunkModelId) as { vector: Uint8Array };
        expect(new Set(new Float32Array(saved.vector.slice().buffer))).toEqual(new Set([1]));
        expect(logs.filter((line) => line.includes("session backfill start"))).toHaveLength(1);
        expect(logs.filter((line) => line.includes("session backfill complete"))).toHaveLength(1);
        console.log(
            `1600-chunk busy backfill: passes=${passes} calls=${calls} max_event_loop_gap_ms=${maxBlock.toFixed(2)} elapsed_ms=${elapsed.toFixed(0)}`,
        );
    } finally {
        clearInterval(heartbeat);
    }
}, 120_000);

it("retries project lease contention on later active passes instead of latching busy", async () => {
    const { pass, register, coverage, db } = fixture(9);
    register("voyage-new");
    expect(acquireGitSweepLease(db, project, "sibling", { ignoreCooldown: true }).acquired).toBe(
        true,
    );
    await settle(pass);
    expect(coverage()).toBe(0);
    expect(autoEmbedAttemptedBySession.has(active)).toBe(false);
    expect(logs.some((line) => line.includes("reason=busy"))).toBe(true);
    releaseGitSweepLease(db, project, "sibling");
    spyOn(Date, "now").mockImplementation(() => now);
    await settle(pass);
    expect(coverage()).toBe(9);
});

it("resumes after the three-failed-batch stop and persisted backoff, including a process restart", async () => {
    const { pass, register, coverage, restart, expireBackoff } = fixture();
    register("voyage-new");
    spyOn(Date, "now").mockImplementation(() => now);
    failures = 12;
    await settle(pass);
    expect(calls).toBe(12);
    expect(coverage()).toBe(0);
    expect(autoEmbedAttemptedBySession.has(active)).toBe(false);
    expect(autoEmbedRetryAfterBySession.get(active)).toBeGreaterThan(now);
    expect(logs.some((line) => line.includes("reason=stalled"))).toBe(true);
    // A new host process forgets its latches, but the database retains retryAt.
    restart();
    await settle(pass);
    expect(coverage()).toBeGreaterThanOrEqual(3);
    expect(coverage()).toBeLessThan(27);
    expect(autoEmbedAttemptedBySession.has(active)).toBe(false);
    const before = calls;
    await settle(pass);
    expect(calls).toBe(before);
    now += 86_400_001;
    // The database worker has its own clock; move persisted deadlines into the past as well.
    expect(expireBackoff().changes).toBeGreaterThan(0);
    await settle(pass);
    expect(coverage()).toBe(27);
    expect(autoEmbedAttemptedBySession.has(active)).toBe(true);
    expect(coverage(inactive)).toBe(0);
});

it("resumes remaining chunks after restart during a busy drain", async () => {
    const { pass, register, coverage, restart } = fixture(20);
    register("voyage-new");
    onCall = () => {
        if (calls === 4) embedRunStateBySession.get(active)?.abort();
    };
    await settle(pass);
    expect(coverage()).toBeGreaterThan(0);
    expect(coverage()).toBeLessThan(20);
    onCall = () => {};
    restart();
    setEmbeddingSessionBusy(active, true);
    await settle(pass);
    expect(coverage()).toBe(20);
});

it("passive sweep preserves old-model vectors for an inactive session", async () => {
    const { db, register, coverage } = fixture(2);
    register("voyage-new");
    expect(await embedUnembeddedCompartmentChunksForProject(db, project)).toBe(0);
    expect(coverage(inactive)).toBe(0);
    expect(calls).toBe(0);
    expect(
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM compartment_chunk_embeddings WHERE session_id = ? AND dims = 4096",
            )
            .get(inactive),
    ).toEqual({ n: 3 });
});

it("passive sweep catches never-embedded chunks even in an inactive session", async () => {
    const { db, register, coverage } = fixture(2);
    db.prepare(
        "DELETE FROM compartment_chunk_embeddings WHERE compartment_id = (SELECT MAX(id) FROM compartments WHERE session_id = ?)",
    ).run(inactive);
    register("voyage-new");
    expect(await embedUnembeddedCompartmentChunksForProject(db, project)).toBe(1);
    expect(coverage(inactive)).toBe(1);
    expect(coverage()).toBe(0);
    expect(calls).toBe(1);
});

it("passive sweep replaces old-model vectors after an active context pass", async () => {
    const { db, pass, register, coverage } = fixture(2);
    register("voyage-new");
    // Simulate an embedding run already in progress so pass() records activity
    // without starting another run before the passive sweep below.
    embedRunStateBySession.set(active, new AbortController());
    pass();
    embedRunStateBySession.delete(active);
    expect(await embedUnembeddedCompartmentChunksForProject(db, project)).toBe(2);
    expect(coverage()).toBe(2);
    expect(coverage(inactive)).toBe(0);
});

it("passive sweep respects a paused active session's old-model history", async () => {
    const { db, pass, register, coverage } = fixture(2);
    register("voyage-new");
    embedPauseBySession.add(active);
    pass();
    expect(await embedUnembeddedCompartmentChunksForProject(db, project)).toBe(0);
    expect(coverage()).toBe(0);
    expect(calls).toBe(0);
});

it("automatic file-backed drains keep coordinator writes off the host thread", async () => {
    const { pass, register, coverage } = fixture(2);
    register("voyage-new");
    const acquire = spyOn(sweepLease, "acquireGitSweepLease");
    const renew = spyOn(sweepLease, "renewGitSweepLease");
    const release = spyOn(sweepLease, "releaseGitSweepLease");
    try {
        await settle(pass);
        expect(coverage()).toBe(2);
        expect(acquire).not.toHaveBeenCalled();
        expect(renew).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    } finally {
        acquire.mockRestore();
        renew.mockRestore();
        release.mockRestore();
    }
});

it("passive sweep does not carry old-model session activity across a model change", async () => {
    const { db, pass, register, coverage } = fixture(2);
    embedRunStateBySession.set(active, new AbortController());
    pass();
    embedRunStateBySession.delete(active);
    register("voyage-new");
    expect(await embedUnembeddedCompartmentChunksForProject(db, project)).toBe(0);
    expect(coverage()).toBe(0);
    expect(calls).toBe(0);
});
