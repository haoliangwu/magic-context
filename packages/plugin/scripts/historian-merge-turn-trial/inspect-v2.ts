import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Root, REPEAT_CASES } from "./v2";

// Review evidence contains no v1 actions, rationales or judgments. The model's
// claim inventory is evidence to inspect, not an oracle for its own correctness.
const root = v2Root(process.argv[2]);
const pass = process.argv[3] ?? "A";
if (!["A", "B", "C"].includes(pass)) throw new Error("Invalid pass");
const cases = process.argv[4]?.split(",").map(Number) ?? (pass === "A" ? Array.from({ length: 40 }, (_, i) => i) : REPEAT_CASES);
const lines: string[] = [];
for (const index of cases) {
    const dir = join(root, "v2-results", pass);
    const candidates = await Bun.file(join(dir, `${index}-candidates.json`)).json();
    const decisions = await Bun.file(join(dir, `${index}-decisions.json`)).json();
    const reply = await Bun.file(join(dir, `${index}-turn2.json`)).json();
    const raw = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
    lines.push(`\nCASE ${index} (${candidates.facts.length} facts)`);
    if (decisions.schemaError) lines.push(`BATCH SCHEMA REJECTION: ${decisions.schemaError}; raw proposals by output position for review only.`);
    candidates.facts.forEach((fact: any, i: number) => {
        const g = decisions.gates[i];
        const proposed = decisions.schemaError ? raw[i] : g.proposed;
        lines.push(`\n${index}:${i + 1} FACT: ${fact.content}`, `PROPOSED ${proposed.action}${proposed.target ? ` #${proposed.target}` : ""}: ${proposed.text ?? ""}`,
            `CLAIMS: ${JSON.stringify(proposed.claims)}`, `GATE: ${g.rejected ? g.violations.join("; ") : "accepted"} → ${g.effective.action}`);
        candidates.matches[i].forEach((m: any, rank: number) => lines.push(`${rank + 1}. #${m.id}${m.id === proposed.target ? " TARGET" : ""}: ${m.content}`));
    });
}
const path = join(root, `v2-review-${pass}-${cases.join("-")}.txt`);
writeFileSync(path, lines.join("\n"), { mode: 0o600 });
console.log(path);
