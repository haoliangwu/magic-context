import { parentPort, workerData } from "node:worker_threads";
import { setHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import { setStoragePrivatePermissionEnforcement } from "../../../shared/storage-permissions";
import {
    getLocalEmbeddingNativeMemoryStats,
    LocalEmbeddingProvider,
    resolveLocalEmbeddingWorkerRuntime,
} from "./embedding-local";

setHarness(workerData.harness);
setStoragePrivatePermissionEnforcement(workerData.enforcePrivateStoragePermissions !== false);

// On Bun before 1.4, shutting down native ONNX in a worker can panic the entire process.
// Use WASM to avoid that native-addon cleanup even if the user requested native.
const unsafeNative =
    workerData.runtimePreference === "native" &&
    resolveLocalEmbeddingWorkerRuntime("native") === "wasm";
if (unsafeNative)
    log(
        "[magic-context] native embedding worker teardown is unsafe on this Bun version; using WASM. Upgrade the host to Bun >=1.4.0 for native inference.",
    );
const provider = new LocalEmbeddingProvider(
    workerData.model,
    workerData.maxInputTokens,
    workerData.dtype,
    unsafeNative ? "wasm" : workerData.runtimePreference,
);
// Handle requests one at a time: Transformers pipelines and output buffers cannot safely run concurrently.
let queue = Promise.resolve();
parentPort?.on("message", (request: { id: number; texts?: string[] }) => {
    queue = queue.then(async () => {
        try {
            const loaded = await provider.initialize();
            let vectors: (Float32Array | null)[] | undefined;
            if (loaded && request.texts) {
                vectors = [];
                // Process at most two texts per inference batch to bound temporary model allocations.
                for (let offset = 0; offset < request.texts.length; offset += 2) {
                    vectors.push(
                        ...(await provider.embedBatch(request.texts.slice(offset, offset + 2))),
                    );
                }
            }
            parentPort?.postMessage(
                {
                    id: request.id,
                    loaded,
                    vectors,
                    failure: provider.getLastFailureReason(),
                    stats: getLocalEmbeddingNativeMemoryStats(),
                },
                vectors?.flatMap((vector) => (vector ? [vector.buffer as ArrayBuffer] : [])) ?? [],
            );
        } catch (error) {
            parentPort?.postMessage({ id: request.id, loaded: false, error: String(error) });
        }
    });
});
