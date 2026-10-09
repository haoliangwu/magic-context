import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frequencies, identifiers, normalizeVector, rankEvidence, tokens } from "../curate-stale-retirement-trial/retrieval";
import { ROOT, REPO, SEED, hash, sample, smallBatches, newerNeighbors, type Memory, type Label, type Excerpt } from "./core";

if (existsSync(join(ROOT, "manifest.json"))) throw new Error("Prepared inputs already frozen; do not overwrite");
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
const db = new Database(join(ROOT, "trial.db"), { readonly: true });
const pool = db.query("SELECT id,category,content,source_type AS source,created_at AS createdAt,importance,retrieval_count AS retrievalCount,seen_count AS seenCount FROM memories WHERE status='active' ORDER BY id").all()
    .map(row => ({ ...row as Omit<Memory, "mappedFiles" | "hasNoFileSentinel">, mappedFiles: [], hasNoFileSentinel: false }));
const embeddings = db.query("SELECT e.memory_id,e.model_id,e.embedding FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.status='active' ORDER BY e.memory_id").all() as { memory_id: number; model_id: string; embedding: Uint8Array }[];
db.close();
if (new Set(embeddings.map(e => e.model_id)).size !== 1) throw new Error("Incompatible embedding models");
const vectors = new Map<number, Float32Array>();
for (const e of embeddings) { const v = normalizeVector(e.embedding); if (v) vectors.set(e.memory_id, v); }
if (new Set([...vectors.values()].map(v => v.length)).size !== 1) throw new Error("Incompatible vector dimensions");
const labelsBytes = readFileSync(join(import.meta.dir, "../curate-stale-retirement-trial/evaluation.json"), "utf8");
const labels: Label[] = JSON.parse(labelsBytes);
const byId = new Map(pool.map(m => [m.id, m]));
if (labels.length !== 125 || new Set(labels.map(l => l.id)).size !== 125 || labels.some(l => !byId.has(l.id))
    || labels.filter(l => l.label === "stale").length !== 21 || labels.filter(l => l.label === "true").length !== 81 || labels.filter(l => l.label === "unsure").length !== 23) throw new Error("Frozen label/snapshot mismatch");
const excluded = new Set(labels.map(l => l.id));
const extra = sample(pool.filter(m => !excluded.has(m.id)), 100, SEED);
const selected = [...labels.map(l => byId.get(l.id)!), ...extra];
const df = frequencies(pool.map(m => tokens(m.content)));
mkdirSync(join(ROOT, "capture"), { mode: 0o700 });

function capture(name: string, paths: string[], untracked = false): Excerpt[] {
    const output = join(ROOT, "capture", `${name}.txt`), fd = openSync(output, "w", 0o600);
    const response = Bun.spawnSync(["timeout", "120s", "git", "grep", "--threads=1", ...(untracked ? ["--no-index"] : []), "-n", "-I", "-e", "", "--", ...paths], { cwd: REPO, stdout: fd });
    closeSync(fd);
    if (![0, 1].includes(response.exitCode)) throw new Error(`Capture ${name} failed: ${response.exitCode}; ${response.stderr}`);
    return readFileSync(output, "utf8").split("\n").flatMap(line => {
        const m = line.match(/^([^:]+):(\d+):(.*)$/);
        return m ? [{ path: m[1]!, line: Number(m[2]), text: m[3]! }] : [];
    });
}
// Fixed allowlists exclude live stores/config, credentials and investigative
// reports. Numbered bytes come from one immutable git-grep capture, not a model.
const source = capture("source", ["packages/plugin/src", "packages/pi-plugin/src", "packages/cli/src", "crates", "scripts", "docs/designs", "CONFIGURATION.md", "packages/plugin/package.json", ":!**/node_modules/**", ":!crates/**/testdata/**", ":!crates/**/tests/**", ":!**/*.json", ":!**/*.jcs", ":!**/*.golden*"]);
const design = capture("design", [".cortexkit/alfonso/plans/ck-extensibility-design-r7.3.md", ".cortexkit/alfonso/plans/ck-extensibility-r7.3-errata.md"], true);
const lineIndex = new Map<string, Set<number>>();
source.forEach((row, index) => { for (const term of new Set(tokens(row.text))) { const indices = lineIndex.get(term) ?? new Set<number>(); indices.add(index); lineIndex.set(term, indices); } });
const targets = selected.map(memory => {
    const terms = identifiers(memory, df);
    const candidates = new Set<number>();
    for (const term of terms.flatMap(tokens)) for (const index of lineIndex.get(term) ?? []) candidates.add(index);
    // Retain the curate ranker and independent latest-design/source quotas,
    // reducing its 8+7 allocation to 5+5 under the ten-line treatment budget.
    const ranked = rankEvidence(memory, terms, design, [...candidates].map(i => source[i]!));
    const isDesign = (e: Excerpt) => e.path.startsWith(".cortexkit/alfonso/plans/");
    const evidence = [...ranked.filter(isDesign).slice(0, 5), ...ranked.filter(e => !isDesign(e)).slice(0, 5)];
    for (const e of ranked) if (evidence.length < 10 && !evidence.includes(e)) evidence.push(e);
    return { memory, newer: newerNeighbors(memory, pool, vectors), evidence };
});
const cutoff = Math.max(...pool.map(m => m.createdAt));
const labelledBatches = smallBatches(targets.slice(0, 125), "labelled", cutoff);
const extraBatches = smallBatches(targets.slice(125), "extra", cutoff);
writeFileSync(join(ROOT, "pool.json"), JSON.stringify(pool), { mode: 0o600 });
writeFileSync(join(ROOT, "evaluation.json"), labelsBytes, { mode: 0o600 });
writeFileSync(join(ROOT, "targets.json"), JSON.stringify(targets), { mode: 0o600 });
writeFileSync(join(ROOT, "batches.json"), JSON.stringify([...labelledBatches, ...extraBatches]), { mode: 0o600 });
const manifest = { repoBaseline: Bun.spawnSync(["timeout", "15s", "git", "rev-parse", "HEAD"], { cwd: REPO }).stdout.toString().trim(), seed: SEED, cutoff, pool: pool.length, poolHash: hash(JSON.stringify(pool)), labelsHash: hash(labelsBytes), labelled: labels.map(l => l.id), extra: extra.map(m => m.id), embeddingModel: embeddings[0]!.model_id, dimensions: vectors.values().next().value!.length, embedded: vectors.size, sourceLines: source.length, designLines: design.length, evidenceLines: targets.reduce((n, t) => n + t.evidence.length, 0), targetsHash: hash(JSON.stringify(targets)), batchesHash: hash(JSON.stringify([...labelledBatches, ...extraBatches])), labelledBatches: labelledBatches.length, extraBatches: extraBatches.length };
writeFileSync(join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(`Bun ${Bun.version}; prepared ${targets.length} targets, ${labelledBatches.length} labelled + ${extraBatches.length} extra batches; ${vectors.size} vectors; ${manifest.evidenceLines} real excerpt lines; inputs frozen.`);
