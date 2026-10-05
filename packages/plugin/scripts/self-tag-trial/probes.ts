import { writeFileSync } from "node:fs";
import { isolate } from "./bootstrap";
const root = isolate();
const { probe, Trial } = await import("./engine");
const cases = {
    single: [{ type: "text", text: "one" }],
    several: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
    reasoning: [{ type: "reasoning", text: "private" }, { type: "text", text: "one" }],
    mixed: [{ type: "text", text: "one" }, { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: {}, output: "fixture" } }],
    parallel: [{ type: "tool", callID: "c1", state: { output: "one" } }, { type: "tool", callID: "c2", state: { output: "two" } }, { type: "text", text: "after tools" }],
    invocationOnly: [{ type: "tool-invocation", callID: "c1" }],
    blank: [{ type: "text", text: "   " }],
};
const results = Object.fromEntries(Object.entries(cases).map(([key, parts]) => [key, probe(parts)]));
results.separateResult = probe([{ type: "tool-invocation", callID: "separate" }], [{ type: "tool", callID: "separate", state: { output: "result" } }]);
const trial = new Trial("probe-loop", "B", "offline-control-not-a-model");
trial.user("start");
const firstWire = await trial.pass();
await trial.accept({ texts: ["§2§ Seven fruit."], calls: [] });
const secondWire = await trial.pass();
const output = { root, cases: results, firstWire, secondWire, rows: trial.rows };
writeFileSync(process.argv[2] ?? `${root}/probes.json`, JSON.stringify(output, null, 2));
trial.close();
console.log(JSON.stringify(output, null, 2));
