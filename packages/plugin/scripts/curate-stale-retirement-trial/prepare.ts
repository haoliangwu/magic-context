import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { batches, cohort, hash, type Label, type Memory } from "./core";

const repo = resolve(import.meta.dir, "../../../.."), root = join(repo, ".curate-trial");
mkdirSync(root, { mode: 0o700, recursive: true });
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query(`SELECT id,category,content,source_type AS source,created_at AS createdAt,importance,retrieval_count AS retrievalCount,seen_count AS seenCount FROM memories WHERE status='active' ORDER BY id`).all()
    .map(row => ({ ...row as Omit<Memory, "mappedFiles" | "hasNoFileSentinel">, mappedFiles: [], hasNoFileSentinel: false }));
db.close();
const selected = cohort(memories);
const labels: Label[] = JSON.parse(readFileSync(join(import.meta.dir, "evaluation.json"), "utf8"));
const expected = [...selected.revisions, ...selected.known, ...selected.random].map(m => m.id).sort((a, b) => a - b);
if (JSON.stringify(labels.map(l => l.id).sort((a, b) => a - b)) !== JSON.stringify(expected)
    || labels.some(l => !["stale", "true", "unsure"].includes(l.label) || !l.reason || Object.keys(l).sort().join() !== "id,label,reason")) throw new Error("Label cohort/schema mismatch");
writeFileSync(join(root, "evaluation.json"), JSON.stringify(labels, null, 2));
writeFileSync(join(root, "input-identity.json"), JSON.stringify({ poolHash: hash(JSON.stringify(memories)), labelsHash: hash(JSON.stringify(labels)), selected: Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, v.map(m => m.id)])) }, null, 2));
writeFileSync(join(root, "pool.json"), JSON.stringify(memories));
writeFileSync(join(root, "evaluation-input.json"), JSON.stringify(selected, null, 2));
writeFileSync(join(root, "review.txt"), Object.entries(selected).flatMap(([group, rows]) => rows.map(m => `${group} #${m.id}: ${m.content}`)).join("\n"));
writeFileSync(join(root, "batches.json"), JSON.stringify(batches(memories)));
console.log(JSON.stringify({ active: memories.length, revisions: selected.revisions.length, known: selected.known.length, random: selected.random.length, labels: Object.fromEntries(["stale", "true", "unsure"].map(l => [l, labels.filter(row => row.label === l).length])), batches: batches(memories).map(b => ({ category: b.category, n: b.memories.length })) }));
