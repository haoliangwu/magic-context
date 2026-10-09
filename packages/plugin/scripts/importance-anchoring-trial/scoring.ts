import { distribution, hash } from "./core";

export type ScoringArm = "E" | "F" | "E2";
export interface SavedScoringInput {
    system: string;
    systemHash: string;
    prompts: { E: string };
    promptHashes: { E: string };
}

/** Keep the shipped reference layout and transcript identical; vary only the system. */
export function scoringCell(input: SavedScoringInput, arm: ScoringArm, revised: string) {
    if (hash(input.system) !== input.systemHash || hash(input.prompts.E) !== input.promptHashes.E) {
        throw new Error("Saved scoring input hash mismatch");
    }
    const tags = (name: string) => [...(input.prompts.E.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`))?.[0] ?? "").matchAll(/<compartment\b[^>]*>/g)].map(m => m[0]);
    const seeds = tags("compartment_examples_from_other_projects");
    const references = tags("session_references");
    if (seeds.length !== 3 || !seeds.every(t => /\bimportance="\d+"/.test(t)) || references.length !== 7 ||
        !references.slice(0, 3).every(t => /\bimportance="\d+"/.test(t)) || references.slice(3).some(t => /\bimportance=/.test(t))) {
        throw new Error("Scoring trial requires three scored seeds, three scored diverse and four unscored recent references");
    }
    if (input.system === revised) throw new Error("Scoring trial systems must differ");
    return { prompt: input.prompts.E, system: arm === "F" ? revised : input.system };
}

export function pairedChanges(baseline: number[], compared: number[]) {
    if (!baseline.length || baseline.length !== compared.length) throw new Error("Incomplete paired scores");
    const delta = compared.map((v, i) => v - baseline[i]!);
    return {
        delta: distribution(delta),
        meanAbsoluteDelta: delta.reduce((s, v) => s + Math.abs(v), 0) / delta.length,
        identical: delta.filter(v => v === 0).length,
        within2: delta.filter(v => Math.abs(v) <= 2).length,
    };
}
