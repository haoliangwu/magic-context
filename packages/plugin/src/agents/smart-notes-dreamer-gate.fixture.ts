/**
 * Shared harness for the smart-note/dreamer tool-surface differential.
 *
 * `gateCases` draws a deterministic, seeded set of raw configs that vary every
 * setting the ctx_* tool list depends on. `renderToolSurfaces` renders the
 * OpenCode 1 registry and the OpenCode 2 registration plus per-request rewrite
 * for one parsed config and returns, per host, a short digest of ctx_note and
 * one of every other tool together.
 *
 * The committed golden (`smart-notes-dreamer-gate.golden.json`) holds these
 * digests as produced by the code before the dreamer gate existed, so the test
 * can prove that every config with a runnable dreamer still gets those exact
 * bytes. The OpenCode 2 per-request smart-note flag is a parameter because the
 * production call site computes it: the golden was rendered with the old
 * `config.smart_notes.enabled` argument.
 */
import { createHash } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { createToolRegistry } from "../plugin/tool-registry";
import { createPromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import type { Database } from "../shared/sqlite";
import { applyV2PromptSurfaceTools } from "../v2/hooks/context";
import { registerTools } from "../v2/hooks/tools";

export const GATE_CASE_COUNT = 240;
const GATE_SEED = 715;

/** mulberry32: a tiny deterministic PRNG so the case list is reproducible. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SMART_NOTES = [undefined, { enabled: true }, { enabled: false }];
const DREAMERS = [
    undefined,
    {},
    { disable: false },
    { disable: true },
    { inject_docs: false },
    { disable: true, inject_docs: false },
    { tasks: { "review-user-memories": { schedule: "" } } },
    { disable: true, tasks: { "evaluate-smart-notes": { schedule: "" } } },
];
const MEMORY = [undefined, { enabled: true }, { enabled: false }];
const COMPACTION = [undefined, { enabled: true }, { enabled: false }];
const PROMPT_SURFACE = [
    undefined,
    { default: "full" },
    { default: "light" },
    { default: "full", models: { "mock/model": "light" } },
];

export function gateCases(): Record<string, unknown>[] {
    const next = prng(GATE_SEED);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    return Array.from({ length: GATE_CASE_COUNT }, () => {
        const raw: Record<string, unknown> = {};
        const entries: Array<[string, unknown]> = [
            ["smart_notes", pick(SMART_NOTES)],
            ["dreamer", pick(DREAMERS)],
            ["memory", pick(MEMORY)],
            ["compaction", pick(COMPACTION)],
            ["prompt_surface", pick(PROMPT_SURFACE)],
        ];
        for (const [key, value] of entries)
            if (value !== undefined) raw[key] = structuredClone(value);
        return raw;
    });
}

const shortDigest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** `note` digests ctx_note's { description, schema }; `other` digests every other tool. */
export interface HostDigests {
    note: string;
    other: string;
}

export interface ToolSurfaceDigests {
    /** OpenCode 1 registry. */
    oc1: HostDigests;
    /** OpenCode 2 registration after the per-request description rewrite. */
    oc2: HostDigests;
    /** Full text per host, kept out of the golden; used for content checks. */
    text: { oc1: string; oc2: string };
}

export async function renderToolSurfaces(args: {
    config: MagicContextPluginConfig;
    directory: string;
    db: Database;
    /** The smart-note flag the OpenCode 2 per-request rewrite receives. */
    oc2SmartNotes: boolean;
}): Promise<ToolSurfaceDigests> {
    const { config, directory, db } = args;
    const warn = () => {};
    const registry = createToolRegistry({
        ctx: { directory } as never,
        pluginConfig: config,
        promptSurfaceRuntime: createPromptSurfaceRuntime({ harness: "opencode", directory, warn }),
    });
    const oc1Surfaces = Object.fromEntries(
        Object.entries(registry)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([name, definition]) => {
                return [
                    name,
                    {
                        description: definition.description,
                        schema: tool.schema.toJSONSchema(tool.schema.object(definition.args)),
                    },
                ];
            }),
    );

    const registered: Array<{ name: string; description: string; input: unknown }> = [];
    await registerTools(
        {
            location: { directory },
            tool: {
                transform: async (callback: (editor: unknown) => void) =>
                    callback({ add: (definition: never) => registered.push(definition) }),
            },
        } as never,
        db,
        config,
    );
    const draft = {
        sessionID: "ses-gate",
        model: { providerID: "mock", id: "model" },
        tools: Object.fromEntries(
            registered.map((definition) => [
                definition.name,
                {
                    description: definition.description,
                    input: structuredClone(definition.input),
                },
            ]),
        ),
    };
    applyV2PromptSurfaceTools(
        draft as never,
        createPromptSurfaceRuntime({ harness: "opencode2", directory, warn }),
        config.prompt_surface,
        args.oc2SmartNotes,
    );
    const oc2Surfaces = Object.fromEntries(
        Object.keys(draft.tools)
            .sort()
            .map((name) => [name, draft.tools[name]]),
    );

    const digests = (surfaces: Record<string, unknown>): HostDigests => {
        const { ctx_note: note, ...other } = surfaces;
        return { note: shortDigest(note ?? null), other: shortDigest(other) };
    };
    return {
        oc1: digests(oc1Surfaces),
        oc2: digests(oc2Surfaces),
        text: { oc1: JSON.stringify(oc1Surfaces), oc2: JSON.stringify(oc2Surfaces) },
    };
}
