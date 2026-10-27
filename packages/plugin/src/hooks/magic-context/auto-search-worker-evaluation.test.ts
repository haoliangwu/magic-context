import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { AutoSearchWorkerInput, AutoSearchWorkerReply } from "./auto-search-worker-client";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) cleanupTestTempDir(directory);
});

/** One archived message and one compartment chunk whose lane needs a query vector. */
function seedSearchDatabase(): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), "auto-search-evaluation-"));
    directories.push(directory);
    const path = join(directory, "context.db");
    const db = new Database(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
        db.prepare(
            "INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES ('session',4,'archived','assistant','historian cache wiring is archived separately')",
        ).run();
        const id = Number(
            db
                .prepare(`INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at)
                VALUES ('session',0,1,2,'u1','a2','Unrelated deployment notes','stored','stored',1)`)
                .run().lastInsertRowid,
        );
        const vector = new Float32Array([0.4, Math.sqrt(1 - 0.4 * 0.4)]);
        db.prepare(`INSERT INTO compartment_chunk_embeddings
            (compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,harness,created_at)
            VALUES (?,'session','/synthetic',0,1,2,'hash','model',2,?,'opencode',1)`).run(
            id,
            new Uint8Array(vector.buffer),
        );
    } finally {
        db.close();
    }
    return path;
}

test("auto-search worker finishes module evaluation before it needs its first embedding reply", async () => {
    // Bun 1.3.14 delivers no parent message to a worker until the worker's
    // entry module has finished evaluating. A first job awaited at module top
    // level then waits forever for its query embedding. The fixture entry
    // reports when the real worker module has settled, and this parent holds
    // every embedding reply until then, so the same hang shows up on any runtime.
    const input: AutoSearchWorkerInput = {
        job: "search",
        persistent: true,
        path: seedSearchDatabase(),
        harness: "opencode",
        sessionId: "session",
        projectPath: "/synthetic",
        query: "historian cache wiring",
        options: {
            sources: ["message"],
            memoryEnabled: false,
            countRetrievals: false,
            measurementDisabled: true,
            chunkModelIdOverride: "model",
            autoHint: true,
            backfillMemoryEmbeddings: false,
        },
        embeddingRuntimeEnabled: true,
        embeddingHostBusy: false,
        snapshot: null,
    };
    const worker = new Worker(
        new URL("./auto-search-worker-evaluation.fixture.ts", import.meta.url),
        { workerData: input },
    );
    try {
        let evaluated = false;
        let queries = 0;
        const held: number[] = [];
        const answer = (id: number) => {
            queries++;
            worker.postMessage({ id, result: new Float32Array([1, 0]), embeddingHostBusy: false });
        };
        const outcome = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve("no result"), 5_000);
            worker.on("error", (error) => {
                clearTimeout(timer);
                resolve(`worker error: ${error.message}`);
            });
            worker.on("message", (message: AutoSearchWorkerReply | { kind: "evaluated" }) => {
                if (message.kind === "evaluated") {
                    evaluated = true;
                    for (const id of held.splice(0)) answer(id);
                } else if (message.kind === "query") {
                    if (evaluated) answer(message.id);
                    else held.push(message.id);
                } else if (message.kind === "result") {
                    clearTimeout(timer);
                    resolve(`result: ${message.results.map((result) => result.source).join(",")}`);
                } else if (message.kind === "error") {
                    clearTimeout(timer);
                    resolve(`error reply: ${message.error}`);
                }
            });
        });
        // The compartment hit can only come from the answered query vector.
        expect({ outcome, evaluated, answered: queries > 0 }).toEqual({
            outcome: "result: message,compartment",
            evaluated: true,
            answered: true,
        });
    } finally {
        await worker.terminate();
    }
});
