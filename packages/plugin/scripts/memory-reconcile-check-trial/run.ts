import { SubcClient, type RouteHandle } from "@cortexkit/subc-client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, MODEL, SYSTEM, hash, reconcilePrompt, evaluate, type Batch } from "./core";

const pass = process.argv[2];
if (!["A", "B"].includes(pass ?? "")) throw new Error("Usage: run.ts A|B (A = 225 targets; B = identical labelled 125)");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const batchesBytes = readFileSync(join(ROOT, "batches.json"), "utf8");
if (hash(batchesBytes) !== manifest.batchesHash) throw new Error("Frozen batches changed");
const batches: Batch[] = JSON.parse(batchesBytes);
const selected = batches.filter(b => pass === "A" || b.key.startsWith("labelled-"));
// Match curate's credential route and unspecified production temperature.
// Never import a product config reader or open a live store.
const generation = { max_output_tokens: 32000 };
type Json = Record<string, any>;
const client = await SubcClient.connect({ connectionFile: join(ROOT, "subc-connection.json"), handshakeTimeoutMs: 10000 });
const results = join(ROOT, "results");
mkdirSync(results, { recursive: true, mode: 0o700 });
writeFileSync(join(ROOT, "catalog.json"), JSON.stringify(await client.catalogList()), { mode: 0o600 });
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });

async function call(batch: Batch) {
    const key = `${pass}-${batch.key}`, file = join(results, `${key}.json`), input = reconcilePrompt(batch.targets, manifest.cutoff);
    if (existsSync(file)) {
        const previous = JSON.parse(readFileSync(file, "utf8"));
        if (previous.promptHash !== hash(input) || previous.systemHash !== hash(SYSTEM)) throw new Error(`Completed input changed: ${key}`);
        console.log(`Retained completed ${key}`); return;
    }
    const admissionFile = join(results, `${key}-admission.json`), rawFile = join(results, `${key}-raw.json`);
    const admitted = existsSync(admissionFile) ? JSON.parse(readFileSync(admissionFile, "utf8")) : undefined;
    if (admitted && admitted.input !== input) throw new Error(`Admitted input changed: ${key}`);
    const identity = admitted?.identity ?? { project_root: ROOT, harness: "memory-reconcile-trial", session: `${key}-${hash(input).slice(0, 12)}-${Date.now()}` };
    let route: RouteHandle | undefined, subroute: RouteHandle | undefined, runId: string | undefined = admitted?.runId;
    const events: Json[] = [], started = admitted?.started ?? Date.now();
    try {
        if (!existsSync(rawFile)) {
            route = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
            if (!admitted) {
                const response = await client.request(route, { method: "session.send", params: { prompt: input, system: SYSTEM, model: { provider: "google", model: MODEL.slice(7) }, tools: [], generation } }, { timeoutMs: 60000 }) as Json;
                runId = response.result?.run_id ?? response.run_id;
                if (!runId) throw new Error(`No run id: ${JSON.stringify(response)}`);
                save(admissionFile, { identity, runId, started, response, input });
            }
            subroute = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
            let done!: () => void, fail!: (error: Error) => void;
            const terminal = new Promise<void>((res, rej) => { done = res; fail = rej; });
            const subscription = client.subscribe(subroute, { method: "session.subscribe", params: { from: "start" } }, bytes => {
                const event = JSON.parse(new TextDecoder().decode(bytes));
                if (event.kind === "display") return;
                const unit = event.unit ?? event, type = unit.type ?? unit.kind;
                events.push(unit);
                if (["error", "run_error", "paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
                if (["run_finished", "terminal", "run_terminal", "finished"].includes(type) && (!unit.run_id || unit.run_id === runId)) done();
            });
            const timer = setTimeout(() => fail(new Error("600s provider deadline; resume admitted run, never resend")), 600000);
            try { await Promise.race([terminal, subscription.closed.then(() => { throw new Error("Stream closed before terminal"); })]); }
            finally { clearTimeout(timer); subscription.unsubscribe(); }
            const text = events.filter(e => (e.type ?? e.kind) === "assistant_message").map(e => e.message?.content?.filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("") ?? e.text ?? "").join("\n");
            save(rawFile, { identity, runId, text, events, durationMs: Date.now() - started });
        }
        const raw = JSON.parse(readFileSync(rawFile, "utf8"));
        const steps = raw.events.filter((e: Json) => (e.type ?? e.kind) === "step_finished");
        if (steps.length !== 1) throw new Error(`Unexpected provider step count: ${key}`);
        // A length-limited terminal is an observed abstention, not a reason to
        // reroll the trial. Count its usage and retain all targets unchanged.
        const incomplete = !raw.text.trim() || steps[0].finish_reason !== "stop";
        const evaluated = evaluate(incomplete ? "" : raw.text, batch.targets);
        save(file, { pass, key: batch.key, ids: batch.targets.map(t => t.memory.id), model: MODEL, generation, promptHash: hash(input), systemHash: hash(SYSTEM), labelsHash: manifest.labelsHash, ...raw, usage: steps[0].usage, finishReason: steps[0].finish_reason, incomplete, ...evaluated });
        console.log(JSON.stringify({ key, runId: raw.runId, seconds: raw.durationMs / 1000, usage: steps[0].usage, incomplete, schemaError: evaluated.schemaError, rejected: evaluated.gates.filter(g => g.rejected).length }));
    } catch (error) {
        save(join(results, `${key}-error.json`), { identity, runId, events, error: String(error) });
        throw error;
    } finally {
        if (subroute) await client.closeRoute(subroute).catch(() => {});
        if (route) await client.closeRoute(route).catch(() => {});
    }
}

try {
    // Three independent lineages at a time. Await all admitted calls on failure
    // so completed siblings are retained rather than accidentally redispatched.
    for (let i = 0; i < selected.length; i += 3) {
        const settled = await Promise.allSettled(selected.slice(i, i + 3).map(call));
        const failed = settled.find(r => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
    }
    console.log(`Bun ${Bun.version}; pass ${pass}: ${selected.length} batches complete`);
} finally { client.close(); }
