#!/usr/bin/env bun
/**
 * Render one prompt-surface preset (full or light) as a review document: the
 * primary system-prompt guidance, then every tool's description and each
 * parameter description as the provider serializes them. Every item ends with
 * revision slots so the copy can be revised item by item in the document
 * itself and then transcribed back into source.
 *
 * Usage: bun packages/plugin/scripts/render-surface-review.ts <full|light> <outPath>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Tokenizer from "ai-tokenizer";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";
import { buildMagicContextSection } from "../src/agents/magic-context-prompt";
import { normalizeToolArgSchemas } from "../src/plugin/normalize-tool-arg-schemas";
import { LIGHT_TOOL_DESCRIPTIONS } from "../src/shared/prompt-surface-runtime";
import { createCtxExpandTools } from "../src/tools/ctx-expand/tools";
import { createCtxMemoryTools } from "../src/tools/ctx-memory/tools";
import { createCtxNoteTools } from "../src/tools/ctx-note/tools";
import { createCtxReduceTools } from "../src/tools/ctx-reduce/tools";
import { createCtxSearchTools } from "../src/tools/ctx-search/tools";

const preset = process.argv[2] === "light" ? "light" : "full";
const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const outPath = resolve(
    process.argv[3] ?? resolve(repoRoot, ".cortexkit", "alfonso", "reviews", `surface-review-${preset}.md`),
);

const tokenizer = new Tokenizer(claudeEncoding);
const t = (s: string) => tokenizer.count(s);

const REVISION_SLOTS = ["rev1", "rev1notes", "rev2", "rev2notes", "rev3"];
const slots = (indent = "####"): string[] =>
    REVISION_SLOTS.flatMap((slot) => [`${indent} ${slot}`, "", "_(empty)_", ""]);

const out: string[] = [];
out.push(`# Agent-facing surface review — ${preset.toUpperCase()} preset`);
out.push("");
out.push(
    `Rendered from source by \`packages/plugin/scripts/render-surface-review.ts ${preset}\` on ${new Date().toISOString().slice(0, 10)}. Token counts are Claude BPE estimates on the raw text. Each item carries revision slots; fill them in order and transcribe the accepted revision back into source.`,
);
out.push("");

// ── 1. System-prompt guidance (primary variant) ──────────────────────────────
const guidance = buildMagicContextSection(
    null,
    0,
    true, // ctx_reduce callable
    true, // dreamer enabled (smart-note guidance present)
    true, // temporal awareness
    false, // caveman
    false, // subagent
    undefined,
    true, // memory enabled
    preset,
);
out.push("## 1. System-prompt guidance (primary: reduce=on, memory=on, dreamer=on, temporal=on)");
out.push("");
out.push(`Current — ${guidance.length} chars, ~${t(guidance)} tokens`);
out.push("");
out.push("```");
out.push(guidance);
out.push("```");
out.push("");
out.push(...slots("###"));

// ── 2. Tools ─────────────────────────────────────────────────────────────────
const stubDeps = new Proxy(
    {},
    {
        get: (_target, prop) => {
            if (prop === "then") return undefined;
            return () => {
                throw new Error(`stub dep called at tool creation: ${String(prop)}`);
            };
        },
    },
    // biome-ignore lint/suspicious/noExplicitAny: deliberate stub for export-time introspection
) as any;

const definitions = {
    ...createCtxReduceTools(stubDeps),
    ...createCtxExpandTools(stubDeps),
    ...createCtxNoteTools(stubDeps),
    ...createCtxMemoryTools(stubDeps),
    ...createCtxSearchTools(stubDeps),
};

out.push("## 2. Tools");
out.push("");
let toolIndex = 0;
for (const [name, definition] of Object.entries(definitions)) {
    toolIndex += 1;
    normalizeToolArgSchemas(definition);
    const description =
        preset === "light"
            ? (LIGHT_TOOL_DESCRIPTIONS as Record<string, string>)[name] ?? definition.description ?? ""
            : (definition.description ?? "");
    out.push(`## 2.${toolIndex} ${name}`);
    out.push("");
    out.push(`### 2.${toolIndex}.0 description — ${description.length} chars, ~${t(description)} tokens`);
    out.push("");
    out.push("```");
    out.push(description);
    out.push("```");
    out.push("");
    out.push(...slots());
    let paramIndex = 0;
    for (const [param, schema] of Object.entries(definition.args)) {
        paramIndex += 1;
        const s = schema as { _zod?: { toJSONSchema?: () => unknown } };
        const json = (s._zod?.toJSONSchema ? s._zod.toJSONSchema() : {}) as Record<string, unknown>;
        const desc = typeof json.description === "string" ? json.description : "";
        const { description: _omit, ...shape } = json;
        out.push(
            `### 2.${toolIndex}.${paramIndex} param \`${param}\` — description ${desc.length} chars, ~${t(desc)} tokens · schema \`${JSON.stringify(shape)}\``,
        );
        out.push("");
        out.push("```");
        out.push(desc || "(no description)");
        out.push("```");
        out.push("");
        out.push(...slots());
    }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(`written: ${outPath}`);
