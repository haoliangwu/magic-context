import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { batches, hash, MODEL, prompt, rubric, sample, SESSIONS, type Row } from "./core";

export const root = resolve(tmpdir(), "magic-context/compartment-rescore-bg_a526ac86bdd83bf2");
if (resolve(process.argv[2] ?? "") !== root) throw new Error("Root outside trial fence");
if (await Bun.file(join(root, "manifest.json")).exists()) throw new Error("Manifest already exists; resume run.ts instead");
// The renderer is pure, but its dependency graph must never see live storage or config paths.
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[key] = join(root, "isolated", key);
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "isolated", "store");
const { selectSeeds, renderSeedExamplesBlock } = await import("../../src/hooks/magic-context/reference-retrieval");
const source = await Bun.file(join(import.meta.dir, "../../src/hooks/magic-context/historian-prompt.source.md")).text();
const system = `Rescore existing coding-session memories using the following historian recall rubric. You receive only stored summaries, never raw conversation or existing importance.\n\n${rubric(source)}`;
const db = new Database(join(root, "trial.db"), { readonly: true });
const history = SESSIONS.flatMap(session => db.query("SELECT * FROM compartments WHERE session_id=? ORDER BY sequence").all(session) as Row[]);
db.close();
if (new Set(history.map(r => r.id)).size !== history.length) throw new Error("Non-unique compartment ids");
const selected = SESSIONS.flatMap(session => sample(history.filter(r => r.session_id === session)));
const recent = Object.fromEntries(SESSIONS.map(session => [session, history.filter(r => r.session_id === session).slice(-8).map(r => r.title)]));
const baseline = batches(selected, "rescore-triplets-v1");
const repeatIndices = [0, 14, 29];
if (baseline.length !== 30 || repeatIndices.some(i => baseline[i]?.length !== 20)) throw new Error("Unexpected batch shape");
mkdirSync(join(root, "inputs"), { recursive: true, mode: 0o700 });
const manifest = [];
for (let i = 0; i < baseline.length; i++) {
    const rows = baseline[i]!;
    const seeds = selectSeeds("compartment-rescore-trial", i, 3);
    const examples = renderSeedExamplesBlock(seeds);
    const base = prompt(rows, examples);
    const variant = prompt(rows, examples, true, recent);
    const arms = repeatIndices.includes(i) ? ["base", "repeat", "context"] : ["base"];
    const item = { index: i, ids: rows.map(r => r.id), arms, seedScores: seeds.map(s => s.importance), systemHash: hash(system), promptHashes: { base: hash(base), repeat: hash(base), context: hash(variant) } };
    writeFileSync(join(root, "inputs", `${i}.json`), JSON.stringify({ ...item, system, prompts: { base, repeat: base, context: variant } }), { mode: 0o600 });
    manifest.push(item);
}
writeFileSync(join(root, "selected.json"), JSON.stringify(selected), { mode: 0o600 });
writeFileSync(join(root, "manifest.json"), JSON.stringify({ model: MODEL, namespace: randomUUID(), historyCounts: SESSIONS.map(s => history.filter(r => r.session_id === s).length), sourceHash: hash(source), batches: manifest }), { mode: 0o600 });
console.log(`Prepared ${selected.length} sampled compartments, ${baseline.length} base batches, 60 exact-prompt reruns and 60 context variants; snapshot read-only.`);
