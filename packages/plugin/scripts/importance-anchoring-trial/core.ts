import { createHash } from "node:crypto";
import { renderSessionRefCompartment, selectSeeds, type ReferenceCompartment } from "../../src/hooks/magic-context/reference-retrieval";
import { REFERENCE_SEEDS } from "../../src/hooks/magic-context/reference-seeds.generated";
import { isNoContentCompartment } from "../../src/features/magic-context/no-content-compartment";

export const BANDS = [[85, 100], [60, 84], [30, 59], [10, 29], [1, 9]] as const;
export type HistoricalReference = ReferenceCompartment & { id: number; sequence: number };
export type Score = { start: number; end: number; importance: number; title: string; p1: string };
export type Variant = "A" | "B" | "C" | "D" | "E" | "A2";
export function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export function band(score: number): number { return BANDS.findIndex(([lo, hi]) => score >= lo && score <= hi); }

/** Change opening compartment attributes only, never prose or seed examples. */
export function alterSessionScores(prompt: string, replacements?: number[]): string {
    let index = 0;
    return prompt.replace(/<session_references>[\s\S]*?<\/session_references>/g, block =>
        block.replace(/<compartment\b[^>]*>/g, tag => tag.replace(/\s+importance="\d+"/, () => {
            if (!replacements) return "";
            const value = replacements[index++];
            if (value === undefined) throw new Error("Missing planted importance");
            return ` importance="${value}"`;
        })));
}
export function plantedScores(key: string, count: number): number[] {
    const values = REFERENCE_SEEDS.map(s => s.importance);
    let state = Number.parseInt(hash(key).slice(0, 8), 16) || 1;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
    for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [values[i], values[j]] = [values[j]!, values[i]!];
    }
    if (count > values.length) throw new Error("Too many references");
    return values.slice(0, count);
}

/** Uncovered bands first; then least represented, with recency as a stable tie-break. */
export function selectD(history: HistoricalReference[], session: string, start: number) {
    // Boundary-only markers are not examples. The production renderer excludes
    // them too; counting one would silently render fewer than seven references.
    history = history.filter(c => !isNoContentCompartment(c));
    const recent = history.slice(-4);
    const older = history.slice(0, -4);
    const seeds = selectSeeds(session, start, 3);
    const counts = BANDS.map(() => 0);
    for (const score of [...seeds.map(s => s.importance), ...recent.map(r => r.importance ?? 50)]) counts[band(score)]!++;
    const diverse: HistoricalReference[] = [];
    for (let i = 0; i < 3; i++) {
        const candidates = older.filter(c => !diverse.includes(c));
        const available = BANDS.map((_, b) => b).filter(b => candidates.some(c => band(c.importance ?? 50) === b));
        available.sort((a, b) => counts[a]! - counts[b]! || a - b);
        const pickedBand = available[0];
        if (pickedBand === undefined) break;
        const picked = candidates.filter(c => band(c.importance ?? 50) === pickedBand).at(-1)!;
        diverse.push(picked);
        counts[pickedBand]!++;
    }
    diverse.sort((a, b) => a.sequence - b.sequence);
    return { seeds, recent, diverse, references: [...diverse, ...recent], olderBandCounts: BANDS.map((_, b) => older.filter(c => band(c.importance ?? 50) === b).length) };
}
export function variantD(prompt: string, history: HistoricalReference[], session: string, start: number) {
    const selected = selectD(history, session, start);
    // D as trialled showed importance on all seven references. Render each with
    // the production per-compartment renderer (escaping and tiers), scores on.
    const body = selected.references.map(c => renderSessionRefCompartment(c, true)).join("\n\n");
    const seeds = `<compartment_examples_from_other_projects>\n${selected.seeds.map(s => s.block).join("\n\n")}\n</compartment_examples_from_other_projects>`;
    // Callback replacement preserves literal $& / $` strings in historical code.
    return { prompt: prompt.replace(/<compartment_examples_from_other_projects>[\s\S]*?<\/compartment_examples_from_other_projects>/, () => seeds).replace(/<session_references>[\s\S]*?<\/session_references>/, () => `<session_references>\n${body}\n</session_references>`), selected };
}
/** D orders three diverse references before four recent ones. Hide only the recent labels. */
export function variantE(dPrompt: string): string {
    const block = dPrompt.match(/<session_references>[\s\S]*?<\/session_references>/)?.[0];
    if (!block || [...block.matchAll(/<compartment\b[^>]*>/g)].length !== 7) throw new Error("E requires D's seven references");
    let index = 0;
    const altered = block.replace(/<compartment\b[^>]*>/g, tag => index++ < 3 ? tag : tag.replace(/\s+importance="\d+"/, ""));
    if ([...altered.matchAll(/<compartment\b[^>]*\simportance="\d+"/g)].length !== 3) throw new Error("E must retain exactly three scored diverse references");
    return dPrompt.replace(block, () => altered);
}
export function scores(xml: string): Score[] {
    const output: Score[] = [];
    for (const m of xml.matchAll(/<compartment\b([^>]*)>([\s\S]*?)<\/compartment>/g)) {
        const attr = (name: string) => m[1]!.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
        const importance = Number(attr("importance"));
        if (!attr("importance") || importance < 1 || importance > 100) throw new Error("Invalid output score");
        output.push({ start: Number(attr("start")), end: Number(attr("end")), importance, title: attr("title"), p1: m[2]!.match(/<p1>([\s\S]*?)<\/p1>/)?.[1]?.trim() ?? "" });
    }
    return output;
}
export function distribution(values: number[]) {
    if (!values.length) throw new Error("Empty distribution");
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { n: values.length, min: Math.min(...values), max: Math.max(...values), mean, sd: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) };
}
