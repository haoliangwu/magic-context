import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeVector } from "../curate-stale-retirement-trial/retrieval";
import { ROOT, REPO, MODEL, SYSTEM, hash, evaluate, reconcilePrompt, newerNeighbors, sample, SEED, type Batch, type Memory, type Label, type Gate } from "./core";

const load = <T = any>(name: string): T => JSON.parse(readFileSync(join(ROOT, name), "utf8"));
const manifest = load("manifest.json"), batches = load<Batch[]>("batches.json"), pool = load<Memory[]>("pool.json");
const labels = load<Label[]>("evaluation.json"), extraLabels = load<Label[]>("extra-labels.json");
type Grade = { pass: string; id: number; grade: "correct" | "wrong" | "unsure"; reason: string };
const grades = load<Grade[]>("action-grades.json");
const resultBatches: { pass: string; batch: Batch; result: any }[] = [];
for (const pass of ["A", "B"]) for (const batch of batches.filter(b => pass === "A" || b.key.startsWith("labelled-"))) resultBatches.push({ pass, batch, result: load(`results/${pass}-${batch.key}.json`) });
const rows = resultBatches.flatMap(({ pass, batch, result }) => (result.gates as Gate[]).map((gate, i) => ({ pass, group: batch.key.startsWith("labelled-") ? "labelled" : "extra", id: batch.targets[i]!.memory.id, gate })));
const assert = (ok: unknown, reason: string) => { if (!ok) throw new Error(reason); };
const equal = (a: unknown, b: unknown, reason: string) => assert(JSON.stringify(a) === JSON.stringify(b), reason);
const checks: [string, () => void][] = [
    ["snapshot, frozen labels and sample identities", () => {
        assert(hash(JSON.stringify(pool)) === manifest.poolHash && hash(JSON.stringify(batches)) === manifest.batchesHash, "Frozen pool/batches changed");
        const labelsBytes = readFileSync(join(ROOT, "evaluation.json"), "utf8");
        assert(hash(labelsBytes) === manifest.labelsHash && labelsBytes === readFileSync(join(import.meta.dir, "../curate-stale-retirement-trial/evaluation.json"), "utf8"), "Relabelled frozen cohort");
        for (const name of ["extra-labels", "action-grades"]) assert(hash(readFileSync(join(ROOT, `${name}.json`), "utf8")) === readFileSync(join(ROOT, `${name}.sha256`), "utf8"), `${name} freeze changed`);
        equal(sample(pool.filter(m => !manifest.labelled.includes(m.id)), 100, SEED).map(m => m.id), manifest.extra, "Random sample changed");
        equal(extraLabels.map(l => l.id), manifest.extra, "Incomplete extra grading");
        assert(extraLabels.every(l => ["stale", "true", "unsure"].includes(l.label) && l.reason.trim()), "Invalid extra labels");
        const db = new Database(join(ROOT, "trial.db"), { readonly: true });
        const actual = db.query("SELECT id,content,created_at AS createdAt FROM memories WHERE status='active' ORDER BY id").all();
        db.close();
        equal(actual, pool.map(m => ({ id: m.id, content: m.content, createdAt: m.createdAt })), "Copied database no longer matches pool");
        equal(batches.flatMap(b => b.targets).map(t => t.memory.id), [...manifest.labelled, ...manifest.extra], "Batch coverage");
        assert(batches.every(b => b.targets.length > 0 && b.targets.length <= 5), "Not small batches");
    }],
    ["strictly newer six-semantic/two-lexical retrieval and real ten-line evidence", () => {
        const db = new Database(join(ROOT, "trial.db"), { readonly: true });
        const embeddings = db.query("SELECT memory_id,embedding FROM memory_embeddings").all() as { memory_id: number; embedding: Uint8Array }[];
        db.close();
        const vectors = new Map<number, Float32Array>();
        for (const row of embeddings) { const v = normalizeVector(row.embedding); if (v) vectors.set(row.memory_id, v); }
        const files = new Map<string, string[]>();
        for (const t of batches.flatMap(b => b.targets)) {
            equal(t.newer, newerNeighbors(t.memory, pool, vectors), `Retrieval changed #${t.memory.id}`);
            assert(t.newer.every(n => n.memory.createdAt > t.memory.createdAt) && new Set(t.newer.map(n => n.memory.id)).size === t.newer.length, "Old/duplicate neighbor");
            assert(t.evidence.length <= 10, "Evidence quota exceeded");
            for (const e of t.evidence) {
                assert(!e.path.startsWith("/") && !e.path.split("/").includes("..") && !/memory-reconcile|curate-stale-retirement|historian-merge-turn-trial|\.env/.test(e.path), "Unfenced excerpt");
                if (!files.has(e.path)) files.set(e.path, readFileSync(join(REPO, e.path), "utf8").split("\n"));
                equal(e.text, files.get(e.path)![e.line - 1]?.slice(0, 1600), `Invented source line ${e.path}:${e.line}`);
            }
        }
    }],
    ["70 independent provider runs, actual admitted prompts and recomputed gates", () => {
        const runIds = new Set<string>(), sessions = new Set<string>();
        let stopped = 0, limited = 0;
        for (const { pass, batch, result } of resultBatches) {
            const key = `${pass}-${batch.key}`, admission = load(`results/${key}-admission.json`), raw = load(`results/${key}-raw.json`);
            equal(admission.input, reconcilePrompt(batch.targets, manifest.cutoff), `Prompt differs: ${key}`);
            assert(result.promptHash === hash(admission.input) && result.systemHash === hash(SYSTEM) && result.model === MODEL && result.labelsHash === manifest.labelsHash, "Settings/hash mismatch");
            equal(result.generation, { max_output_tokens: 32000 }, "Production temperature override");
            assert(result.runId === raw.runId && result.runId === admission.runId && result.identity.session === admission.identity.session, "Run association mismatch");
            const steps = raw.events.filter((e: any) => (e.type ?? e.kind) === "step_finished");
            assert(steps.length === 1, "Multiple/missing provider steps");
            if (steps[0].finish_reason === "stop") stopped++; else { assert(steps[0].finish_reason === "length", "Unknown provider terminal"); limited++; }
            assert(raw.events.some((e: any) => (e.type ?? e.kind) === "run_finished" && (!e.run_id || e.run_id === raw.runId)), "Missing completion event");
            assert(typeof result.usage?.input_tokens === "number" && typeof result.usage?.output_tokens === "number", "Missing usage");
            equal(result.usage, steps[0].usage, "Usage mismatch");
            const incomplete = !raw.text.trim() || steps[0].finish_reason !== "stop";
            const evaluated = evaluate(incomplete ? "" : raw.text, batch.targets);
            equal(result.gates, evaluated.gates, `Stored gate differs: ${key}`);
            equal(result.schemaError, evaluated.schemaError, `Schema result differs: ${key}`);
            runIds.add(raw.runId); sessions.add(raw.identity.session);
        }
        assert(runIds.size === 70 && sessions.size === 70 && stopped === 69 && limited === 1, "Run coverage/terminal mismatch");
    }],
    ["complete independent semantic grades for every changed proposal", () => {
        const changed = rows.filter(r => ["replaced", "partly_replaced"].includes(r.gate.proposed.verdict));
        equal(grades.map(g => `${g.pass}:${g.id}`), changed.map(r => `${r.pass}:${r.id}`), "Missing/duplicate action grades");
        assert(grades.every(g => ["correct", "wrong", "unsure"].includes(g.grade) && g.reason.trim()), "Empty semantic grade");
        for (const pass of ["A", "B"]) equal(rows.filter(r => r.pass === pass && r.group === "labelled").map(r => r.id), manifest.labelled, "Labelled pass coverage");
    }],
    ["deliverables contain no full active memory or raw model response", () => {
        const files = [...readdirSync(import.meta.dir).filter(f => !f.startsWith(".")).map(f => join(import.meta.dir, f)), join(REPO, "docs/reports/memory-reconcile-check-trial.md")];
        for (const path of files) {
            const text = readFileSync(path, "utf8");
            for (const m of pool) {
                const content = m.content.trim();
                assert(!content || (!text.includes(content) && !text.includes(JSON.stringify(content).slice(1, -1))), `Full memory #${m.id} in ${path}`);
            }
            for (const { result } of resultBatches) assert(!result.text.trim() || !text.includes(result.text.trim()), `Raw response in ${path}`);
        }
    }],
];
console.log(`Bun ${Bun.version}; memory reconcile private verification`);
let failures = 0;
for (const [name, check] of checks) { try { check(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error}`); } }
console.log(`${checks.length - failures} checks passed; ${failures} failed; ${resultBatches.length} provider runs; ${rows.length} decisions`);
if (failures) process.exit(1);

function metrics(selected: typeof rows, judgement: Label[]) {
    const labelsById = new Map(judgement.map(l => [l.id, l.label]));
    const counts = Object.fromEntries(["replaced", "partly_replaced", "still_true", "unsure"].map(verdict => {
        const acted = selected.filter(r => r.gate.effective.verdict === verdict);
        return [verdict, { total: acted.length, ...Object.fromEntries(["stale", "true", "unsure"].map(label => [label, acted.filter(r => labelsById.get(r.id) === label).map(r => r.id)])) }];
    }));
    const caught = selected.filter(r => ["replaced", "partly_replaced"].includes(r.gate.effective.verdict) && labelsById.get(r.id) === "stale").map(r => r.id);
    return { counts, staleDetected: caught, staleMissed: judgement.filter(l => l.label === "stale" && !caught.includes(l.id)).map(l => l.id), rejected: selected.filter(r => r.gate.rejected).map(r => r.id) };
}
const summary = {
    labels: { frozen: manifest.labelsHash, extra: readFileSync(join(ROOT, "extra-labels.sha256"), "utf8"), actions: readFileSync(join(ROOT, "action-grades.sha256"), "utf8") },
    A: { labelled: metrics(rows.filter(r => r.pass === "A" && r.group === "labelled"), labels), extra: metrics(rows.filter(r => r.group === "extra"), extraLabels), all: metrics(rows.filter(r => r.pass === "A"), [...labels, ...extraLabels]) },
    B: metrics(rows.filter(r => r.pass === "B"), labels),
    semantic: Object.fromEntries(["A", "B"].map(pass => [pass, Object.fromEntries(["replaced", "partly_replaced"].map(verdict => [verdict, grades.filter(g => g.pass === pass && rows.some(r => r.pass === pass && r.id === g.id && r.gate.effective.verdict === verdict))]))])),
    noise: { sameVerdict: rows.filter(r => r.pass === "A" && r.group === "labelled" && rows.find(s => s.pass === "B" && s.id === r.id)!.gate.effective.verdict === r.gate.effective.verdict).length,
        differences: rows.filter(r => r.pass === "A" && r.group === "labelled").flatMap(r => { const b = rows.find(s => s.pass === "B" && s.id === r.id)!; return r.gate.effective.verdict === b.gate.effective.verdict ? [] : [{ id: r.id, A: r.gate.effective.verdict, B: b.gate.effective.verdict }]; }) },
    cost: Object.fromEntries(["A-labelled", "A-extra", "B-labelled"].map(group => {
        const selected = resultBatches.filter(r => `${r.pass}-${r.batch.key.split("-")[0]}` === group);
        const sum = (field: string) => selected.reduce((n, r) => n + (r.result.usage[field] ?? 0), 0);
        return [group, { calls: selected.length, input: sum("input_tokens"), output: sum("output_tokens"), reasoning: sum("reasoning_tokens"), reasoningReported: selected.filter(r => r.result.usage.reasoning_tokens !== undefined).length, seconds: selected.reduce((n, r) => n + r.result.durationMs / 1000, 0) }];
    })),
};
writeFileSync(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(`Verified summary written privately; labelled A detected ${summary.A.labelled.staleDetected.length}/21, B ${summary.B.staleDetected.length}/21; ${summary.noise.sameVerdict}/125 repeated verdicts stable.`);
