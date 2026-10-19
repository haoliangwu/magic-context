import { Worker } from "node:worker_threads";
import { log } from "../../../shared/logger";
import type { EmbeddingWorkerReply, EmbeddingWorkerWireReply } from "./embedding-worker-client";

// This process starts with ORT_DISABLE_TELEMETRY in its native environment. Keep the
// model ownership and request serialization in the embedding worker thread, without loading ORT here.
let worker: Worker | undefined;
process.on(
    "message",
    (message: {
        entry?: string;
        data?: Record<string, unknown>;
        id?: number;
        texts?: string[];
    }) => {
        if (message.entry && !worker) {
            const entry = new URL(message.entry);
            worker = inRootAsyncContext(() => new Worker(entry, { workerData: message.data }));
            worker.on("message", (reply: EmbeddingWorkerReply) => {
                const wire: EmbeddingWorkerWireReply = {
                    ...reply,
                    vectors: reply.vectors?.map((vector) =>
                        vector === null
                            ? null
                            : Buffer.from(
                                  vector.buffer,
                                  vector.byteOffset,
                                  vector.byteLength,
                              ).toString("base64"),
                    ),
                };
                if (process.connected) process.send?.(wire);
            });
            worker.on("error", (error) => {
                log("[magic-context] embedding worker failed:", error);
                process.exit(1);
            });
            worker.on("exit", (code) => process.exit(code));
        } else {
            worker?.postMessage(message);
        }
    },
);

// A disconnected host must not leave a model process or a native uploader behind.
process.on("disconnect", () => process.exit(0));

import { inRootAsyncContext } from "../../../shared/sqlite";
