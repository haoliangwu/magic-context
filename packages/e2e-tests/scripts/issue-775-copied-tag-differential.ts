#!/usr/bin/env bun
/**
 * Randomized source-boundary differential for OC1, OC2 and Pi. Real-host wire
 * lanes remain separate: this driver isolates tag stripping and replay over saved
 * message history from scheduler/host nondeterminism. Each host runs at least 300 passes.
 *
 * bun packages/e2e-tests/scripts/issue-775-copied-tag-differential.ts BASE [FIX|WORKTREE] [--passes 300]
 *
 * Archives never open a host store. All scratch and test storage stay under the
 * worktree; package test preloads are active and OPENCODE_DB is not exported.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const base = process.argv[2];
const candidate = process.argv[3]?.startsWith("--") ? "WORKTREE" : process.argv[3] ?? "WORKTREE";
const countAt = process.argv.indexOf("--passes");
const passes = countAt < 0 ? 300 : Number(process.argv[countAt + 1]);
if (!base || !Number.isSafeInteger(passes) || passes < 300) throw new Error("Provide BASE [FIX|WORKTREE] and --passes >=300");
const scratch = join(repo, "target/scratch");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "issue775-differential-"));

function extract(ref: string, name: string): string {
    if (ref === "WORKTREE") return repo;
    const dir = join(root, name);
    mkdirSync(dir);
    const archive = execFileSync("git", ["archive", "--format=tar", ref], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", dir], { input: archive });
    for (const sub of ["", "packages/plugin", "packages/pi-plugin", "packages/e2e-tests", "packages/retina-local-fs"]) {
        const modules = join(repo, sub, "node_modules");
        if (existsSync(modules)) symlinkSync(modules, join(dir, sub, "node_modules"), "dir");
    }
    return dir;
}

const runner = join(root, "runner.test.ts");
writeFileSync(runner, String.raw`
import { test } from "bun:test";
test("randomized copied-tag boundary differential", async () => {
const root = process.env.MC_DIFF_ROOT;
const output = process.env.MC_DIFF_OUTPUT;
const passesText = process.env.MC_DIFF_PASSES;
const passes = Number(passesText);
const load = (file) => import(root + "/" + file);
const { Database } = await load("packages/plugin/src/shared/sqlite.ts");
const { initializeDatabase } = await load("packages/plugin/src/features/magic-context/storage-db.ts");
const { runMigrations } = await load("packages/plugin/src/features/magic-context/migrations.ts");
const { createTagger } = await load("packages/plugin/src/features/magic-context/tagger.ts");
const { tagMessages } = await load("packages/plugin/src/hooks/magic-context/tag-messages.ts");
const { createTextCompleteHandler } = await load("packages/plugin/src/hooks/magic-context/text-complete.ts");
const { stripTagPrefixFromAssistantMessage } = await load("packages/pi-plugin/src/strip-tag-prefix.ts");
const { createPiTranscript } = await load("packages/pi-plugin/src/transcript-pi.ts");
const { tagTranscript } = await load("packages/plugin/src/shared/tag-transcript.ts");
const { adaptPayload } = await load("packages/plugin/src/v2/hooks/payload.ts");
const { stripCopiedTagNotation } = await load("packages/plugin/src/v2/hooks/copied-tag-notation.ts");
let repairModule;
try { repairModule = await load("packages/plugin/src/hooks/magic-context/served-shape-repair.ts"); } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" && !String(error).includes("Cannot find module")) throw error;
}
const samples = ["§58§", " §58§ \n", "§1§ §2§", "§42$", "§§", "§12§ Done", "see §17§ here", "99 files", "\n prose \n", " \n\t ", "", "plain answer"];
let state = 775;
const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
const results = [];
for (const host of ["opencode1", "opencode2", "pi"]) {
    const db = new Database(":memory:"); initializeDatabase(db); runMigrations(db);
    const tagger = createTagger();
    const sessions = new Map();
    for (const provider of ["anthropic", "openai", "ark", "bedrock"]) sessions.set(provider, { raw: [], previous: null });
    for (let pass = 0; pass < passes; pass++) {
        const provider = [...sessions.keys()][(random() >>> 16) % 4];
        const session = host + "-" + provider;
        const data = sessions.get(provider);
        const sample = samples[(random() >>> 16) % samples.length];
        const raw = { role: "assistant", provider, content: [{ type: "text", text: sample }] };
        if (host === "opencode1") {
            const output = { text: sample };
            await createTextCompleteHandler(() => provider)({ sessionID: session, messageID: "a" + pass, partID: "p" }, output);
            raw.content[0].text = output.text;
        } else if (host === "pi") stripTagPrefixFromAssistantMessage(raw);
        data.raw.push({ id: "a" + pass, role: "assistant", content: raw.content });
        data.raw.push({ id: "u" + pass, role: "user", content: [{ type: "text", text: "continue " + pass }] });
        const draft = { sessionID: session, model: { providerID: provider, id: "mock-model" }, agent: "build", messages: structuredClone(data.raw), system: [], tools: {}, options: {} };
        const mapped = host === "opencode2" ? adaptPayload(draft) : {
            messages: draft.messages.map((m) => ({ info: { id: m.id, role: m.role, sessionID: session, providerID: provider }, parts: m.content })),
            commit() { draft.messages = this.messages.map((m) => ({ id: m.info.id, role: m.info.role, content: m.parts })); },
        };
        tagger.initFromDb(session, db);
        if (host === "pi") {
            const transcript = createPiTranscript(draft.messages, session, draft.messages.map((m) => m.id));
            tagTranscript(session, transcript, tagger, db, { preserveTagOnlyAssistantText: provider !== "anthropic" });
            transcript.commit();
        } else tagMessages(session, mapped.messages, tagger, db, host === "opencode2" ? { normalizeRestoredAssistantText: (text) => stripCopiedTagNotation(text, provider === "anthropic") } : {});
        let rebuild = pass % 23 === 0;
        if (repairModule && host === "opencode2") {
            const repair = repairModule.prepareServedShapeRepair(db, session, mapped.messages, () => data.previous);
            rebuild ||= repair.needsRebuild;
            repair.apply(rebuild);
        }
        data.previous = structuredClone(mapped.messages);
        if (host !== "pi") mapped.commit();
        results.push({ host, provider, pass, sample, rebuild, messages: draft.messages });
    }
    db.close();
}
await Bun.write(output, JSON.stringify(results));
console.log("boundary passes=" + results.length);
}, 120000);
`);

type Row = { host: string; provider: string; pass: number; sample: string; rebuild: boolean; messages: Array<{ id: string; role: string; content: Array<{ type: string; text?: string }> }> };
const outputs = [extract(base, "base"), extract(candidate, "candidate")].map((dir, index) => {
    const output = join(root, `${index}.json`);
    const env = { ...process.env };
    delete env.OPENCODE_DB;
    env.MC_DIFF_ROOT = dir;
    env.MC_DIFF_OUTPUT = output;
    env.MC_DIFF_PASSES = String(passes);
    execFileSync(process.execPath, [
        "test",
        "--preload", join(dir, "packages/plugin/test-preload.ts"),
        "--tsconfig-override", join(dir, "packages/pi-plugin/tsconfig.json"),
        runner,
    ], { cwd: dir, env, stdio: "inherit" });
    return JSON.parse(readFileSync(output, "utf8")) as Row[];
});
const [left, right] = outputs;
if (left.length !== right.length) throw new Error("pass counts differ");
const originals = new Map<string, string>();
const previous = [new Map<string, Row>(), new Map<string, Row>()];
const counts: Record<string, { passes: number; tagOnly: number; newWhitespace: number; deferReplay: number }> = {};
for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    const session = `${a.host}/${a.provider}`;
    const count = counts[a.host] ??= { passes: 0, tagOnly: 0, newWhitespace: 0, deferReplay: 0 };
    count.passes++;
    originals.set(`${session}/a${a.pass}`, a.sample);
    if (a.messages.length !== b.messages.length) throw new Error(`message count changed ${session}/${a.pass}`);
    for (let message = 0; message < a.messages.length; message++) {
        const before = a.messages[message];
        const after = b.messages[message];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const raw = originals.get(`${session}/${before.id}`);
        if (a.provider === "anthropic" || before.role !== "assistant" || raw === undefined || before.content.length !== 1 || after.content.length !== 1)
            throw new Error(`unrelated message changed ${session}/${a.pass}/${before.id}`);
        if (raw.includes("§") && !before.content[0].text?.trim() && after.content[0].text === raw) count.tagOnly++;
        else if (a.host !== "opencode2" && !raw.includes("§") && raw.length > 0 && !raw.trim() && before.content[0].text === "" && after.content[0].text === raw) count.newWhitespace++;
        else throw new Error(`unexpected text delta ${session}/${before.id}: ${JSON.stringify({ raw, before, after })}`);
    }
    for (const [side, row] of [a, b].entries()) {
        const old = previous[side].get(session);
        if (old && !row.rebuild) {
            const prefix = row.messages.slice(0, old.messages.length);
            if (JSON.stringify(prefix) !== JSON.stringify(old.messages)) throw new Error(`defer changed its predecessor: side=${side} ${session}/${row.pass}`);
            if (side === 1) count.deferReplay++;
        }
        previous[side].set(session, row);
    }
}
for (const [host, count] of Object.entries(counts)) {
    if (count.passes < 300 || count.tagOnly === 0 || count.deferReplay === 0) throw new Error(`vacuous host coverage: ${host}`);
}
console.log(JSON.stringify({ base, candidate, seed: 775, counts, result: "PASS" }, null, 2));
