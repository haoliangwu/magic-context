// Runs one arm of the priming trial: a real OpenCode 1.18.30 host with Magic
// Context loaded from this checkout's dist, driven through the scripted workload
// against a local OpenAI-compatible model server.
//
//   UNSLOTH_API_KEY=... bun scripts/priming-trial/run.ts --arm bracket|neutral \
//       [--label smoke] [--turns 20] [--root <existing run root to resume>]
//
// Every store the host or Magic Context can write lives under
// $TMPDIR/magic-context/issue-563-priming/<run>/. The run refuses to start if the
// host binary is not the pinned version, and stops if lsof shows the host holding
// a file in the live OpenCode or Magic Context stores.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MagicContextConfigSchema } from "../../src/config/schema/magic-context";
import { forbiddenOpenPaths } from "../self-tag-trial/bootstrap";
import type { PlaceholderArm } from "./placeholder";
import { Relay } from "./relay";
import { WORKLOAD_REPO_COMMIT, workloadTurns } from "./workload";

const { values } = parseArgs({
    options: {
        arm: { type: "string" },
        label: { type: "string", default: "arm" },
        turns: { type: "string", default: "300" },
        root: { type: "string" },
        thinking: { type: "string", default: process.env.PRIMING_THINKING ?? "on" },
        "historian-model": { type: "string", default: "on" },
    },
});
const arm = values.arm as PlaceholderArm;
if (arm !== "bracket" && arm !== "neutral") throw new Error("--arm must be bracket or neutral");
const apiKey = process.env.UNSLOTH_API_KEY;
if (!apiKey) throw new Error("UNSLOTH_API_KEY is required; it is never written to disk");
const upstream = process.env.UNSLOTH_BASE_URL ?? "http://127.0.0.1:8888/v1";
const modelID = process.env.PRIMING_MODEL ?? "unsloth/Qwen3.8-27B-GGUF";
const providerID = "unsloth-studio";
const sourceRepo = process.env.PRIMING_REPO ?? join(homedir(), "Work/OSS/toon");
const hostBinary = process.env.PRIMING_OPENCODE ?? "opencode";
const liveHome = homedir();
const historianOn = values["historian-model"] !== "off";
const thinking = values.thinking !== "off";
const TURN_TIMEOUT_MS = 45 * 60_000;

const base = join(tmpdir(), "magic-context", "issue-563-priming");
mkdirSync(base, { recursive: true });
const root = values.root ? resolve(values.root) : mkdtempSync(join(base, `${values.label}-${arm}-`));
if (!root.startsWith(base + "/")) throw new Error("Run root must live under the trial base directory");
const work = join(root, "work", "toon");
const log = (line: string) => {
    console.log(line);
    appendFileSync(join(root, "progress.log"), `${new Date().toISOString()} ${line}\n`);
};

function prepare(): void {
    for (const dir of ["data/opencode", "data/state", "data/runtime", "config/opencode", "cache", "home", "work", "bodies"])
        mkdirSync(join(root, dir), { recursive: true });
    if (!existsSync(work)) {
        execFileSync("git", ["clone", "--quiet", "--no-hardlinks", sourceRepo, work]);
        execFileSync("git", ["-C", work, "checkout", "--quiet", WORKLOAD_REPO_COMMIT]);
        execFileSync("git", ["-C", work, "remote", "remove", "origin"]);
        execFileSync("git", ["-C", work, "switch", "--quiet", "-c", "trial"]);
    }
}

function writeConfigs(relayUrl: string): void {
    const model = `${providerID}/${modelID}`;
    const config = {
        plugin: [`file://${resolve(import.meta.dir, "host-plugin.mjs")}`],
        enabled_providers: [providerID],
        model,
        small_model: model,
        autoupdate: false,
        share: "disabled",
        lsp: false,
        formatter: false,
        compaction: { auto: false, prune: false },
        provider: {
            [providerID]: {
                npm: "@ai-sdk/openai-compatible",
                name: "Unsloth Studio (trial relay)",
                // The relay injects the real key; this placeholder only satisfies the SDK.
                options: { baseURL: relayUrl, apiKey: "relay-injects-key", timeout: false },
                models: { [modelID]: { name: modelID, limit: { context: 99840, input: 99840, output: 24960 } } },
            },
        },
        // Nothing may wait on a human: tools that ask, delegate or reach the network are off.
        permission: {
            edit: "allow",
            // Package managers and remote git would reach the network; the smoke run
            // showed the model trying `pnpm install` to fetch test fixtures.
            bash: {
                "*": "allow",
                "*install*": "deny",
                "npm *": "deny",
                "npx *": "deny",
                "pnpm *": "deny",
                "yarn *": "deny",
                "bun *": "deny",
                "bunx *": "deny",
                "curl *": "deny",
                "wget *": "deny",
                "git fetch*": "deny",
                "git pull*": "deny",
                "git push*": "deny",
                "git clone*": "deny",
            },
            webfetch: "deny",
            external_directory: "deny",
            doom_loop: "deny",
            task: "deny",
            question: "deny",
            skill: "deny",
        },
        tools: { task: false, question: false, skill: false, webfetch: false },
        agent: {
            build: { steps: 12, tools: { task: false, question: false, skill: false, webfetch: false } },
            title: { disable: true },
        },
    };
    writeFileSync(join(root, "config", "opencode", "opencode.json"), JSON.stringify(config, null, 2));
    // Master's defaults, except: the historian runs on the same local model so
    // history folds (and the queued drops that ride on them) happen; the dreamer and
    // embeddings are off so nothing downloads a model or calls another provider.
    const magicContextConfig = {
        transform_mode: "ts",
        historian: historianOn ? { opencode: { model } } : { disable: true },
        dreamer: { disable: true },
        embedding: { provider: "off" },
    };
    MagicContextConfigSchema.parse(magicContextConfig);
    writeFileSync(join(root, "config", "opencode", "magic-context.jsonc"), JSON.stringify(magicContextConfig, null, 2));
}

async function boot(relayUrl: string): Promise<{ child: ChildProcess; url: string }> {
    const version = execFileSync(hostBinary, ["--version"], { encoding: "utf8" }).trim();
    if (version !== "1.18.30") throw new Error(`Pinned host version mismatch: ${version}`);
    writeConfigs(relayUrl);
    const env: Record<string, string> = {};
    for (const key of ["PATH", "LANG", "LC_ALL", "SHELL", "TERM"]) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, {
        HOME: join(root, "home"),
        TMPDIR: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "data", "state"),
        XDG_RUNTIME_DIR: join(root, "data", "runtime"),
        OPENCODE_DB: join(root, "data", "opencode", "opencode.db"),
        MAGIC_CONTEXT_STORAGE_DIR: join(root, "data", "cortexkit", "magic-context"),
        MAGIC_CONTEXT_LOG_PATH: join(root, "magic-context.log"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        PRIMING_DIST: resolve(import.meta.dir, "../../dist/index.js"),
        PRIMING_CAPTURE: join(root, "host-capture.jsonl"),
        PRIMING_PLACEHOLDER: arm,
    });
    let stdout = "";
    const child = spawn(hostBinary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
        cwd: work,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (data) => {
        stdout += String(data);
    });
    child.stderr!.on("data", (data) => appendFileSync(join(root, "host-stderr.log"), String(data)));
    for (let i = 0; i < 600; i++) {
        const match = stdout.match(/opencode server listening on (https?:\/\/[^\s]+)/);
        if (match) return { child, url: match[1]! };
        if (child.exitCode !== null) throw new Error("OpenCode exited before readiness; see host-stderr.log");
        await Bun.sleep(100);
    }
    throw new Error("OpenCode readiness timeout");
}

function isolationCheck(pid: number, turn: number): void {
    const pids = [String(pid)];
    try {
        pids.push(...execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean));
    } catch {
        // No child processes at this moment.
    }
    const forbidden: string[] = [];
    let files = 0;
    let lsof = "";
    for (const target of pids) {
        try {
            const out = execFileSync("lsof", ["-Fn", "-p", target], { encoding: "utf8" });
            lsof += `# pid ${target}\n${out}`;
            files += out.split("\n").filter((line) => line.startsWith("n/")).length;
            forbidden.push(...forbiddenOpenPaths(out, liveHome));
        } catch {
            // The child exited between pgrep and lsof.
        }
    }
    const stores = [...new Set(lsof.split("\n").filter((line) => /\.db(-wal|-shm)?$/.test(line)).map((line) => line.slice(1)))];
    appendFileSync(join(root, "isolation.jsonl"), `${JSON.stringify({ turn, at: Date.now(), pids, files, forbidden, stores })}\n`);
    if (turn === 0 || !existsSync(join(root, "lsof-first.txt"))) writeFileSync(join(root, "lsof-first.txt"), lsof);
    if (forbidden.length) throw new Error(`Live store opened by host: ${forbidden.join(", ")}`);
}

async function waitForTurn(client: any, session: string, userText: string, started: number): Promise<{ error?: string; timedOut?: boolean }> {
    await Bun.sleep(1500);
    while (Date.now() - started < TURN_TIMEOUT_MS) {
        const status = (await client.session.status()).data ?? {};
        const busy = status[session] && status[session].type !== "idle";
        if (!busy) {
            const messages = ((await client.session.messages({ path: { id: session } })).data ?? []) as any[];
            let userIndex = -1;
            messages.forEach((m, index) => {
                if (m.info.role === "user" && m.parts.some((p: any) => p.type === "text" && p.text === userText)) userIndex = index;
            });
            const last = messages.at(-1);
            if (userIndex !== -1 && last && last.info.role === "assistant" && (last.info.time?.completed || last.info.error)) {
                const errors = messages
                    .slice(userIndex + 1)
                    .map((m) => m.info.error)
                    .filter(Boolean)
                    .map((e: any) => `${e.name}: ${String(e.data?.message ?? "").slice(0, 200)}`);
                return errors.length ? { error: errors.join(" | ") } : {};
            }
        }
        await Bun.sleep(3000);
    }
    await client.session.abort({ path: { id: session } });
    return { timedOut: true };
}

prepare();
const turns = workloadTurns();
const lastTurn = Math.min(Number(values.turns), turns.length);
const turnsPath = join(root, "turns.jsonl");
const completed = existsSync(turnsPath) ? readFileSync(turnsPath, "utf8").trim().split("\n").filter(Boolean).length : 0;
let currentTurn = completed;
// Request bodies are written before a call completes, so they count calls a killed process left unfinished.
const priorCalls = readdirSync(join(root, "bodies")).filter((name) => name.endsWith(".json.gz")).length;
const relay = new Relay({ root, arm, upstream, apiKey, model: modelID, maxTokens: 4096, thinking, currentTurn: () => currentTurn, priorCalls });
relay.start();
const { child, url } = await boot(relay.url);
const { createOpencodeClient } = await import("@opencode-ai/sdk");
const client = createOpencodeClient({ baseUrl: url });
const statePath = join(root, "state.json");
let session: string;
if (existsSync(statePath)) session = JSON.parse(readFileSync(statePath, "utf8")).session;
else {
    const created = await client.session.create({ body: { title: `issue-563 priming ${arm}` } });
    if (!created.data?.id) throw new Error("Session creation failed");
    session = created.data.id;
    writeFileSync(
        statePath,
        JSON.stringify({ session, arm, thinking, historianOn, modelID, repoCommit: WORKLOAD_REPO_COMMIT, created: Date.now() }, null, 2),
    );
}
log(`root=${root} arm=${arm} session=${session} resume-from=${completed + 1} last=${lastTurn} thinking=${thinking} historian=${historianOn}`);
let stopped = false;
const stop = async () => {
    if (stopped) return;
    stopped = true;
    await relay.settle();
    if (child.exitCode === null) {
        await new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill("SIGTERM");
            setTimeout(() => {
                child.kill("SIGKILL");
                done();
            }, 15_000);
        });
    }
    relay.stop();
};
process.on("SIGINT", () => void stop().then(() => process.exit(130)));
try {
    isolationCheck(child.pid!, completed);
    for (let turn = completed + 1; turn <= lastTurn; turn++) {
        currentTurn = turn;
        const prompt = turns[turn - 1]!;
        const firstCall = relay.calls.length;
        const started = Date.now();
        const sent = await client.session.promptAsync({
            path: { id: session },
            body: { agent: "build", model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] },
        });
        if (sent.error) throw new Error(`promptAsync failed: ${JSON.stringify(sent.error).slice(0, 300)}`);
        const outcome = await waitForTurn(client, session, prompt, started);
        await relay.settle();
        const calls = relay.calls.slice(firstCall);
        const main = calls.filter((call) => call.lane === "main");
        const row = {
            turn,
            prompt,
            startedAt: started,
            durationMs: Date.now() - started,
            calls: calls.map((call) => call.index),
            mainCalls: main.length,
            auxCalls: calls.length - main.length,
            ...outcome,
        };
        appendFileSync(turnsPath, `${JSON.stringify(row)}\n`);
        const last = main.at(-1);
        const cached = main.map((call) => `${call.usage?.prompt_tokens_details?.cached_tokens ?? "?"}/${call.usage?.prompt_tokens ?? "?"}`);
        log(
            `turn ${turn} ${(row.durationMs / 1000).toFixed(0)}s main=${main.length} aux=${row.auxCalls} cache=${cached.join(",")} drops=${
                last ? last.exposure.droppedToolResults + last.exposure.droppedToolInputs + last.exposure.droppedTextParts : "?"
            } maxTag=${last?.exposure.maxTag ?? "?"}${outcome.error ? ` ERROR ${outcome.error}` : ""}${outcome.timedOut ? " TIMEOUT" : ""}`,
        );
        if (turn % 25 === 0 || turn === lastTurn) isolationCheck(child.pid!, turn);
    }
} finally {
    await stop();
}
log("done");
process.exit(0);
