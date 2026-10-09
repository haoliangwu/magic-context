import { SubcClient, type RouteHandle } from "@cortexkit/subc-client";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cosine, eligible, embeddingCredential, EMBEDDING_MODEL, hash, isolate, mergePrompt, MODEL, parseDecisions, retrieve, trialRoot, type Memory } from "./core";

const root = trialRoot(process.argv[2]);
const limit = Number(process.argv[3] ?? 40);
if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error("Limit must be 1..40");
const phase = process.argv[4] ?? "all";
if (!["first", "second", "all"].includes(phase)) throw new Error("Phase must be first, second or all");
// The authorized vault helper resolves its enrollment path before HOME is isolated.
let apiKey: string | undefined;
let credentialError: string | undefined;
try { if (phase !== "first") apiKey = await embeddingCredential(); }
catch { credentialError = "Vault read failed; authorized BM25-only fallback"; }
isolate(root);
const { OpenAICompatibleEmbeddingProvider } = await import("../../src/features/magic-context/memory/embedding-openai");
const { parseCompartmentOutput } = await import("../../src/hooks/magic-context/compartment-parser");
const provider = apiKey ? new OpenAICompatibleEmbeddingProvider({ endpoint: "https://openrouter.ai/api/v1", model: EMBEDDING_MODEL, apiKey, maxInputTokens: 8192 }) : undefined;
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
const stored = db.query("SELECT memory_id,model_id,embedding FROM memory_embeddings").all() as {memory_id: number; model_id: string; embedding: Uint8Array}[];
const vectors = new Map(stored.map(r => [r.memory_id, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))]));
if (provider && stored.some(r => r.model_id !== provider.modelId)) throw new Error("Embedding provider identity differs from snapshot");
mkdirSync(join(root, "results"), { recursive: true, mode: 0o700 });
const save = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
if (provider) {
    const active = memories.filter(m => m.status === "active" && vectors.has(m.id));
    const samples = Array.from({ length: 5 }, (_, i) => active[Math.floor(i * (active.length - 1) / 4)]!);
    const checked = [];
    for (const m of samples) {
        const q = await provider.embed(m.content, undefined, "passage");
        if (!q) throw new Error(`Document self-match embedding failed: ${provider.getLastFailureReason()?.reason}`);
        const ranking = active.map(a => ({ id: a.id, score: cosine(q, vectors.get(a.id)!) })).sort((a, b) => b.score - a.score);
        checked.push({ id: m.id, top: ranking[0], selfScore: ranking.find(a => a.id === m.id)!.score });
        if (ranking[0]!.id !== m.id) throw new Error(`Document self-match failed for #${m.id}`);
    }
    save(join(root, "self-check.json"), { model: EMBEDDING_MODEL, providerId: provider.modelId, checked });
    console.log(`Five independent stored-document self-matches passed (${EMBEDDING_MODEL})`);
} else if (phase !== "first") save(join(root, "self-check.json"), { credentialError });
const client = await SubcClient.connect({ connectionFile: join(root, "subc-connection.json") });
const system = readFileSync(join(import.meta.dir, "../../../..", "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
type Json = Record<string, any>;
const generation = { max_output_tokens: 32000, temperature: 0.1 };
async function turn(identity: {project_root: string; harness: string; session: string}, prompt: string, index: number, number: number) {
    let route: RouteHandle | undefined, stream: RouteHandle | undefined, runId: string | undefined;
    const events: Json[] = [];
    let text = "";
    const started = Date.now();
    try {
        route = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        const response = await client.request(route, { method: "session.send", params: { prompt, system, model: { provider: "google", model: "antigravity-gemini-3.8-flash" }, tools: [], generation } }, { timeoutMs: 60000 }) as Json;
        runId = response.result?.run_id ?? response.run_id;
        if (!runId) throw new Error("Broca did not admit a run");
        save(join(root, "results", `${index}-turn${number}-admission.json`), { runId, identity, promptHash: hash(prompt) });
        stream = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        let finish!: () => void, fail!: (e: Error) => void;
        const terminal = new Promise<void>((res, rej) => { finish = res; fail = rej; });
        let current = false;
        const subscription = client.subscribe(stream, { method: "session.subscribe", params: { from: "start" } }, bytes => {
            const event = JSON.parse(new TextDecoder().decode(bytes));
            if (event.kind === "display") return;
            const unit = event.unit ?? event;
            const type = unit.type ?? unit.kind;
            // Session replay includes the first turn; only the admitted run contributes.
            if (type === "run_started") current = unit.run_id === runId;
            if (!current && unit.run_id !== runId) return;
            events.push(unit);
            if (type === "assistant_message") text += unit.message?.content?.filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("") ?? unit.text ?? "";
            if (["error", "run_error", "paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
            if (["run_finished", "terminal", "run_terminal", "finished"].includes(type)) finish();
        });
        const timer = setTimeout(() => fail(new Error("600s provider deadline")), 600000);
        try { await Promise.race([terminal, subscription.closed.then(() => { throw new Error("Stream closed before terminal"); })]); }
        finally { clearTimeout(timer); subscription.unsubscribe(); }
        const steps = events.filter(e => e.type === "step_finished");
        if (steps.length !== 1 || steps[0]!.finish_reason !== "stop" || events.find(e => e.type === "run_finished")?.reason !== "completed") throw new Error("Incomplete or non-single-step run");
        const result = { runId, identity, model: MODEL, generation, systemHash: hash(system), promptHash: hash(prompt), text, events, usage: steps[0]!.usage, durationMs: Date.now() - started };
        save(join(root, "results", `${index}-turn${number}.json`), result);
        console.log(JSON.stringify({ index, turn: number, runId, seconds: result.durationMs / 1000, usage: result.usage }));
        return result;
    } catch (error) {
        save(join(root, "results", `${index}-turn${number}-error.json`), { error: String(error), runId, events, text });
        if (route && runId) await client.request(route, { method: "run.cancel", params: { run_id: runId } }, { timeoutMs: 30000 }).catch(() => {});
        throw error;
    } finally {
        if (stream) await client.closeRoute(stream).catch(() => {});
        if (route) await client.closeRoute(route).catch(() => {});
    }
}
async function run(index: number) {
    if (existsSync(join(root, "results", `${index}-decisions.json`))) return;
    const input = await Bun.file(join(root, "inputs", `${index}.json`)).json();
    const identity = { project_root: root, harness: "historian-merge-turn-trial", session: `merge-turn-${index}-${hash(input.prompt).slice(0, 24)}` };
    const firstPath = join(root, "results", `${index}-turn1.json`);
    let first;
    if (existsSync(firstPath)) first = await Bun.file(firstPath).json();
    else {
        if (phase === "second" || existsSync(join(root, "results", `${index}-turn1-admission.json`))) throw new Error(`Missing completed first turn for case ${index}; refusing reused lineage`);
        first = await turn(identity, input.prompt, index, 1);
    }
    const parsed = parseCompartmentOutput(first.text);
    if (!parsed.compartments.length || parsed.droppedFacts || parsed.droppedFactBlocks) throw new Error("Unusable historian output");
    const pool = eligible(memories, input.before);
    const lexicalPath = join(root, "results", `${index}-lexical.json`);
    const lexicalMatches = existsSync(lexicalPath) ? (await Bun.file(lexicalPath).json()).matches : parsed.facts.map(f => retrieve(f, pool, vectors));
    if (!existsSync(lexicalPath)) save(lexicalPath, { facts: parsed.facts, matches: lexicalMatches, poolSize: pool.length, compartments: parsed.compartments.length });
    if (phase === "first") return;
    if (existsSync(join(root, "results", `${index}-turn2-admission.json`))) throw new Error(`Refusing repeated second turn for case ${index}`);
    const queries = provider ? await provider.embedBatch(parsed.facts.map(f => f.content), undefined, "query") : [];
    if (provider && queries.some(q => !q)) throw new Error("Query embedding failed; do not silently change retrieval lane");
    const matches = parsed.facts.map((f, i) => retrieve(f, pool, vectors, queries[i] ?? undefined, lexicalMatches[i]));
    const prompt = mergePrompt(parsed.facts, matches);
    save(join(root, "results", `${index}-candidates.json`), { facts: parsed.facts, matches, poolSize: pool.length, prompt, compartments: parsed.compartments.length });
    const second = await turn(identity, prompt, index, 2);
    save(join(root, "results", `${index}-decisions.json`), { decisions: parseDecisions(second.text, matches) });
}
try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, limit) }, async () => { while (next < limit) await run(next++); }));
} finally { client.close(); db.close(); await provider?.dispose(); }
console.log(`Completed ${limit} cases (${phase} phase); no publication, fallback models or retries.`);
