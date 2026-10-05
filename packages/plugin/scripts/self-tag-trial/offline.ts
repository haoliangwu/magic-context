import { writeFileSync } from "node:fs";
import { isolate } from "./bootstrap";
import { literalHead, scenarios } from "./scenarios";
const root = isolate();
const { Trial } = await import("./engine");
const rows: unknown[] = [];
const snapshots: unknown[] = [];
for (const variant of ["A", "B"] as const) for (const scenario of scenarios) {
    const trial = new Trial(`${variant}-${scenario}`, variant, "offline-control-not-a-model");
    try {
        if (scenario === "literal-head") trial.user(literalHead);
        for (let turn = 1; turn <= 12; turn++) {
            trial.user(`Turn ${turn}: summarize the fruit fixture.`);
            if (turn === 3 || turn === 8) {
                for (let step = 0; step < 4; step++) {
                    await trial.pass();
                    await trial.accept({ texts: step === 1 ? [] : ["Inspecting the fixture."],
                        reasoning: step === 0 ? "Need the total" : undefined,
                        calls: [{ id: `t${turn}s${step}`, name: step % 2 ? "echo" : "read", input: { text: "7" } },
                            ...(step === 0 ? [{ id: `t${turn}parallel`, name: "list", input: {} }] : [])] });
                }
            }
            await trial.pass();
            const assigned = Math.max(0, ...trial.tagger.getAssignments(trial.session).values()) + 1;
            await trial.accept({ texts: [variant === "B" ? `§${assigned}§ There are seven fruit.` : "There are seven fruit."], calls: [] });
            if (scenario === "reduced" && turn === 10) {
                await trial.accept({ texts: [], calls: [{ id: "reduce", name: "ctx_reduce", input: { drop: String(Math.max(...[...trial.tagger.getAssignments(trial.session)].filter(([key]) => key.includes("\u0000")).map(([, n]) => n))) } }] });
                snapshots.push({ scenario, variant, afterReduction: await trial.pass() });
            }
        }
        rows.push(...trial.rows);
        snapshots.push({ scenario, variant, finalWire: await trial.pass() });
    } finally { trial.close(); }
}
const out = process.argv[2] ?? `${root}/offline.jsonl`;
writeFileSync(out, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(out.replace(/\.jsonl$/, "-snapshots.json"), JSON.stringify(snapshots, null, 2));
console.log(`Offline plumbing only: ${rows.length} reply rows, six multi-turn sessions, zero model calls.`);
