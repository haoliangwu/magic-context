import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { trialRoot } from "./core";

const root = trialRoot(process.argv[2]);
const phase = process.argv[3] ?? "first";
if (!["first", "second"].includes(phase)) throw new Error("Invalid phase");
const start = Number(process.argv[4] ?? 0), end = Number(process.argv[5] ?? 40);
const kindFilter = process.argv[6];
if (kindFilter && !["FIRST", "ORIGINAL"].includes(kindFilter)) throw new Error("Invalid fact kind filter");
const all = await Bun.file(join(root, `review-${phase}.json`)).json();
const lines: string[] = [];
for (const c of all.slice(start, end)) {
    lines.push(`\nCASE ${c.index} ${c.session}`);
    for (const [kind, facts] of [["ORIGINAL", c.original], ["FIRST", c.facts]] as const) {
        if (kindFilter && kindFilter !== kind) continue;
        facts.forEach((f: {content: string; matches?: any[]; newIds?: number[]; exactBefore?: number[]}, i: number) => {
            const d = c.decisions?.[i];
            lines.push(`${kind} ${i + 1} ${f.content}`);
            if (kind === "ORIGINAL") lines.push(`newIds=${f.newIds} exactBefore=${f.exactBefore}`);
            else if (d) lines.push(`DECISION ${JSON.stringify(d)}`);
            const matches = kind === "ORIGINAL" ? f.matches : c.matches[i];
            const selected = matches?.filter((m: any, j: number) => j < (kind === "ORIGINAL" ? 2 : 3) || (kind === "FIRST" && m.id === d?.target)) ?? [];
            selected.forEach((m: any) => lines.push(`#${m.id} (${m.score.toFixed(3)} ${m.lane}) ${m.id === d?.target ? m.content : m.content.slice(0, kind === "ORIGINAL" ? 500 : 900)}`));
        });
    }
}
const path = join(root, `review-${phase}-${start}-${end}.txt`);
writeFileSync(path, lines.join("\n"), { mode: 0o600 });
console.log(`Wrote ${end - start} review cases to ${path}; raw contents stay outside git.`);
