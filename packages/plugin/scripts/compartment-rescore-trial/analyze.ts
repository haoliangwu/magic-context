import { Database } from "bun:sqlite";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { adjacency, agreement, distribution, hash, MODEL, parseScores, SESSIONS, type Row, type Score } from "./core";

const root = resolve(tmpdir(), "magic-context/compartment-rescore-bg_a526ac86bdd83bf2");
if (resolve(process.argv[2] ?? "") !== root) throw new Error("Root outside trial fence");
const manifest = await Bun.file(join(root, "manifest.json")).json();
const selected = await Bun.file(join(root, "selected.json")).json() as Row[];
const arms: Record<string, Score[]> = { base: [], repeat: [], context: [] };
const cells = [];
for (const batch of manifest.batches) {
    for (const arm of batch.arms) {
        const result = await Bun.file(join(root, "results", `${batch.index}-${arm}.json`)).json();
        if (result.error || result.model !== MODEL || result.promptHash !== batch.promptHashes[arm] || result.systemHash !== batch.systemHash) throw new Error(`Invalid cell ${batch.index}/${arm}`);
        const steps = result.events.filter((e: Record<string, unknown>) => e.type === "step_finished");
        if (steps.length !== 1 || steps[0].finish_reason !== "stop") throw new Error("Incomplete provider step");
        const scores = parseScores(result.text, batch.ids);
        arms[arm]!.push(...scores);
        cells.push({ index: batch.index, arm, runId: result.runId, promptHash: result.promptHash, systemHash: result.systemHash, seedScores: batch.seedScores, ids: batch.ids, scores: scores.map(({ id, importance }) => ({ id, importance })), usage: steps[0].usage, durationMs: result.durationMs });
    }
}
if (arms.base!.length !== 600 || arms.repeat!.length !== 60 || arms.context!.length !== 60 || new Set(arms.base!.map(s => s.id)).size !== 600) throw new Error("Incomplete or duplicated cohort");
const db = new Database(join(root, "trial.db"), { readonly: true });
const history = SESSIONS.flatMap(session => db.query("SELECT * FROM compartments WHERE session_id=? ORDER BY sequence").all(session) as Row[]);
db.close();
const oldScores = new Map(history.map(r => [r.id, r.importance]));
const baseScores = new Map(arms.base!.map(s => [s.id, s.importance]));
const summary = {
    sessions: SESSIONS.map(session => {
        const all = history.filter(r => r.session_id === session);
        const rows = selected.filter(r => r.session_id === session);
        return { session, allBefore: distribution(all.map(r => r.importance)), allAdjacencyBefore: adjacency(all, oldScores), sampleBefore: distribution(rows.map(r => r.importance)), sampleAfter: distribution(rows.map(r => baseScores.get(r.id)!)), adjacencyBefore: adjacency(rows, oldScores), adjacencyAfter: adjacency(rows, baseScores), plateauBefore: rows.filter(r => r.importance >= 70 && r.importance <= 74).length, plateauAfter: rows.filter(r => baseScores.get(r.id)! >= 70 && baseScores.get(r.id)! <= 74).length, thirds: [0, 1, 2].map(i => {
            const segment = rows.slice(i * 100, (i + 1) * 100);
            return { before: distribution(segment.map(r => r.importance)), after: distribution(segment.map(r => baseScores.get(r.id)!)) };
        }) };
    }),
    repeat: agreement(arms.base!, arms.repeat!),
    contextVsBase: agreement(arms.base!, arms.context!),
    contextVsRepeat: agreement(arms.repeat!, arms.context!),
    arms: Object.fromEntries(Object.entries(arms).map(([arm, scores]) => [arm, distribution(scores.map(s => s.importance))])),
    pairedBaseline: distribution(arms.repeat!.map(s => baseScores.get(s.id)!)),
};
// Retain numeric observations and hashes only. Candidate prose, provider reasons and credentials stay private.
const superseded = [];
if (existsSync(join(root, "superseded"))) for (const name of readdirSync(join(root, "superseded"))) {
    const result = await Bun.file(join(root, "superseded", name)).json();
    const steps = result.events.filter((e: Record<string, unknown>) => e.type === "step_finished");
    superseded.push({ index: result.index, arm: result.arm, runId: result.runId, error: result.error, usage: steps.map((e: Record<string, unknown>) => e.usage), recoveredRunRetained: cells.some(c => c.runId === result.runId) });
}
const evidence = { model: MODEL, generation: { temperature: 0.1, max_output_tokens: 32000 }, namespace: manifest.namespace, sourceHash: manifest.sourceHash, sampling: "100 evenly spaced triplets per session; deterministic shuffled non-neighbour batches of 20", summary, rows: selected.map(r => ({ id: r.id, session: r.session_id, sequence: r.sequence, createdAt: r.created_at, oldScore: r.importance, newScore: baseScores.get(r.id), inputHash: hash(JSON.stringify({ title: r.title, episode_type: r.episode_type, p1: r.p1 })), p2Hash: hash(r.p2 ?? "") })), cells, superseded };
writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
const examples: Row[] = [];
for (const session of SESSIONS) {
    const rows = selected.filter(r => r.session_id === session);
    const picks = [rows[0]!, rows[1]!, rows[2]!, rows[3]!, rows[4]!, ...rows.slice(-3), ...[8, 25, 45, 75, 95].map(target => [...rows].sort((a, b) => Math.abs(baseScores.get(a.id)! - target) - Math.abs(baseScores.get(b.id)! - target))[0]!)];
    for (const r of picks) if (!examples.includes(r)) examples.push(r);
}
for (const r of selected) if (examples.length < 25 && !examples.includes(r)) examples.push(r);
const draft = examples.slice(0, 25).map(r => ({ id: r.id, session: r.session_id, sequence: r.sequence, date: new Date(r.created_at).toISOString(), title: r.title, old: r.importance, new: baseScores.get(r.id), reason: arms.base!.find(s => s.id === r.id)!.reason, p1: r.p1 }));
writeFileSync(join(root, "examples-private.json"), JSON.stringify(draft, null, 2), { mode: 0o600 });
const paired = selected.filter(r => arms.repeat!.some(s => s.id === r.id)).map(r => ({ id: r.id, session: r.session_id, title: r.title, p1: r.p1, p2: r.p2, base: arms.base!.find(s => s.id === r.id), repeat: arms.repeat!.find(s => s.id === r.id), context: arms.context!.find(s => s.id === r.id) }));
writeFileSync(join(root, "paired-private.json"), JSON.stringify(paired, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
console.log(`Validated ${cells.length} stop-finished generations, 600 base scores and two paired 60-score arms. Sanitized evidence ready; example judgments require human review of private P1.`);
