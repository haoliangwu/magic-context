#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildMagicContextSection } from "../src/agents/magic-context-prompt";
import { parseRangeString } from "../src/features/magic-context/range-parser";
import { LIGHT_TOOL_DESCRIPTIONS } from "../src/shared/prompt-surface-runtime";
import { LIGHT_PARAMETER_DESCRIPTIONS } from "../src/tools/parameter-descriptions";

const ARTIFACT_DIR = resolve(
    import.meta.dir,
    "../../..",
    "docs/specs/prompt-surface/light-validation",
);
const MODEL = {
    label: "Gemma 4 31B",
    route: "ollama-cloud/gemma4:31b",
    model: "gemma4:31b",
} as const;
const TEMPERATURE = 0;
const SEED = 268;
const MAX_OUTPUT_TOKENS = 128;
const TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 2;

interface OllamaToolCall {
    function?: {
        name?: string;
        arguments?: Record<string, unknown>;
    };
}

interface OllamaResponse {
    message?: {
        content?: string;
        tool_calls?: OllamaToolCall[];
    };
    prompt_eval_count?: number;
    eval_count?: number;
}

type ToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

type Probe = {
    id: "stamp" | "search" | "note";
    prompt: string;
    tools: ToolDefinition[];
};

const PROBES: Probe[] = [
    {
        id: "stamp",
        prompt: `§101§ User instruction: preserve the requested migration order.
§102§ Assistant: I extracted the relevant code paths.
§103§ Tool output: a large file read already analyzed and acted on.
§104§ Tool output: an unresolved compiler error that still needs diagnosis.
§105§ Tool output: repeated passing status already recorded elsewhere.

The next step uses only the unresolved compiler error. Continue with normal desk housekeeping before that step.`,
        tools: [
            {
                type: "function",
                function: {
                    name: "ctx_reduce",
                    description: LIGHT_TOOL_DESCRIPTIONS.ctx_reduce,
                    parameters: {
                        type: "object",
                        properties: {
                            drop: {
                                type: "string",
                                description: LIGHT_PARAMETER_DESCRIPTIONS.ctx_reduce.drop,
                            },
                        },
                        required: ["drop"],
                        additionalProperties: false,
                    },
                },
            },
        ],
    },
    {
        id: "search",
        prompt:
            "You need the recorded reason this project chose SQLite instead of Postgres. It is not on the desk, but it may already be in the archive. Resolve it using the available project tool before deciding whether the user must be asked.",
        tools: [
            {
                type: "function",
                function: {
                    name: "ctx_search",
                    description: LIGHT_TOOL_DESCRIPTIONS.ctx_search,
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: LIGHT_PARAMETER_DESCRIPTIONS.ctx_search.query,
                            },
                        },
                        required: ["query"],
                        additionalProperties: true,
                    },
                },
            },
        ],
    },
    {
        id: "note",
        prompt:
            'The user says: "Take a note: after v1.0, revisit the cache invalidation benchmark. Evidence: the current run is noisy on CI, and compare it with the local baseline." Use the available session-note tool.',
        tools: [
            {
                type: "function",
                function: {
                    name: "ctx_note",
                    description: LIGHT_TOOL_DESCRIPTIONS.ctx_note,
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: ["write", "read", "update", "dismiss"],
                                description: LIGHT_PARAMETER_DESCRIPTIONS.ctx_note.action,
                            },
                            content: {
                                type: "string",
                                description: LIGHT_PARAMETER_DESCRIPTIONS.ctx_note.content,
                            },
                        },
                        required: ["action", "content"],
                        additionalProperties: true,
                    },
                },
            },
        ],
    },
];

interface RunRecord {
    model: string;
    requestedModel: string;
    preset: "light";
    probe: Probe["id"];
    content: string;
    toolCalls: OllamaToolCall[];
    checks: Record<string, boolean>;
    passed: boolean;
    usage: { promptTokens: number; completionTokens: number };
}

function resolveOllamaCloudKey(): string {
    const candidates = [
        join(homedir(), ".local", "share", "opencode", "auth.json"),
        join(homedir(), ".config", "opencode", "auth.json"),
    ];
    const path = candidates.find(existsSync);
    if (!path) throw new Error(`opencode auth.json not found (looked in ${candidates.join(", ")})`);
    const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: string }>;
    const key = auth["ollama-cloud"]?.key?.trim();
    if (!key) throw new Error(`ollama-cloud key not found in ${path}`);
    return key;
}

async function callModel(probe: Probe, system: string): Promise<OllamaResponse> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch("https://ollama.com/api/chat", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${resolveOllamaCloudKey()}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: MODEL.model,
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: probe.prompt },
                    ],
                    tools: probe.tools,
                    think: false,
                    stream: false,
                    options: {
                        temperature: TEMPERATURE,
                        seed: SEED,
                        num_predict: MAX_OUTPUT_TOKENS,
                    },
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const text = await response.text();
            if (!response.ok)
                throw new Error(`ollama-cloud ${response.status}: ${text.slice(0, 500)}`);
            return JSON.parse(text) as OllamaResponse;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < MAX_ATTEMPTS) await Bun.sleep(1_000);
        }
    }
    throw lastError ?? new Error("ollama-cloud request failed without an error");
}

function evaluate(probe: Probe, response: OllamaResponse): RunRecord {
    const content = response.message?.content?.trim() ?? "";
    const toolCalls = response.message?.tool_calls ?? [];
    const call = toolCalls[0]?.function;
    let checks: Record<string, boolean>;
    if (probe.id === "stamp") {
        const drop = typeof call?.arguments?.drop === "string" ? call.arguments.drop : null;
        let ids: number[] = [];
        try {
            ids = drop ? [...new Set(parseRangeString(drop))].sort((a, b) => a - b) : [];
        } catch {
            ids = [];
        }
        checks = {
            stampsEarly:
                toolCalls.length === 1 &&
                call?.name === "ctx_reduce" &&
                ids.includes(103) &&
                ids.includes(105) &&
                !ids.includes(101) &&
                !ids.includes(104),
            doesNotNarrate: content.length === 0 && !/§\d+§|\[dropped\s+§\d+§\]/i.test(content),
        };
    } else if (probe.id === "search") {
        const query = typeof call?.arguments?.query === "string" ? call.arguments.query : "";
        checks = {
            searchesBeforeAsking:
                toolCalls.length === 1 &&
                call?.name === "ctx_search" &&
                /sqlite/i.test(query) &&
                /postgres/i.test(query) &&
                !content.includes("?"),
        };
    } else {
        const action = call?.arguments?.action;
        const note = typeof call?.arguments?.content === "string" ? call.arguments.content : "";
        const [title = "", ...detail] = note.split("\n");
        checks = {
            notesWithTitle:
                toolCalls.length === 1 &&
                call?.name === "ctx_note" &&
                action === "write" &&
                title.trim().length > 0 &&
                title.length < 80 &&
                detail.join("\n").trim().length > 0,
        };
    }
    return {
        model: MODEL.route,
        requestedModel: MODEL.model,
        preset: "light",
        probe: probe.id,
        content,
        toolCalls,
        checks,
        passed: Object.values(checks).every(Boolean),
        usage: {
            promptTokens: response.prompt_eval_count ?? 0,
            completionTokens: response.eval_count ?? 0,
        },
    };
}

function markdownFor(records: RunRecord[]): string {
    const lines = [
        `# ${MODEL.label}: light prompt behavior`,
        "",
        `Route: \`${MODEL.route}\` (request model \`${MODEL.model}\`)`,
        "",
        "The light preset received three probes covering early stamping without narration, archive search before asking, and titled note creation.",
        "",
    ];
    for (const record of records) {
        lines.push(`## ${record.probe}`, "", `Result: **${record.passed ? "PASS" : "FAIL"}**`, "");
        lines.push("```json", JSON.stringify(record, null, 2), "```", "");
    }
    return lines.join("\n");
}

async function main(): Promise<void> {
    const guidance = buildMagicContextSection(
        null,
        20,
        true,
        true,
        true,
        false,
        false,
        undefined,
        true,
        "light",
    );
    const records: RunRecord[] = [];
    for (const probe of PROBES) {
        const response = await callModel(probe, guidance);
        const record = evaluate(probe, response);
        records.push(record);
        console.log(`${MODEL.route} ${probe.id}: ${record.passed ? "PASS" : "FAIL"}`);
    }

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const name = MODEL.route.replace(/[^A-Za-z0-9._-]+/g, "-");
    writeFileSync(join(ARTIFACT_DIR, `${name}.md`), markdownFor(records));
    writeFileSync(
        join(ARTIFACT_DIR, "manifest.json"),
        `${JSON.stringify(
            {
                artifactId: "prompt-surface-light-weak-model-validation",
                revision: "desk-r1",
                timestamp: new Date().toISOString(),
                endpoint: "https://ollama.com/api/chat",
                model: MODEL,
                preset: "light",
                settings: {
                    temperature: TEMPERATURE,
                    seed: SEED,
                    think: false,
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                    timeoutMs: TIMEOUT_MS,
                    maxAttempts: MAX_ATTEMPTS,
                    repetitions: 1,
                },
                probes: PROBES.map(({ id, prompt }) => ({ id, prompt })),
                rubric: [
                    "stamps early: one ctx_reduce call includes spent outputs 103 and 105 while keeping user 101 and unresolved error 104",
                    "does not narrate: the stamp call emits no prose or marker imitation",
                    "searches before asking: one ctx_search query names SQLite and Postgres",
                    "notes with title: one ctx_note write has a title under 80 chars and detail",
                ],
                unavailableModelPolicy: "fail the harness; do not substitute a model silently",
                records,
                behaviors: Object.fromEntries(
                    records.flatMap((record) => Object.entries(record.checks)),
                ),
                passed: records.length === PROBES.length && records.every((record) => record.passed),
            },
            null,
            2,
        )}\n`,
    );

    if (records.length !== PROBES.length || records.some((record) => !record.passed)) {
        process.exitCode = 1;
    }
}

await main();
