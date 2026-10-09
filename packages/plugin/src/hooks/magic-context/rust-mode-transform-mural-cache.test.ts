import { expect, spyOn, test } from "bun:test";

import { insertMemory } from "../../features/magic-context/memory";
import { runMigrations } from "../../features/magic-context/migrations";
import * as muralRenderer from "../../features/magic-context/mural/render-mural";
import { resolveMuralWire } from "../../features/magic-context/mural/render-trigger";
import * as muralResolver from "../../features/magic-context/mural/resolve-mural";
import * as muralRevision from "../../features/magic-context/mural/source-revision";
import { getMural, upsertMural } from "../../features/magic-context/mural/storage-mural";
import {
    computeCueContentHash,
    setMuralCue,
} from "../../features/magic-context/mural/storage-mural-cues";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import {
    clearModelsDevCache,
    modelSupportsVision,
    refreshModelLimitsFromApi,
} from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    createRustModeTransform,
    type RustModeModuleClient,
    type RustModeTransformOptions,
} from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

const project = process.cwd();
const providerID = "mural-cache-provider";
const modelID = "mural-cache-model";

async function refreshCatalog(vision: boolean): Promise<void> {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: providerID,
                            models: {
                                [modelID]: {
                                    limit: { context: 200_000 },
                                    modalities: { input: vision ? ["text", "image"] : ["text"] },
                                },
                            },
                        },
                    ],
                },
            }),
        },
    });
    expect(modelSupportsVision(providerID, modelID)).toBe(vision);
}

function createFixture(
    sessionId: string,
    disableCache = false,
    muralResolverForTests?: RustModeTransformOptions["muralResolverForTests"],
) {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => [row],
        readMessageOrdinalPage: (after, limit) => (after ? [] : [row].slice(0, limit)),
        getStoredMessageCount: () => 1,
        readMessagePartsById: () => ({
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
            createdAt: 1,
        }),
    });
    for (let index = 0; index < 20; index++) {
        const content = `Memory ${index}: ${"important architecture constraint ".repeat(20)}`;
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE_DECISIONS",
            content,
            importance: 100 - index,
        });
        setMuralCue(
            db,
            project,
            memory.id,
            `architecture cue ${index}`,
            computeCueContentHash(content),
        );
    }
    const muralOnPass: boolean[] = [];
    const muralHashOnPass: Array<string | undefined> = [];
    const modelOnPass: unknown[] = [];
    let rowVersion = 0;
    const messages: MessageLike[] = [
        {
            info: { id: "m1", role: "user", sessionID: sessionId, model: { providerID, modelID } },
            parts: [{ type: "text", text: "hello" }],
        },
    ];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method !== "transform") return { ok: true };
            const request = body as {
                mural?: {
                    data_url?: string;
                    content_hash?: string;
                    supports_vision?: boolean;
                };
                model_key?: string;
            };
            const hasMural = typeof request.mural?.data_url === "string";
            if (hasMural) {
                expect(request.mural?.data_url).toStartWith("data:image/png;base64,");
                expect(request.mural?.supports_vision).toBe(true);
            }
            muralOnPass.push(hasMural);
            muralHashOnPass.push(request.mural?.content_hash);
            modelOnPass.push(request.model_key);
            return {
                decision: "HARD",
                row_version: ++rowVersion,
                rendered_memory_ids: [],
                native_messages: structuredClone(messages),
            };
        },
    };
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: project,
        projectPath: project,
        memoryConfig: { enabled: false, injectionBudgetTokens: 1, autoPromote: false },
        liveModelBySession: new Map([[sessionId, { providerID, modelID }]]),
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        muralEnabled: true,
    };
    const transform = createRustModeTransform(deps, {
        moduleClient,
        disableHotPathIoCachesForTests: disableCache,
        muralResolverForTests,
        scheduleLkgCapture: (capture) => capture(),
    });
    return {
        db,
        muralOnPass,
        muralHashOnPass,
        modelOnPass,
        async run() {
            deps.pendingMaterializationSessions.add(sessionId);
            const input = structuredClone(messages);
            await transform.run(
                sessionId,
                input,
                { messages: structuredClone(input) },
                getOrCreateSessionMeta(db, sessionId),
            );
        },
        dispose() {
            unregister();
            closeReadOnlySessionDb();
            resetLkgSlotsForTest();
            clearModelsDevCache();
            db.close();
        },
    };
}

for (const scenario of [
    {
        name: "cached adapter removes mural after same-model vision support is revoked",
        initial: true,
        corrected: false,
        disableCache: false,
        expected: [true, false, false],
    },
    {
        name: "cached adapter supplies mural after same-model vision support becomes available",
        initial: false,
        corrected: true,
        disableCache: false,
        expected: [false, true, true],
    },
    {
        name: "uncached adapter honors same-model vision correction",
        initial: true,
        corrected: false,
        disableCache: true,
        expected: [true, false, false],
    },
]) {
    test(scenario.name, async () => {
        const fixture = createFixture(scenario.name, scenario.disableCache);
        try {
            await refreshCatalog(scenario.initial);
            await fixture.run();
            await refreshCatalog(scenario.corrected);
            const fresh = resolveMuralWire(
                fixture.db,
                project,
                `${providerID}/${modelID}`,
                true,
                1,
            );
            expect(Boolean(fresh.dataUrl)).toBe(scenario.corrected);
            await fixture.run();
            await fixture.run();
            expect(fixture.modelOnPass).toEqual(Array(3).fill(`${providerID}/${modelID}`));
            expect(fixture.muralOnPass).toEqual(scenario.expected);
        } finally {
            fixture.dispose();
        }
    });
}

test("an updated durable artifact reaches the next HARD response instead of the stale memo", async () => {
    const durableResolver: NonNullable<RustModeTransformOptions["muralResolverForTests"]> = (
        db,
        projectIdentity,
    ) => {
        const artifact = projectIdentity ? getMural(db, projectIdentity) : null;
        return artifact
            ? {
                  enabled: true,
                  supportsVision: true,
                  dataUrl: `data:image/png;base64,${artifact.image.toString("base64")}`,
                  contentHash: artifact.contentHash,
              }
            : { enabled: true, supportsVision: true };
    };
    const fixture = createFixture("mural-cache-artifact-update", false, durableResolver);
    const writeArtifact = (contentHash: string, renderedAt: number): void => {
        upsertMural(fixture.db, {
            projectPath: project,
            image: Buffer.from(contentHash),
            contentHash,
            renderedAt,
            model: null,
            memoryIds: [],
            width: 1,
            height: 1,
        });
    };
    try {
        await refreshCatalog(true);
        writeArtifact("mural-hash-a", 100);
        await fixture.run();
        writeArtifact("mural-hash-b", 200);
        await fixture.run();
        expect(fixture.muralHashOnPass).toEqual(["mural-hash-a", "mural-hash-b"]);
    } finally {
        fixture.dispose();
    }
});

test("HARD opportunities check source revisions without re-resolving unchanged cues", async () => {
    const fixture = createFixture("mural-cache-stable-verdict");
    const render = spyOn(muralRenderer, "renderPlannedMural");
    const resolve = spyOn(muralResolver, "resolveMural");
    const revision = spyOn(muralRevision, "muralSourceRevision");
    try {
        let renderedAt: number | undefined;
        for (let pass = 0; pass < 5; pass++) {
            await refreshCatalog(true);
            await fixture.run();
            const artifact = getMural(fixture.db, project);
            expect(artifact).not.toBeNull();
            renderedAt ??= artifact!.renderedAt;
            expect(artifact!.renderedAt).toBe(renderedAt);
        }
        expect(fixture.muralOnPass).toEqual([true, true, true, true, true]);
        expect(revision).toHaveBeenCalledTimes(5);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(render).toHaveBeenCalledTimes(1);
    } finally {
        render.mockRestore();
        resolve.mockRestore();
        revision.mockRestore();
        fixture.dispose();
    }
});
