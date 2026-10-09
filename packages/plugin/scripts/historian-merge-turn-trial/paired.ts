import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash, MODEL, removeMemory } from "./core";

export const PAIRED_ROOT = resolve(tmpdir(), "magic-context/historian-paired-control-bg7d08");
export const GENERATION = { max_output_tokens: 32000, temperature: 0.1 };
export type Arm = "F" | "S" | "T";
export function pairedRoot(arg = PAIRED_ROOT): string {
    if (resolve(arg) !== PAIRED_ROOT) throw new Error("Root outside private paired-control fence");
    return PAIRED_ROOT;
}
export interface Input {
    index: number; session: string; before: number; prompt: string;
    promptHash: string; originalPromptHash: string; blockHash: string;
}
export function pairedPrompts(input: Input, recorded: { child_session: string; created_at: number; user_prompt: string }): { F: string; S: string } {
    const stripped = removeMemory(recorded.user_prompt);
    if (recorded.child_session !== input.session || recorded.created_at !== input.before ||
        hash(recorded.user_prompt) !== input.originalPromptHash || hash(stripped.block) !== input.blockHash ||
        stripped.prompt !== input.prompt || hash(input.prompt) !== input.promptHash) throw new Error("Recorded prompt identity changed");
    // Read the full prompt from the snapshot rather than rebuilding its memory
    // span: reinsertion or XML round-tripping could change otherwise identical bytes.
    return { F: recorded.user_prompt, S: input.prompt };
}
export function armOrder(index: number): ("F" | "S")[] {
    return index % 2 === 0 ? ["F", "S"] : ["S", "F"];
}
export function validateTurn(result: any, prompt: string, system: string): void {
    if (result.model !== MODEL || result.promptHash !== hash(prompt) || result.systemHash !== hash(system) ||
        JSON.stringify(result.generation) !== JSON.stringify(GENERATION)) throw new Error("Turn settings or prompt changed");
    const steps = result.events.filter((e: any) => e.type === "step_finished");
    if (!result.runId || steps.length !== 1 || steps[0].finish_reason !== "stop" ||
        result.events.find((e: any) => e.type === "run_finished")?.reason !== "completed" ||
        JSON.stringify(result.usage) !== JSON.stringify(steps[0].usage)) throw new Error("Incomplete provider turn or usage mismatch");
}
export function exactDuplicates(facts: { content: string }[], pool: { content: string }[], normalize: (s: string) => string): number {
    const seen = new Set(pool.map(f => normalize(f.content)));
    let count = 0;
    for (const f of facts) {
        const key = normalize(f.content);
        if (seen.has(key)) count++;
        seen.add(key);
    }
    return count;
}
