import { parentPort, workerData } from "node:worker_threads";
import type { Database as DatabaseHandle } from "../../shared/sqlite";
import type {
    AutoSearchEmbeddingReply,
    AutoSearchWorkerInput,
    AutoSearchWorkerReply,
} from "./auto-search-worker-client";

const port = parentPort;
if (!port) throw new Error("auto-search worker requires a parent port");
const input = workerData as AutoSearchWorkerInput;
// Tell a message-search caller the worker is running before loading the search
// modules: the caller's first deadline only has to cover thread start, and a
// worker that never gets this far is replaced by the in-process search.
if (input.job === "messages") {
    port.postMessage({ kind: "accepted" } satisfies AutoSearchWorkerReply);
}
const [
    { ensureMemoryEmbeddings },
    { getProjectEmbeddings },
    { getMemoriesByProject },
    { installProjectEmbeddingSearchBridge },
    { searchMessageHistory, unifiedSearch },
    { setEmbeddingSessionBusy },
    { getHarness, setHarness },
    { Database, registerSqliteDiagnosticSink },
    { log },
] = await Promise.all([
    import("../../features/magic-context/memory/embedding-backfill"),
    import("../../features/magic-context/memory/embedding-cache"),
    import("../../features/magic-context/memory/storage-memory"),
    import("../../features/magic-context/project-embedding-registry"),
    import("../../features/magic-context/search"),
    import("../../shared/embedding-activity"),
    import("../../shared/harness"),
    import("../../shared/sqlite"),
    import("../../shared/logger"),
]);
// Workers have their own module globals; session rows must retain their owner's
// harness identity, and Pi/OMP must never inherit OpenCode-store ownership.
setHarness(input.harness);
registerSqliteDiagnosticSink(log, getHarness);
setEmbeddingSessionBusy(input.sessionId, input.embeddingHostBusy === true);
let nextId = 0;
const pending = new Map<number, (reply: AutoSearchEmbeddingReply) => void>();
let queryDimensions: number | null = null;
let db: DatabaseHandle;
port.on("message", (reply: AutoSearchEmbeddingReply) => {
    // Backfill's busy-host gate is owner state, not this worker's empty activity
    // tracker. Refresh it when an embedding continuation is about to resume SQL.
    if (reply.embeddingHostBusy !== undefined)
        setEmbeddingSessionBusy(input.sessionId, reply.embeddingHostBusy);
    const vector = reply.result instanceof Float32Array ? reply.result : reply.result?.vector;
    if (vector) queryDimensions = vector.length;
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
});
function request(
    message:
        | Omit<Extract<AutoSearchWorkerReply, { kind: "query" }>, "id">
        | Omit<Extract<AutoSearchWorkerReply, { kind: "batch" }>, "id">,
): Promise<AutoSearchEmbeddingReply> {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error)) : resolve(reply)));
        port?.postMessage({ ...message, id });
    });
}
if (input.snapshot) {
    installProjectEmbeddingSearchBridge(input.snapshot, {
        modelId: input.snapshot.modelId,
        initialize: async () => true,
        isLoaded: () => true,
        dispose: async () => {},
        embed: async (text) => {
            const result = (await request({ kind: "query", text })).result;
            return result instanceof Float32Array ? result : (result?.vector ?? null);
        },
        embedBatch: async (texts, _signal, purpose = "passage") => {
            const passage = (await request({ kind: "batch", texts, purpose })).passage;
            const captured = input.snapshot;
            if (
                !passage ||
                !captured ||
                passage.generation !== captured.generation ||
                passage.modelId !== captured.modelId ||
                passage.providerIdentity !== captured.providerIdentity ||
                passage.runtimeFingerprint !== captured.runtimeFingerprint ||
                !queryDimensions ||
                passage.dimensions !== queryDimensions ||
                passage.vectors.length !== texts.length
            )
                return texts.map(() => null);
            return passage.vectors.map((vector) =>
                vector && vector.length === queryDimensions && vector.every(Number.isFinite)
                    ? vector
                    : null,
            );
        },
    });
}
// Search is enforced read-only by SQLite, not just by a caller convention.
// Only the separate post-decision backfill job may open a writable connection.
db = new Database(input.path, input.job === "backfill" ? undefined : { readonly: true });
db.exec("PRAGMA busy_timeout = 250");
try {
    if (input.job === "backfill") {
        if (input.snapshot?.enabled && input.snapshot.features.memoryEnabled) {
            // Capture query dimensions before the passage RPC so incompatible batches
            // can never be stored under the captured model's namespace.
            await request({ kind: "query", text: input.query });
            if (queryDimensions) {
                const existingEmbeddings = getProjectEmbeddings(
                    db,
                    input.projectPath,
                    input.snapshot.modelId,
                );
                const memories = getMemoriesByProject(db, input.projectPath)
                    .filter((memory) => !existingEmbeddings.has(memory.id))
                    .slice(0, 50);
                await ensureMemoryEmbeddings({
                    db,
                    projectIdentity: input.projectPath,
                    memories,
                    existingEmbeddings,
                });
            }
        }
        port.postMessage({ kind: "result", results: [] } satisfies AutoSearchWorkerReply);
    } else if (input.job === "messages") {
        if (!input.messageRequest) throw new Error("message search job carries no request");
        const outcome = searchMessageHistory(db, input.messageRequest);
        port.postMessage({ kind: "messages", outcome } satisfies AutoSearchWorkerReply);
    } else {
        const results = await unifiedSearch(db, input.sessionId, input.projectPath, input.query, {
            ...input.options,
            backfillMemoryEmbeddings: false,
            countRetrievals: false,
            measurementDisabled: true,
            embedQuery: async (text) => (await request({ kind: "query", text })).result ?? null,
            isEmbeddingRuntimeEnabled: () => input.embeddingRuntimeEnabled,
        });
        port.postMessage({ kind: "result", results } satisfies AutoSearchWorkerReply);
    }
} catch (error) {
    port.postMessage({
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
    } satisfies AutoSearchWorkerReply);
} finally {
    db.close();
    port.close();
}
