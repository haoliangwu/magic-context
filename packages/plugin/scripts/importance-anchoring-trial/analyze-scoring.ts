import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../src/hooks/magic-context/historian-prompt.generated";
import { distribution, hash, scores } from "./core";
import { pairedChanges, scoringCell, type ScoringArm } from "./scoring";

const root = resolve(process.argv[2] ?? "");
const fence = resolve(tmpdir(), "magic-context");
if (!root.startsWith(`${fence}/`) || !/^historian-scoring-[a-z0-9-]+$/.test(root.slice(fence.length + 1))) throw new Error("Root outside trial fence");
const models = process.argv.slice(3);
if (!models.length) throw new Error("Pass the exact models dispatched by run.ts");
const arms: ScoringArm[] = ["E", "F", "E2"];
const prior = await Bun.file(join(import.meta.dir, "evidence.json")).json();
type Json = Record<string, any>;
const cases: Json[] = [];
const quality: Json[] = [];
const usageKeys = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"];
const addUsage = (total: Json, usage: Json) => { for (const k of usageKeys) total[k] = (total[k] ?? 0) + (usage[k] ?? 0); };
for (let index = 0; index < 30; index++) {
    const input = await Bun.file(join(root, "inputs", `${index}.json`)).json();
    const old = prior.cases[index];
    if (input.key !== old.key || input.systemHash !== old.systemHash || input.promptHashes.E !== old.promptHashes.E) throw new Error(`Cohort mismatch ${index}`);
    const row: Json = { index, key: input.key, session: input.session, sequence: input.sequence, start: input.start, end: input.end, previousImportance: input.previousImportance, promptHash: input.promptHashes.E, baselineSystemHash: input.systemHash, models: {} };
    for (const model of models) {
        const cells: Json = {};
        for (const arm of arms) {
            const cell = scoringCell(input, arm, COMPARTMENT_AGENT_SYSTEM_PROMPT);
            const path = join(root, "results", model.replaceAll("/", "--"), `${index}-${arm}.json`);
            const result = await Bun.file(path).json();
            if (result.key !== input.key || result.model !== model || result.index !== index || result.variant !== arm) throw new Error(`Result identity mismatch ${index}-${arm}`);
            if (result.error) {
                // Do not retain provider envelopes or credentials in the evidence.
                if (!result.error.includes("Insufficient credits")) throw new Error(`Unexpected provider failure ${index}-${arm}: ${result.error}`);
                cells[arm] = { status: "provider_error", error: "OpenRouter 402: insufficient credits", runId: result.runId };
                continue;
            }
            if (result.promptHash !== hash(cell.prompt) || result.systemHash !== hash(cell.system)) throw new Error(`Wire hash mismatch ${index}-${arm}`);
            const steps = result.events.filter((e: Json) => e.type === "step_finished");
            const terminals = result.events.filter((e: Json) => e.type === "run_finished");
            if (steps.length !== 1 || steps[0].finish_reason !== "stop" || terminals.length !== 1 || terminals[0].reason !== "completed") throw new Error(`Incomplete provider output ${index}-${arm}`);
            let parsed: ReturnType<typeof scores> = [];
            let validationError: string | undefined;
            try { parsed = scores(result.text); if (!parsed.length) throw new Error("No compartments in provider output"); }
            catch (error) { validationError = String(error); }
            if (validationError !== result.outputValidationError || JSON.stringify(parsed) !== JSON.stringify(result.scores)) throw new Error(`Score extraction mismatch ${index}-${arm}`);
            cells[arm] = {
                status: validationError ? "invalid_output" : "scored",
                runId: result.runId, durationMs: result.durationMs, recoveredFrom: result.recoveredFrom, promptHash: result.promptHash, systemHash: result.systemHash,
                outputHash: hash(result.text), outputValidationError: validationError, usage: steps[0].usage,
                scores: parsed.map(({ p1, ...s }) => ({ ...s, p1Hash: hash(p1), p1Characters: p1.length })),
            };
            if ([0, 5, 14, 19, 22, 27].includes(index) && model === "google/antigravity-gemini-3.8-flash" && arm !== "E2") {
                quality.push({ index, sequence: input.sequence, arm, scores: parsed.map(s => ({ ...s, firstP1Line: s.p1.split("\n").find(l => l.trim()) })) });
            }
        }
        row.models[model] = cells;
    }
    cases.push(row);
}
const summary: Json = {};
const first = (r: Json, model: string, arm: ScoringArm) => r.models[model][arm].scores[0].importance as number;
for (const model of models) {
    const usage: Json = {};
    const byArm = Object.fromEntries(arms.map(arm => {
        const valid = cases.filter(r => r.models[model][arm].status === "scored");
        const completed = cases.filter(r => r.models[model][arm].status !== "provider_error");
        for (const r of completed) addUsage(usage, r.models[model][arm].usage);
        const within2 = valid.filter(r => Math.abs(first(r, model, arm) - r.previousImportance) <= 2).length;
        return [arm, {
            attempted: 30, completed: completed.length, invalid: completed.length - valid.length, providerErrors: 30 - completed.length,
            first: valid.length ? distribution(valid.map(r => first(r, model, arm))) : null,
            all: valid.length ? distribution(valid.flatMap(r => r.models[model][arm].scores.map((s: Json) => s.importance))) : null,
            within2: { count: within2, scoredDenominator: valid.length, attemptedDenominator: 30 },
            single: valid.filter(r => r.models[model][arm].scores.length === 1).length,
        }];
    }));
    const paired = (compared: ScoringArm) => {
        const rows = cases.filter(r => r.models[model].E.status === "scored" && r.models[model][compared].status === "scored");
        const arrays = (r: Json, arm: ScoringArm, field: string) => JSON.stringify(r.models[model][arm].scores.map((s: Json) => field === "range" ? [s.start, s.end] : s[field]));
        return rows.length ? {
            indices: rows.map(r => r.index), ...pairedChanges(rows.map(r => first(r, model, "E")), rows.map(r => first(r, model, compared))),
            sameRanges: rows.filter(r => arrays(r, "E", "range") === arrays(r, compared, "range")).length,
            sameTitles: rows.filter(r => arrays(r, "E", "title") === arrays(r, compared, "title")).length,
            sameP1: rows.filter(r => arrays(r, "E", "p1Hash") === arrays(r, compared, "p1Hash")).length,
        } : null;
    };
    const common = cases.filter(r => arms.every(a => r.models[model][a].status === "scored"));
    summary[model] = {
        arms: byArm, noiseE2: paired("E2"), interventionF: paired("F"), commonTripletIndices: common.map(r => r.index),
        commonTripletArms: Object.fromEntries(arms.map(a => [a, common.length ? { first: distribution(common.map(r => first(r, model, a))), within2: common.filter(r => Math.abs(first(r, model, a) - r.previousImportance) <= 2).length } : null])),
        usage, isolation: await Bun.file(join(root, "results", model.replaceAll("/", "--"), "isolation.json")).json(),
    };
}
const superseded: Json[] = [];
if (existsSync(join(root, "superseded"))) for (const file of readdirSync(join(root, "superseded"))) {
    const r = await Bun.file(join(root, "superseded", file)).json();
    const usage: Json = {};
    for (const e of r.events.filter((e: Json) => e.type === "step_finished")) addUsage(usage, e.usage);
    superseded.push({ index: r.index, arm: r.variant, model: r.model, runId: r.runId, status: r.error ? "failed_attempt" : "completed_excluded_retry", error: r.error, usage,
        scores: r.scores?.map(({ p1, ...s }: Json) => ({ ...s, p1Hash: hash(p1), p1Characters: p1.length })) });
}
writeFileSync(join(root, "scoring-quality.json"), JSON.stringify(quality, null, 2));
writeFileSync(join(root, "scoring-evidence.json"), JSON.stringify({ revisedSystemHash: hash(COMPARTMENT_AGENT_SYSTEM_PROMPT), summary, superseded, cases }, null, 2));
console.log(JSON.stringify({ cases: cases.length, cells: cases.length * models.length * arms.length, summary, superseded }, null, 2));
