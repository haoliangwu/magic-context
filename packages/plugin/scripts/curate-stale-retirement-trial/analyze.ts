import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MODEL, SEED, hash, metrics, sample, type Label, type Memory, type Operation, type TrialBatch } from "./core";

const root = resolve(import.meta.dir, "../../../../.curate-trial");
const labels: Label[] = JSON.parse(readFileSync(join(root, "evaluation.json"), "utf8"));
const pool: Memory[] = JSON.parse(readFileSync(join(root, "pool.json"), "utf8"));
const arms = process.argv.slice(2);
if (!arms.length || arms.some(a => !["text", "evidence", "topic"].includes(a))) throw new Error("Usage: analyze.ts text evidence topic");
const summary: Record<string, unknown> = {};
const spotChecks: Record<string, number[]> = {};
for (const arm of arms) {
    const batches: TrialBatch[] = JSON.parse(readFileSync(join(root, arm === "text" ? "batches.json" : `${arm}-batches.json`), "utf8"));
    const results = batches.map(batch => JSON.parse(readFileSync(join(root, "results", `${arm}-${batch.category}-${batch.index}.json`), "utf8")));
    if (results.some(r => r.model !== MODEL || r.labelsHash !== hash(JSON.stringify(labels)))) throw new Error("Model/ground truth mismatch");
    const operations: Operation[] = results.flatMap(r => r.operations);
    const retirements = operations.filter(o => o.action === "retire");
    const retired = new Set(retirements.flatMap(o => o.ids));
    const labelled = new Set(labels.map(l => l.id));
    const outside = [...retired].filter(id => !labelled.has(id)).map(id => ({ id }));
    const spots = sample(outside, Math.min(20, outside.length), `${SEED}:spots:${arm}`);
    spotChecks[arm] = spots.map(s => s.id);
    const counts = Object.fromEntries(["retire", "archive", "merge", "update"].map(a => [a, operations.filter(o => o.action === a).length]));
    const seenIds = batches.flatMap(b => b.memories.map(m => m.id));
    if (new Set(seenIds).size !== pool.length || seenIds.length !== pool.length) throw new Error("Incomplete or overlapping pool coverage");
    const result = { metrics: metrics(labels, retired), counts, totalRetirements: retired.size, outsideLabelledRetirements: outside.length, spotIds: spotChecks[arm], batches: results.map((r, index) => ({ category: r.category, index: r.index, promptHash: r.promptHash, systemHash: r.systemHash, ids: batches[index]!.memories.map(m => m.id), actions: r.operations.map((o: Operation) => ({action: o.action, ids: o.ids, ...(o.superseded_by ? {superseded_by: o.superseded_by} : {})})), retiredIds: r.operations.filter((o: Operation) => o.action === "retire").flatMap((o: Operation) => o.ids), turns: r.turns ?? [{runId: r.runId, durationMs: r.durationMs, usage: [r.usage]}] })) };
    summary[arm] = result;
    writeFileSync(join(root, `${arm}-retirements-review.txt`), retirements.map(o => { const m = pool.find(m => m.id === o.ids[0])!; return `#${m.id} label=${labels.find(l => l.id === m.id)?.label ?? "unlabelled"}: ${m.content}\nREPLACEMENT: ${o.replacement}\nREASON: ${o.reason}\n`; }).join("\n"));
    console.log(JSON.stringify({ arm, metrics: result.metrics, counts, totalRetirements: result.totalRetirements, outsideLabelledRetirements: outside.length, spotIds: spotChecks[arm], completedBatches: results.length }));
}
writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(root, "spot-checks.json"), JSON.stringify(spotChecks, null, 2));
