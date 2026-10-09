import { SubcClient, type RouteHandle } from "@cortexkit/subc-client";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, isolate, MODEL } from "./core";
import { armOrder, GENERATION, pairedPrompts, pairedRoot, validateTurn } from "./paired";

const root = pairedRoot(process.argv[2]);
const cases = process.argv[3] ? process.argv[3].split(",").map(Number) : Array.from({ length: 40 }, (_, i) => i);
if (new Set(cases).size !== cases.length || cases.some(i => !Number.isInteger(i) || i < 0 || i >= 40)) throw new Error("Cases outside cohort");
isolate(root);
const { parseCompartmentOutput } = await import("../../src/hooks/magic-context/compartment-parser");
const db = new Database(join(root, "trial.db"), { readonly: true });
const system = readFileSync(join(import.meta.dir, "../../../..", "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
mkdirSync(join(root, "paired-results"), { recursive: true, mode: 0o700 });
const client = await SubcClient.connect({ connectionFile: join(root, "subc-connection.json") });
const save = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });

async function run(index: number): Promise<void> {
    const input = await Bun.file(join(root, "inputs", `${index}.json`)).json();
    const row = db.query("SELECT child_session,created_at,user_prompt FROM historian_runs WHERE child_session=?").get(input.session) as { child_session: string; created_at: number; user_prompt: string };
    const prompts = pairedPrompts(input, row);
    const baseline = await Bun.file(join(root, "results", `${index}-turn1.json`)).json();
    validateTurn(baseline, prompts.S, system);
    for (const arm of armOrder(index)) {
        const prompt = prompts[arm];
        const base = join(root, "paired-results", `${index}-${arm}`);
        const identity = { project_root: root, harness: "historian-memory-block-paired-control", session: `paired-${index}-${arm}-${hash(prompt).slice(0, 24)}` };
        if (existsSync(`${base}.json`)) {
            validateTurn(await Bun.file(`${base}.json`).json(), prompt, system);
            continue;
        }
        const admitted = existsSync(`${base}-admission.json`) ? await Bun.file(`${base}-admission.json`).json() : undefined;
        let route: RouteHandle | undefined, stream: RouteHandle | undefined, runId: string | undefined;
        const events: any[] = [];
        let text = "";
        const started = admitted?.started ?? Date.now();
        try {
            route = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
            if (admitted) {
                if (JSON.stringify(admitted.identity) !== JSON.stringify(identity) || admitted.promptHash !== hash(prompt) || admitted.systemHash !== hash(system)) throw new Error("Admission identity changed");
                runId = admitted.runId;
            } else {
                // Each arm is a fresh first turn, not an import or continuation.
                // Read before sending so an unexpectedly occupied lineage is refused.
                const prior = await client.request(route, { method: "session.read", params: {} }, { timeoutMs: 60000 }) as any;
                if (prior.result.messages.length) throw new Error("First-turn lineage is not empty");
                const response = await client.request(route, { method: "session.send", params: { prompt, system, model: { provider: "google", model: "antigravity-gemini-3.8-flash" }, tools: [], generation: GENERATION } }, { timeoutMs: 60000 }) as any;
                runId = response.result?.run_id ?? response.run_id;
                if (!runId) throw new Error("Broca did not admit a run");
                save(`${base}-admission.json`, { runId, identity, promptHash: hash(prompt), systemHash: hash(system), started, priorMessages: 0, lineageId: prior.result.lineage_id });
            }
            stream = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
            let finish!: () => void, fail!: (e: Error) => void;
            const terminal = new Promise<void>((res, rej) => { finish = res; fail = rej; });
            let current = false;
            const subscription = client.subscribe(stream, { method: "session.subscribe", params: { from: "start" } }, bytes => {
                const event = JSON.parse(new TextDecoder().decode(bytes));
                if (event.kind === "display") return;
                const unit = event.unit ?? event;
                const type = unit.type ?? unit.kind;
                if (type === "run_started") current = unit.run_id === runId;
                if (!current && unit.run_id !== runId) return;
                events.push(unit);
                if (type === "assistant_message") text += unit.message?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? unit.text ?? "";
                if (["error", "run_error", "paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
                if (["run_finished", "terminal", "run_terminal", "finished"].includes(type)) finish();
            });
            const timer = setTimeout(() => fail(new Error("600s provider deadline")), 600000);
            try { await Promise.race([terminal, subscription.closed.then(() => { throw new Error("Stream closed before terminal"); })]); }
            finally { clearTimeout(timer); subscription.unsubscribe(); }
            const result = { runId, identity, model: MODEL, generation: GENERATION, promptHash: hash(prompt), systemHash: hash(system), text, events,
                usage: events.find(e => e.type === "step_finished")?.usage, durationMs: Date.now() - started, reattached: Boolean(admitted) };
            validateTurn(result, prompt, system);
            save(`${base}.json`, result);
            const parsed = parseCompartmentOutput(text);
            if (!parsed.compartments.length || parsed.droppedFacts || parsed.droppedFactBlocks) throw new Error("Unusable historian output (raw reply retained)");
            console.log(JSON.stringify({ index, arm, facts: parsed.facts.length, compartments: parsed.compartments.length, seconds: result.durationMs / 1000, usage: result.usage }));
        } catch (error) {
            save(`${base}-error.json`, { error: String(error), runId, text, events });
            if (route && runId) await client.request(route, { method: "run.cancel", params: { run_id: runId } }, { timeoutMs: 30000 }).catch(() => {});
            throw error;
        } finally {
            if (stream) await client.closeRoute(stream).catch(() => {});
            if (route) await client.closeRoute(route).catch(() => {});
        }
    }
}
try {
    let next = 0;
    // A failure stops new work; already admitted pairs finish and remain resumable.
    let stopped = false;
    const settled = await Promise.allSettled(Array.from({ length: Math.min(3, cases.length) }, async () => {
        while (!stopped && next < cases.length) {
            try { await run(cases[next++]!); } catch (error) { stopped = true; throw error; }
        }
    }));
    const failed = settled.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
} finally { client.close(); db.close(); }
console.log(`Completed ${cases.length} fresh pairs; no tools, retries, imports, continuations or memory writes.`);
