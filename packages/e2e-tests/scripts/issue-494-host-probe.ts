import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MockProvider } from "../src/mock-provider/server";

const root = process.env.MC_494_ROOT;
if (!root || !root.includes("/magic-context/issue-494/")) throw new Error("MC_494_ROOT must be a throwaway issue-494 subdirectory");
const plugin = process.env.MC_494_PLUGIN;
if (!plugin || !realpathSync(plugin).startsWith(`${realpathSync(root)}/`)) throw new Error("Probe plugin must be built in the throwaway root");
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({ text: "Mock completion", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" });
const forbidden = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit"].map((path) => join(homedir(), path));
try {
    for (const mode of ["inline", "worker"]) {
        const runRoot = join(root, mode);
        for (const path of ["home", "config", "data", "cache", "work", "tmp"]) mkdirSync(join(runRoot, path), { recursive: true });
        const results = join(runRoot, "results.jsonl");
        writeFileSync(results, "");
        writeFileSync(join(runRoot, "config", "opencode.json"), JSON.stringify({
            plugin: [`file://${resolve(plugin)}`], autoupdate: false, compaction: { auto: false, prune: false },
            enabled_providers: ["mock"], model: "mock/model", provider: { mock: {
                npm: "@ai-sdk/anthropic", options: { baseURL, apiKey: "mock-not-real" },
                models: { model: { name: "mock", limit: { context: 200000, output: 8192 } } },
            } },
        }));
        const portReservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
        const port = portReservation.port;
        portReservation.stop(true);
        const serverURL = `http://127.0.0.1:${port}`;
        const child = spawn(process.env.MC_494_OPENCODE ?? "opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "DEBUG"], {
            cwd: join(runRoot, "work"), stdio: ["ignore", "pipe", "pipe"], env: {
                OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
                ORT_DYLIB_PATH: process.env.ORT_DYLIB_PATH,
                PATH: process.env.PATH, HOME: join(runRoot, "home"), TMPDIR: join(runRoot, "tmp"),
                XDG_CONFIG_HOME: join(runRoot, "config"), XDG_DATA_HOME: join(runRoot, "data"),
                XDG_CACHE_HOME: join(runRoot, "cache"), XDG_STATE_HOME: join(runRoot, "data", "state"),
                OPENCODE_CONFIG_DIR: join(runRoot, "config"), OPENCODE_DB: join(runRoot, "data", "opencode.db"),
                MAGIC_CONTEXT_STORAGE_DIR: join(root, "embedding-storage"),
                MAGIC_CONTEXT_LOG_PATH: join(runRoot, "plugin.log"),
                MC_494_MODE: mode, MC_494_RUNTIME: process.env.MC_494_RUNTIME ?? "wasm", MC_494_RESULTS: results,
            },
        });
        child.stdout?.on("data", (data) => appendFileSync(join(runRoot, "host.log"), data));
        child.stderr?.on("data", (data) => appendFileSync(join(runRoot, "host.log"), data));
        let stop = false;
        let poll: Promise<void> | undefined;
        const health: number[] = [];
        const proveIsolation = () => {
            const opened = execFileSync("lsof", ["-Fn", "-p", String(child.pid)], { encoding: "utf8" });
            writeFileSync(join(runRoot, "lsof.txt"), opened);
            const live = opened.split("\n").filter((line) => line.startsWith("n/") && forbidden.some((path) => line.slice(1).startsWith(`${path}/`)));
            if (live.length) throw new Error(`live-store descriptors: ${live.join(", ")}`);
            console.log(`lsof pid=${child.pid} forbidden=0 mode=${mode}`);
        };
        try {
            const deadline = Date.now() + 120000;
            for (;;) {
                if (child.exitCode !== null || Date.now() > deadline) throw new Error("host failed to start");
                try { if ((await fetch(`${serverURL}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
                await Bun.sleep(100);
            }
            proveIsolation();
            const session = await (await fetch(`${serverURL}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60000) })).json() as { id: string };
            poll = (async () => {
                while (!stop) {
                    const start = performance.now();
                    await (await fetch(`${serverURL}/health`, { signal: AbortSignal.timeout(180000) })).text();
                    health.push(performance.now() - start);
                    await Bun.sleep(50);
                }
            })();
            const response = await fetch(`${serverURL}/session/${session.id}/message`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: { providerID: "mock", modelID: "model" }, parts: [{ type: "text", text: "Run the embedding probe" }] }),
                signal: AbortSignal.timeout(300000),
            });
            if (!response.ok) throw new Error(`prompt failed ${response.status}: ${await response.text()}`);
            await response.text();
            proveIsolation();
            const rows = readFileSync(results, "utf8").trim().split("\n").map((line) => JSON.parse(line));
            if (rows.length !== 3) throw new Error("not all inference phases executed");
            console.log(JSON.stringify({ mode, healthSamples: health.length, maxHealthMs: Math.max(...health), phases: rows.map(({ vectors: _vectors, ...row }) => row) }));
        } finally {
            stop = true;
            child.kill("SIGTERM");
            const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
            await poll?.catch(() => {});
            await new Promise((resolveExit) => { if (child.exitCode !== null || child.signalCode !== null) resolveExit(undefined); else child.once("exit", resolveExit); });
            clearTimeout(killTimer);
        }
    }
    const before = readFileSync(join(root, "inline/results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const after = readFileSync(join(root, "worker/results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    let maxVectorDelta = 0;
    for (let phase = 0; phase < before.length; phase++) {
        if (before[phase].phase !== after[phase]?.phase || before[phase].vectors.length !== after[phase]?.vectors.length) throw new Error("phase/vector count mismatch");
        for (let vector = 0; vector < before[phase].vectors.length; vector++) {
            const left = before[phase].vectors[vector] as number[];
            const right = after[phase].vectors[vector] as number[];
            if (!left || !right || left.length !== 384 || right.length !== left.length) throw new Error("missing or invalid vector dimensions");
            left.forEach((value: number, dimension: number) => {
                const delta = Math.abs(value - right[dimension]);
                if (!Number.isFinite(delta)) throw new Error("non-finite vector comparison");
                maxVectorDelta = Math.max(maxVectorDelta, delta);
            });
        }
    }
    if (maxVectorDelta > 1e-6) throw new Error(`vector drift ${maxVectorDelta}`);
    console.log(`real model maxVectorDelta=${maxVectorDelta}`);
} finally { await mock.stop(); }
