import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bm25, eligible, hash, isolate, normalize, ROOT, type Memory } from "./core";
import { exactDuplicates, pairedPrompts, pairedRoot, validateTurn, type Arm } from "./paired";

const root = pairedRoot(process.argv[2]);
const mode = process.argv[3] ?? "analyze";
if (!["inspect", "analyze", "memory", "search"].includes(mode)) throw new Error("Mode must be inspect, analyze, memory or search");
isolate(root);
const { parseCompartmentOutput } = await import("../../src/hooks/magic-context/compartment-parser");
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
const system = readFileSync(join(import.meta.dir, "../../../..", "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
const save = (name: string, value: unknown): void => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
if (mode === "memory") {
    const ids = process.argv[4]!.split(",").map(Number);
    for (const id of ids) console.log(JSON.stringify(memories.find(m => m.id === id)));
    db.close();
    process.exit(0);
}
if (mode === "search") {
    const input = await Bun.file(join(root, `inputs/${Number(process.argv[4])}.json`)).json();
    const query = new RegExp(process.argv[5]!, "i");
    const matches = eligible(memories, input.before).filter(m => query.test(m.content));
    for (const m of matches) console.log(`#${m.id}: ${m.content}`);
    console.log(`${matches.length} complete eligible passages (case ${input.index}).`);
    db.close(); process.exit(0);
}
const start = mode === "inspect" ? Number(process.argv[4] ?? 0) : 0;
const end = mode === "inspect" ? Number(process.argv[5] ?? 40) : 40;
const summaries: any[] = [], packets: string[] = [];
const runIds = new Set<string>(), sessions = new Set<string>(), freshSessions = new Set<string>();
const arms: Arm[] = ["F", "T", "S"];
for (let index = start; index < end; index++) {
    const input = await Bun.file(join(root, "inputs", `${index}.json`)).json();
    const row = db.query("SELECT child_session,created_at,user_prompt FROM historian_runs WHERE child_session=?").get(input.session) as any;
    const prompts = pairedPrompts(input, row);
    const pool = eligible(memories, input.before);
    const results: any = {}, parsed: any = {};
    packets.push(`\nCASE ${index} (pool ${pool.length})`);
    for (const arm of arms) {
        const result = await Bun.file(join(root, arm === "T" ? `results/${index}-turn1.json` : `paired-results/${index}-${arm}.json`)).json();
        validateTurn(result, arm === "F" ? prompts.F : prompts.S, system);
        if (runIds.has(result.runId) || sessions.has(result.identity.session)) throw new Error("Reused run/session");
        runIds.add(result.runId); sessions.add(result.identity.session);
        if (arm !== "T") {
            const admission = await Bun.file(join(root, `paired-results/${index}-${arm}-admission.json`)).json();
            if (admission.runId !== result.runId || admission.priorMessages !== 0 || admission.promptHash !== result.promptHash ||
                admission.systemHash !== result.systemHash || JSON.stringify(admission.identity) !== JSON.stringify(result.identity) ||
                result.identity.project_root !== root || result.identity.harness !== "historian-memory-block-paired-control" ||
                result.identity.session !== `paired-${index}-${arm}-${hash(arm === "F" ? prompts.F : prompts.S).slice(0, 24)}`) throw new Error("Not an independent empty session");
            freshSessions.add(result.identity.session);
        }
        parsed[arm] = parseCompartmentOutput(result.text);
        if (!parsed[arm].compartments.length || parsed[arm].droppedFacts || parsed[arm].droppedFactBlocks) throw new Error("Dropped/invalid output");
        results[arm] = { facts: parsed[arm].facts.length, compartments: parsed[arm].compartments.length,
            exactEarlier: parsed[arm].facts.filter((f: any) => pool.some(m => normalize(m.content) === normalize(f.content))).length,
            exactDuplicateInserts: exactDuplicates(parsed[arm].facts, pool, normalize), usage: result.usage, durationMs: result.durationMs };
        packets.push(`${arm}: ${results[arm].facts} facts, ${results[arm].compartments} compartments`);
        parsed[arm].facts.forEach((f: any, i: number) => packets.push(`${arm}:${i + 1} [${f.category}] ${f.content}`));
    }
    // Scores are search aids only. Whole-pool lookups remain available for joint
    // coverage and refinements not visible in the two displayed lexical neighbours.
    const seen = new Set<string>();
    for (const arm of arms) parsed[arm].facts.forEach((f: any, i: number) => {
        if (seen.has(normalize(f.content))) return;
        seen.add(normalize(f.content));
        packets.push(`EVIDENCE ${arm}:${i + 1}`);
        for (const m of bm25(f.content, pool).slice(0, 2)) packets.push(`#${m.id}: ${m.content}`);
    });
    summaries.push({ case: index, ...results });
}
db.close();
if (mode === "inspect") {
    writeFileSync(join(root, `paired-review-${start}-${end}.txt`), packets.join("\n"), { mode: 0o600 });
    console.log(`Wrote ${end - start} validated F/T/S review cases; ${runIds.size} completed runs, ${freshSessions.size} fresh sessions.`);
    process.exit(0);
}
interface FactJudgment { fact: number; coverage: "known" | "new" | "debatable"; ids: number[]; reason: string }
interface CaseJudgment { case: number; claims: { label: string; arms: string }[]; facts: Record<Arm, string[]>; reason: string }
const judgments = await Bun.file(join(root, "paired-judgments.json")).json() as CaseJudgment[];
if (judgments.length !== 40 || new Set(judgments.map(j => j.case)).size !== 40) throw new Error("Missing/duplicate case judgments");
for (const c of summaries) {
    const j = judgments.find(j => j.case === c.case)!;
    if (!j || !j.reason.trim() || !j.claims.length || new Set(j.claims.map(t => t.label)).size !== j.claims.length ||
        j.claims.some(t => !t.label.trim() || !/^(F?T?S?)$/.test(t.arms) || !t.arms)) throw new Error("Incomplete claim review");
    for (const arm of arms) {
        const fs = j.facts[arm].map((text, i): FactJudgment => {
            const m = /^(known|new|debatable)(?:#([\d,]+))?: (.+)$/.exec(text);
            if (!m) throw new Error(`Invalid manual judgment ${c.case}:${arm}:${i + 1}`);
            return { fact: i + 1, coverage: m[1] as FactJudgment["coverage"], ids: m[2]?.split(",").map(Number) ?? [], reason: m[3]! };
        });
        if (fs.length !== c[arm].facts || new Set(fs.map(f => f.fact)).size !== fs.length ||
            fs.some(f => f.fact < 1 || f.fact > fs.length || !["known", "new", "debatable"].includes(f.coverage) || !f.reason.trim() ||
                (f.coverage !== "new" && !f.ids.length) || f.ids.some(id => !memories.some(m => m.id === id && m.status === "active" && m.created_at < JSON.parse(readFileSync(join(root, `inputs/${c.case}.json`), "utf8")).before)))) throw new Error(`Incomplete coverage review ${c.case}:${arm}`);
        Object.assign(c[arm], { known: fs.filter(f => f.coverage === "known").length, debatable: fs.filter(f => f.coverage === "debatable").length,
            claims: j.claims.filter(t => t.arms.includes(arm)).length });
    }
    c.claimDifferences = Object.fromEntries(["FT", "FS", "TS"].map(pair => [pair,
        j.claims.filter(t => t.arms.includes(pair[0]!) !== t.arms.includes(pair[1]!)).length]));
    c.reason = j.reason;
}
const totals = Object.fromEntries(arms.map(arm => [arm, {
    ...Object.fromEntries(["facts", "compartments", "known", "debatable", "claims", "exactEarlier", "exactDuplicateInserts"].map(key => [key, summaries.reduce((n, c) => n + c[arm][key], 0)])),
    usage: Object.fromEntries(["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"].map(key => [key, {
        total: summaries.reduce((n, c) => n + (c[arm].usage[key] ?? 0), 0), reporting: summaries.filter(c => c[arm].usage[key] !== undefined).length,
    }])),
}]));
const comparisons = Object.fromEntries(["FT", "FS", "TS"].map(pair => [pair, {
    changedFactCounts: summaries.filter(c => c[pair[0]!].facts !== c[pair[1]!].facts).length,
    changedClaimSets: summaries.filter(c => c.claimDifferences[pair] > 0).length,
    claimSymmetricDifference: summaries.reduce((n, c) => n + c.claimDifferences[pair], 0),
    more: summaries.filter(c => c[pair[1]!].facts > c[pair[0]!].facts).length,
    fewer: summaries.filter(c => c[pair[1]!].facts < c[pair[0]!].facts).length,
}]));
const provenance = await Bun.file(join(root, "paired-provenance.json")).json();
for (const file of provenance.copies) {
    if (hash(readFileSync(join(root, file.path)).toString("base64")) !== file.sourceHash ||
        hash(readFileSync(join(ROOT, file.path)).toString("base64")) !== file.sourceHash) throw new Error(`Source/copy changed: ${file.path}`);
}
const summary = { runs: runIds.size, freshSessions: freshSessions.size, copiesVerified: provenance.copies.length,
    judgmentHash: hash(readFileSync(join(root, "paired-judgments.json"), "utf8")), totals, comparisons, cases: summaries };
save("paired-summary.json", summary);
writeFileSync(join(root, "paired-ledger.md"), ["| Case | F facts/compartments/known | T facts/compartments/known | S facts/compartments/known | Claim Δ FT/FS/TS | Read comparison |", "| --- | --- | --- | --- | --- | --- |",
    ...summaries.map(c => `| ${c.case} | ${arms.map(a => `${c[a].facts}/${c[a].compartments}/${c[a].known}`).join(" | ")} | ${Object.values(c.claimDifferences).join("/")} | ${c.reason.replace(/\|/g, "/")} |`)].join("\n"), { mode: 0o600 });
console.log(JSON.stringify({ ...summary, cases: undefined }, null, 2));
