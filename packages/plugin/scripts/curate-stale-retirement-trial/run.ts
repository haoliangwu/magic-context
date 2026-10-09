import { SubcClient, type RouteHandle } from "@cortexkit/subc-client";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SYSTEM, MODEL, hash, prompt, parseDraft, validateOperations, type Arm, type Label, type TrialBatch } from "./core";

const repo = resolve(import.meta.dir, "../../../.."), root = join(repo, ".curate-trial");
const arm = process.argv[2];
if (!["text", "evidence", "topic", "probe"].includes(arm ?? "")) throw new Error("Usage: run.ts text|evidence|topic|probe");
// Unspecified dreamer temperature stays unspecified through the agent schema
// and OpenCode override resolution. No live config reader is imported.
const generation = { max_output_tokens: 32000 };
type Json = Record<string, any>;
const client = await SubcClient.connect({ connectionFile: join(root, "subc-connection.json"), handshakeTimeoutMs: 10000 });
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "catalog.json"), JSON.stringify(await client.catalogList()));

async function call(key: string, input: string) {
    const identity = { project_root: root, harness: "curate-trial", session: `${key}-${hash(input).slice(0, 16)}-${Date.now()}` };
    let route: RouteHandle | undefined, subroute: RouteHandle | undefined, runId: string | undefined;
    const events: Json[] = [], started = Date.now();
    try {
        route = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        const response = await client.request(route, { method: "session.send", params: { prompt: input, system: SYSTEM, model: { provider: "google", model: MODEL.slice(7) }, tools: [], generation } }, { timeoutMs: 60000 }) as Json;
        runId = response.result?.run_id ?? response.run_id;
        if (!runId) throw new Error(`No run id: ${JSON.stringify(response)}`);
        writeFileSync(join(root, "results", `${key}-admission.json`), JSON.stringify({ identity, runId, response, input }));
        subroute = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        let done!: () => void, fail!: (e: Error) => void;
        const terminal = new Promise<void>((res, rej) => { done = res; fail = rej; });
        const subscription = client.subscribe(subroute, { method: "session.subscribe", params: { from: "start" } }, bytes => {
            const event = JSON.parse(new TextDecoder().decode(bytes));
            if (event.kind === "display") return;
            const unit = event.unit ?? event, type = unit.type ?? unit.kind;
            events.push(unit);
            if (["error", "run_error", "paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
            if (["run_finished", "terminal", "run_terminal", "finished"].includes(type) && (!unit.run_id || unit.run_id === runId)) done();
        });
        const timer = setTimeout(() => fail(new Error("600s provider deadline")), 600000);
        try { await Promise.race([terminal, subscription.closed.then(() => { throw new Error("Stream closed before terminal"); })]); }
        finally { clearTimeout(timer); subscription.unsubscribe(); }
        const text = events.filter(e => (e.type ?? e.kind) === "assistant_message").map(e => e.message?.content?.filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("") ?? e.text ?? "").join("\n");
        const steps = events.filter(e => (e.type ?? e.kind) === "step_finished");
        writeFileSync(join(root, "results", `${key}-raw.json`), JSON.stringify({ identity, runId, text, events, durationMs: Date.now() - started }));
        if (!text.trim() || steps.length !== 1 || steps[0].finish_reason !== "stop") throw new Error("Empty or incomplete one-shot provider output");
        console.log(JSON.stringify({ key, runId, seconds: (Date.now() - started) / 1000, usage: steps.map(s => s.usage) }));
        return { text, identity, runId, usage: steps[0].usage, durationMs: Date.now() - started };
    } catch (error) {
        writeFileSync(join(root, "results", `${key}-error.json`), JSON.stringify({ identity, runId, events, error: String(error) }));
        if (route && runId) await client.request(route, { method: "run.cancel", params: { run_id: runId } }, { timeoutMs: 30000 }).catch(() => {});
        throw error;
    } finally {
        if (subroute) await client.closeRoute(subroute).catch(() => {});
        if (route) await client.closeRoute(route).catch(() => {});
    }
}

try {
    if (arm === "probe") {
        await call("probe", 'Return only {"operations":[]}. Connectivity check, no memories.');
        console.log(`Model reachable: ${MODEL}; one completed step; temperature omitted.`);
    } else {
        const labels: Label[] = await Bun.file(join(root, "evaluation.json")).json();
        if (!labels.length) throw new Error("Freeze ground truth before dispatch");
        const allBatches: TrialBatch[] = await Bun.file(join(root, arm === "text" ? "batches.json" : `${arm}-batches.json`)).json();
        for (const batch of allBatches) {
            const key = `${arm}-${batch.category}-${batch.index}`, path = join(root, "results", `${key}.json`);
            if (existsSync(path)) { console.log(`Already completed ${key}`); continue; }
            const input = prompt(batch, arm as Arm), result = await call(key, input);
            const draft = parseDraft(result.text);
            if (!draft.operations) throw new Error("One-shot arm returned source requests");
            validateOperations(draft.operations, new Set(batch.memories.map(m => m.id)), new Map(batch.memories.map(m => [m.id, m.category])));
            writeFileSync(path, JSON.stringify({ arm, category: batch.category, index: batch.index, promptHash: hash(input), systemHash: hash(SYSTEM), labelsHash: hash(JSON.stringify(labels)), model: MODEL, generation, operations: draft.operations, ...result }));
        }
    }
} finally { client.close(); }
