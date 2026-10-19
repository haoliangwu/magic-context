import { expect, spyOn, test } from "bun:test";
import * as embeddings from "../../features/magic-context/project-embedding-registry";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import * as drains from "../../hooks/magic-context/embed-history-runner";
import {
    clearEmbedSessionState,
    embedPauseBySession,
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
    const coverage = spyOn(embeddings, "getAutoEmbeddingSessionCoverage").mockResolvedValue({
        enabled: true,
        total: 2,
        embedded: 0,
    } as Awaited<ReturnType<typeof embeddings.getAutoEmbeddingSessionCoverage>>);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const drain = spyOn(drains, "runEmbedHistoryDrain").mockImplementation(async () => {
        finish();
        return "done";
    });
    const deadline = setTimeout(() => finish(), 1000);
    try {
        const deps = { db, resolveDirectory: () => dir, recompProgressBySession: new Map() };
        const run = createV2AutoEmbedSession(deps);
        run("ses709embed");
        run("ses709embed");
        await finished;
        expect(register).toHaveBeenCalledTimes(1);
        expect(coverage).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledWith(deps, "ses709embed", { silent: true });
        embedPauseBySession.add("ses709paused");
        run("ses709paused");
        expect(coverage).toHaveBeenCalledTimes(1);
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
