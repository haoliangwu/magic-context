import { SubcClient, type BindIdentity, type RouteHandle } from "@cortexkit/subc-client";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hash, MODEL, parseScores } from "./core";

const root = resolve(tmpdir(), "magic-context/compartment-rescore-bg_a526ac86bdd83bf2");
if (resolve(process.argv[2] ?? "") !== root) throw new Error("Root outside trial fence");
const limit = Number(process.argv[3] ?? 30);
if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("Batch limit must be 1-30");
const retryFailed = process.argv[4] === "--retry-failed";
const manifest = await Bun.file(join(root, "manifest.json")).json();
mkdirSync(join(root, "results"), { recursive: true, mode: 0o700 });
const client = await SubcClient.connect({ connectionFile: join(root, "subc-connection.json") });
type Json = Record<string, any>;
async function call(index: number, arm: string) {
    const path = join(root, "results", `${index}-${arm}.json`);
    const input = await Bun.file(join(root, "inputs", `${index}.json`)).json();
    let recovery: { identity: BindIdentity; runId: string } | undefined;
    if (await Bun.file(path).exists()) {
        const prior = await Bun.file(path).json();
        if (!prior.error) {
            if (prior.promptHash !== input.promptHashes[arm] || prior.systemHash !== input.systemHash) throw new Error("Resume hash mismatch");
            parseScores(prior.text, input.ids);
            return;
        }
        if (!retryFailed) throw new Error(`Failed cell ${index}/${arm}; inspect, then explicitly use --retry-failed`);
        if (prior.error === "Error: client closed" && prior.runId) recovery = await Bun.file(join(root, "results", `${index}-${arm}-admission.json`)).json();
        mkdirSync(join(root, "superseded"), { recursive: true, mode: 0o700 });
        renameSync(path, join(root, "superseded", `${index}-${arm}-${Date.now()}.json`));
    }
    // Retrying a rejected terminal answer must never append to its provider conversation.
    const identity = recovery?.identity ?? { project_root: root, harness: "compartment-rescore-trial", session: `rescore-${manifest.namespace}-${index}-${arm}-${randomUUID()}` };
    const events: Json[] = [];
    let route: RouteHandle | undefined, subroute: RouteHandle | undefined, runId: string | undefined;
    let text = "";
    const started = Date.now();
    try {
        route = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        if (recovery) runId = recovery.runId;
        else {
            const response = await client.request(route, { method: "session.send", params: { prompt: input.prompts[arm], system: input.system, model: { provider: "google", model: "antigravity-gemini-3.8-flash" }, tools: [], generation: { temperature: 0.1, max_output_tokens: 32000 } } }, { timeoutMs: 60000 }) as Json;
            runId = response.result?.run_id ?? response.run_id;
            if (!runId) throw new Error(`No run id: ${JSON.stringify(response)}`);
        }
        writeFileSync(join(root, "results", `${index}-${arm}-admission.json`), JSON.stringify({ runId, identity }), { mode: 0o600 });
        subroute = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        let finish!: () => void, fail!: (error: Error) => void;
        const terminal = new Promise<void>((res, rej) => { finish = res; fail = rej; });
        const subscription = client.subscribe(subroute, { method: "session.subscribe", params: { from: "start" } }, bytes => {
            const event = JSON.parse(new TextDecoder().decode(bytes));
            if (event.kind === "display") return;
            const unit = event.unit ?? event;
            events.push(unit);
            const type = unit.type ?? unit.kind;
            if (type === "assistant_message") text += unit.message?.content?.filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("") ?? unit.text ?? "";
            if (["error", "run_error", "paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
            if (["run_finished", "terminal", "run_terminal", "finished"].includes(type)) finish();
        });
        const timer = setTimeout(() => fail(new Error("600s cell deadline")), 600000);
        try { await Promise.race([terminal, subscription.closed.then(() => { throw new Error("Stream ended before terminal"); })]); }
        finally { clearTimeout(timer); subscription.unsubscribe(); }
        const scores = parseScores(text, input.ids);
        const steps = events.filter(e => e.type === "step_finished");
        if (steps.length !== 1 || steps[0]!.finish_reason !== "stop") throw new Error(`Incomplete provider generation: ${JSON.stringify(steps)}`);
        writeFileSync(path, JSON.stringify({ index, arm, model: MODEL, identity, runId, recovered: Boolean(recovery), text, scores, events, promptHash: hash(input.prompts[arm]), systemHash: hash(input.system), durationMs: Date.now() - started }), { mode: 0o600 });
        console.log(JSON.stringify({ index, arm, runId, count: scores.length, seconds: (Date.now() - started) / 1000, usage: steps.map(e => e.usage) }));
    } catch (error) {
        if (route && runId) await client.request(route, { method: "run.cancel", params: { run_id: runId } }, { timeoutMs: 30000 }).catch(() => {});
        writeFileSync(path, JSON.stringify({ index, arm, error: String(error), runId, events }), { mode: 0o600 });
        throw error;
    } finally {
        if (subroute) await client.closeRoute(subroute).catch(() => {});
        if (route) await client.closeRoute(route).catch(() => {});
    }
}
try {
    let next = 0;
    let stopped = false;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(2, limit) }, async () => {
        while (!stopped && next < limit) {
            const index = next++;
            // A pilot only dispatches one base cell. Full runs resume it and rotate repeat/context order.
            const arms = limit === 1 ? ["base"] : manifest.batches[index].arms;
            try {
                for (const arm of index % 2 ? [...arms].reverse() : arms) {
                    if (stopped) break;
                    await call(index, arm);
                }
            } catch (error) { stopped = true; throw error; }
        }
    }));
    const failure = outcomes.find(r => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
} finally { client.close(); }
console.log(`Completed/resumed ${limit} batches; no fallback models or automatic retries.`);
