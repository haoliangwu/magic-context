import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../src/mock-provider/server";
import { fixturePrompt, fixtureSystem } from "./historian-cache-tail-probe";
import { buildHistorianRepairPrompt } from "../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { createHash } from "node:crypto";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import { withoutHistorianTailCache } from "../../plugin/src/shared/historian-cache";

const base = join(tmpdir(), "magic-context/i744b");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "wire-"));
const evidence = process.env.I744_EVIDENCE ?? join(root, "evidence");
mkdirSync(evidence, {recursive: true});
const save = (name: string, value: string) => writeFileSync(join(evidence, name), value);
function isolated(name: string) {
    const dir = join(root, name);
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ANTHROPIC_API_KEY: "test-key-not-real"};
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR"]) {
        env[key] = join(dir, key); mkdirSync(env[key]!, {recursive: true});
    }
    const cwd = join(dir, "work"); mkdirSync(cwd, {recursive: true});
    env.OPENCODE_DB = "opencode2.db";
    env.MAGIC_CONTEXT_LOG_PATH = join(dir, "magic-context.log");
    return {root: dir, env, cwd};
}
function inventory(pid: number, label: string, dir: string) {
    const result = spawnSync("lsof", ["-p", String(pid), "-Fn"], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    save(`${label}.lsof`, result.stdout);
    const stores = result.stdout.split("\n").filter(line => line.startsWith("n/") && /\.(db|sqlite|jsonl)(-wal|-shm)?$/.test(line));
    for (const path of stores) assert.ok(path.slice(1).startsWith(dir + "/"), path);
    return stores;
}
async function bundle(entry: string, out: string) {
    const result = await Bun.build({entrypoints: [resolve(entry)], outdir: out, target: "bun", format: "esm", naming: "index.js", define: { "process.env.NODE_ENV": '"production"' }, external: ["node:sqlite", "bun:sqlite", "@opencode/plugin", "@opencode-ai/plugin"]});
    assert.ok(result.success, result.logs.join("\n"));
    const entryPath = result.outputs.find(output => output.kind === "entry-point")!.path;
    // Bun can emit an undefined helper for bundled async initializers; the
    // disposable probe uses the native Promise implementation instead.
    writeFileSync(entryPath, readFileSync(entryPath, "utf8").replaceAll("__promiseAll(", "Promise.all("));
    return entryPath;
}
const summary: Record<string, unknown> = {root, bun: Bun.version, prompt: { systemBytes: Buffer.byteLength(fixtureSystem), userBytes: Buffer.byteLength(fixturePrompt), systemTokens: estimateTokens(fixtureSystem), userTokens: estimateTokens(fixturePrompt), systemSha256: createHash("sha256").update(fixtureSystem).digest("hex"), userSha256: createHash("sha256").update(fixturePrompt).digest("hex") }};

// Import after the caller has provisioned the pinned host binary.
const {spawnOpencode2, waitForPluginActive, inspectOpenFiles} = await import("../src/opencode2-runner/spawn");
const oc = isolated("oc2");
const probeDir = join(oc.root, "probe");
await bundle("packages/e2e-tests/scripts/historian-cache-tail-probe.ts", probeDir);
writeFileSync(join(probeDir, "package.json"), JSON.stringify({name: "mc-cache-tail-proof", type: "module", "main": "index.js"}));

const host = await spawnOpencode2({existingIsolation: oc, providerID: "anthropic", probePlugin: probeDir, includeMagicContext: false, modelContextLimit: 200000});
try {
    const client = OpenCode.make({baseUrl: host.url, headers: {authorization: `Basic ${btoa(`opencode:${host.password}`)}`}});
    const session = await client.session.create({location: {directory: host.cwd}, model: {providerID: "anthropic", id: "mock-model"}});
    await waitForPluginActive(client, host.cwd, "mc-cache-tail-proof");
    await client.session.prompt({sessionID: session.id, text: "Ordinary main-session prompt."});
    await client.session.wait({sessionID: session.id}, {signal: AbortSignal.timeout(20000)});
    inventory(host.pid!, "oc2", oc.root);
    inspectOpenFiles(host.pid!, oc.root, oc.env);
    let hidden = 0;
    host.mock.addMatcher(body => {
        if (!JSON.stringify(body).includes("# Historian")) return null;
        hidden++;
        if (hidden === 2) return {error: {status: 503, type: "overloaded_error", message: "503 overloaded"}};
        return {text: "<compartment start=\"1\" end=\"2\" title=\"cache proof\"><p1>Stable prefix.</p1></compartment>", usage: {input_tokens: 100, output_tokens: 20}};
    });
    await client.session.generate({sessionID: session.id, prompt: "CACHE_PROOF"}).catch(() => {});
    if (existsSync(join(oc.cwd, "cache-proof.error"))) throw new Error(readFileSync(join(oc.cwd, "cache-proof.error"), "utf8"));
    assert.equal(readFileSync(join(oc.cwd, "cache-proof.done"), "utf8"), "ok", host.stderr());
    const rows = JSON.parse(readFileSync(join(oc.cwd, "cache-wire.json"), "utf8")) as Array<{owned: boolean; kind: string; before: string; after: string}>;
    const historian = rows.filter(row => row.owned && row.kind === "primary");
    assert.equal(historian.length, 6);
    assert.equal(historian[0]!.before, historian[0]!.after);
    assert.equal(historian[1]!.after, withoutHistorianTailCache(historian[1]!.before));
    assert.notEqual(historian[1]!.after, historian[1]!.before);
    assert.equal(historian[1]!.before, historian[0]!.before);
    assert.equal(historian[2]!.before, historian[2]!.after);
    assert.equal(historian[3]!.before, historian[3]!.after);
    assert.equal(historian[4]!.before, historian[4]!.after);
    assert.equal(historian[5]!.after, withoutHistorianTailCache(historian[4]!.before));
    assert.notEqual(historian[5]!.after, historian[5]!.before);

    const main = rows.filter(row => !row.owned);
    assert.ok(main.length > 0);
    for (const row of main) assert.equal(row.before, row.after);
    const captures = host.mock.requests().filter(row => JSON.stringify(row.body).includes("# Historian"));
    assert.deepEqual(captures.map(row => row.rawBody), historian.map(row => row.after));
    save("oc2-wire.json", JSON.stringify({main, historian, captures: captures.map(row => row.rawBody)}, null, 2));
    summary.oc2 = {checks: 16 + main.length, historianRequests: historian.length, mainRequests: main.length, mainByteIdentical: true};
} catch (error) { console.error("Host trace:", host.stderr().slice(-3000)); throw error; } finally { await host.stop(); }

const pi = isolated("pi");
pi.env.OPENCODE_DB = join(pi.root, "unused-opencode.db");
const piPackage = resolve("packages/pi-plugin/node_modules/@earendil-works/pi-coding-agent/package.json");
const piManifest = JSON.parse(readFileSync(piPackage, "utf8"));
const cli = join(dirname(piPackage), piManifest.bin.pi);
const extension = await bundle("packages/pi-plugin/src/historian-calibration-extension.ts", join(pi.root, "extension"));
const mock = new MockProvider();
const provider = await mock.start();
mock.setDefault({text: "<compartment start=\"1\" end=\"2\" title=\"cache proof\"><p1>Stable prefix.</p1></compartment>", usage: {input_tokens: 100, output_tokens: 20}});
writeFileSync(join(pi.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({providers: {anthropic: {baseUrl: provider.baseURL, apiKey: "test-key-not-real"}}}));
writeFileSync(join(pi.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}));
const systemPath = join(pi.root, "system.txt"); writeFileSync(systemPath, fixtureSystem);
let piPid = 0;
let piInventory = 0;
mock.addMatcher(() => {inventory(piPid, `pi-${piInventory++}`, pi.root); return null;});
async function piRun(label: string, prompt: string, cacheTail?: "skip" | "write") {
    const env = {...pi.env, ...(cacheTail ? {MAGIC_CONTEXT_HISTORIAN_CACHE_TAIL: cacheTail} : {})};
    const child = spawn("node", [cli, "--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", extension, "--model", "anthropic/claude-haiku-4-5", "--thinking", "off", "--no-tools", "--system-prompt", systemPath, prompt], {cwd: pi.cwd, env, stdio: ["ignore", "pipe", "pipe"]});
    piPid = child.pid!;
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => {stdout += chunk;}); child.stderr.on("data", chunk => {stderr += chunk;});
    const code = await new Promise(resolve => child.on("close", resolve));
    save(`${label}.stdout`, stdout); save(`${label}.stderr`, stderr);
    assert.equal(code, 0, stderr);
    const body = mock.requests().at(-1)!.rawBody!;
    save(`${label}.json`, body);
    return body;
}
try {
    const before = await piRun("pi-before", fixturePrompt, "write");
    const after = await piRun("pi-after", fixturePrompt, "skip");
    assert.equal(after, withoutHistorianTailCache(before)); assert.notEqual(after, before);
    const retry = await piRun("pi-outer-retry", fixturePrompt, "write"); assert.equal(retry, before);
    const repair = buildHistorianRepairPrompt(fixturePrompt, "invalid XML", "missing compartment", "en");
    const repairBefore = await piRun("pi-repair-before", repair, "write");
    const repairAfter = await piRun("pi-repair-after", repair, "skip"); assert.equal(repairAfter, withoutHistorianTailCache(repairBefore));
    const mainBefore = await piRun("pi-main-before", "Ordinary main-session prompt.");
    const mainAfter = await piRun("pi-main-after", "Ordinary main-session prompt."); assert.equal(mainAfter, mainBefore);
    summary.pi = {version: piManifest.version, checks: 13, historianRequests: 5, mainRequests: 2, mainByteIdentical: true};
} finally {await mock.stop();}
summary.result = "passed";
save("summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Evidence: ${evidence}`);
