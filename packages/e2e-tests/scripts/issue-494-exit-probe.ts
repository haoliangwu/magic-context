// Load and use a real model, then exit with an idle or explicitly terminated worker.
// A nonzero exit detects native-addon cleanup crashes; use throwaway storage on Bun 1.3.x.
import { getLocalEmbeddingNativeMemoryStats, LocalEmbeddingProvider } from "../../plugin/src/features/magic-context/memory/embedding-local";

const storage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
if (!storage?.includes("/magic-context/issue-494/")) throw new Error("isolated storage required");
const runtime = process.env.MC_494_RUNTIME === "native" ? "native" : "wasm";
const provider = new LocalEmbeddingProvider(undefined, 512, "fp32", runtime);
if (!(await provider.initialize())) throw new Error(JSON.stringify(provider.getLastFailureReason()));
const vector = await provider.embed("Clean worker process exit probe");
if (!vector || vector.length !== 384) throw new Error("missing real model vector");
const actualRuntimes = getLocalEmbeddingNativeMemoryStats().runtimes;
if (process.env.MC_494_DISPOSE === "1") await provider.dispose();
console.log(JSON.stringify({ runtime, actualRuntimes, bun: process.versions.bun, dispose: process.env.MC_494_DISPOSE === "1", dimensions: vector.length }));
