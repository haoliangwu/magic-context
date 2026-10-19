import { Worker } from "node:worker_threads";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingWorkerClient } from "../../packages/plugin/src/features/magic-context/memory/embedding-worker-client";
import { prepareNativeOnnxTelemetry } from "../../packages/plugin/src/features/magic-context/memory/onnx-telemetry";
import { LocalEmbeddingProvider, __setLocalEmbeddingTestHooks } from "../../packages/plugin/src/features/magic-context/memory/embedding-local";

const model = process.env.ORT_PROBE_MODEL ?? process.argv[2];
const mode = process.env.ORT_PROBE_MODE ?? process.argv[3];
if (!model) throw new Error("a throwaway local model path is required");

function checkpoint(phase: string): void {
    const root = process.env.ORT_PROBE_SCAN_ROOT;
    if (!root) return;
    const paths: string[] = [];
    function visit(directory: string): void {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.name === "deviceid" && directory.endsWith(".onnxruntime")) paths.push(path);
        }
    }
    visit(root);
    console.log("DEVICE_ID_CHECKPOINT", JSON.stringify({ phase, count: paths.length, paths }));
}
if (mode === "main-env" && !(await prepareNativeOnnxTelemetry())) throw new Error("native main-thread opt-out unavailable");
if (mode === "baseline" || mode === "main-env") {
    // Start an embedding worker directly; Transformers writes process.env only inside that thread.
    const worker = new Worker(new URL("./embedding-worker.js", import.meta.url), {
        workerData: {
            magicContextEmbeddingWorker: true,
            model,
            maxInputTokens: 512,
            dtype: "fp32",
            runtimePreference: "native",
            modelCacheDir: process.env.XDG_CACHE_HOME,
            harness: "opencode",
        },
    });
    const reply = await new Promise<{ loaded: boolean; vectors?: Float32Array[]; failure?: unknown }>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.postMessage({ id: 1, texts: ["hello world"] });
    });
    console.log("LOAD", JSON.stringify(reply));
    if (!reply.loaded || reply.vectors?.[0]?.[0] !== 1) process.exitCode = 1;
    checkpoint("after-load");
    // Wait for the SDK's batched initialization upload to reach the egress blocker.
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.ORT_PROBE_WAIT_MS ?? 3000)));
    checkpoint("after-wait");
    await worker.terminate();
} else {
    __setLocalEmbeddingTestHooks({ modelCacheDir: () => process.env.XDG_CACHE_HOME!, workerFactory: (data) => new EmbeddingWorkerClient(data) });
    const provider = new LocalEmbeddingProvider(model, 512, "fp32", "native");
    try {
        const vector = await provider.embed("hello world");
        console.log("LOAD", JSON.stringify({ loaded: provider.isLoaded(), vector: vector && Array.from(vector), failure: provider.getLastFailureReason() }));
        if (!provider.isLoaded() || vector?.[0] !== 1) process.exitCode = 1;
        checkpoint("after-load");
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.ORT_PROBE_WAIT_MS ?? 3000)));
        checkpoint("after-wait");
    } finally {
        await provider.dispose();
    }
}
