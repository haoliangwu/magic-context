/// <reference types="bun-types" />

/**
 * A dreamer model that stops answering must not hold a task's whole slice and
 * then end the chain: on OpenCode's prompt_async wait the attempt is cut at the
 * first-output deadline and the configured fallback runs. A model that has
 * streamed anything keeps its full timeout. Each dreamer path that sends through
 * the shared model chain is exercised here against an OpenCode host double.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory } from "../memory";
import { recordMemoryVerifications } from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { type ClassifyArgs, type ClassifyModuleCallArgs, runClassify } from "./classify";
import { acquireLease } from "./lease";
import { MAP_BATCH_FLOOR_MS, mapMemories } from "./map-memories";
import { runVerify } from "./verify";

const PRIMARY = "opencode/deepseek-v4.1-flash-free";
const FALLBACK = "anthropic/claude-sonnet-5-5";
/**
 * Production uses DREAMER_FIRST_OUTPUT_TIMEOUT_MS. The prompt_async wait polls the
 * child once a second, so the deadline here must leave room for the first poll to
 * see a streamed part.
 */
const FIRST_OUTPUT_MS = 2_000;
/** Per-test bound: a few poll cycles plus one first-output deadline. */
const TEST_TIMEOUT_MS = 20_000;

/**
 * "dead": the host writes the empty assistant row it creates before the provider
 * responds, then the run stays busy forever. "partial": a text part streams, then
 * the run stays busy forever. "slow": a text part streams and the answer settles
 * well after the first-output deadline. "answer": the answer settles on the next poll.
 */
type Behaviour = "dead" | "partial" | "slow" | "answer";

type HostMessage = {
    info: {
        id: string;
        role: string;
        time: { created: number; completed?: number };
        finish?: string;
        error?: unknown;
        tokens?: { input: number; output: number; cache: { read: number; write: number } };
        providerID?: string;
        modelID?: string;
    };
    parts: Array<{ type: string; text?: string }>;
};

type ChildRun = {
    behaviour: Behaviour;
    answer: string;
    model: string;
    sentAt: number;
};

function opencodeHost(
    behaviours: Record<string, Behaviour>,
    answerFor: (prompt: string) => string,
) {
    const sessions = new Map<string, HostMessage[]>();
    const runs = new Map<string, ChildRun | null>();
    const sent: string[] = [];
    let created = 0;
    let rows = 0;

    const settle = (sessionId: string, run: ChildRun) => {
        const last = sessions.get(sessionId)?.at(-1);
        if (last?.info.role !== "assistant" || last.info.time.completed) return;
        last.info.time.completed = Date.now();
        last.info.finish = "stop";
        last.info.tokens = { input: 900, output: 60, cache: { read: 0, write: 0 } };
        const [providerID, modelID] = run.model.split("/");
        last.info.providerID = providerID;
        last.info.modelID = modelID;
        last.parts = [{ type: "text", text: run.answer }];
        runs.set(sessionId, null);
    };

    const client = {
        session: {
            create: async () => {
                const id = `child-${++created}`;
                sessions.set(id, []);
                return { data: { id } };
            },
            promptAsync: async (request: {
                path: { id: string };
                body: {
                    model?: { providerID: string; modelID: string };
                    parts?: Array<{ text?: string }>;
                };
            }) => {
                const model = request.body.model
                    ? `${request.body.model.providerID}/${request.body.model.modelID}`
                    : PRIMARY;
                sent.push(model);
                const behaviour = behaviours[model] ?? "answer";
                const messages = sessions.get(request.path.id) ?? [];
                sessions.set(request.path.id, messages);
                messages.push({
                    info: { id: `msg_${++rows}`, role: "user", time: { created: Date.now() } },
                    parts: [{ type: "text", text: request.body.parts?.[0]?.text ?? "" }],
                });
                messages.push({
                    info: { id: `msg_${++rows}`, role: "assistant", time: { created: Date.now() } },
                    parts: behaviour === "dead" ? [] : [{ type: "text", text: "<" }],
                });
                runs.set(request.path.id, {
                    behaviour,
                    answer: answerFor(request.body.parts?.[0]?.text ?? ""),
                    model,
                    sentAt: Date.now(),
                });
                return { data: undefined };
            },
            status: async () => {
                const busy: Record<string, { type: string }> = {};
                for (const [sessionId, run] of runs) {
                    if (!run) continue;
                    const due =
                        run.behaviour === "answer" ||
                        (run.behaviour === "slow" &&
                            Date.now() - run.sentAt >= 2 * FIRST_OUTPUT_MS);
                    if (due) settle(sessionId, run);
                    else busy[sessionId] = { type: "busy" };
                }
                return { data: busy };
            },
            messages: async (args: { path: { id: string } }) => ({
                data: (sessions.get(args.path.id) ?? []).map((message) => ({ ...message })),
            }),
            abort: async (args: { path: { id: string } }) => {
                const last = sessions.get(args.path.id)?.at(-1);
                if (last?.info.role === "assistant" && !last.info.time.completed) {
                    last.info.time.completed = Date.now();
                    last.info.error = { name: "MessageAbortedError", data: { message: "aborted" } };
                }
                runs.set(args.path.id, null);
                return { data: true };
            },
            delete: async () => ({ data: true }),
            prompt: async () => {
                throw new Error("the prompt_async host must not receive a synchronous prompt");
            },
        },
    };
    return { client: client as never, sent };
}

function idsIn(prompt: string): number[] {
    return [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
}

const classifyAnswer = (prompt: string) =>
    `<classify>${idsIn(prompt)
        .map((id) => `<memory id="${id}" importance="80" scope="project" shareable="false"/>`)
        .join("")}</classify>`;
const mapAnswer = (prompt: string) =>
    `<mappings>${idsIn(prompt)
        .map((id) => `<memory id="${id}" independent="true"/>`)
        .join("")}</mappings>`;
const verifyAnswer = (prompt: string) =>
    `<verify>${idsIn(prompt)
        .map((id) => `<verified id="${id}"/>`)
        .join("")}</verify>`;

const tempDirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs.splice(0)) closeQuietly(db);
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    dbs.push(db);
    return db;
}

function tempProject(): string {
    const root = path.join(tmpdir(), "magic-context", "dreamer-fallback");
    mkdirSync(root, { recursive: true });
    const dir = createTestTempDirFromPath(path.join(root, "project-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "old.ts"), "export const oldValue = 1;", "utf8");
    return dir;
}

function addMemories(db: Database, projectIdentity: string, count: number): number[] {
    return Array.from(
        { length: count },
        (_, index) =>
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: `Dreamer fallback fact ${index}.`,
                sourceSessionId: "ses",
            }).id,
    );
}

function leaseFields(db: Database) {
    const holderId = "fallback-holder";
    const leaseKey = `fallback-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return { holderId, leaseKey };
}

describe("classify-memories", () => {
    function classifyArgs(client: unknown, deadlineMs: number): ClassifyArgs {
        const db = freshDb();
        const projectIdentity = `git:classify-fallback-${Math.random()}`;
        addMemories(db, projectIdentity, 10);
        return {
            db,
            client: client as never,
            projectIdentity,
            parentSessionId: "ses-parent",
            sessionDirectory: tempProject(),
            ...leaseFields(db),
            deadline: Date.now() + deadlineMs,
            model: PRIMARY,
            fallbackModels: [{ model: FALLBACK, qualifier: "high" }],
            firstOutputTimeoutMs: FIRST_OUTPUT_MS,
        };
    }

    test(
        "a primary that never answers falls back and the fallback classifies the chunk",
        async () => {
            const host = opencodeHost({ [PRIMARY]: "dead" }, classifyAnswer);
            const startedAt = Date.now();

            const result = await runClassify(classifyArgs(host.client, 60_000));

            expect(result).toMatchObject({ classified: 10, remaining: 0, complete: true });
            expect(host.sent).toEqual([PRIMARY, FALLBACK]);
            expect(Date.now() - startedAt).toBeLessThan(10_000);
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "a primary that streamed output and then timed out does not fall back",
        async () => {
            const host = opencodeHost({ [PRIMARY]: "partial" }, classifyAnswer);

            await expect(runClassify(classifyArgs(host.client, 5_000))).rejects.toThrow(
                /^prompt timed out after \d+ms$/,
            );
            expect(host.sent).toEqual([PRIMARY]);
        },
        TEST_TIMEOUT_MS,
    );

    describe("through the Rust classify module under the host runner", () => {
        function moduleArgs(client: unknown, deadlineMs: number): ClassifyArgs {
            const args = classifyArgs(client, deadlineMs);
            args.moduleSessionId = "module-session";
            args.moduleProjectRoot = "/repo";
            args.moduleClient = {
                call: async (call: ClassifyModuleCallArgs) => {
                    if (call.method === "dreamer.run_task") {
                        const completion = (call.body as { host_completion?: { text: string } })
                            .host_completion;
                        // The module has no runner of its own here: it asks the host for the
                        // completion, then returns the text the host sent back.
                        return completion
                            ? { result: { ok: true, manifest_text: completion.text } }
                            : {
                                  result: {
                                      ok: false,
                                      code: "host_completion_required",
                                      system_prompt: "module classify system prompt",
                                  },
                              };
                    }
                    const rows = (
                        call.body as { arguments: { rows: Array<{ memory_id: number }> } }
                    ).arguments.rows;
                    return { result: { accepted: rows.map((row) => row.memory_id), rejected: [] } };
                },
            };
            return args;
        }

        test(
            "a primary that never answers falls back and the module records the fallback's manifest",
            async () => {
                const host = opencodeHost({ [PRIMARY]: "dead" }, classifyAnswer);

                const result = await runClassify(moduleArgs(host.client, 60_000));

                expect(result).toMatchObject({ classified: 10, remaining: 0, complete: true });
                expect(host.sent).toEqual([PRIMARY, FALLBACK]);
            },
            TEST_TIMEOUT_MS,
        );

        test(
            "a primary that streamed output and then timed out fails the module run without falling back",
            async () => {
                const host = opencodeHost({ [PRIMARY]: "partial" }, classifyAnswer);

                await expect(runClassify(moduleArgs(host.client, 5_000))).rejects.toThrow(
                    /^Rust classify module failed: prompt timed out after \d+ms$/,
                );
                expect(host.sent).toEqual([PRIMARY]);
            },
            TEST_TIMEOUT_MS,
        );
    });
});

describe("map-memories batches", () => {
    function mapArgs(client: unknown) {
        const db = freshDb();
        const projectIdentity = `git:map-fallback-${Math.random()}`;
        addMemories(db, projectIdentity, 5);
        return {
            db,
            client: client as never,
            projectIdentity,
            parentSessionId: "ses-parent",
            sessionDirectory: tempProject(),
            ...leaseFields(db),
            deadline: Date.now() + MAP_BATCH_FLOOR_MS + 60_000,
            model: PRIMARY,
            fallbackModels: [FALLBACK],
            firstOutputTimeoutMs: FIRST_OUTPUT_MS,
        };
    }

    test(
        "a batch whose primary never answers falls back and the fallback maps it",
        async () => {
            const host = opencodeHost({ [PRIMARY]: "dead" }, mapAnswer);

            const result = await mapMemories(mapArgs(host.client));

            expect(result).toMatchObject({ independent: 5, remaining: 0, complete: true });
            expect(host.sent).toEqual([PRIMARY, FALLBACK]);
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "a primary that streams output keeps its slice past the first-output deadline",
        async () => {
            // The slice here is the production 240-second floor, so the batch cannot be
            // timed out in a unit test. A slow model that has started answering shows
            // the same rule: it is not cut at the first-output deadline, and no fallback
            // is sent.
            const host = opencodeHost({ [PRIMARY]: "slow" }, mapAnswer);

            const result = await mapMemories(mapArgs(host.client));

            expect(result).toMatchObject({ independent: 5, remaining: 0, complete: true });
            expect(host.sent).toEqual([PRIMARY]);
        },
        TEST_TIMEOUT_MS,
    );
});

describe("verify batches", () => {
    function verifyArgs(client: unknown) {
        const db = freshDb();
        const projectIdentity = `git:verify-fallback-${Math.random()}`;
        for (const id of addMemories(db, projectIdentity, 5))
            recordMemoryVerifications(db, id, ["src/old.ts"], 1_000);
        return {
            db,
            client: client as never,
            projectIdentity,
            parentSessionId: "ses-parent",
            sessionDirectory: tempProject(),
            ...leaseFields(db),
            deadline: Date.now() + 120_000,
            model: PRIMARY,
            fallbackModels: [FALLBACK],
            firstOutputTimeoutMs: FIRST_OUTPUT_MS,
        };
    }

    test(
        "a batch whose primary never answers falls back and the fallback verifies it",
        async () => {
            const host = opencodeHost({ [PRIMARY]: "dead" }, verifyAnswer);

            const result = await runVerify(verifyArgs(host.client));

            expect(result).toMatchObject({ verified: 5, remaining: 0, complete: true });
            expect(host.sent).toEqual([PRIMARY, FALLBACK]);
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "a primary that streams output keeps its slice past the first-output deadline",
        async () => {
            const host = opencodeHost({ [PRIMARY]: "slow" }, verifyAnswer);

            const result = await runVerify(verifyArgs(host.client));

            expect(result).toMatchObject({ verified: 5, remaining: 0, complete: true });
            expect(host.sent).toEqual([PRIMARY]);
        },
        TEST_TIMEOUT_MS,
    );
});
