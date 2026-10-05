/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as projectIdentity from "../../features/magic-context/memory/project-identity";
import * as registry from "../../features/magic-context/project-embedding-registry";
import * as bootstrap from "../../plugin/embedding-bootstrap";
import type { Database } from "../../shared/sqlite";
import type { RecompProgress } from "./compartment-runner-types";
import { runEmbedHistoryDrain } from "./embed-history-runner";
import { embedRunStateBySession } from "./embed-session-state";

const restores: Array<() => void> = [];

afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    embedRunStateBySession.clear();
});

function stubProjectResolution(registration: Promise<void> = Promise.resolve()): {
    registrations: () => number;
} {
    let registrations = 0;
    const register = spyOn(bootstrap, "ensureProjectRegisteredFromOpenCodeDirectory");
    register.mockImplementation(async () => {
        registrations += 1;
        await registration;
    });
    const identity = spyOn(projectIdentity, "resolveProjectIdentityForSession");
    identity.mockImplementation(() => "project-identity");
    const coverage = spyOn(registry, "getEmbeddingCoverageStatus");
    coverage.mockImplementation(
        () =>
            ({ session: { embedded: 1, total: 4 } }) as ReturnType<
                typeof registry.getEmbeddingCoverageStatus
            >,
    );
    restores.push(
        () => register.mockRestore(),
        () => identity.mockRestore(),
        () => coverage.mockRestore(),
    );
    return { registrations: () => registrations };
}

function deps(progress: Map<string, RecompProgress>) {
    return {
        db: {} as Database,
        resolveDirectory: () => "/tmp/project",
        recompProgressBySession: progress,
    };
}

describe("runEmbedHistoryDrain", () => {
    it("leaves a failed progress entry, not a running one, when the drain throws", async () => {
        stubProjectResolution();
        const embed = spyOn(registry, "embedSessionCompartmentChunks");
        embed.mockImplementation(async () => {
            throw new Error("database is locked");
        });
        restores.push(() => embed.mockRestore());
        const progress = new Map<string, RecompProgress>();

        await expect(runEmbedHistoryDrain(deps(progress), "ses-throw")).rejects.toThrow(
            "database is locked",
        );

        expect(progress.get("ses-throw")).toMatchObject({
            kind: "embed",
            phase: "failed",
            message: "Embedding stopped: database is locked",
        });
        expect(embedRunStateBySession.has("ses-throw")).toBe(false);
    });

    it("answers a second start as already running while the first is still registering", async () => {
        let finishRegistration!: () => void;
        const registration = new Promise<void>((resolve) => {
            finishRegistration = resolve;
        });
        const { registrations } = stubProjectResolution(registration);
        const signals: AbortSignal[] = [];
        const embed = spyOn(registry, "embedSessionCompartmentChunks");
        embed.mockImplementation(async (_db, _identity, _session, options) => {
            if (options?.signal) signals.push(options.signal);
            // Let the competing start run to completion before this drain reads its signal.
            await new Promise((resolve) => setTimeout(resolve, 10));
            return options?.signal?.aborted
                ? { status: "aborted" as const, embedded: 1, total: 4, failed: 0 }
                : { status: "done" as const, embedded: 3, total: 4, failed: 0 };
        });
        restores.push(() => embed.mockRestore());
        const progress = new Map<string, RecompProgress>();

        const first = runEmbedHistoryDrain(deps(progress), "ses-race");
        const second = runEmbedHistoryDrain(deps(progress), "ses-race");
        finishRegistration();

        expect(await second).toBe("Embedding is already running for this session.");
        expect(await first).toBe("Embedded 3 compartments of history for semantic search.");
        expect(registrations()).toBe(1);
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(false);
    });
});
