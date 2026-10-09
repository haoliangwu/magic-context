import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, isolate, removeMemory, trialRoot, type Memory } from "./core";

const root = trialRoot(process.argv[2]);
isolate(root);
const { parseCompartmentOutput } = await import("../../src/hooks/magic-context/compartment-parser");
const { estimateTokens } = await import("../../src/hooks/magic-context/read-session-formatting");
const db = new Database(join(root, "trial.db"), { readonly: true });
const rows = db.query("SELECT * FROM historian_runs ORDER BY created_at DESC,child_session DESC LIMIT 40").all() as {child_session: string; created_at: number; user_prompt: string; output: string}[];
if (rows.length !== 40) throw new Error("Expected forty newest runs");
const memories = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
const embeddings = db.query("SELECT model_id,count(*) AS count,length(embedding)/4 AS dims FROM memory_embeddings GROUP BY model_id").all();
const coverage = db.query("SELECT m.status,count(*) AS memories,count(e.memory_id) AS embedded FROM memories m LEFT JOIN memory_embeddings e ON m.id=e.memory_id GROUP BY m.status").all();
mkdirSync(join(root, "inputs"), { recursive: true, mode: 0o700 });
const manifest = rows.map((r, index) => {
    const stripped = removeMemory(r.user_prompt);
    const original = parseCompartmentOutput(r.output);
    const input = { index, session: r.child_session, before: r.created_at, prompt: stripped.prompt, originalOutput: r.output, originalFacts: original.facts,
        promptHash: hash(stripped.prompt), originalPromptHash: hash(r.user_prompt), blockHash: hash(stripped.block), originalChars: r.user_prompt.length,
        strippedChars: stripped.prompt.length, originalEstimatedTokens: estimateTokens(r.user_prompt), strippedEstimatedTokens: estimateTokens(stripped.prompt),
        memoryEstimatedTokens: estimateTokens(stripped.block), originalCompartments: original.compartments.length };
    writeFileSync(join(root, "inputs", `${index}.json`), JSON.stringify(input), { mode: 0o600 });
    const { prompt: _prompt, originalOutput: _output, originalFacts: _facts, ...safe } = input;
    return { ...safe, originalFactCount: original.facts.length, poolSize: memories.filter(m => m.status === "active" && m.created_at < r.created_at).length };
});
writeFileSync(join(root, "manifest.json"), JSON.stringify({ coverage, embeddings, cases: manifest }, null, 2), { mode: 0o600 });
db.close();
console.log(JSON.stringify({ prepared: manifest.length, coverage, embeddings, estimatedOriginalTokens: manifest.reduce((n, m) => n + m.originalEstimatedTokens, 0) }));
