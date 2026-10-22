import { expect, spyOn, test } from "bun:test";
import * as embeddings from "../../features/magic-context/project-embedding-registry";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    clearEmbedSessionState,
    embedPauseBySession,
    embedRunStateBySession,
} from "../../hooks/magic-context/embed-session-state";
import * as bootstrap from "../../plugin/embedding-bootstrap";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { createV2AutoEmbedSession } from "./transform-features";

test("v2 automatic embedding silently drains once and respects a paused session", async () => {
    const dir = createTestTempDir("v2-auto-embed-").dir;
    const db = openDatabase(`${dir}/context.db`);
    if (!db) throw new Error("throwaway store unavailable");
    const register = spyOn(
        bootstrap,
        "ensureProjectRegisteredFromOpenCodeDirectory",
    ).mockResolvedValue();
    const snapshot = spyOn(embeddings, "getProjectEmbeddingSnapshot").mockReturnValue(undefined);
    const coverage = spyOn(embeddings, "getAutoEmbeddingSessionCoverage")
        .mockResolvedValueOnce({ enabled: true, total: 2, embedded: 0 })
        .mockResolvedValue({ enabled: true, total: 2, embedded: 2 });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const drain = spyOn(embeddings, "embedSessionCompartmentChunks").mockImplementation(
        async () => {
            finish();
            return { status: "done", embedded: 2, total: 2, failed: 0 };
        },
    );
    const deadline = setTimeout(() => finish(), 1000);
    try {
        const deps = { db, resolveDirectory: () => dir, recompProgressBySession: new Map() };
        const run = createV2AutoEmbedSession(deps);
        run("ses709embed");
        run("ses709embed");
        await finished;
        while (embedRunStateBySession.has("ses709embed")) await Bun.sleep(1);
        expect(register).toHaveBeenCalledTimes(1);
        expect(coverage).toHaveBeenCalledTimes(2);
        expect(drain).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledWith(db, expect.any(String), "ses709embed", {
            signal: expect.any(AbortSignal),
            automatic: true,
        });
        embedPauseBySession.add("ses709paused");
        run("ses709paused");
        expect(coverage).toHaveBeenCalledTimes(2);
    } finally {
        clearTimeout(deadline);
        clearEmbedSessionState("ses709embed");
        clearEmbedSessionState("ses709paused");
        register.mockRestore();
        snapshot.mockRestore();
        coverage.mockRestore();
        drain.mockRestore();
        closeDatabase();
        cleanupTestTempDir(dir);
    }
});
