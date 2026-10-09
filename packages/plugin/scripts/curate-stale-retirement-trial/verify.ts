import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash, parseDraft, prompt, type Memory, type TrialBatch } from "./core";

const repo = resolve(import.meta.dir, "../../../.."), root = join(repo, ".curate-trial");
const pool: Memory[] = JSON.parse(readFileSync(join(root, "pool.json"), "utf8"));
const retained = JSON.parse(readFileSync(join(root, "sanitized-evidence.json"), "utf8"));
const checks: [string, () => void][] = [
    ["all three arms cover each active id exactly once", () => {
        const expected = pool.map(m => m.id).sort((a, b) => a - b);
        for (const arm of ["text", "evidence", "topic"]) {
            const rows = retained.arms[arm].batches.flatMap((b: any) => b.ids).sort((a: number, b: number) => a - b);
            if (JSON.stringify(rows) !== JSON.stringify(expected)) throw new Error(`Coverage mismatch: ${arm}`);
        }
    }],
    ["all 54 retained completions are one stop-finished provider step", () => {
        let checked = 0;
        for (const arm of ["text", "evidence", "topic"]) {
            const batches: TrialBatch[] = JSON.parse(readFileSync(join(root, arm === "text" ? "batches.json" : `${arm}-batches.json`), "utf8"));
            for (const batch of batches) {
                const key = `${arm}-${batch.category}-${batch.index}`;
                const raw = JSON.parse(readFileSync(join(root, "results", `${key}${arm === "text" ? "-0" : ""}-raw.json`), "utf8"));
                const result = JSON.parse(readFileSync(join(root, "results", `${key}.json`), "utf8"));
                const steps = raw.events.filter((e: any) => e.type === "step_finished");
                if (steps.length !== 1 || steps[0].finish_reason !== "stop") throw new Error(`Incomplete raw completion: ${key}`);
                if (JSON.stringify(parseDraft(raw.text).operations) !== JSON.stringify(result.operations)) throw new Error(`Raw verdict mismatch: ${key}`);
                checked++;
            }
        }
        if (checked !== 54) throw new Error(`Only ${checked} completions`);
    }],
    ["supplied excerpts match repository lines and accepted provider prompts", () => {
        const actual = JSON.parse(readFileSync(join(root, "evidence.json"), "utf8"));
        const files = new Map<string, string[]>();
        for (const [id, rows] of Object.entries(actual) as [string, any[]][]) {
            const refs = retained.suppliedEvidence[id].map((index: number) => retained.excerptCatalog[index]);
            if (JSON.stringify(refs) !== JSON.stringify(rows.map(e => ({ path: e.path, line: e.line, excerptHash: hash(e.text) })))) throw new Error(`Evidence mismatch: ${id}`);
            for (const row of rows) {
                if (!files.has(row.path)) files.set(row.path, readFileSync(join(repo, row.path), "utf8").split("\n"));
                if (files.get(row.path)![row.line - 1]?.slice(0, 1600) !== row.text) throw new Error(`Source mismatch: ${row.path}:${row.line}`);
            }
        }
        const batches: TrialBatch[] = JSON.parse(readFileSync(join(root, "evidence-batches.json"), "utf8"));
        for (const batch of batches) {
            const key = `evidence-${batch.category}-${batch.index}`;
            for (const memory of batch.memories) if (JSON.stringify(batch.evidence?.[memory.id]) !== JSON.stringify(actual[memory.id])) throw new Error(`Supplied batch evidence mismatch: ${memory.id}`);
            const admission = JSON.parse(readFileSync(join(root, "results", `${key}-admission.json`), "utf8"));
            const result = JSON.parse(readFileSync(join(root, "results", `${key}.json`), "utf8"));
            if (admission.input !== prompt(batch, "evidence") || hash(admission.input) !== result.promptHash) throw new Error(`Accepted prompt mismatch: ${key}`);
        }
    }],
    ["privacy export contains no full active memory content", () => {
        const paths = [...readdirSync(import.meta.dir).map(f => join(import.meta.dir, f)), join(repo, "docs/reports/curate-stale-retirement-trial.md")];
        for (const path of paths) {
            const text = readFileSync(path, "utf8");
            for (const m of pool) {
                const content = m.content.trim();
                if (content && (text.includes(content) || text.includes(JSON.stringify(content).slice(1, -1)))) throw new Error(`Full memory #${m.id} found in ${path}`);
            }
        }
    }],
];
console.log(`Bun ${Bun.version}; private trial verification`);
let failed = 0;
for (const [name, check] of checks) {
    try { check(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error}`); }
}
console.log(`${checks.length - failed} checks passed; ${failed} failed`);
if (failed) process.exit(1);
