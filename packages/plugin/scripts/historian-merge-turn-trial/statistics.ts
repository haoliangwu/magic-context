import { join } from "node:path";
import { Database } from "bun:sqlite";
import { eligible, isolate, normalize, recordedMemoryFacts, removeMemory, trialRoot, type Memory } from "./core";

const root = trialRoot(process.argv[2]);
isolate(root);
const summary = await Bun.file(join(root, "summary.json")).json();
const review = await Bun.file(join(root, "review-first.json")).json();
if (summary.caseCount !== 40 || review.length !== 40) throw new Error("Incomplete forty-case cohort");
const original = review.flatMap((r: any) => r.original);
const newFacts = original.filter((f: any) => f.newIds.length);
const priorExact = original.filter((f: any) => f.exactBefore.length);
const db = new Database(join(root, "trial.db"), { readonly: true });
const memories = db.query("SELECT * FROM memories").all() as Memory[];
const byContent = new Map<string, Memory[]>();
for (const m of memories) {
    const key = normalize(m.content);
    byContent.set(key, [...(byContent.get(key) ?? []), m]);
}
const firstExact = review.flatMap((r: any) => {
    return r.facts.flatMap((f: any, i: number) => {
        const matches = eligible(byContent.get(normalize(f.content)) ?? [], r.before);
        return matches.length ? [{ case: r.index, fact: i + 1, ids: matches.map(m => m.id) }] : [];
    });
});
const recordedPools: {case: number; recorded: number; mapped: number; archivedNow: number; updatedLater: number}[] = review.map((r: any) => {
    const row = db.query("SELECT user_prompt FROM historian_runs WHERE child_session=?").get(r.session) as {user_prompt: string};
    const recorded = recordedMemoryFacts(removeMemory(row.user_prompt).block);
    if (!recorded.length) throw new Error("Recorded memory inventory parser found no rows");
    const mapped = recorded.map(f => byContent.get(normalize(f.content))?.find(m => m.created_at < r.before));
    return { case: r.index, recorded: recorded.length, mapped: mapped.filter(Boolean).length, archivedNow: mapped.filter(m => m?.status === "archived").length,
        updatedLater: mapped.filter(m => m && m.updated_at > r.before).length };
});
db.close();
console.log(JSON.stringify({ originalFacts: original.length, observedInsertedFacts: newFacts.length, observedInsertedIds: new Set(newFacts.flatMap((f: any) => f.newIds)).size,
    earlierExactFacts: priorExact.length, firstExact,
    recordedPoolRanges: Object.fromEntries(["recorded", "mapped", "archivedNow", "updatedLater"].map(k => [k, [Math.min(...recordedPools.map(r => r[k as keyof typeof r] as number)), Math.max(...recordedPools.map(r => r[k as keyof typeof r] as number))]])),
    unattributedOriginalFacts: original.filter((f: any) => !f.newIds.length && !f.exactBefore.length).length,
    oldest: new Date(Math.min(...summary.cases.map((c: any) => c.before))).toISOString(), newest: new Date(Math.max(...summary.cases.map((c: any) => c.before))).toISOString(),
    poolRange: [Math.min(...summary.cases.map((c: any) => c.poolSize)), Math.max(...summary.cases.map((c: any) => c.poolSize))] }, null, 2));
console.log("| Case (newest = 0) | Original facts | Stripped facts | Original user BPE estimate | Stripped user BPE estimate | Turn-1 reported input | Observed inserted original facts |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const c of summary.cases) {
    const r = review.find((r: any) => r.index === c.index);
    console.log(`| ${c.index} | ${c.originalFactCount} | ${c.first.facts} | ${c.originalEstimatedTokens} | ${c.strippedEstimatedTokens} | ${c.first.usage.input_tokens} | ${r.original.filter((f: any) => f.newIds.length).length} |`);
}
