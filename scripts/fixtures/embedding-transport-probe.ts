import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { EmbeddingWorkerClient, type EmbeddingWorkerReply } from "../../packages/plugin/src/features/magic-context/memory/embedding-worker-client";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const entry = new URL("./embedding-worker.fixture.js", import.meta.url);
const realEntry = new URL("./embedding-worker.js", import.meta.url);
const [action, mode, model] = process.argv.slice(2);

function live(pid: number): boolean {
    try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
        }
        return true;
    } catch { return false; }
}

async function waitDead(pid: number): Promise<number> {
    const start = performance.now();
    while (live(pid) && performance.now() - start < 5000) await pause(20);
    if (live(pid)) throw new Error(`orphan model subprocess survives: ${pid}`);
    return performance.now() - start;
}

if (action === "bench") {
    if (!model) throw new Error("model path required");
    const data = { magicContextEmbeddingWorker: true, model, dtype: "fp32", maxInputTokens: 512,
        runtimePreference: "native", modelCacheDir: process.env.XDG_CACHE_HOME, harness: "opencode" };
    let worker: Worker | undefined;
    let client: EmbeddingWorkerClient | undefined;
    let nextId = 1;
    const coldStart = performance.now();
    if (mode === "old") worker = new Worker(realEntry, { workerData: data });
    else client = new EmbeddingWorkerClient(data, realEntry);
    async function request(texts: string[]): Promise<EmbeddingWorkerReply> {
        if (client) return client.request(texts);
        return new Promise((resolve, reject) => {
            const onMessage = (reply: EmbeddingWorkerReply) => { worker!.off("error", onError); resolve(reply); };
            const onError = (error: Error) => { worker!.off("message", onMessage); reject(error); };
            worker!.once("message", onMessage);
            worker!.once("error", onError);
            worker!.postMessage({ id: nextId++, texts });
        });
    }
    const templates = [
        "Memory: The API service uses PostgreSQL transactions for atomic writes. Keep schema migrations backward compatible and run the integration tests before deploying.",
        "Message: Investigate why the background indexing job retries after cancellation. Check the abort signal, pending request cleanup, and the worker's exit handler.",
        "Memory: The user prefers focused diffs and explicit verification commands. Preserve existing configuration defaults and document any behavior change in the release notes.",
        "Message: Add a regression test for the search result ranking when two files share a symbol name. Include a fixture with distinct paths and stable scores.",
    ];
    function texts(batch: number) { return [templates[batch % templates.length] + ` Batch ${batch}.`, templates[(batch + 1) % templates.length] + ` Record ${batch}.`]; }
    const first = await request(texts(0));
    const coldMs = performance.now() - coldStart;
    if (first.vectors?.length !== 2 || first.vectors.some((v) => v?.length !== 384)) throw new Error("expected two real 384-dimensional embeddings");
    for (let i = 0; i < 5; i++) await request(texts(i));
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
        const start = performance.now();
        const result = await request(texts(i));
        if (!result.loaded || result.vectors?.length !== 2) throw new Error("inference failed");
        samples.push(performance.now() - start);
    }
    function rss(pid: number) { return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1]); }
    const childPid = (client as unknown as { worker?: { pid?: number } })?.worker?.pid;
    const parentKiB = rss(process.pid);
    const childKiB = childPid ? rss(childPid) : 0;
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(JSON.stringify({ action, runtime: process.versions.bun ? "bun" : "node", mode, batches: samples.length, textsPerBatch: 2,
        coldMs, p50Ms: sorted[Math.ceil(sorted.length * .50) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
        rss: { parentKiB, childKiB, totalKiB: parentKiB + childKiB }, samplesMs: samples }));
    await client?.dispose();
    await worker?.terminate();
} else if (action === "host") {
    const client = new EmbeddingWorkerClient(model ? {
        magicContextEmbeddingWorker: true, model, dtype: "fp32", maxInputTokens: 512,
        runtimePreference: "native", modelCacheDir: process.env.XDG_CACHE_HOME, harness: "opencode",
    } : {}, model ? realEntry : entry, undefined, async () => false);
    let childPid: number | undefined;
    if (model) {
        const loaded = await client.request(["A memory record describing safe worker shutdown and cancellation."]);
        if (loaded.vectors?.[0]?.length !== 384) throw new Error("real host inference failed");
        childPid = (client as unknown as { worker?: { pid?: number } }).worker?.pid;
    } else childPid = (await client.request(["pid"])).vectors?.[0]?.[0];
    if (!childPid) throw new Error("child PID unavailable");
    console.log(JSON.stringify({ hostPid: process.pid, childPid, nativeModel: Boolean(model) }));
    if (mode === "idle") { /* Let the host exit without disposing the model owner. */ }
    else if (mode === "exit") process.exit(0);
    else setInterval(() => {}, 1000);
} else if (action === "lifecycle") {
    let checks = 0;
    for (const death of ["crash", "SIGKILL"] as const) {
        const client = new EmbeddingWorkerClient({}, entry, undefined, async () => false);
        try {
            const childPid = (await client.request(["pid"])).vectors?.[0]?.[0]!;
            const pending = [client.request(["hang-a"]), client.request([death === "crash" ? "crash" : "hang-b"])];
            if (death === "SIGKILL") process.kill(childPid, "SIGKILL");
            const results = await Promise.allSettled(pending);
            if (results.some((r) => r.status !== "rejected")) throw new Error("in-flight request was not rejected");
            const recovered = await client.request(["recovered"]);
            if (recovered.vectors?.[0]?.[0] !== 9) throw new Error("restart failed");
            console.log(JSON.stringify({ check: "subprocess-death", death, rejected: results.map((r) => r.status === "rejected" ? String(r.reason) : "fulfilled"), recovered: true }));
            checks++;
        } finally { await client.dispose(); }
    }
    for (const death of ["idle", "exit", "SIGKILL"] as const) {
        const host = spawn(process.execPath, [new URL(import.meta.url).pathname, "host", death, ...(model ? [model] : [])], {
            env: process.env, stdio: ["ignore", "pipe", "inherit"],
            windowsHide: true,
        });
        const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
        const ready = await new Promise<{ hostPid: number; childPid: number }>((resolve, reject) => {
            let buffer = "";
            host.stdout!.on("data", (chunk) => {
                buffer += chunk;
                const newline = buffer.indexOf("\n");
                if (newline !== -1) {
                    try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
                }
            });
            host.once("error", reject);
        });
        if (death === "SIGKILL") host.kill("SIGKILL");
        await exited;
        try {
            const exitMs = await waitDead(ready.childPid);
            console.log(JSON.stringify({ check: "host-death", death, ...ready, orphan: false, childExitMs: exitMs }));
            checks++;
        } catch (error) {
            process.kill(ready.childPid, "SIGKILL");
            throw new Error(`host-death ${death} (${process.versions.bun ? "bun" : "node"}): ${String(error)}`);
        }
    }
    console.log(JSON.stringify({ action, runtime: process.versions.bun ? "bun" : "node", checks, passed: true }));
} else throw new Error("unknown probe action");
