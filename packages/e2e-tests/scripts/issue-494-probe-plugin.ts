// Diagnostic-only OpenCode plugin: measure whether local inference delays server-thread timers.
import { appendFileSync } from "node:fs";
import {
    __setLocalEmbeddingTestHooks,
    LocalEmbeddingProvider,
} from "../../plugin/src/features/magic-context/memory/embedding-local";

export default async function probePlugin() {
    const mode = process.env.MC_494_MODE ?? "worker";
    const runtime = process.env.MC_494_RUNTIME === "native" ? "native" : "wasm";
    if (mode === "inline") {
        __setLocalEmbeddingTestHooks({ host: () => ({
            isElectron: false, isBun: true, bunVersion: process.versions.bun, hasNodeFilesystem: true,
        }) });
    }
    const provider = new LocalEmbeddingProvider(undefined, 512, "fp32", runtime);
    let ran = false;
    return {
        "chat.message": async () => {
            if (ran) return;
            ran = true;
            const loaded = await provider.initialize();
            if (!loaded) throw new Error(JSON.stringify(provider.getLastFailureReason()));
            const text = "Archived discussion about reliable local memory retrieval and project indexing. ".repeat(30);
            for (const [phase, count] of [["auto-search", 1], ["proactive-memory", 10], ["backfill", 32]] as const) {
                const lags: number[] = [];
                let last = performance.now();
                const timer = setInterval(() => {
                    const now = performance.now();
                    lags.push(Math.max(0, now - last - 50));
                    last = now;
                }, 50);
                const start = performance.now();
                const vectors = await provider.embedBatch(Array.from({ length: count }, (_, index) => `${index} ${text}`));
                const elapsedMs = performance.now() - start;
                // Wait one interval so a callback blocked by inline inference records its full delay.
                await new Promise((resolve) => setTimeout(resolve, 60));
                clearInterval(timer);
                lags.sort((a, b) => a - b);
                appendFileSync(process.env.MC_494_RESULTS!, `${JSON.stringify({
                    mode, runtime, phase, count, bun: process.versions.bun, elapsedMs,
                    samples: lags.length, p99LagMs: lags[Math.ceil(lags.length * 0.99) - 1],
                    maxLagMs: Math.max(...lags), vectors: vectors.map((vector) => vector ? Array.from(vector) : null),
                })}\n`);
                if (vectors.some((vector) => !vector)) throw new Error("missing embedding vectors");
            }
            await provider.dispose();
        },
    };
}
