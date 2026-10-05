import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { alterSessionScores, hash, scores, variantD, variantE, type HistoricalReference } from "./core";

const root = resolve(process.argv[2] ?? join(tmpdir(), "magic-context/importance-trial"));
if (root !== resolve(tmpdir(), "magic-context/importance-trial")) throw new Error("Root outside trial fence");
const evidence = await Bun.file(join(import.meta.dir, "evidence.json")).json();
if (evidence.cases.length !== 30) throw new Error("Follow-up requires the original thirty cases");
const db = new Database(join(root, "context.db"), { readonly: true });
const host = new Database(join(root, "opencode.db"), { readonly: true });
for (const table of ["credential", "account", "account_state", "control_account"]) {
    if (host.query("SELECT name FROM sqlite_master WHERE name=?").get(table)) throw new Error(`Unscrubbed ${table}`);
}
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[key] = join(root, "isolated", key);
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "isolated", "store");
const { COMPARTMENT_AGENT_SYSTEM_PROMPT } = await import("../../src/hooks/magic-context/compartment-prompt");
mkdirSync(join(root, "inputs"), { recursive: true });
const manifest = [];
let verifiedHashes = 0;
for (const old of evidence.cases) {
    const messages = host.query("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(old.child) as { id: string; data: string }[];
    const parts = messages.flatMap(m => (host.query("SELECT data FROM part WHERE message_id=? ORDER BY time_created,id").all(m.id) as { data: string }[]).map(p => ({ part: JSON.parse(p.data), info: JSON.parse(m.data) })));
    const user = parts.find(p => p.info.role === "user" && typeof p.part.text === "string" && hash(p.part.text) === old.promptHashes.A);
    if (!user) throw new Error(`Original prompt unavailable or changed: ${old.key}`);
    const system = Array.isArray(user.info.system) ? user.info.system.join("\n") : typeof user.info.system === "string" ? user.info.system : COMPARTMENT_AGENT_SYSTEM_PROMPT;
    if (hash(system) !== old.systemHash) throw new Error(`Original system changed: ${old.key}`);
    verifiedHashes++;
    const history = db.query(`SELECT id,sequence,start_message AS startMessage,end_message AS endMessage,title,content,p1,p2,p3,p4,importance,episode_type AS episodeType FROM compartments WHERE session_id=? AND end_message<? ORDER BY sequence`).all(old.session, old.start) as HistoricalReference[];
    const d = variantD(user.part.text, history, old.session, old.start);
    const prompts = { A: user.part.text as string, B: alterSessionScores(user.part.text), C: alterSessionScores(user.part.text, old.plant), D: d.prompt, E: variantE(d.prompt), A2: user.part.text as string };
    for (const variant of ["A", "B", "C", "D"] as const) {
        if (hash(prompts[variant]) !== old.promptHashes[variant]) throw new Error(`Original ${variant} prompt changed: ${old.key}`);
        verifiedHashes++;
    }
    // A2 and E are new model runs; the original A-D observations are kept unchanged.
    const { cells, index, ...metadata } = old;
    const originalText = parts.filter(p => p.info.role === "assistant" && p.part.type === "text").map(p => p.part.text).join("\n");
    const recorded = scores(originalText)[0];
    if (!recorded || hash(recorded.p1) !== old.recorded.p1Hash) throw new Error(`Original output unavailable or changed: ${old.key}`);
    const item = { ...metadata, recorded, promptHashes: Object.fromEntries(Object.entries(prompts).map(([v,p]) => [v,hash(p)])) };
    if (item.promptHashes.A2 !== item.promptHashes.A) throw new Error("A2 differs from A");
    writeFileSync(join(root, "inputs", `${index}.json`), JSON.stringify({ ...item, system, prompts }));
    manifest.push(item);
}
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(root, "prior-evidence.json"), JSON.stringify(evidence));
db.close(); host.close();
console.log(`Restored exactly 30 original inputs; ${verifiedHashes} original prompt/system SHA-256 checks passed; A2 is byte-identical to A; E hides four recent labels only.`);
