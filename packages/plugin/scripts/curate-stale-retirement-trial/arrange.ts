import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chunkCurateMemories } from "../../src/features/magic-context/dreamer/task-prompts";
import { CATEGORIES, hash, safeRepoPath, type Excerpt, type Memory, type TrialBatch } from "./core";
import { frequencies, identifiers, normalizeVector, rankEvidence, tokens, topicBatches } from "./retrieval";

const repo = resolve(import.meta.dir, "../../../.."), root = join(repo, ".curate-trial");
const pool: Memory[] = JSON.parse(readFileSync(join(root, "pool.json"), "utf8"));
const df = frequencies(pool.map(m => tokens(m.content)));
const terms = new Map(pool.map(m => [m.id, identifiers(m, df)]));
const allTerms = [...new Set([...terms.values()].flat())];
mkdirSync(join(root, "grep-cache"), { recursive: true });

function grep(paths: string[], untracked = false): Excerpt[] {
    for (const path of paths.filter(p => !p.startsWith(":!"))) safeRepoPath(repo, path);
    const found = new Map<string, Excerpt>();
    // Enumerate numbered source once, then execute each memory's literal
    // identifier queries against that immutable capture. This avoids repeatedly
    // scanning large Rust files while preserving real git-grep path/line bytes.
    for (const start of [0]) {
        const command = ["timeout", "120s", "git", "grep", "--threads=1", ...(untracked ? ["--no-index"] : []), "-n", "-I", "-e", "", "--", ...paths];
        const output = join(root, "grep-cache", `${hash(JSON.stringify(["numbered-source", paths]))}.txt`);
        if (!existsSync(`${output}.ok`)) {
            // Redirect the large capture to disk instead of buffering it in
            // the child process's output pipe.
            const fd = openSync(output, "w");
            const response = Bun.spawnSync(command, { cwd: repo, stdout: fd });
            closeSync(fd);
            if (![0, 1].includes(response.exitCode)) {
                const partial = readFileSync(output, "utf8");
                throw new Error(`Evidence grep shard ${start} failed: ${response.exitCode}; bytes=${partial.length}; last path=${partial.trim().split("\n").at(-1)?.split(":")[0]}; ${response.stderr}`);
            }
            writeFileSync(`${output}.ok`, "complete");
        }
        console.log(`Captured numbered ${untracked ? "design" : "source"} for ${allTerms.length} identifier queries`);
        for (const line of readFileSync(output, "utf8").split("\n")) {
            const match = line.match(/^([^:]+):(\d+):(.*)$/);
            if (!match || match[1]!.includes("curate-stale-retirement-trial")) continue;
            found.set(`${match[1]}:${match[2]}`, { path: match[1]!, line: Number(match[2]), text: match[3]! });
        }
    }
    return [...found.values()];
}
const source = grep(["packages/plugin/src", "packages/pi-plugin/src", "packages/cli/src", "crates", "scripts", "docs/designs", "CONFIGURATION.md", "packages/plugin/package.json", ":!**/node_modules/**", ":!crates/**/testdata/**", ":!crates/**/tests/**", ":!**/*.json", ":!**/*.jcs", ":!**/*.golden*"]);
const docs = grep([".cortexkit/alfonso/plans/ck-extensibility-design-r7.3.md", ".cortexkit/alfonso/plans/ck-extensibility-r7.3-errata.md"], true);
const lineIndex = new Map<string, Set<number>>();
source.forEach((row, index) => { for (const term of new Set(tokens(row.text))) { const ids = lineIndex.get(term) ?? new Set<number>(); ids.add(index); lineIndex.set(term, ids); } });
const evidence = Object.fromEntries(pool.map(m => {
    const candidates = new Set<number>();
    for (const term of terms.get(m.id)!.flatMap(tokens)) for (const index of lineIndex.get(term) ?? []) candidates.add(index);
    return [m.id, rankEvidence(m, terms.get(m.id)!, docs, [...candidates].map(i => source[i]!))];
}));
const byId = new Map(pool.map(m => [m.id, m]));
const evidenceBatches: TrialBatch[] = CATEGORIES.flatMap(category => {
    const sized = pool.filter(m => m.category === category).map(m => ({ ...m, content: m.content + "\n" + evidence[m.id]!.map(e => `${e.path}:${e.line}: ${e.text}`).join("\n") }));
    return chunkCurateMemories(sized, 240000).map((chunk, index) => ({ category, index, memories: chunk.memories.map(m => byId.get(m.id)!), crossChunkCandidates: chunk.crossChunkCandidates, evidence: Object.fromEntries(chunk.memories.map(m => [m.id, evidence[m.id]])) }));
});
writeFileSync(join(root, "evidence-batches.json"), JSON.stringify(evidenceBatches));
writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence));

const db = new Database(join(root, "trial.db"), { readonly: true });
const rows = db.query("SELECT e.memory_id,e.model_id,e.embedding FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.status='active' ORDER BY e.memory_id").all() as { memory_id: number; model_id: string; embedding: Uint8Array }[];
db.close();
if (new Set(rows.map(r => r.model_id)).size > 1) throw new Error("Cannot compare embeddings from different models");
const vectors = new Map<number, Float32Array>();
for (const row of rows) { const v = normalizeVector(row.embedding); if (v) vectors.set(row.memory_id, v); }
const topics = topicBatches(pool, vectors);
writeFileSync(join(root, "topic-batches.json"), JSON.stringify(topics));
writeFileSync(join(root, "arrangement.json"), JSON.stringify({ embeddingModel: rows[0]?.model_id, vectorDimensions: vectors.values().next().value?.length, embedded: vectors.size, bm25Fallback: pool.length - vectors.size, evidenceLines: Object.values(evidence).reduce((n, e) => n + e.length, 0), sourceHits: source.length, designHits: docs.length, evidenceHash: hash(JSON.stringify(evidence)), termsHash: hash(JSON.stringify([...terms])), evidenceBatches: evidenceBatches.map(b => ({ category: b.category, index: b.index, ids: b.memories.map(m => m.id) })), topicBatches: topics.map(b => ({ index: b.index, ids: b.memories.map(m => m.id) })) }, null, 2));
console.log(JSON.stringify({ embedded: vectors.size, bm25Fallback: pool.length - vectors.size, sourceHits: source.length, designHits: docs.length, evidenceBatches: evidenceBatches.length, topicBatches: topics.length }));
