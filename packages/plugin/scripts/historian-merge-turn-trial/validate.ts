import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eligible, hash, isolate, MODEL, removeMemory, trialRoot, type Memory } from "./core";

const root = trialRoot(process.argv[2]);
isolate(root);
const { parseCompartmentOutput } = await import("../../src/hooks/magic-context/compartment-parser");
const db = new Database(join(root, "trial.db"), { readonly: true });
const rows = db.query("SELECT * FROM historian_runs ORDER BY created_at DESC,child_session DESC LIMIT 40").all() as {child_session: string; created_at: number; user_prompt: string}[];
const memories = db.query("SELECT * FROM memories").all() as Memory[];
const byId = new Map(memories.map(m => [m.id, m]));
const embeddingIds = new Set((db.query("SELECT memory_id FROM memory_embeddings").all() as {memory_id: number}[]).map(e => e.memory_id));
if (rows.length !== 40) throw new Error("Incomplete recorded cohort");
let facts = 0, entries = 0;
for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const input = await Bun.file(join(root, "inputs", `${i}.json`)).json();
    const first = await Bun.file(join(root, "results", `${i}-turn1.json`)).json();
    const second = await Bun.file(join(root, "results", `${i}-turn2.json`)).json();
    const candidates = await Bun.file(join(root, "results", `${i}-candidates.json`)).json();
    const lexical = await Bun.file(join(root, "results", `${i}-lexical.json`)).json();
    if (input.session !== row.child_session || input.prompt !== removeMemory(row.user_prompt).prompt || first.promptHash !== hash(input.prompt)) throw new Error(`Prompt identity mismatch ${i}`);
    if (JSON.stringify(first.identity) !== JSON.stringify(second.identity) || first.runId === second.runId) throw new Error(`Continuation identity mismatch ${i}`);
    for (const r of [first, second]) {
        if (r.model !== MODEL || r.generation.temperature !== 0.1 || r.generation.max_output_tokens !== 32000) throw new Error("Model/generation changed");
        const steps = r.events.filter((e: any) => e.type === "step_finished");
        if (steps.length !== 1 || steps[0].finish_reason !== "stop" || r.events.find((e: any) => e.type === "run_finished")?.reason !== "completed") throw new Error("Incomplete provider step");
    }
    if (JSON.stringify(parseCompartmentOutput(first.text).facts) !== JSON.stringify(candidates.facts) || JSON.stringify(candidates.facts) !== JSON.stringify(lexical.facts)) throw new Error("Fact/candidate mismatch");
    if (candidates.matches.length !== candidates.facts.length || second.promptHash !== hash(candidates.prompt)) throw new Error("Candidate/continuation prompt mismatch");
    candidates.matches.forEach((ms: any[], fact: number) => {
        if (ms.length !== 20 || new Set(ms.map(m => m.id)).size !== 20 || eligible(ms, row.created_at).length !== 20) throw new Error("Invalid candidate count/fence");
        if (ms.filter(m => m.lane === "semantic").length !== 15 || ms.filter(m => m.lane === "bm25").length !== 5) throw new Error("Hybrid lane count mismatch");
        for (const m of ms) {
            const stored = byId.get(m.id);
            if (!stored || stored.content !== m.content || !Number.isFinite(m.score)) throw new Error("Candidate content/score mismatch");
            if (m.lane === "semantic" && !embeddingIds.has(m.id)) throw new Error("Unembedded semantic candidate");
            if (m.lane === "bm25" && !lexical.matches[fact].some((l: any) => l.id === m.id)) throw new Error("Lexical candidate not from staged list");
        }
        entries += ms.length;
    });
    facts += candidates.facts.length;
}
db.close();
const report = readFileSync(join(import.meta.dir, "../../../..", "docs/reports/historian-merge-turn-trial.md"), "utf8");
const ledger = readFileSync(join(root, "judgment-ledger.md"), "utf8");
if (!report.includes(ledger)) throw new Error("Report decision ledger differs from reviewed annotations");
const insertions = readFileSync(join(root, "insertion-ledger.md"), "utf8");
if (!report.includes(insertions)) throw new Error("Report insertion ledger differs from recorded attribution");
console.log(`Bun ${Bun.version}: validated 40 byte-preserved first prompts, 40 same-session continuations, 80 completed steps, ${facts} facts, ${entries} hybrid candidates, complete report decision and insertion ledgers.`);
