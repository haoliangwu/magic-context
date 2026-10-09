import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { unescapeXml } from "../../src/shared/xml-unescape";
import { hash, normalize, parseDecisions, removeMemory, trialRoot, type Decision } from "./core";

type Grade = "correct" | "wrong" | "debatable";
interface Judgment { case: number; fact: number; grade: Grade; reason: string; known?: boolean }
interface OriginalJudgment { case: number; fact: number; duplicate: "yes" | "no" | "debatable"; reason: string; firstFact?: number; caught?: boolean }
const root = trialRoot(process.argv[2]);
const reviews: any[] = await Bun.file(join(root, "review-second.json")).json();
const annotations = await Bun.file(join(root, "judgments.json")).json() as { decisions: Judgment[]; originals: OriginalJudgment[] };
const decisions: any[] = [];
const originals: any[] = [];
const usage: Record<string, Record<string, number>> = { first: {}, second: {} };
const reported: Record<string, Record<string, number>> = { first: {}, second: {} };
const db = new Database(join(root, "trial.db"), { readonly: true });
if (reviews.length !== 40) throw new Error("Incomplete cohort");
const used = new Set<string>();
for (const c of reviews) {
    const first = await Bun.file(join(root, "results", `${c.index}-turn1.json`)).json();
    const second = await Bun.file(join(root, "results", `${c.index}-turn2.json`)).json();
    if (JSON.stringify(first.identity) !== JSON.stringify(second.identity) || first.runId === second.runId) throw new Error("Not an independent same-session continuation");
    if (first.systemHash !== second.systemHash || second.promptHash !== hash(c.prompt)) throw new Error("Continuation input changed");
    const parsed = parseDecisions(second.text, c.matches);
    const recorded = db.query("SELECT user_prompt FROM historian_runs WHERE child_session=?").get(c.session) as {user_prompt: string};
    const recordedMemory = normalize(unescapeXml(removeMemory(recorded.user_prompt).block));
    for (const [name, result] of [["first", first], ["second", second]] as const) {
        const steps = result.events.filter((e: any) => e.type === "step_finished");
        if (steps.length !== 1 || steps[0].finish_reason !== "stop" || result.events.find((e: any) => e.type === "run_finished")?.reason !== "completed") throw new Error("Incomplete provider step");
        for (const key of ["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"]) {
            usage[name]![key] = (usage[name]![key] ?? 0) + (result.usage[key] ?? 0);
            reported[name]![key] = (reported[name]![key] ?? 0) + Number(result.usage[key] !== undefined);
        }
    }
    parsed.forEach((d: Decision) => {
        const j = annotations.decisions.find(j => j.case === c.index && j.fact === d.fact);
        if (!j || !["correct", "wrong", "debatable"].includes(j.grade) || !j.reason.trim()) throw new Error(`Missing decision judgment ${c.index}:${d.fact}`);
        const key = `d:${j.case}:${j.fact}`;
        if (used.has(key)) throw new Error("Duplicate judgment");
        used.add(key);
        const target = c.matches[d.fact - 1].find((m: any) => m.id === d.target);
        decisions.push({ ...j, action: d.action, target: d.target, targetLane: target?.lane,
            targetCaptured: target ? recordedMemory.includes(normalize(target.content)) : undefined });
    });
    c.original.forEach((f: any, i: number) => {
        const j = annotations.originals.find(j => j.case === c.index && j.fact === i + 1);
        if (!j || !["yes", "no", "debatable"].includes(j.duplicate) || !j.reason.trim()) throw new Error(`Missing original judgment ${c.index}:${i + 1}`);
        const key = `o:${j.case}:${j.fact}`;
        if (used.has(key)) throw new Error("Duplicate original judgment");
        used.add(key);
        if (j.caught && (!j.firstFact || !parsed.some(d => d.fact === j.firstFact && ["skip", "merge", "update", "replaces"].includes(d.action)) || !decisions.some(d => d.case === c.index && d.fact === j.firstFact && d.grade === "correct"))) throw new Error("Unsupported caught attribution");
        originals.push({ ...j, insertedIds: f.newIds });
    });
}
if (used.size !== annotations.decisions.length + annotations.originals.length) throw new Error("Annotations contain out-of-cohort or duplicate rows");
const byAction = Object.fromEntries(["new", "skip", "merge", "update", "replaces"].map(action => [action, {
    total: decisions.filter(d => d.action === action).length,
    ...Object.fromEntries(["correct", "wrong", "debatable"].map(grade => [grade, decisions.filter(d => d.action === action && d.grade === grade).length])),
}]));
const inserted = originals.filter(f => f.insertedIds.length);
const duplicateInserted = inserted.filter(f => f.duplicate === "yes");
const summary = { cases: reviews.length, decisions: decisions.length, byAction, usage, reported,
    knownFirstFacts: decisions.filter(d => d.known).length,
    wrongDestructive: decisions.filter(d => d.grade === "wrong" && ["merge", "replaces"].includes(d.action)),
    original: { facts: originals.length, inserted: inserted.length, duplicates: duplicateInserted.length,
        debatableDuplicates: inserted.filter(f => f.duplicate === "debatable").length,
        caughtDebatableDuplicates: inserted.filter(f => f.duplicate === "debatable" && f.caught).length,
        caughtDuplicates: duplicateInserted.filter(f => f.caught).length,
        missingFromFirst: duplicateInserted.filter(f => !f.firstFact).length },
    judgments: decisions, originalJudgments: originals };
db.close();
const targets = decisions.filter(d => d.action !== "new");
Object.assign(summary, { targetAudit: { decisions: targets.length, lexicalOnly: targets.filter(d => d.targetLane === "bm25").length,
    notCaptured: targets.filter(d => !d.targetCaptured).map(d => `${d.case}:${d.fact}`) } });
writeFileSync(join(root, "full-summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const ledger = ["| Case:fact | Decision | Judgment | Reason |", "| --- | --- | --- | --- |",
    ...decisions.map(d => `| ${d.case}:${d.fact} | ${d.action}${d.target ? ` #${d.target}` : ""} | ${d.grade} | ${esc(d.reason)} |`)];
writeFileSync(join(root, "judgment-ledger.md"), ledger.join("\n"), { mode: 0o600 });
const originalLedger = ["| Case:fact | Observed inserted IDs | Older-pool duplicate? | Caught? | Reason |", "| --- | --- | --- | --- | --- |",
    ...originals.map(d => `| ${d.case}:${d.fact} | ${d.insertedIds.join(", ") || "Unattributed"} | ${d.duplicate} | ${d.caught ? `Yes (${d.case}:${d.firstFact})` : "No demonstrated catch"} | ${esc(d.reason)} |`)];
writeFileSync(join(root, "original-ledger.md"), originalLedger.join("\n"), { mode: 0o600 });
console.log(JSON.stringify({ ...summary, judgments: undefined, originalJudgments: undefined }, null, 2));
