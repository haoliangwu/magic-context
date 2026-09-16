import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { runValidatedHistorianPass } from "../hooks/magic-context/compartment-runner-historian";
import type { PluginContext } from "../plugin/types";
import * as logger from "../shared/logger";

const valid =
    '<compartment start="1" end="2" title="Summary"><p1>Both messages preserved.</p1></compartment>';
const scenarios = [
    "clean",
    "transient",
    "validation-repair-editor",
    "fallback-model",
    "length-capped-reasoning",
    "aborted",
] as const;
const golden = join(import.meta.dir, "v1-sequences.golden.json");

test("v1 six lifecycle sequences are byte-identical to master", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-hidden-sequences-"));
    const oldData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root;
    closeDatabase();
    const clock = spyOn(Date, "now").mockReturnValue(1700000000000);
    const random = spyOn(Math, "random").mockReturnValue(0);
    const captures: Record<string, unknown[]> = {};
    let events: unknown[] = [];
    const logging = spyOn(logger, "sessionLog").mockImplementation((_session, message) => {
        if (typeof message === "string" && message.startsWith("historian: prompt completed"))
            events.push(["prompt-settled-log", message]);
    });
    try {
        const db = openDatabase();
        for (const scenario of scenarios) {
            events = [];
            let created = 0;
            let prompts = 0;
            let reads = 0;
            const capture = (kind: string, args: unknown) =>
                events.push([
                    kind,
                    JSON.parse(
                        JSON.stringify(args, (key, value) =>
                            key === "signal" ? "<AbortSignal>" : value,
                        ).replaceAll(root, "<directory>"),
                    ),
                ]);
            const client = {
                session: {
                    async create(args: unknown) {
                        capture("create", args);
                        return { data: { id: `child-${++created}` } };
                    },
                    async prompt(args: unknown) {
                        capture("prompt", args);
                        prompts++;
                        if (scenario === "transient" && prompts === 1)
                            throw new Error("503 overloaded");
                        if (scenario === "fallback-model" && prompts === 1)
                            throw new Error("401 unauthorized");
                        if (scenario === "aborted") {
                            const error = new Error("aborted");
                            error.name = "AbortError";
                            throw error;
                        }
                        return {};
                    },
                    async messages(args: unknown) {
                        capture("messages", args);
                        reads++;
                        const data = [
                            {
                                info: {
                                    role: "assistant",
                                    time: { created: 1 },
                                    finish_reason:
                                        scenario === "length-capped-reasoning" ? "length" : "stop",
                                    tokens: { input: 20, output: 7, cache: { read: 2, write: 3 } },
                                },
                                parts: [
                                    {
                                        type:
                                            scenario === "length-capped-reasoning"
                                                ? "reasoning"
                                                : "text",
                                        text:
                                            scenario === "validation-repair-editor" && reads === 1
                                                ? "not a compartment"
                                                : valid,
                                    },
                                ],
                            },
                        ];
                        capture("messages-result-and-usage", data);
                        return { data };
                    },
                    async delete(args: unknown) {
                        capture("retire-delete", args);
                        return {};
                    },
                    async update(args: unknown) {
                        capture("retire-archive", args);
                        return {};
                    },
                    async abort(args: unknown) {
                        capture("abort", args);
                        return {};
                    },
                },
            } as unknown as PluginContext["client"];
            const result = await runValidatedHistorianPass({
                client,
                db,
                parentSessionId: `parent-${scenario}`,
                sessionDirectory: root,
                prompt: "Messages 1-2:\n1: U: first\n2: A: second",
                chunk: {
                    startIndex: 1,
                    endIndex: 2,
                    lines: [
                        { ordinal: 1, messageId: "m1" },
                        { ordinal: 2, messageId: "m2" },
                    ],
                },
                priorCompartments: [],
                sequenceOffset: 0,
                dumpLabelBase: scenario,
                model: "mock/primary",
                fallbackModels: scenario === "fallback-model" ? ["mock/alternate"] : undefined,
                timeoutMs: 10000,
                twoPass: scenario === "validation-repair-editor",
            });
            expect(result.ok).toBe(
                scenario !== "length-capped-reasoning" && scenario !== "aborted",
            );
            captures[scenario] = events;
        }
        const bytes = JSON.stringify(captures, null, 2) + "\n";
        if (process.env.MC_RECORD_V1_SEQUENCES === "1") writeFileSync(golden, bytes);
        else expect(bytes).toBe(readFileSync(golden, "utf8"));
    } finally {
        logging.mockRestore();
        random.mockRestore();
        clock.mockRestore();
        closeDatabase();
        if (oldData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = oldData;
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
