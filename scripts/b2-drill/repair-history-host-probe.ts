// One real OpenCode host pass over CLONES of an existing session, to check what the
// model is sent for its <session-history> after `ck-mc single-store-repair-history`.
//
// Run with bun from the repository root, after `bun run build` in packages/plugin:
//
//   bun scripts/b2-drill/repair-history-host-probe.ts \
//     --root   "$TMPDIR/magic-context/b2-repair/run-repaired" \
//     --stores "$TMPDIR/magic-context/b2-repair/apply-1" \
//     --opencode-db "$TMPDIR/magic-context/b2-repair/host-oc/opencode.db" \
//     --project ~/Work/Projects/CortexKit/subconscious \
//     --session ses_... --model anthropic/claude-opus-5-5
//
// Everything the host opens is an APFS clone under --root, which must sit below
// $TMPDIR/magic-context/: the stores directory (context.db, store.db and their -wal
// files), the OpenCode database, and the project's .git and .cortexkit (so the session
// keeps its project identity without the host touching the real checkout). The provider
// is the local mock from packages/e2e-tests; historian requests are answered with an
// overload error so the pass cannot write compartments. The host's open files are checked
// with lsof against the live store roots before the prompt is sent.
import { execFileSync, spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MockProvider } from "../../packages/e2e-tests/src/mock-provider/server";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}
const need = (key: string) => {
    const value = args.get(key);
    if (!value) throw new Error(`--${key} is required`);
    return value;
};
const root = resolve(need("root"));
const session = need("session");
const [providerID, modelID] = need("model").split("/");
const tmp = realpathSync(process.env.TMPDIR ?? "/tmp");
mkdirSync(root, { recursive: true });
if (!realpathSync(root).startsWith(join(tmp, "magic-context") + "/")) {
    throw new Error(`--root must sit under ${tmp}/magic-context/`);
}
if (existsSync(join(root, "data"))) throw new Error(`${root} was used already; pick a new --root`);

const dataDir = join(root, "data");
const configDir = join(root, "config");
const workdir = join(root, "work");
const storage = join(dataDir, "cortexkit", "magic-context");
for (const dir of [join(dataDir, "opencode"), storage, join(configDir, "opencode"), workdir, join(root, "cache"), join(dataDir, "state"), join(dataDir, "runtime")]) {
    mkdirSync(dir, { recursive: true });
}
const clone = (from: string, to: string) => execFileSync("cp", ["-c", "-R", from, to]);
for (const name of ["context.db", "context.db-wal", "store.db", "store.db-wal"]) {
    const from = join(need("stores"), name);
    if (existsSync(from)) clone(from, join(storage, name));
}
const opencodeDb = need("opencode-db");
clone(opencodeDb, join(dataDir, "opencode", "opencode.db"));
if (existsSync(`${opencodeDb}-wal`)) clone(`${opencodeDb}-wal`, join(dataDir, "opencode", "opencode.db-wal"));
for (const name of [".git", ".cortexkit"]) clone(join(need("project"), name), join(workdir, name));

const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({ text: "probe ok", usage: { input_tokens: 1000, output_tokens: 5 } });
const isHistorian = (body: Record<string, unknown>) =>
    JSON.stringify(body.system ?? "").includes("the hippocampus of a long-running coding agent");
mock.addMatcher((body) =>
    isHistorian(body) ? { error: { status: 529, type: "overloaded_error", message: "probe: historian disabled" } } : null,
);

const model = { id: modelID, name: modelID, cost: { input: 0, output: 0 }, limit: { context: 1_000_000, output: 8192 }, modalities: { input: ["text"], output: ["text"] }, options: {} };
writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [`file://${resolve("packages/plugin/dist/index.js")}`],
    autoupdate: false,
    compaction: { auto: false, prune: false },
    provider: { [providerID]: { npm: "@ai-sdk/anthropic", name: "Mock", env: [], options: { apiKey: "test-key-not-real", baseURL }, models: { [modelID]: model } } },
    enabled_providers: [providerID],
    model: `${providerID}/${modelID}`,
    small_model: `${providerID}/${modelID}`,
}, null, 2));
writeFileSync(join(configDir, "opencode", "magic-context.jsonc"), JSON.stringify({
    dreamer: { disable: true },
    compressor: { enabled: false },
    memory: { auto_promote: false, auto_search: { enabled: false } },
}, null, 2));

const logPath = join(root, "magic-context.log");
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "NODE_ENV", "MAGIC_CONTEXT_TEST_DATA_DIR", "SUBC_MODULE_ID", "SUBC_LAUNCH_NONCE", "OPENCODE_CONFIG"].includes(key)) continue;
    env[key] = value;
}
Object.assign(env, {
    OPENCODE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(dataDir, "state"),
    XDG_RUNTIME_DIR: join(dataDir, "runtime"),
    OPENCODE_DB: join(dataDir, "opencode", "opencode.db"),
    MAGIC_CONTEXT_STORAGE_DIR: storage,
    MAGIC_CONTEXT_LOG_PATH: logPath,
    ANTHROPIC_API_KEY: "test-key-not-real",
});
const child = spawn(args.get("opencode") ?? "opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
const output: Record<string, unknown> = { root, session, model: `${providerID}/${modelID}` };
try {
    let url = "";
    for (const deadline = Date.now() + 120_000; Date.now() < deadline && !url; await Bun.sleep(50)) {
        const match = stdout.match(/listening on (https?:\/\/[^\s]+)/);
        if (match) url = match[1];
        if (child.exitCode !== null) throw new Error(`opencode exited: ${stderr.slice(-2000)}`);
    }
    if (!url) throw new Error(`no listening line: ${stdout.slice(-1000)} ${stderr.slice(-1000)}`);

    const opened = execFileSync("lsof", ["-Fn", "-p", String(child.pid)], { encoding: "utf8" });
    const liveRoots = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit"].map((path) => join(homedir(), path));
    const forbidden = opened.split("\n").filter((line) => line.startsWith("n/") && liveRoots.some((path) => line.slice(1).startsWith(`${path}/`)));
    if (forbidden.length) throw new Error(`host opened live store paths: ${forbidden.join(", ")}`);
    output.isolation = { pid: child.pid, forbidden, databases: opened.split("\n").filter((line) => /^n\/.*\.db$/.test(line)).map((line) => line.slice(1)) };

    const started = Date.now();
    const response = await fetch(`${url}/session/${session}/message?directory=${encodeURIComponent(workdir)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID, modelID }, parts: [{ type: "text", text: "Probe after the history repair: reply ok." }] }),
        signal: AbortSignal.timeout(30 * 60_000),
    });
    output.prompt = { status: response.status, ms: Date.now() - started, body: (await response.text()).slice(0, 400) };
    await Bun.sleep(2_000);

    const main = mock.requests().filter((request) => !isHistorian(request.body));
    output.requests = { main: main.length, historian: mock.requests().length - main.length };
    const wire = JSON.stringify(main.at(-1)?.body ?? {});
    const history = wire.match(/<session-history>([\s\S]*?)<\/session-history>/)?.[1] ?? "";
    const headings = [...history.matchAll(/## (\d+)-(\d+) ·/g)].map((match) => [Number(match[1]), Number(match[2])]);
    output.render = {
        sessionHistoryBytes: history.length,
        headings: headings.length,
        firstHeading: headings[0] ?? null,
        lastHeading: headings.at(-1) ?? null,
    };
    writeFileSync(join(root, "wire.json"), wire);

    const db = new Database(join(storage, "context.db"), { readonly: true });
    try {
        output.after = db.prepare(
            `SELECT (SELECT COUNT(*) FROM compartments WHERE session_id = ?1) AS compartments,
                    (SELECT MAX(end_message) FROM compartments WHERE session_id = ?1) AS end_message,
                    cached_m0_max_compartment_seq, cached_m0_materialized_at, cached_m0_last_baseline_end_message_id,
                    length(cached_m0_bytes) AS cached_m0_length, pending_compaction_marker_state
               FROM session_meta WHERE session_id = ?1`,
        ).get(session);
    } finally {
        db.close();
    }
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes(session)) : [];
    output.log = {
        lines: log.length,
        degraded: log.filter((line) => /degraded/.test(line)).map((line) => line.slice(0, 300)),
        materialize: log.filter((line) => /materializ|mustMaterialize|HARD|reason/i.test(line)).slice(-12).map((line) => line.slice(0, 300)),
    };
} catch (error) {
    output.error = error instanceof Error ? error.message : String(error);
} finally {
    try { process.kill(-(child.pid ?? 0), "SIGTERM"); } catch {}
    await Bun.sleep(3_000);
    try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch {}
    await mock.stop();
}
writeFileSync(join(root, "probe.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
