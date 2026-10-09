import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash, SEED, MODEL, type Label, type Excerpt } from "./core";

const root = resolve(import.meta.dir, "../../../../.curate-trial");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const labels: Label[] = read("evaluation.json"), summary = read("summary.json"), arrangement = read("arrangement.json"), identity = read("input-identity.json");
const judgements: Label[] = JSON.parse(readFileSync(join(import.meta.dir, "spot-judgements.json"), "utf8"));
const expectedSpots = new Set<number>(Object.values(summary).flatMap((s: any) => s.spotIds));
if (expectedSpots.size !== judgements.length || judgements.some(l => !expectedSpots.has(l.id))) throw new Error("Outside-retirement census mismatch");
const supplied: Record<string, Excerpt[]> = read("evidence.json");
const excerptCatalog: {path: string; line: number; excerptHash: string}[] = [];
const excerptIds = new Map<string, number>();
const evidence = Object.fromEntries(Object.entries(supplied).map(([id, rows]) => [id, rows.map(e => {
    const ref = { path: e.path, line: e.line, excerptHash: hash(e.text) }, key = JSON.stringify(ref);
    let index = excerptIds.get(key);
    if (index === undefined) { index = excerptCatalog.length; excerptIds.set(key, index); excerptCatalog.push(ref); }
    return index;
})]));
const catalog = read("catalog.json"), broca = catalog.find((m: any) => m.module_id === "broca");
const excluded = new Map<string, unknown>();
for (const dir of ["results", "superseded", "superseded/protocol-clarification", "superseded/session-continuation"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const name of readdirSync(join(root, dir))) {
        if (!name.startsWith("code-") || !/(?:raw|error)\.json$/.test(name)) continue;
        const raw = read(`${dir}/${name}`);
        if (!raw.runId || !raw.events?.length) continue;
        const steps = raw.events.filter((e: any) => e.type === "step_finished");
        excluded.set(raw.runId, { runId: raw.runId, stepFinishReasons: steps.map((s: any) => s.finish_reason), usage: steps.map((s: any) => s.usage) });
    }
}
const output = { baselineSha: "3556ba22e7814d719fe358f55668d800d62af95e", seed: SEED, model: MODEL, generation: { max_output_tokens: 32000 }, temperature: "unspecified (no override)",
    brocaVersion: broca?.module_version ?? broca?.version ?? broca?.implementation_version ?? null, poolCount: 1299, poolHash: identity.poolHash, labelsHash: identity.labelsHash,
    labelCounts: Object.fromEntries(["stale", "true", "unsure"].map(label => [label, labels.filter(l => l.label === label).length])),
    strata: Object.fromEntries(Object.entries(identity.selected).map(([stratum, ids]) => [stratum, { ids, counts: Object.fromEntries(["stale", "true", "unsure"].map(label => [label, labels.filter(l => (ids as number[]).includes(l.id) && l.label === label).length])) }])),
    arrangement, excerptCatalog, suppliedEvidence: evidence, arms: summary, outsideRetirementJudgements: judgements,
    excludedCodeBridgeRuns: [...excluded.values()], ...(excluded.size ? { queuedBridgeSubmission: { runId: "run-code-PROJECT_RULES-0-739b4b6ded8ea801-1791284496288-82982-18dbb4bd07dd6e78-271", retractResult: "already_started", finalState: existsSync(join(root, "queued-bridge-result.json")) ? read("queued-bridge-result.json").result?.state : "not captured", usage: "not captured; excluded" } } : {}) };
writeFileSync(join(root, "sanitized-evidence.json"), JSON.stringify(output, null, 2));
if (process.argv[2] === "--retain") writeFileSync(join(import.meta.dir, "evidence.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ labelCounts: output.labelCounts, strata: Object.fromEntries(Object.entries(output.strata).map(([k, v]: [string, any]) => [k, v.counts])), brocaVersion: output.brocaVersion, outsideUnique: judgements.length, evidenceLines: arrangement.evidenceLines,
    arms: Object.fromEntries(Object.entries(summary).map(([arm, s]: [string, any]) => [arm, { batches: s.batches.length, milliseconds: s.batches.reduce((n: number, b: any) => n + b.turns.reduce((t: number, r: any) => t + r.durationMs, 0), 0),
        usage: s.batches.flatMap((b: any) => b.turns.flatMap((t: any) => t.usage)).reduce((sum: any, u: any) => { for (const [k, n] of Object.entries(u)) sum[k] = (sum[k] ?? 0) + Number(n); return sum; }, {}) }])) }));
