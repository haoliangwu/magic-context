import { SubcClient, type RouteHandle } from "@cortexkit/subc-client";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eligible, hash, isolate, MODEL, type Memory } from "./core";
import { evaluateV2, mergePromptV2, rankCandidates, REPEAT_CASES, transcriptEvidence, v2Root } from "./v2";

const root = v2Root(process.argv[2]);
const pass = process.argv[3] ?? "A";
if (!["A", "B", "C"].includes(pass)) throw new Error("Pass must be A, B or C");
const cohort = pass === "A" ? Array.from({ length: 40 }, (_, i) => i) : REPEAT_CASES;
const cases = process.argv[4] ? process.argv[4].split(",").map(Number) : cohort;
if (new Set(cases).size !== cases.length || cases.some(i => !cohort.includes(i))) throw new Error("Cases outside pass cohort");
isolate(root);
const out = join(root, "v2-results", pass);
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown): void => writeFileSync(join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const load = (name: string) => Bun.file(join(root, name)).json();
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
const system = readFileSync(join(import.meta.dir, "../../../..", "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
const client = await SubcClient.connect({ connectionFile: join(root, "subc-connection.json") });
type Json = Record<string, any>;
const generation = { max_output_tokens: 32000, temperature: 0.1 };

async function run(index: number): Promise<void> {
    if (existsSync(join(out, `${index}-decisions.json`))) return;
    const input = await load(`inputs/${index}.json`);
    const first = await load(`results/${index}-turn1.json`);
    const staged = await load(`results/${index}-candidates.json`);
    if (first.systemHash !== hash(system) || first.promptHash !== hash(input.prompt) || first.model !== MODEL) throw new Error("First-turn identity mismatch");
    const pool = eligible(memories, input.before);
    const matches = staged.facts.map((f: any, i: number) => rankCandidates(f, staged.matches[i], pool));
    const prompt = mergePromptV2(staged.facts, matches, input.before);
    save(`${index}-candidates.json`, { facts: staged.facts, matches, poolSize: pool.length, prompt, before: input.before });
    const evidence = transcriptEvidence(input.prompt);
    const resultPath = join(out, `${index}-turn2.json`);
    if (existsSync(resultPath)) {
        const completed = await Bun.file(resultPath).json();
        if (completed.promptHash !== hash(prompt)) throw new Error("Completed prompt changed");
        recordDecisions(completed.text);
        return;
    }
    const admitted = existsSync(join(out, `${index}-admission.json`)) ? await Bun.file(join(out, `${index}-admission.json`)).json() : undefined;
    const identity = { project_root: root, harness: "historian-merge-turn-trial-v2", session: `v2-${pass}-${index}-${hash(prompt).slice(0, 24)}` };
    let route: RouteHandle | undefined, stream: RouteHandle | undefined, runId: string | undefined;
    const events: Json[] = [];
    let text = "";
    const started = Date.now();
    function recordDecisions(reply: string): void {
        save(`${index}-decisions.json`, evaluateV2(reply, matches, evidence));
    }
    try {
        route = await client.routeOpen({ kind: "management_surface", module_id: "broca" }, identity);
        if (admitted) {
            if (JSON.stringify(admitted.identity) !== JSON.stringify(identity) || admitted.promptHash !== hash(prompt)) throw new Error("Admitted identity changed");
            runId = admitted.runId;
        } else {
        // V1 already appended its second turn to the original lineages. Import
        // only the recorded first exchange into a fresh lineage per repetition;
        // this avoids contaminating v2 with either v1 or earlier v2 answers.
        const prior = [{ role: "user", content: [{ type: "text", text: input.prompt }] },
            { role: "assistant", content: [{ type: "text", text: first.text }], origin: { provider_module_id: "google", model_id: "antigravity-gemini-3.8-flash" } }];
        const imported = await client.request(route, { method: "session.import", params: { import_id: `v2-${pass}-${index}`, origin: { kind: "import", source_ref: `merge-turn-trial:${first.runId}` }, messages: prior } }, { timeoutMs: 60000 }) as Json;
        const read = await client.request(route, { method: "session.read", params: {} }, { timeoutMs: 60000 }) as Json;
        const actual = read.result.messages.map((m: Json) => m.message);
        if (actual.length !== 2 || actual.some((m: Json, i: number) => m.role !== prior[i]!.role || m.content.map((b: Json) => b.text ?? "").join("") !== prior[i]!.content[0]!.text)) throw new Error("Imported first exchange changed");
        save(`${index}-prior.json`, { mode: "imported-prior-turns", imported, lineageId: read.result.lineage_id, roles: actual.map((m: Json) => m.role), firstRunId: first.runId, promptHash: hash(input.prompt), replyHash: hash(first.text) });
        const admission = await client.request(route, { method: "session.send", params: { prompt, system, model: { provider: "google", model: "antigravity-gemini-3.8-flash" }, tools: [], generation } }, { timeoutMs: 60000 }) as Json;
        runId = admission.result?.run_id ?? admission.run_id;
        if (!runId) throw new Error("Broca did not admit a run");
        save(`${index}-admission.json`, { runId, identity, promptHash: hash(prompt), started });
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
            if (type === "assistant_message") text += unit.message?.content?.filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("") ?? unit.text ?? "";
            if (["error", "run_error", "paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
            if (["run_finished", "terminal", "run_terminal", "finished"].includes(type)) finish();
        });
        const timer = setTimeout(() => fail(new Error("600s provider deadline")), 600000);
        try { await Promise.race([terminal, subscription.closed.then(() => { throw new Error("Stream closed before terminal"); })]); }
        finally { clearTimeout(timer); subscription.unsubscribe(); }
        const steps = events.filter(e => e.type === "step_finished");
        if (steps.length !== 1 || steps[0]!.finish_reason !== "stop" || events.find(e => e.type === "run_finished")?.reason !== "completed") throw new Error("Incomplete provider run");
        save(`${index}-turn2.json`, { runId, identity, model: MODEL, generation, systemHash: hash(system), promptHash: hash(prompt), text, events, usage: steps[0]!.usage, durationMs: Date.now() - (admitted?.started ?? started), reattached: Boolean(admitted) });
        recordDecisions(text);
        console.log(JSON.stringify({ pass, index, seconds: (Date.now() - started) / 1000, usage: steps[0]!.usage }));
    } catch (error) {
        save(`${index}-error.json`, { error: String(error), runId, events, text });
        if (route && runId) await client.request(route, { method: "run.cancel", params: { run_id: runId } }, { timeoutMs: 30000 }).catch(() => {});
        throw error;
    } finally {
        if (stream) await client.closeRoute(stream).catch(() => {});
        if (route) await client.closeRoute(route).catch(() => {});
    }
}
try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, cases.length) }, async () => { while (next < cases.length) await run(cases[next++]!); }));
} finally { client.close(); db.close(); }
console.log(`V2 pass ${pass}: ${cases.length} cases completed; imported first turns, no extraction reruns or memory writes.`);
