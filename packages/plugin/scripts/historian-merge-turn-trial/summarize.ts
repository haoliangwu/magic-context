import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, isolate, trialRoot } from "./core";

const root = trialRoot(process.argv[2]);
isolate(root);
const { estimateTokens } = await import("../../src/hooks/magic-context/read-session-formatting");
const manifest = await Bun.file(join(root, "manifest.json")).json();
const system = readFileSync(join(import.meta.dir, "../../../..", "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
const cases: Record<string, any>[] = [];
for (const item of manifest.cases) {
    const first = await Bun.file(join(root, "results", `${item.index}-turn1.json`)).json();
    const lexical = await Bun.file(join(root, "results", `${item.index}-lexical.json`)).json();
    if (first.model !== "google/antigravity-gemini-3.8-flash" || first.promptHash !== item.promptHash || first.systemHash !== hash(system)) throw new Error("Input identity mismatch");
    const secondPath = join(root, "results", `${item.index}-turn2.json`);
    const second = existsSync(secondPath) ? await Bun.file(secondPath).json() : undefined;
    cases.push({ ...item, originalEstimatedSystemTokens: estimateTokens(system), first: { runId: first.runId, usage: first.usage, durationMs: first.durationMs, facts: lexical.facts.length, compartments: lexical.compartments },
        second: second ? { runId: second.runId, usage: second.usage, durationMs: second.durationMs } : undefined });
}
const usageKeys = ["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"];
const total = (key: string) => cases.reduce((n, c) => n + c[key], 0);
const usage = (turn: "first" | "second") => Object.fromEntries(usageKeys.map(k => [k, cases.reduce((n, c) => n + (c[turn]?.usage[k] ?? 0), 0)]));
const reported = (turn: "first" | "second") => Object.fromEntries(usageKeys.map(k => [k, cases.filter(c => c[turn]?.usage[k] !== undefined).length]));
const summary = { caseCount: cases.length, turn2Completed: cases.filter(c => c.second).length, model: "google/antigravity-gemini-3.8-flash", systemHash: hash(system),
    originalFacts: total("originalFactCount"), firstFacts: cases.reduce((n, c) => n + c.first.facts, 0), originalCompartments: total("originalCompartments"), firstCompartments: cases.reduce((n, c) => n + c.first.compartments, 0),
    coverage: manifest.coverage, embeddings: manifest.embeddings,
    originalEstimatedUserTokens: total("originalEstimatedTokens"), strippedEstimatedUserTokens: total("strippedEstimatedTokens"), estimatedSystemTokens: total("originalEstimatedSystemTokens"), memoryEstimatedTokens: total("memoryEstimatedTokens"),
    firstUsage: usage("first"), secondUsage: usage("second"),
    firstUsageReportedCases: reported("first"), secondUsageReportedCases: reported("second"),
    memoryUserShareRange: [Math.min(...cases.map(c => c.memoryEstimatedTokens / c.originalEstimatedTokens)), Math.max(...cases.map(c => c.memoryEstimatedTokens / c.originalEstimatedTokens))],
    firstMoreFacts: cases.filter(c => c.first.facts > c.originalFactCount).length, firstFewerFacts: cases.filter(c => c.first.facts < c.originalFactCount).length,
    cases };
writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...summary, cases: cases.length }, null, 2));
