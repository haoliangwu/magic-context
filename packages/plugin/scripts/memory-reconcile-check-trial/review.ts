import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type Batch, type Gate, type Label } from "./core";

const batches: Batch[] = JSON.parse(readFileSync(join(ROOT, "batches.json"), "utf8"));
const labels: Label[] = JSON.parse(readFileSync(join(ROOT, "evaluation.json"), "utf8"));
const extras = batches.filter(b => b.key.startsWith("extra-")).flatMap(b => b.targets);
// This packet deliberately hides model verdicts for independent prevalence
// grading. The action packet is opened only after the extra labels are frozen.
writeFileSync(join(ROOT, "extra-review.txt"), extras.map((t, i) => `\n## ${i + 1}. #${t.memory.id} · ${t.memory.category} · ${new Date(t.memory.createdAt).toISOString()}\n${t.memory.content}\n${t.evidence.map(e => `${e.path}:${e.line}: ${e.text}`).join("\n")}\n`).join("\n"), { mode: 0o600 });
writeFileSync(join(ROOT, "extra-texts.txt"), extras.map((t, i) => `${i + 1}. #${t.memory.id}: ${t.memory.content}`).join("\n\n"), { mode: 0o600 });
const actionLines: string[] = [], counts: Record<string, Record<string, number>> = {};
for (const pass of ["A", "B"]) {
    counts[pass] = {};
    for (const batch of batches.filter(b => pass === "A" || b.key.startsWith("labelled-"))) {
        const path = join(ROOT, "results", `${pass}-${batch.key}.json`);
        if (!existsSync(path)) continue;
        const result = JSON.parse(readFileSync(path, "utf8"));
        for (const [i, g] of (result.gates as Gate[]).entries()) {
            counts[pass]![g.effective.verdict] = (counts[pass]![g.effective.verdict] ?? 0) + 1;
            const t = batch.targets[i]!, label = labels.find(l => l.id === t.memory.id);
            if (["replaced", "partly_replaced"].includes(g.proposed.verdict) || g.rejected || label?.label === "stale") {
                actionLines.push(`\n## ${pass} #${t.memory.id} · label: ${label?.label ?? "extra"} · ${g.proposed.verdict} => ${g.effective.verdict}\nTarget: ${t.memory.content}\n${JSON.stringify(g, null, 2)}\n${t.newer.map(n => `memory:${n.memory.id}: ${n.memory.content}`).join("\n")}\n${t.evidence.map(e => `${e.path}:${e.line}: ${e.text}`).join("\n")}`);
            }
        }
    }
}
writeFileSync(join(ROOT, "action-review.txt"), actionLines.join("\n"), { mode: 0o600 });
const changed = ["A", "B"].flatMap(pass => batches.filter(b => pass === "A" || b.key.startsWith("labelled-")).flatMap(batch => {
    const path = join(ROOT, "results", `${pass}-${batch.key}.json`);
    if (!existsSync(path)) return [];
    const result = JSON.parse(readFileSync(path, "utf8"));
    return (result.gates as Gate[]).filter(g => ["replaced", "partly_replaced"].includes(g.proposed.verdict)).map(g => ({ pass, gate: g, target: batch.targets.find(t => t.memory.id === g.proposed.id)!.memory.content }));
}));
writeFileSync(join(ROOT, "changed-review.json"), JSON.stringify(changed, null, 2), { mode: 0o600 });
console.log(`Bun ${Bun.version}; ${extras.length} verdict-hidden extra review rows; ${actionLines.length} changed/rejected/stale action packets; ${JSON.stringify(counts)}`);
