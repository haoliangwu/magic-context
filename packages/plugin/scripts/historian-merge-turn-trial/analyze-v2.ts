import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eligible, hash, MODEL, type Memory } from "./core";
import { evaluateV2, mergePromptV2, rankCandidates, REPEAT_CASES, transcriptEvidence, v2Root } from "./v2";

const root = v2Root(process.argv[2]);
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
const system = readFileSync(join(import.meta.dir, "../../../..", "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
const { estimateTokens } = await import("../../src/hooks/magic-context/read-session-formatting");
const load = (path: string) => Bun.file(join(root, path)).json();
const save = (path: string, data: unknown) => writeFileSync(join(root, path), JSON.stringify(data, null, 2), { mode: 0o600 });
const rows: any[] = [];
const runs: any[] = [];
const reviewHashes: Record<string, string> = {};
let originalSecondPromptTokens = 0, v2SecondPromptTokens = 0;
for (const pass of ["A", "B", "C"]) {
    const annotationText = readFileSync(join(root, `v2-judgments-${pass}.json`), "utf8");
    reviewHashes[pass] = hash(annotationText);
    const annotations = JSON.parse(annotationText).decisions;
    const cases = pass === "A" ? Array.from({ length: 40 }, (_, i) => i) : REPEAT_CASES;
    const seen = new Set<string>();
    for (const index of cases) {
        const input = await load(`inputs/${index}.json`);
        const first = await load(`results/${index}-turn1.json`);
        const staged = await load(`results/${index}-candidates.json`);
        const c = await load(`v2-results/${pass}/${index}-candidates.json`);
        const r = await load(`v2-results/${pass}/${index}-turn2.json`);
        const prior = await load(`v2-results/${pass}/${index}-prior.json`);
        const decisions = await load(`v2-results/${pass}/${index}-decisions.json`);
        const matches = staged.facts.map((f: any, i: number) => rankCandidates(f, staged.matches[i], eligible(memories, input.before)));
        if (pass === "A") { originalSecondPromptTokens += estimateTokens(staged.prompt); v2SecondPromptTokens += estimateTokens(c.prompt); }
        if (JSON.stringify(c.matches) !== JSON.stringify(matches) || JSON.stringify(c.facts) !== JSON.stringify(staged.facts)) throw new Error("Candidate derivation changed");
        if (hash(c.prompt) !== hash(mergePromptV2(c.facts, matches, input.before)) || r.promptHash !== hash(c.prompt)) throw new Error("V2 prompt changed");
        if (first.promptHash !== hash(input.prompt) || first.systemHash !== hash(system) || r.systemHash !== first.systemHash || r.model !== MODEL
            || r.generation.temperature !== 0.1 || r.generation.max_output_tokens !== 32000) throw new Error("Replay identity changed");
        if (prior.mode !== "imported-prior-turns" || prior.firstRunId !== first.runId || prior.promptHash !== first.promptHash || prior.replyHash !== hash(first.text)
            || JSON.stringify(prior.roles) !== JSON.stringify(["user", "assistant"]) || prior.imported.result.dropped_system_messages !== 0
            || prior.imported.result.synthesized_tool_results !== 0 || prior.imported.result.dropped_orphan_tool_results !== 0) throw new Error("Invalid first exchange import");
        const steps = r.events.filter((e: any) => e.type === "step_finished");
        if (steps.length !== 1 || steps[0].finish_reason !== "stop" || r.events.find((e: any) => e.type === "run_finished")?.reason !== "completed") throw new Error("Incomplete provider event sequence");
        const checked = evaluateV2(r.text, matches, transcriptEvidence(input.prompt));
        if (JSON.stringify(checked) !== JSON.stringify(decisions)) throw new Error("Gate result drift");
        const observed = JSON.parse(r.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
        if (!Array.isArray(observed) || observed.length !== c.facts.length) throw new Error("Cannot review raw output by ordinal");
        decisions.gates.forEach((g: any, i: number) => {
            const key = `${index}:${i + 1}`;
            const j = annotations.find((j: any) => j.case === index && j.fact === i + 1);
            if (!j || !["correct", "wrong", "debatable"].includes(j.grade) || !j.reason.trim()
                || !["correct", "wrong", "debatable"].includes(j.proposedGrade) || seen.has(key)) throw new Error(`Missing/invalid review ${pass}:${key}`);
            seen.add(key);
            const raw = observed[i];
            rows.push({ pass, ...j, action: g.effective.action, target: g.effective.target, proposedAction: raw.action, proposedTarget: raw.target ?? undefined,
                rejected: g.rejected, schemaError: decisions.schemaError, violations: g.violations, rewrite: ["merge", "update", "replaces"].includes(raw.action) });
        });
        runs.push({ pass, index, runId: r.runId, lineageId: prior.lineageId, usage: r.usage, facts: c.facts.length, schemaError: decisions.schemaError });
    }
    if (seen.size !== annotations.length) throw new Error("Out-of-cohort or duplicate review");
}
db.close();
if (new Set(runs.map(r => r.runId)).size !== 70 || new Set(runs.map(r => r.lineageId)).size !== 70) throw new Error("Runs/repetitions share a lineage");
// Freeze all verdict-hidden annotations before loading baseline verdicts.
const lockPath = "v2-review-lock.json";
if (existsSync(join(root, lockPath))) {
    if (JSON.stringify((await load(lockPath)).reviewHashes) !== JSON.stringify(reviewHashes)) throw new Error("Review changed after baseline comparison");
} else save(lockPath, { reviewHashes, frozenAt: new Date().toISOString() });
const baseline = (await load("judgments.json")).decisions;
const firstRows = rows.filter(r => r.pass === "A");
const baselineWrong: any[] = [], baselineConcern: any[] = [];
for (let index = 0; index < 40; index++) {
    const d = (await load(`results/${index}-decisions.json`)).decisions;
    for (const old of d) {
        if (!["merge", "update", "replaces"].includes(old.action)) continue;
        const j = baseline.find((j: any) => j.case === index && j.fact === old.fact);
        if (j.grade === "correct") continue;
        const now = firstRows.find(r => r.case === index && r.fact === old.fact);
        const row = { key: `${index}:${old.fact}`, v1Action: old.action, v1Target: old.target, v1Grade: j.grade, ...now };
        baselineConcern.push(row);
        if (j.grade === "wrong") baselineWrong.push(row);
    }
}
function counts(selected: any[], proposed = false): unknown {
    return Object.fromEntries(["new", "skip", "merge", "update", "replaces"].map(action => {
        const subset = selected.filter(r => r[proposed ? "proposedAction" : "action"] === action);
        return [action, { total: subset.length, ...Object.fromEntries(["correct", "wrong", "debatable"].map(grade => [grade, subset.filter(r => r[proposed ? "proposedGrade" : "grade"] === grade).length])) }];
    }));
}
const passSummaries = Object.fromEntries(["A", "B", "C"].map(pass => {
    const selected = rows.filter(r => r.pass === pass);
    const passRuns = runs.filter(r => r.pass === pass);
    const keys = ["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"];
    return [pass, { cases: passRuns.length, facts: selected.length, effective: counts(selected), proposed: counts(selected, true),
        usage: Object.fromEntries(keys.map(k => [k, { sum: passRuns.reduce((n, r) => n + (r.usage[k] ?? 0), 0), reporting: passRuns.filter(r => r.usage[k] !== undefined).length }])),
        schemaFailures: passRuns.filter(r => r.schemaError).map(r => r.index),
        gateRejectedRewrites: selected.filter(r => r.rejected && r.rewrite && !r.schemaError),
        wrongRewrites: selected.filter(r => r.grade === "wrong" && ["merge", "update", "replaces"].includes(r.action)),
        proposedWrongRewrites: selected.filter(r => r.proposedGrade === "wrong" && r.rewrite),
        gateCaught: selected.filter(r => r.rejected && r.rewrite && r.proposedGrade === "wrong" && !r.schemaError),
        gateMissed: selected.filter(r => !r.rejected && r.rewrite && r.proposedGrade === "wrong"),
        gateFalsePositives: selected.filter(r => r.rejected && r.rewrite && r.proposedGrade === "correct" && !r.schemaError) }];
}));
const noise = firstRows.filter(r => REPEAT_CASES.includes(r.case)).map(a => {
    const b = rows.find(r => r.pass === "B" && r.case === a.case && r.fact === a.fact);
    const c = rows.find(r => r.pass === "C" && r.case === a.case && r.fact === a.fact);
    const triple = [a, b, c];
    return { key: `${a.case}:${a.fact}`, actions: triple.map(r => `${r.action}${r.target ? ` #${r.target}` : ""}`), grades: triple.map(r => r.grade),
        stableAction: new Set(triple.map(r => `${r.action}:${r.target ?? ""}`)).size === 1, stableGrade: new Set(triple.map(r => r.grade)).size === 1 };
});
const summary = { cases: runs.length, decisions: rows.length, passSummaries, baselineWrong, baselineConcern, noise, rows, reviewHashes,
    estimatedSecondPromptTokens: { v1: originalSecondPromptTokens, v2: v2SecondPromptTokens } };
save("v2-summary.json", summary);
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
for (const pass of ["A", "B", "C"]) writeFileSync(join(root, `v2-ledger-${pass}.md`), ["| Case:fact | Effective decision | Grade | Proposed grade / gate | Reason |", "| --- | --- | --- | --- | --- |",
    ...rows.filter(r => r.pass === pass).map(r => `| ${r.case}:${r.fact} | ${r.action}${r.target ? ` #${r.target}` : ""} | ${r.grade} | ${r.proposedGrade}${r.rejected ? " / rejected" : ""} | ${esc(r.reason)} |`)].join("\n"), { mode: 0o600 });
console.log(JSON.stringify({ validated: `${runs.length} provider runs, ${rows.length} complete independent judgments; candidate/prompt/import/gate identities checked`,
    passSummaries, baselineWrong, noise: { facts: noise.length, stableActions: noise.filter(n => n.stableAction).length, stableGrades: noise.filter(n => n.stableGrade).length } }, null, 2));
