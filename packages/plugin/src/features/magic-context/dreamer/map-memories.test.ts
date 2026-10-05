/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory } from "../memory";
import {
    getMemoryVerifications,
    getUnmappedMemoryIds,
    recordMemoryMapping,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getSubagentInvocations } from "../storage-subagent-invocations";
import { acquireLease } from "./lease";
import {
    applyBatchMappings,
    computeMapBatchSliceMs,
    MAP_BATCH_FLOOR_MS,
    type MapMemoriesArgs,
    mapMemories,
    selectMapMemoryInputs,
    shouldRequeueIndependentMapping,
} from "./map-memories";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "mc-map-memories-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "fact.ts"), "export const fact = true;", "utf8");
    return dir;
}

function mapArgs(db: Database, sessionDirectory: string, projectIdentity: string): MapMemoriesArgs {
    const holderId = "map-holder";
    const leaseKey = `map-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: "ses-parent",
        sessionDirectory,
        holderId,
        leaseKey,
        // Every direct mapping test that reaches the loop needs enough budget to
        // clear the production floor; deadline-stop fixtures override this value.
        deadline: Date.now() + MAP_BATCH_FLOOR_MS + 60_000,
    };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function scriptedMapClient(manifestFor: (promptCall: number, ids: number[]) => string): {
    client: unknown;
    promptCalls: () => number;
    promptIds: () => number[][];
} {
    let promptCalls = 0;
    let lastIds: number[] = [];
    const promptedIds: number[][] = [];
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "map-child" } }),
                prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    promptCalls += 1;
                    const prompt = args.body?.parts?.[0]?.text ?? "";
                    lastIds = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                    promptedIds.push(lastIds);
                    return {};
                },
                messages: async () => ({
                    data: assistantMessages(manifestFor(promptCalls, lastIds)),
                }),
                delete: async () => ({}),
            },
        },
        promptCalls: () => promptCalls,
        promptIds: () => promptedIds,
    };
}

function successfulMapClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "map-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

/** The exact timeout-class error from the shared prompt helper. */
function timeoutMapClient(
    onPrompt?: () => void,
    timeoutError: () => unknown = () => new Error("prompt timed out after 99997ms"),
) {
    return {
        session: {
            create: async () => ({ data: { id: "map-child" } }),
            prompt: async () => {
                onPrompt?.();
                throw timeoutError();
            },
            abort: async () => ({}),
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    };
}

describe("mapMemories disposition", () => {
    test("banks a completed batch and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-deadline";
            const dir = tempProject();
            for (let index = 0; index < 21; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Independent fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await mapMemories(args);

            expect(result).toEqual({
                mapped: 0,
                independent: 20,
                batches: 1,
                remaining: 1,
                complete: false,
                stopReason: "deadline",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("floors a 12-batch default-deadline backfill and banks its first completed batch", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-floor-primary";
            const dir = tempProject();
            // 221 memories produce 12 batches. The old even split assigned only
            // 100 seconds (1,200,000 / 12) to each batch, below the agentic floor.
            const defaultDeadlineMs = 20 * 60 * 1000;
            expect(Math.floor(defaultDeadlineMs / 12)).toBe(100_000);
            expect(computeMapBatchSliceMs(defaultDeadlineMs, 12)).toBe(MAP_BATCH_FLOOR_MS);
            for (let index = 0; index < 221; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Large-backlog mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.deadline = Date.now() + defaultDeadlineMs;
            let promptCalls = 0;
            args.client = successfulMapClient(() => {
                promptCalls += 1;
                // One full floor-sized batch completed; no fair slice remains for
                // batch two, so its untouched inputs must stay banked for resume.
                args.deadline = Date.now() + 60_000;
            }) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(1);
            expect(result).toEqual({
                mapped: 0,
                independent: 20,
                batches: 1,
                remaining: 201,
                complete: false,
                stopReason: "deadline",
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toHaveLength(201);
        } finally {
            closeQuietly(db);
        }
    });

    test("stops before the next batch when the remaining deadline cannot fit the floor", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-floor-stop";
            const dir = tempProject();
            for (let index = 0; index < 21; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Floor-boundary mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            let promptCalls = 0;
            args.client = successfulMapClient(() => {
                promptCalls += 1;
                args.deadline = Date.now() + 60_000;
            }) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(1);
            expect(result).toEqual({
                mapped: 0,
                independent: 20,
                batches: 1,
                remaining: 1,
                complete: false,
                stopReason: "deadline",
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("two consecutive batch timeouts trip the starvation circuit breaker", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-timeout-breaker";
            const dir = tempProject();
            // Three batches prove the third is left unattempted by the two-timeout breaker.
            for (let index = 0; index < 61; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Timeout mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            let promptCalls = 0;
            args.client = timeoutMapClient(() => {
                promptCalls += 1;
            }) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(2);
            expect(result).toEqual({
                mapped: 0,
                independent: 0,
                batches: 0,
                remaining: 61,
                complete: false,
                stopReason: "timeout-circuit-breaker",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("two consecutive host request timeouts also trip the starvation circuit breaker", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-host-timeout-breaker";
            const dir = tempProject();
            for (let index = 0; index < 61; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Host timeout mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            let promptCalls = 0;
            // Bun's fetch rejects with this DOMException when the host client's own
            // request timer fires on a long synchronous prompt.
            args.client = timeoutMapClient(
                () => {
                    promptCalls += 1;
                },
                () => new DOMException("The operation timed out.", "TimeoutError"),
            ) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(2);
            expect(result.stopReason).toBe("timeout-circuit-breaker");
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("a failed batch row records the child's tokens and model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-failed-row-evidence";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Evidence mapping fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.parentSessionId = "ses-parent-map";
            // A step-capped loop ends with prose instead of a manifest.
            args.client = {
                session: {
                    create: async () => ({ data: { id: "map-child" } }),
                    prompt: async () => ({}),
                    messages: async () => ({
                        data: [
                            {
                                info: {
                                    role: "assistant",
                                    providerID: "openai",
                                    modelID: "gpt-map",
                                    time: { created: 1, completed: 2 },
                                    finish: "stop",
                                    tokens: {
                                        input: 900,
                                        output: 120,
                                        cache: { read: 0, write: 0 },
                                    },
                                },
                                parts: [{ type: "text", text: "I mapped most of them." }],
                            },
                        ],
                    }),
                    delete: async () => ({}),
                },
            } as never;

            await mapMemories(args);

            const [row] = getSubagentInvocations(db, "ses-parent-map", { subagent: "dreamer" });
            expect(row).toMatchObject({
                task: "map-memories",
                status: "failed",
                providerId: "openai",
                modelId: "gpt-map",
                inputTokens: 900,
                outputTokens: 120,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("a later run resumes the durable remainder after a floored partial run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-floor-resume";
            const dir = tempProject();
            for (let index = 0; index < 41; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Resumable mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient(() => {
                args.deadline = Date.now() + 60_000;
            }) as never;

            const first = await mapMemories(args);
            expect(first).toMatchObject({ independent: 20, batches: 1, remaining: 21 });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toHaveLength(21);

            args.deadline = Date.now() + 2 * MAP_BATCH_FLOOR_MS;
            args.client = successfulMapClient() as never;
            const second = await mapMemories(args);

            expect(second).toEqual({
                mapped: 0,
                independent: 21,
                batches: 2,
                remaining: 0,
                complete: true,
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("commits a 19/20 closed subset and retries only its omitted id", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-omission-retry";
            const dir = tempProject();
            const memoryIds: number[] = [];
            for (let index = 0; index < 20; index += 1) {
                memoryIds.push(
                    insertMemory(db, {
                        projectPath: projectIdentity,
                        category: "ARCHITECTURE",
                        content: `Mapping omission fact ${index}.`,
                        sourceSessionId: "ses",
                    }).id,
                );
            }
            const progress: number[] = [];
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient((call, ids) => {
                if (call === 2) {
                    // The closing root makes the first response complete rather than
                    // truncated, so its returned mappings can commit immediately. Only
                    // its one absent id is present in the retry prompt.
                    expect(ids).toHaveLength(1);
                    expect(getMemoryVerifications(db, memoryIds).size).toBe(19);
                    expect(getMemoryVerifications(db, ids).has(ids[0] as number)).toBe(false);
                }
                const returnedIds = call === 1 ? ids.slice(0, -1) : ids;
                return `<mappings>${returnedIds.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`;
            });
            args.client = scripted.client as never;
            args.onProgress = (processed) => progress.push(processed);

            const result = await mapMemories(args);

            expect(scripted.promptCalls()).toBe(2);
            const promptIds = scripted.promptIds();
            const initialPrompt = promptIds[0];
            const retryPrompt = promptIds[1];
            if (!initialPrompt || !retryPrompt) throw new Error("missing prompt fixture");
            expect(initialPrompt).toHaveLength(20);
            expect([...initialPrompt].sort((a, b) => a - b)).toEqual(
                [...memoryIds].sort((a, b) => a - b),
            );
            expect(retryPrompt).toEqual([initialPrompt[initialPrompt.length - 1]]);
            expect(progress).toEqual([19, 20]);
            expect(result).toEqual({
                mapped: 0,
                independent: 20,
                batches: 2,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("leaves an id omitted again by its targeted retry for the next run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-omission-resume";
            const dir = tempProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First resumable fact.",
                sourceSessionId: "ses",
            });
            const second = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Second resumable fact.",
                sourceSessionId: "ses",
            });
            const firstRun = mapArgs(db, dir, projectIdentity);
            const partial = scriptedMapClient((call) =>
                call === 1
                    ? `<mappings><memory id="${first.id}" independent="true"/></mappings>`
                    : "<mappings></mappings>",
            );
            firstRun.client = partial.client as never;

            const firstResult = await mapMemories(firstRun);

            const [initialPrompt, retryPrompt] = partial.promptIds();
            if (!initialPrompt || !retryPrompt) throw new Error("missing prompt fixture");
            expect(initialPrompt).toHaveLength(2);
            expect([...initialPrompt].sort((a, b) => a - b)).toEqual([first.id, second.id]);
            // Mapping prioritizes by the memory query's recency ordering. The retry
            // contract is that the unreturned id, rather than a fixed prompt position,
            // is the one left for the next run.
            expect(retryPrompt).toEqual([second.id]);
            expect(firstResult).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 1,
                complete: false,
            });
            expect(
                selectMapMemoryInputs(db, projectIdentity, dir).map((memory) => memory.id),
            ).toEqual([second.id]);

            const resumed = mapArgs(db, dir, projectIdentity);
            const complete = scriptedMapClient(
                (_call, ids) =>
                    `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`,
            );
            resumed.client = complete.client as never;

            const resumedResult = await mapMemories(resumed);

            expect(complete.promptIds()).toEqual([[second.id]]);
            expect(resumedResult).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("converges all-rejected paths into a marked fallback across consecutive runs", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-rejected-fallback";
            const dir = tempProject();
            // The host rejects both in-repo untracked paths and paths outside the
            // repository. The mixed manifest proves the fallback is all-rejected,
            // not a special case for only one rejection reason.
            execFileSync("git", ["init", "-q"], { windowsHide: true, cwd: dir });
            execFileSync("git", ["add", "src/fact.ts"], { windowsHide: true, cwd: dir });
            writeFileSync(
                path.join(dir, "src", "untracked.ts"),
                "export const draft = true;",
                "utf8",
            );
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/untracked.ts.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient(
                (_call, ids) =>
                    `<mappings>${ids.map((id) => `<memory id="${id}" files="src/untracked.ts,/outside-project/fact.ts"/>`).join("")}</mappings>`,
            );
            args.client = scripted.client as never;

            const first = await mapMemories(args);

            expect(first).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state).toMatchObject({
                files: [],
                hasSentinel: true,
                mappingOrigin: "host_rejected_fallback",
            });
            expect(getUnmappedMemoryIds(db, [memory.id])).toEqual([]);
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);

            const second = await mapMemories(args);
            expect(second).toEqual({
                mapped: 0,
                independent: 0,
                batches: 0,
                remaining: 0,
                complete: true,
            });
            expect(scripted.promptCalls()).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-complete";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient() as never;

            expect(await mapMemories(args)).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed batch failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-failure";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await mapMemories(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("mapMemories retry-time validation", () => {
    test("wrong-but-rooted empty parse fires the fallback model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-retry-empty";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient((call, ids) =>
                call === 1
                    ? `<mappings>\n<map id="1">\nsrc/fact.ts\n</map>\n</mappings>`
                    : `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`,
            );
            args.client = scripted.client as never;
            args.fallbackModels = ["anthropic/claude-sonnet-4-6"];

            const result = await mapMemories(args);
            expect(scripted.promptCalls()).toBe(2);
            expect(result).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("an unclosed subset rejects the full batch before the fallback retry", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-retry-coverage";
            const dir = tempProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First fact.",
                sourceSessionId: "ses",
            });
            const second = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Second fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient((call, ids) =>
                call === 1
                    ? `<mappings><memory id="${first.id}" independent="true"/>`
                    : `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`,
            );
            args.client = scripted.client as never;
            args.fallbackModels = ["anthropic/claude-sonnet-4-6"];

            const result = await mapMemories(args);
            expect(scripted.promptCalls()).toBe(2);
            const promptIds = scripted.promptIds();
            expect(promptIds[0]).toEqual(promptIds[1]);
            expect([...new Set(promptIds[0])].sort((a, b) => a - b)).toEqual(
                [first.id, second.id].sort((a, b) => a - b),
            );
            expect(result.independent).toBe(2);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyBatchMappings", () => {
    test("complete manifest writes the mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.files).toEqual([
                "src/fact.ts",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("overrides a directive-shaped PROJECT_RULES file mapping to independent", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:directive-map-safety";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content:
                    "When told to check a cache bust, run src/fact.ts first and never reason by hand.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: ["src/fact.ts"],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 0, independent: 1 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)).toMatchObject({
                files: [],
                hasSentinel: true,
                mappingOrigin: "host_rejected_fallback",
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("preserves mapper-authored independent as distinct from the host fallback", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-mapper-independent";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" independent="true"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 0, independent: 1 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.mappingOrigin).toBe(
                "mapper",
            );
            expect(selectMapMemoryInputs(db, projectIdentity, dir).map(({ id }) => id)).toEqual([
                memory.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("keeps accepted paths when a manifest only partially fails normalization", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-partial-rejection";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts,/outside-project/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)).toMatchObject({
                files: ["src/fact.ts"],
                hasSentinel: false,
                mappingOrigin: "mapper",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("truncated manifest rejects before replacing an existing mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryMapping(db, memory.id, [], 1_000);

            await expect(
                applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/fact.ts"/>`,
                ),
            ).rejects.toThrow(/closing root/);

            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual([]);
            expect(state?.hasSentinel).toBe(true);
            expect(state?.mappedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("drops unknown ids and commits the valid remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-unknown";
            const dir = tempProject();
            const mapped = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Mapped fact.",
                sourceSessionId: "ses",
            });
            const omitted = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Omitted fact.",
                sourceSessionId: "ses",
            });
            const unknown = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Wrong-batch fact.",
                sourceSessionId: "ses",
            });
            const batch = [mapped, omitted].map((memory) => ({
                id: memory.id,
                category: memory.category,
                content: memory.content,
                candidates: [] as string[],
            }));

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                batch,
                `<mappings><memory id="${mapped.id}" independent="true"/><memory id="${unknown.id}" independent="true"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 0, independent: 1 });
            const states = getMemoryVerifications(db, [mapped.id, omitted.id, unknown.id]);
            expect(states.has(mapped.id)).toBe(true);
            expect(states.has(omitted.id)).toBe(false);
            expect(states.has(unknown.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a manifest covering less than half of the batch", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-mostly-wrong";
            const dir = tempProject();
            const batchMemories = ["First", "Second", "Third"].map((content) =>
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content,
                    sourceSessionId: "ses",
                }),
            );
            const unknown = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Wrong-batch fact.",
                sourceSessionId: "ses",
            });
            const batch = batchMemories.map((memory) => ({
                id: memory.id,
                category: memory.category,
                content: memory.content,
                candidates: [] as string[],
            }));

            await expect(
                applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    batch,
                    `<mappings><memory id="${batchMemories[0]?.id}" independent="true"/><memory id="${unknown.id}" independent="true"/></mappings>`,
                ),
            ).rejects.toThrow(/mostly-wrong manifest/);
            expect(
                getMemoryVerifications(
                    db,
                    batch.map((memory) => memory.id),
                ).size,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("nested file children persist as a real mapping, not independent", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-nested";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}"><file path="src/fact.ts"/></memory></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/fact.ts"]);
            expect(state?.hasSentinel).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("independent re-queue heal", () => {
    test("predicate selects a path-seeded independent and skips a conceptual bystander", () => {
        const dir = tempProject();
        expect(
            shouldRequeueIndependentMapping(
                { hasSentinel: true, files: [] },
                "Fact lives in src/fact.ts.",
                dir,
            ),
        ).toBe(true);
        expect(
            shouldRequeueIndependentMapping(
                { hasSentinel: true, files: [] },
                "Anthropic returns 400 on empty content.",
                dir,
            ),
        ).toBe(false);
        expect(
            shouldRequeueIndependentMapping(
                { hasSentinel: false, files: ["src/fact.ts"] },
                "Fact lives in src/fact.ts.",
                dir,
            ),
        ).toBe(false);
    });

    test("selectMapMemoryInputs re-queues the corrupted row and leaves the bystander mapped", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-requeue";
            const dir = tempProject();
            const corrupted = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });
            const bystander = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: "Anthropic returns 400 on empty content.",
                sourceSessionId: "ses",
            });
            recordMemoryMapping(db, corrupted.id, [], 1_000);
            recordMemoryMapping(db, bystander.id, [], 1_000);

            const selected = selectMapMemoryInputs(db, projectIdentity, dir);
            expect(selected.map((row) => row.id)).toEqual([corrupted.id]);
            expect(selected[0]?.candidates).toEqual(["src/fact.ts"]);

            const bystanderState = getMemoryVerifications(db, [bystander.id]).get(bystander.id);
            expect(bystanderState?.hasSentinel).toBe(true);
            expect(bystanderState?.files).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("map-memories module applier", () => {
    test("writes through memory.set_mapping using shared context row ids", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-map";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "The module owns this mapped memory.",
            });
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = mapArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [memory.id], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-map",
                moduleProjectRoot: dir,
                moduleCommandId: "map-command",
            };

            expect(
                await applyBatchMappings(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" independent="true"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 1 });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                method: "memory.set_mapping",
                body: {
                    arguments: {
                        memory_project: projectIdentity,
                        rows: [
                            {
                                memory_id: memory.id,
                                content_hash_at_prompt: memory.normalizedHash,
                                mapped_files: null,
                            },
                        ],
                    },
                },
            });
            expect(getMemoryVerifications(db, [memory.id]).size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("preserves host-rejected fallback origin through a MODULE mapping call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-map-fallback";
            const dir = tempProject();
            execFileSync("git", ["init", "-q"], { windowsHide: true, cwd: dir });
            execFileSync("git", ["add", "src/fact.ts"], { windowsHide: true, cwd: dir });
            writeFileSync(
                path.join(dir, "src", "untracked.ts"),
                "export const draft = true;",
                "utf8",
            );
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "The module-owned fact references a rejected path.",
            });
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = mapArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [memory.id], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-map-fallback",
                moduleProjectRoot: dir,
                moduleCommandId: "map-fallback-command",
            };

            expect(
                await applyBatchMappings(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/untracked.ts,/outside-project/fact.ts"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 1 });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                method: "memory.set_mapping",
                body: {
                    arguments: {
                        memory_project: projectIdentity,
                        rows: [
                            {
                                memory_id: memory.id,
                                content_hash_at_prompt: memory.normalizedHash,
                                mapped_files: null,
                                mapping_origin: "host_rejected_fallback",
                            },
                        ],
                    },
                },
            });
            expect(getMemoryVerifications(db, [memory.id]).size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
    test("overrides directive file mappings before a MODULE mapping call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-map-directive";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: "When told to inspect a fact, run src/fact.ts first.",
            });
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = mapArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [memory.id], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-map-directive",
                moduleProjectRoot: dir,
                moduleCommandId: "map-directive-command",
            };

            expect(
                await applyBatchMappings(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: ["src/fact.ts"],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 1 });
            expect(calls[0]).toMatchObject({
                method: "memory.set_mapping",
                body: {
                    arguments: {
                        rows: [
                            {
                                memory_id: memory.id,
                                mapped_files: null,
                                mapping_origin: "host_rejected_fallback",
                            },
                        ],
                    },
                },
            });
        } finally {
            closeQuietly(db);
        }
    });
});
test("a budget-finalized mapping manifest banks its closed subset", async () => {
    const db = freshDb();
    try {
        const projectIdentity = "git:budget-map";
        const dir = tempProject();
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "Budgeted mapping fact.",
        });
        const others = Array.from({ length: 51 }, (_, index) =>
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: `Another mapping fact ${index} for the next run.`,
            }),
        );
        const covered = selectMapMemoryInputs(db, projectIdentity, dir).slice(0, 2);
        const messages: unknown[] = [];
        let sends = 0;
        let aborted = false;
        const args = mapArgs(db, dir, projectIdentity);
        args.tokenBudget = 100;
        args.deadline = Date.now() + MAP_BATCH_FLOOR_MS + 500;
        args.parentSessionId = "ses-parent-map";
        args.client = {
            session: {
                create: async () => ({ data: { id: "map-budget-child" } }),
                messages: async () => ({ data: [...messages] }),
                abort: async () => {
                    aborted = true;
                    return { data: true };
                },
                status: async () => {
                    if (sends === 1 && !aborted) {
                        if (messages.length === 1)
                            messages.push({
                                info: {
                                    id: "step",
                                    role: "assistant",
                                    finish: "tool-calls",
                                    tokens: { input: 81 },
                                    time: { created: 1, completed: 2 },
                                },
                                parts: [{ type: "tool" }],
                            });
                        return { data: { "map-budget-child": { type: "busy" } } };
                    }
                    if (sends === 2 && messages.length === 3)
                        messages.push({
                            info: {
                                id: "final",
                                role: "assistant",
                                finish: "stop",
                                tokens: { input: 25 },
                                time: { created: 3, completed: 4 },
                            },
                            parts: [
                                {
                                    type: "text",
                                    text: `<mappings>${covered.map((item) => `<memory id="${item.id}" files="src/fact.ts"/>`).join("")}</mappings>`,
                                },
                            ],
                        });
                    return { data: {} };
                },
                promptAsync: async (request: { body: { parts: Array<{ text: string }> } }) => {
                    sends++;
                    messages.push({
                        info: { id: `user-${sends}`, role: "user" },
                        parts: request.body.parts,
                    });
                    return { data: undefined };
                },
                delete: async () => ({}),
            },
        } as never;
        const result = await mapMemories(args);
        expect(sends).toBe(2);
        expect(result.mapped).toBe(2);
        expect(result.remaining).toBe(50);
        expect(result.complete).toBe(false);
        expect(
            selectMapMemoryInputs(db, projectIdentity, dir)
                .map((item) => item.id)
                .sort((a, b) => a - b),
        ).toEqual(
            [memory, ...others]
                .filter((item) => !covered.some((entry) => entry.id === item.id))
                .map((item) => item.id)
                .sort((a, b) => a - b),
        );
        for (const item of covered) {
            expect(getMemoryVerifications(db, [item.id]).get(item.id)?.files).toEqual([
                "src/fact.ts",
            ]);
        }
    } finally {
        closeQuietly(db);
    }
});

test("non-budget mapping rejects a 10/52 manifest without writes", async () => {
    const db = freshDb();
    try {
        const project = "git:non-budget-map";
        const dir = tempProject();
        const items = Array.from({ length: 52 }, (_, index) =>
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Fact ${index}.`,
            }),
        );
        const args = mapArgs(db, dir, project);
        await expect(
            applyBatchMappings(
                args,
                selectMapMemoryInputs(db, project, dir),
                `<mappings>${items
                    .slice(0, 10)
                    .map((item) => `<memory id="${item.id}" files="src/fact.ts"/>`)
                    .join("")}</mappings>`,
            ),
        ).rejects.toThrow("rejecting mostly-wrong manifest");
        expect(selectMapMemoryInputs(db, project, dir)).toHaveLength(52);
    } finally {
        closeQuietly(db);
    }
});
