import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { distribution, hash, type Variant } from "./core";

const root = resolve(process.argv[2] ?? join(tmpdir(), "magic-context/importance-trial"));
if (root !== resolve(tmpdir(), "magic-context/importance-trial")) throw new Error("Root outside trial fence");
const manifest = await Bun.file(join(root,"manifest.json")).json();
const prior = existsSync(join(root,"prior-evidence.json")) ? await Bun.file(join(root,"prior-evidence.json")).json() : undefined;
const variants: Variant[] = prior ? ["A","B","C","D","E","A2"] : ["A","B","C","D"];
const cases = await Promise.all(manifest.map(async (input:any,index:number)=>{
    const cells = Object.fromEntries(await Promise.all(variants.map(async v=>{
        if (prior && ["A","B","C","D"].includes(v)) {
            const old = prior.cases.find((r:any)=>r.key===input.key);
            if (!old?.cells[v] || old.promptHashes[v]!==input.promptHashes[v] || old.systemHash!==input.systemHash) throw new Error(`Original input/cell mismatch ${index}-${v}`);
            return [v,structuredClone(old.cells[v])];
        }
        const result = await Bun.file(join(root,"results",`${index}-${v}.json`)).json();
        if(result.error || !result.scores?.length) throw new Error(`Incomplete cell ${index}-${v}`);
        if(result.key !== input.key) throw new Error("Manifest/result mismatch");
        const steps = result.events.filter((e:any)=>e.type==="step_finished");
        const terminal = result.events.find((e:any)=>e.type==="run_finished");
        if(steps.length!==1 || terminal?.reason!=="completed" || steps[0].finish_reason!=="stop") throw new Error("Non-single-step or incomplete provider run");
        return [v,{runId:result.runId,durationMs:result.durationMs,usage:steps[0].usage,scores:result.scores.map((s:any)=>({...s,p1Hash:hash(s.p1),p1Characters:s.p1.length}))}];
    })));
    const {recorded,...metadata}=input;
    return {index,...metadata,recorded:{...recorded,p1Hash:hash(recorded.p1),p1:undefined},cells};
}));
const mean=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
const first=(row:any,v:Variant)=>row.cells[v].scores[0].importance;
const cov=(x:number[],y:number[])=>mean(x.map((v,i)=>(v-mean(x))*(y[i]!-mean(y))));
const regression=(x:number[],y:number[])=>({slope:cov(x,y)/cov(x,x),correlation:cov(x,y)/Math.sqrt(cov(x,x)*cov(y,y))});
const summaries = Object.fromEntries(variants.map(v=>[v,{
    first:distribution(cases.map(r=>first(r,v))),
    all:distribution(cases.flatMap(r=>r.cells[v].scores.map((s:any)=>s.importance))),
    within2:cases.filter(r=>Math.abs(first(r,v)-r.previousImportance)<=2).length,
    single:cases.filter(r=>r.cells[v].scores.length===1).length,
    sameTitlesAsA:cases.filter(r=>JSON.stringify(r.cells[v].scores.map((s:any)=>s.title))===JSON.stringify(r.cells.A.scores.map((s:any)=>s.title))).length,
    sameP1AsA:cases.filter(r=>JSON.stringify(r.cells[v].scores.map((s:any)=>s.p1Hash))===JSON.stringify(r.cells.A.scores.map((s:any)=>s.p1Hash))).length,
    ...(prior ? {
        sameTitlesAsA2:cases.filter(r=>JSON.stringify(r.cells[v].scores.map((s:any)=>s.title))===JSON.stringify(r.cells.A2.scores.map((s:any)=>s.title))).length,
        sameP1AsA2:cases.filter(r=>JSON.stringify(r.cells[v].scores.map((s:any)=>s.p1Hash))===JSON.stringify(r.cells.A2.scores.map((s:any)=>s.p1Hash))).length,
        meanAbsoluteDeltaFromA2:mean(cases.map(r=>Math.abs(first(r,v)-first(r,"A2")))),
    } : {}),
    meanDeltaFromA:mean(cases.map(r=>first(r,v)-first(r,"A"))),
    meanAbsoluteDeltaFromA:mean(cases.map(r=>Math.abs(first(r,v)-first(r,"A")))),
    meanAbsoluteDeltaFromRecorded:mean(cases.map(r=>Math.abs(first(r,v)-r.recorded.importance))),
    bySession:[...new Set(cases.map(r=>r.session))].map(session=>{const rs=cases.filter(r=>r.session===session);return {session,first:distribution(rs.map(r=>first(r,v))),within2:rs.filter(r=>Math.abs(first(r,v)-r.previousImportance)<=2).length};}),
}]));
const attraction=(target:(r:any)=>number,original:(r:any)=>number)=>{
    const xs=cases.map(r=>target(r)-original(r));
    const ys=cases.map(r=>first(r,"C")-first(r,"A"));
    return {...regression(xs,ys),movedInPlantedDirection:cases.filter((_,i)=>xs[i]!*ys[i]!>0).length,closerToPlantedThanA:cases.filter(r=>Math.abs(first(r,"C")-target(r))<Math.abs(first(r,"A")-target(r))).length,meanDistanceReduction:mean(cases.map(r=>Math.abs(first(r,"A")-target(r))-Math.abs(first(r,"C")-target(r))))};
};
const usage=variants.reduce((total,v)=>{
    for(const r of cases) for(const k of ["input_tokens","cached_input_tokens","output_tokens","reasoning_tokens"]) total[k]=(total[k]??0)+(r.cells[v].usage[k]??0);
    return total;
},{} as Record<string,number>);
const supersededUsage:Record<string,number>=prior ? {...prior.summary.supersededUsage} : {runs:0,input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_tokens:0};
if(existsSync(join(root,"superseded"))) for(const file of readdirSync(join(root,"superseded"))) {
    const r=await Bun.file(join(root,"superseded",file)).json();
    supersededUsage.runs!++;
    for(const e of r.events.filter((e:any)=>e.type==="step_finished")) for(const k of ["input_tokens","cached_input_tokens","output_tokens","reasoning_tokens"]) supersededUsage[k]!+=e.usage[k]??0;
}
const measuredUsage=Object.fromEntries(Object.entries(usage).map(([k,v])=>[k,v+supersededUsage[k]!]));
const followupUsage:Record<string,number>={input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_tokens:0};
if(prior) for(const r of cases) for(const v of ["E","A2"] as const) for(const k of Object.keys(followupUsage)) followupUsage[k]!+=r.cells[v].usage[k]??0;
const summary={cases:cases.length,cells:cases.length*variants.length,model:"google/antigravity-gemini-3.8-flash",variants:summaries,
    ...(prior ? {followupUsage,noiseA2:{delta:distribution(cases.map(r=>first(r,"A2")-first(r,"A"))),sameFirstScore:cases.filter(r=>first(r,"A2")===first(r,"A")).length,within2OfA:cases.filter(r=>Math.abs(first(r,"A2")-first(r,"A"))<=2).length,sameRanges:cases.filter(r=>JSON.stringify(r.cells.A2.scores.map((s:any)=>[s.start,s.end]))===JSON.stringify(r.cells.A.scores.map((s:any)=>[s.start,s.end]))).length},originalUsage:prior.summary.usage} : {}),
    recorded:{first:distribution(cases.map(r=>r.recorded.importance)),within2:cases.filter(r=>Math.abs(r.recorded.importance-r.previousImportance)<=2).length},
    attractionNewest:attraction(r=>r.plant.at(-1),r=>r.refScores.at(-1)),
    attractionMean:attraction(r=>mean(r.plant),r=>mean(r.refScores)),
    dAvailability:[...new Set(cases.map(r=>r.session))].map(session=>{const rs=cases.filter(r=>r.session===session);return {session,olderBandMin:rs[0].d.olderBandCounts.map((_:number,b:number)=>Math.min(...rs.map(r=>r.d.olderBandCounts[b]))),olderBandMax:rs[0].d.olderBandCounts.map((_:number,b:number)=>Math.max(...rs.map(r=>r.d.olderBandCounts[b]))),casesWith10to29:rs.filter(r=>r.d.olderBandCounts[3]>0).length,casesWith1to9:rs.filter(r=>r.d.olderBandCounts[4]>0).length,diverseScores:rs.map(r=>r.d.diverse.map((c:any)=>c.importance))};}),
    usage,supersededUsage,measuredUsage,
    illustrativeUSD:{uncachedInputRatePerM:0.5,cachedInputRatePerM:0.05,outputRatePerM:3,finalCells:(usage.input_tokens!*0.5+usage.cached_input_tokens!*0.05+usage.output_tokens!*3)/1e6,allMeasured:(measuredUsage.input_tokens!*0.5+measuredUsage.cached_input_tokens!*0.05+measuredUsage.output_tokens!*3)/1e6,...(prior ? {followup:(followupUsage.input_tokens!*0.5+followupUsage.cached_input_tokens!*0.05+followupUsage.output_tokens!*3)/1e6}: {})},
    examples:[0,5,11,20,29].map(i=>({index:i,session:cases[i].session,sequence:cases[i].sequence,previous:cases[i].previousImportance,planted:cases[i].plant,titles: Object.fromEntries(variants.map(v=>[v,cases[i].cells[v].scores.map((s:any)=>({importance:s.importance,title:s.title}))]))}))};
writeFileSync(join(root,"summary.json"),JSON.stringify(summary,null,2));
// Only metadata, scores, titles, hashes and usage survive; no prompts, p1 bodies,
// reasoning, project memories, credentials or copied stores belong in git.
for(const r of cases) for(const v of variants) for(const s of r.cells[v].scores) delete s.p1;
writeFileSync(join(root,"evidence.json"),JSON.stringify({summary,cases},null,2));
console.log(JSON.stringify(summary,null,2));
