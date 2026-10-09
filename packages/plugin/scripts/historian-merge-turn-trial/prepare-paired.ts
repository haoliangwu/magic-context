import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, ROOT } from "./core";
import { pairedPrompts, pairedRoot, type Input } from "./paired";

const root = pairedRoot(process.argv[2]);
if (existsSync(root)) throw new Error("Private copy already exists; do not overwrite trials");
mkdirSync(root, { mode: 0o700 });
const files = ["trial.db", "subc-connection.json", "judgments.json", "manifest.json",
    ...Array.from({ length: 40 }, (_, i) => [`inputs/${i}.json`, `results/${i}-turn1.json`]).flat()];
const copies = files.map(path => {
    const dest = join(root, path);
    mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 });
    copyFileSync(join(ROOT, path), dest);
    chmodSync(dest, path === "trial.db" ? 0o400 : 0o600);
    const sourceHash = hash(readFileSync(join(ROOT, path)).toString("base64"));
    if (hash(readFileSync(dest).toString("base64")) !== sourceHash) throw new Error(`Copy mismatch: ${path}`);
    return { path, sourceHash };
});
const db = new Database(join(root, "trial.db"), { readonly: true });
const rows = db.query("SELECT child_session,created_at,user_prompt FROM historian_runs ORDER BY created_at DESC,child_session DESC LIMIT 40").all() as { child_session: string; created_at: number; user_prompt: string }[];
if (rows.length !== 40) throw new Error("Expected forty newest cases");
for (let i = 0; i < 40; i++) {
    const input = await Bun.file(join(root, "inputs", `${i}.json`)).json() as Input;
    if (input.index !== i) throw new Error("Case index changed");
    pairedPrompts(input, rows[i]!);
}
db.close();
writeFileSync(join(root, "paired-provenance.json"), JSON.stringify({ source: ROOT, copies, cases: 40 }, null, 2), { mode: 0o600 });
console.log(`Prepared ${copies.length} hash-verified private copies; forty full/stripped prompt identities passed. Source not modified.`);
