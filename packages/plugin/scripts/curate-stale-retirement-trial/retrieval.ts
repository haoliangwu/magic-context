import type { Excerpt, Memory, TrialBatch } from "./core";

const STOP = new Set("the a an and or of to in for on with is are be as by from that this not only all at it must never always uses use when while which via into without rather than instead code memory context magic cortexkit system project session sessions tool tools provider providers run runs their its each they have has no new current old per same named content".split(" "));
export const tokens = (text: string): string[] => text.toLowerCase().match(/[a-z][a-z0-9_.:-]{2,}/g)?.filter(s => !STOP.has(s)) ?? [];

export function bm25(query: string[], document: string[], df: Map<string, number>, n: number, avgLength: number): number {
    const frequency = new Map<string, number>();
    for (const term of document) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(query)) {
        const count = frequency.get(term) ?? 0;
        if (!count) continue;
        const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        score += idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * document.length / Math.max(1, avgLength)));
    }
    return score;
}

export function identifiers(memory: Memory, df: Map<string, number>): string[] {
    const explicit = [
        ...[...memory.content.matchAll(/`([^`]+)`/g)].flatMap(m => m[1]!.match(/[A-Za-z][A-Za-z0-9_./:-]{2,}/g) ?? []),
        ...(memory.content.match(/[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+|[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)+|\br\d+(?:\.\d+)?\b/g) ?? []),
    ].filter(s => s.length <= 160 && !s.startsWith("http"));
    const rare = [...new Set(tokens(memory.content))].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || a.localeCompare(b)).slice(0, 8);
    return [...new Set([...explicit, ...rare])].slice(0, 24);
}

export function frequencies(documents: string[][]): Map<string, number> {
    const df = new Map<string, number>();
    for (const doc of documents) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
    return df;
}

export function rankEvidence(_memory: Memory, terms: string[], docs: Excerpt[], source: Excerpt[]): Excerpt[] {
    const score = (row: Excerpt) => terms.reduce((sum, term) => sum + (row.text.toLowerCase().includes(term.toLowerCase()) ? (term.includes(".") || term.includes("/") || term.includes("_") ? 4 : 1) : 0), 0);
    const rank = (rows: Excerpt[]) => rows.filter(r => score(r) > 0).sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.line - b.line);
    const design = rank(docs), code = rank(source);
    // Give the newest spec an independent quota so abundant old test fixtures
    // cannot crowd out explicit replacement language. Never use the labels.
    const selected = [...design.slice(0, 8), ...code.slice(0, 7)];
    const keys = new Set(selected.map(r => `${r.path}:${r.line}`));
    for (const row of [...design.slice(8), ...code.slice(7)]) {
        if (selected.length === 15) break;
        if (!keys.has(`${row.path}:${row.line}`)) { selected.push(row); keys.add(`${row.path}:${row.line}`); }
    }
    return selected.map(row => ({ ...row, text: row.text.slice(0, 1600) }));
}

export function normalizeVector(blob: Uint8Array): Float32Array | undefined {
    if (!blob.byteLength || blob.byteLength % 4) return;
    const vector = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
    let squared = 0;
    for (const value of vector) { if (!Number.isFinite(value)) return; squared += value * value; }
    if (!squared) return;
    const norm = Math.sqrt(squared);
    for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
    return vector;
}

export function topicBatches(memories: Memory[], vectors: Map<number, Float32Array>, maxCount = 80): TrialBatch[] {
    const docs = memories.map(m => tokens(m.content)), df = frequencies(docs), avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
    const tokenById = new Map(memories.map((m, i) => [m.id, docs[i]!]));
    const remaining = new Map([...memories].sort((a, b) => a.id - b.id).map(m => [m.id, m]));
    const result: TrialBatch[] = [];
    while (remaining.size) {
        const seed = remaining.values().next().value!, seedVector = vectors.get(seed.id);
        const similarity = (m: Memory): number => {
            const other = vectors.get(m.id);
            if (seedVector && other && seedVector.length === other.length) {
                let dot = 0; for (let i = 0; i < other.length; i++) dot += seedVector[i]! * other[i]!;
                return dot;
            }
            const score = bm25(tokenById.get(seed.id)!, tokenById.get(m.id)!, df, docs.length, avg);
            return score / (score + 20);
        };
        const ranked = [...remaining.values()].map(m => ({ m, score: m.id === seed.id ? Infinity : similarity(m) })).sort((a, b) => b.score - a.score || a.m.id - b.m.id);
        const chosen: Memory[] = [];
        let characters = 0;
        for (const { m } of ranked) {
            if (chosen.length === maxCount) break;
            const size = m.content.length + 160;
            if (chosen.length && characters + size > 256000) break;
            chosen.push(m); remaining.delete(m.id); characters += size;
        }
        result.push({ category: "TOPIC", index: result.length, memories: chosen.sort((a, b) => a.id - b.id), crossChunkCandidates: [] });
    }
    return result;
}
