import { SubcClient, type RouteHandle } from "@cortexkit/subc-client";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { hash, scores, type Variant } from "./core";
import { scoringCell, type ScoringArm } from "./scoring";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../src/hooks/magic-context/historian-prompt.generated";

const root = resolve(process.argv[2] ?? join(tmpdir(), "magic-context/importance-trial"));
// A model argument opts into the fixed-cohort system-prompt experiment, which
// needs a private root and fresh lineages rather than the earlier arm E's cache.
const scoringModel = process.argv[5];
if (scoringModel ? !/^historian-scoring-[a-z0-9-]+$/.test(root.slice(resolve(tmpdir(), "magic-context").length + 1)) || !root.startsWith(`${resolve(tmpdir(), "magic-context")}/`) : root !== resolve(tmpdir(), "magic-context/importance-trial")) throw new Error("Root outside trial fence");
const limit = Number(process.argv[3] ?? 30);
if (limit < 1 || limit > 30) throw new Error("Trial is capped at 30 cases per invocation");
const variants = (process.argv[4] ?? "A,B,C,D").split(",") as (Variant | ScoringArm)[];
if (!variants.length || new Set(variants).size !== variants.length || variants.some(v => !(scoringModel ? ["E","F","E2"] : ["A","B","C","D","E","A2"]).includes(v))) throw new Error("Invalid or duplicate trial arms");
const config = scoringModel ? { historian: { opencode: { model: scoringModel }, temperature: 0.1 } } : parse(await Bun.file(join(root, "magic-context.jsonc")).text());
const configured = config.historian.opencode.model;
const model = typeof configured === "string" ? configured : configured.model;
const slash = model.indexOf("/");
const generation = { max_output_tokens: 32000, temperature: config.historian.temperature };
if (!scoringModel && variants.some(v => v === "E" || v === "A2") && (model !== "google/antigravity-gemini-3.8-flash" || generation.temperature !== 0.1)) throw new Error("Follow-up model/temperature differs from the original trial");
const manifest = await Bun.file(join(root, "manifest.json")).json();
const results = scoringModel ? join(root, "results", model.replaceAll("/", "--")) : join(root, "results");
mkdirSync(results, { recursive: true });
if (scoringModel) {
    const evidence = await Bun.file(join(import.meta.dir, "evidence.json")).json();
    if (manifest.length !== 30 || manifest.some((m:any, i:number) => m.key !== evidence.cases[i]?.key || m.promptHashes.E !== evidence.cases[i]?.promptHashes.E || m.systemHash !== evidence.cases[i]?.systemHash)) throw new Error("Scoring trial must use the original thirty saved inputs");
    for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
        process.env[key] = join(root, "isolated", key);
        mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
    }
    process.env.OPENCODE_DB = join(root, "isolated", "opencode.db");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "isolated", "store");
    const probe = spawnSync("timeout", ["10s", "/usr/sbin/lsof", "-p", String(process.pid)], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error("Could not prove runner database isolation with lsof");
    const dbLines = probe.stdout.split("\n").filter(line => /\.db(?:\s|$|-)/.test(line));
    if (dbLines.some(line => !line.includes(`${root}/`))) throw new Error("Runner opened a database outside throwaway root");
    writeFileSync(join(results, "isolation.json"), JSON.stringify({ pid: process.pid, command: `lsof -p ${process.pid}`, dbLines, environment: Object.fromEntries(["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR"].map(k => [k, process.env[k]])) }, null, 2));
    console.log(`lsof -p ${process.pid}: ${dbLines.length} database paths; all under throwaway root (no host launched)`);
}
const client = await SubcClient.connect({connectionFile:join(root,"subc-connection.json")});
type Json = Record<string, any>;
async function call(index: number, variant: Variant | ScoringArm) {
    const path = join(results,`${index}-${variant}.json`);
    const input = await Bun.file(join(root,"inputs",`${index}.json`)).json();
    const cell = scoringModel ? scoringCell(input, variant as ScoringArm, COMPARTMENT_AGENT_SYSTEM_PROMPT) : { prompt: input.prompts[variant], system: input.system };
    const cellHash = hash(`${model}\0${cell.system}\0${cell.prompt}`);
    let attemptSuffix = "";
    if (existsSync(path)) {
        const prior = await Bun.file(path).json();
        if (!prior.error && prior.identity?.session.includes((scoringModel ? cellHash : input.promptHashes[variant]).slice(0,24))) return;
        // A harness correction must not erase its earlier spend or be mistaken
        // for a replicate of the final, corrected cell.
        mkdirSync(join(root,"superseded"),{recursive:true});
        renameSync(path,join(root,"superseded",`${index}-${variant}-${Date.now()}.json`));
        if (scoringModel) attemptSuffix = `-retry-${Date.now()}`;
    }
    // Each cell gets a separate, fresh lineage. No variant can see another cell's answer.
    const identity = {project_root:root,harness:"importance-trial",session:scoringModel ? `scoring-v1-${hash(root).slice(0,12)}-${cellHash.slice(0,24)}-${variant}${attemptSuffix}` : `importance-trial-v2-${input.promptHashes[variant].slice(0,24)}-${variant}`};
    let route: RouteHandle | undefined;
    let subroute: RouteHandle | undefined;
    const events: Json[] = [];
    let text = "";
    const started = Date.now();
    let runId: string | undefined;
    try {
        route = await client.routeOpen({kind:"management_surface",module_id:"broca"},identity);
        const response = await client.request(route,{method:"session.send",params:{prompt:cell.prompt,system:cell.system,model:{provider:model.slice(0,slash),model:model.slice(slash+1)},tools:[],generation}},{timeoutMs:60000}) as Json;
        runId = response.result?.run_id ?? response.run_id;
        if (!runId) throw new Error(`No run id: ${JSON.stringify(response)}`);
        writeFileSync(join(results,`${index}-${variant}-admission.json`),JSON.stringify({runId,identity,response}));
        subroute = await client.routeOpen({kind:"management_surface",module_id:"broca"},identity);
        let finish!:()=>void;
        let fail!:(error:Error)=>void;
        const terminal = new Promise<void>((res,rej)=>{finish=res;fail=rej;});
        const subscription = client.subscribe(subroute,{method:"session.subscribe",params:{from:"start"}}, bytes=>{
            const event = JSON.parse(new TextDecoder().decode(bytes));
            if (event.kind === "display") return;
            const unit = event.unit ?? event;
            events.push(unit);
            const type = unit.type ?? unit.kind;
            if (type === "assistant_message") {
                text += unit.message?.content?.filter((b:Json)=>b.type==="text").map((b:Json)=>b.text).join("") ?? unit.text ?? "";
            }
            if (["error","run_error","paused"].includes(type)) fail(new Error(JSON.stringify(unit)));
            if (["run_finished","terminal","run_terminal","finished"].includes(type)) finish();
        });
        const timer = setTimeout(()=>fail(new Error("600s trial deadline")),600000);
        try { await Promise.race([terminal,subscription.closed.then(()=>{throw new Error("Stream ended before terminal");})]); }
        finally { clearTimeout(timer); subscription.unsubscribe(); }
        const baseline = await client.request(route,{method:"session.baseline",params:{}},{timeoutMs:30000});
        // A missing score is a trial outcome, not a reason to repair or resample
        // the answer. Retain the completed output so failures remain in the denominator.
        let parsed: ReturnType<typeof scores> = [];
        let outputValidationError: string | undefined;
        try {
            parsed = scores(text);
            if (!parsed.length) throw new Error("No compartments in provider output");
        } catch (error) {
            if (!scoringModel) throw error;
            outputValidationError = String(error);
        }
        const result = {index,variant,key:input.key,model,configuredVariant:configured.variant ?? null,generation,systemHash:hash(cell.system),promptHash:hash(cell.prompt),runId,identity,durationMs:Date.now()-started,scores:parsed,outputValidationError,text,events,baseline};
        writeFileSync(path,JSON.stringify(result));
        console.log(JSON.stringify({index,variant,runId,scores:result.scores.map(s=>s.importance),outputValidationError,seconds:result.durationMs/1000,usage:events.filter(e=>e.type==="step_finished").map(e=>e.usage)}));
    } catch(error) {
        if (route && runId) await client.request(route,{method:"run.cancel",params:{run_id:runId}},{timeoutMs:30000}).catch(()=>{});
        writeFileSync(path,JSON.stringify({index,variant,key:input.key,model,runId,error:String(error),durationMs:Date.now()-started,text,events}));
        if (!scoringModel) throw error;
        console.log(JSON.stringify({index,variant,runId,error:String(error)}));
    } finally {
        if (subroute) await client.closeRoute(subroute).catch(()=>{});
        if (route) await client.closeRoute(route).catch(()=>{});
    }
}
try {
    // Three independent cases concurrently; rotate arm order to limit time/quota confounding.
    let next=0;
    await Promise.all(Array.from({length:Math.min(3,limit)},async()=>{
        while(next<Math.min(limit,manifest.length)) {
            const index=next++;
            const order=[...variants.slice(index%variants.length),...variants.slice(0,index%variants.length)];
            for(const variant of order) await call(index,variant);
        }
    }));
} finally {client.close();}
console.log(`Completed/resumed ${Math.min(limit,manifest.length)} cases (${variants.join("/")} cells); no automatic retries or fallback models.`);
