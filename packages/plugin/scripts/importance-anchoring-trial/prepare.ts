import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hash, scores, variantD, plantedScores, alterSessionScores, type HistoricalReference } from "./core";

const root = resolve(process.argv[2] ?? join(tmpdir(), "magic-context/importance-trial"));
if (root !== resolve(tmpdir(), "magic-context/importance-trial")) throw new Error("Root outside trial fence");
const db = new Database(join(root, "context.db"), { readonly: true });
const host = new Database(join(root, "opencode.db"), { readonly: true });
for (const table of ["credential", "account", "account_state", "control_account"]) {
    if (host.query("SELECT name FROM sqlite_master WHERE name=?").get(table)) throw new Error(`Unscrubbed ${table}`);
}
const sessions = ["ses_313660571ffeZTsf4koSJwk50Q", "ses_114f158ccffet7znXAgI7lc3Kp", "ses_331acff95fferWZOYF1pG0cjOn"];
type Child = { id: string; time_created: number; title: string };
type Part = { data: string; message_id: string };
const manifest: unknown[] = [];
const historyQuery = db.query(`SELECT id,sequence,start_message AS startMessage,end_message AS endMessage,title,content,p1,p2,p3,p4,importance,episode_type AS episodeType FROM compartments WHERE session_id=? ORDER BY sequence`);
mkdirSync(join(root, "inputs"), { recursive: true });
// Pure prompt modules are imported only after storage and model-cache paths are isolated.
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[key] = join(root, "isolated", key);
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "isolated", "store");
const { COMPARTMENT_AGENT_SYSTEM_PROMPT } = await import("../../src/hooks/magic-context/compartment-prompt");
for (const session of sessions) {
    const history = historyQuery.all(session) as HistoricalReference[];
    const children = host.query("SELECT id,time_created,title FROM session WHERE parent_id=? AND title LIKE 'magic-context-%' ORDER BY time_created DESC LIMIT 160").all(session) as Child[];
    let accepted = 0;
    const seen = new Set<string>();
    for (const child of children) {
        if (accepted >= 10) break;
        const messages = host.query("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(child.id) as {id: string; data: string}[];
        const parts = messages.flatMap(m => (host.query("SELECT data,message_id FROM part WHERE message_id=? ORDER BY time_created,id").all(m.id) as Part[]).map(p => ({...p, role: JSON.parse(m.data).role, info: JSON.parse(m.data)})));
        const user = parts.find(p => p.role === "user" && JSON.parse(p.data).text?.includes("<session_references>"));
        if (!user) continue;
        const prompt: string = JSON.parse(user.data).text;
        // Initial runs only: repair prompts include a previous draft and are a different experiment.
        if (prompt.includes("<draft>") || prompt.includes("<previous_output>")) continue;
        const output = parts.filter(p => p.role === "assistant" && JSON.parse(p.data).type === "text").map(p => JSON.parse(p.data).text).join("\n");
        let parsed;
        try { parsed = scores(output); } catch { continue; }
        if (parsed.length !== 1) continue;
        const source = prompt.match(/<new_messages>([\s\S]*?)<\/new_messages>/)?.[1] ?? "";
        const range = source.match(/Messages (\d+)-(\d+):/);
        const blocks = [...source.matchAll(/^\[(\d+)(?:-(\d+))?\]/gm)];
        if (!range && !blocks.length) continue;
        const start = Number(range?.[1] ?? blocks[0]![1]);
        const end = Number(range?.[2] ?? blocks.at(-1)![2] ?? blocks.at(-1)![1]);
        if (seen.has(`${start}-${end}`)) continue;
        const prior = history.filter(c => c.endMessage < start);
        const previous = prior.at(-1);
        const refScores = [...prompt.match(/<session_references>[\s\S]*?<\/session_references>/)![0].matchAll(/<compartment\b[^>]*importance="(\d+)"/g)].map(m => Number(m[1]));
        if (!previous || refScores.length !== 6) continue;
        // Do not silently compare a rebased ordinal to a different previous row.
        if (refScores.at(-1) !== previous.importance) continue;
        const published = history.find(c => c.startMessage === parsed[0]!.start && c.endMessage === parsed[0]!.end && c.title === parsed[0]!.title && c.importance === parsed[0]!.importance);
        if (!published) continue;
        const key = `${session}:${start}-${end}`;
        const plant = plantedScores(key, refScores.length);
        const d = variantD(prompt, prior, session, start);
        if (d.selected.references.length !== 7) continue;
        const renderedDCount = [...d.prompt.match(/<session_references>[\s\S]*?<\/session_references>/)![0].matchAll(/<compartment\b/g)].length;
        if (renderedDCount !== 7) throw new Error(`D rendered ${renderedDCount} references: ${session}:${start} selected ${JSON.stringify(d.selected.references.map(c=>({id:c.id,sequence:c.sequence,title:c.title,importance:c.importance})))}`);
        const prompts = { A: prompt, B: alterSessionScores(prompt), C: alterSessionScores(prompt, plant), D: d.prompt };
        const withoutRefs = (p:string) => p.replace(/<session_references>[\s\S]*?<\/session_references>/, "");
        const withoutExamples = (p:string) => withoutRefs(p).replace(/<compartment_examples_from_other_projects>[\s\S]*?<\/compartment_examples_from_other_projects>/, "");
        if (withoutRefs(prompts.B) !== withoutRefs(prompt) || withoutRefs(prompts.C) !== withoutRefs(prompt) || withoutExamples(prompts.D) !== withoutExamples(prompt)) throw new Error("Variant changed transcript, guard or project memory");
        const system = Array.isArray(user.info.system) ? user.info.system.join("\n") : typeof user.info.system === "string" ? user.info.system : COMPARTMENT_AGENT_SYSTEM_PROMPT;
        const assistantInfo = parts.find(p => p.role === "assistant")?.info;
        if (`${assistantInfo?.providerID}/${assistantInfo?.modelID}` !== "google/antigravity-gemini-3.8-flash") continue;
        const item = { key, session, child: child.id, date: new Date(child.time_created).toISOString(), start, end, publishedId: published.id, sequence: published.sequence, originalModel: `${assistantInfo?.providerID}/${assistantInfo?.modelID}`, previousImportance: previous.importance, recorded: parsed[0], refScores, plant, d: { seedScores: d.selected.seeds.map(s => s.importance), recent: d.selected.recent.map(c => ({id:c.id,sequence:c.sequence,importance:c.importance})), diverse: d.selected.diverse.map(c => ({id:c.id,sequence:c.sequence,importance:c.importance})), olderBandCounts: d.selected.olderBandCounts }, source: "recorded hidden child user prompt", systemSource: user.info.system ? "recorded user message system" : "current production generated system prompt", promptHashes: Object.fromEntries(Object.entries(prompts).map(([v,p])=>[v,hash(p)])), systemHash: hash(system) };
        writeFileSync(join(root, "inputs", `${manifest.length}.json`), JSON.stringify({ ...item, system, prompts }));
        manifest.push(item);
        seen.add(`${start}-${end}`);
        accepted++;
    }
    console.log(JSON.stringify({session,accepted,history:history.length,children:children.length}));
}
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
db.close(); host.close();
console.log(`Prepared ${manifest.length} paired inputs; no raw transcripts copied into git.`);
