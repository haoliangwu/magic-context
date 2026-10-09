import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eligible, embeddingCredential, EMBEDDING_MODEL, isolate, normalize, retrieve, trialRoot, type Memory } from "./core";

const root = trialRoot(process.argv[2]);
const phase = process.argv[3] ?? "second";
if (!["first", "second"].includes(phase)) throw new Error("Review phase must be first or second");
const limit = Number(process.argv[4] ?? 40);
if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error("Review limit must be 1..40");
const credential = phase === "second" ? await embeddingCredential().catch(() => undefined) : undefined;
isolate(root);
const { OpenAICompatibleEmbeddingProvider } = await import("../../src/features/magic-context/memory/embedding-openai");
const provider = credential ? new OpenAICompatibleEmbeddingProvider({ endpoint: "https://openrouter.ai/api/v1", model: EMBEDDING_MODEL, apiKey: credential, maxInputTokens: 8192 }) : undefined;
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
const rows = db.query("SELECT memory_id,embedding FROM memory_embeddings").all() as {memory_id: number; embedding: Uint8Array}[];
const vectors = new Map(rows.map(r => [r.memory_id, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))]));
const manifest = await Bun.file(join(root, "manifest.json")).json();
const reviews = [];
for (const c of manifest.cases.slice(0, limit)) {
    const input = await Bun.file(join(root, "inputs", `${c.index}.json`)).json();
    const candidate = await Bun.file(join(root, "results", `${c.index}-${phase === "first" ? "lexical" : "candidates"}.json`)).json();
    const decisions = phase === "second" ? await Bun.file(join(root, "results", `${c.index}-decisions.json`)).json() : {};
    const pool = eligible(memories, input.before);
    const queries = provider ? await provider.embedBatch(input.originalFacts.map((f: {content: string}) => f.content), undefined, "query") : [];
    if (provider && queries.some(q => !q)) throw new Error("Original-fact embedding failed");
    const original = input.originalFacts.map((f: {category: string; content: string}, i: number) => {
        const exact = memories.filter(m => normalize(m.content) === normalize(f.content));
        return { ...f, exactBefore: exact.filter(m => m.created_at < input.before).map(m => m.id),
            newIds: exact.filter(m => m.created_at >= input.before && m.created_at < input.before + 600000 && m.source_type === "historian").map(m => m.id),
            matches: retrieve(f, pool, vectors, queries[i] ?? undefined) };
    });
    const item = { index: c.index, before: input.before, session: input.session, original, ...candidate, ...decisions };
    reviews.push(item);
    writeFileSync(join(root, "results", `${c.index}-review-${phase}.json`), JSON.stringify(item, null, 2), { mode: 0o600 });
}
writeFileSync(join(root, `review-${phase}.json`), JSON.stringify(reviews), { mode: 0o600 });
db.close(); await provider?.dispose();
console.log(`Prepared ${reviews.length} cases for independent manual adjudication; exact content/time attribution is not a publish audit log.`);
