import { Worker } from "node:worker_threads";
import { log } from "../../../shared/logger";
import type { EmbeddingFailure } from "./embedding-failure";
import type { LocalEmbeddingNativeMemoryStats } from "./embedding-local";

export type EmbeddingWorkerReply = {
    id: number;
    loaded: boolean;
    vectors?: (Float32Array | null)[];
    failure?: EmbeddingFailure | null;
    error?: string;
    stats?: LocalEmbeddingNativeMemoryStats;
};

/** One model owner; a dead or unresponsive worker rejects every outstanding request. */
export class EmbeddingWorkerClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly pending = new Map<
        number,
        {
            resolve: (reply: EmbeddingWorkerReply) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private disposed = false;

    constructor(
        private readonly data: Record<string, unknown>,
        private readonly entry = new URL(
            new URL(import.meta.url).pathname.endsWith(".ts")
                ? "./embedding-worker.ts"
                : "./embedding-worker.js",
            import.meta.url,
        ),
        private readonly timeoutMs = 5 * 60_000,
    ) {}

    private start(): Worker {
        if (this.disposed) throw new Error("embedding worker disposed");
        if (this.worker) return this.worker;
        const worker = new Worker(this.entry, { workerData: this.data });
        this.worker = worker;
        worker.unref();
        worker.on("message", (reply: EmbeddingWorkerReply) => {
            if (this.worker !== worker) return;
            const request = this.pending.get(reply.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(reply.id);
            if (reply.error) request.reject(new Error(reply.error));
            else request.resolve(reply);
            if (this.pending.size === 0) worker.unref();
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.worker = null;
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(error);
            }
            this.pending.clear();
            log("[magic-context] embedding worker exited unexpectedly:", error);
            void worker.terminate();
        };
        worker.on("error", fail);
        worker.on("exit", (code) => fail(new Error(`embedding worker exited (${code})`)));
        return worker;
    }

    isRunning(): boolean {
        return this.worker !== null;
    }

    request(texts?: string[], signal?: AbortSignal): Promise<EmbeddingWorkerReply> {
        if (signal?.aborted) return Promise.reject(new Error("embedding request aborted"));
        return new Promise((resolve, reject) => {
            const worker = this.start();
            const id = this.nextId++;
            // Loading may download a model; inference must still have a finite deadline.
            const timer = setTimeout(() => {
                void this.stop(new Error("embedding worker request timed out"));
            }, this.timeoutMs);
            const abort = () => {
                clearTimeout(timer);
                this.pending.delete(id);
                signal?.removeEventListener("abort", abort);
                reject(new Error("embedding request aborted"));
                if (this.pending.size === 0) worker.unref();
            };
            signal?.addEventListener("abort", abort, { once: true });
            const cleanup = () => signal?.removeEventListener("abort", abort);
            this.pending.set(id, {
                timer,
                resolve: (reply) => {
                    cleanup();
                    resolve(reply);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            });
            worker.ref();
            try {
                worker.postMessage({ id, texts });
            } catch (error) {
                void this.stop(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private async stop(error: Error): Promise<void> {
        const worker = this.worker;
        this.worker = null;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        await worker?.terminate();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop(new Error("embedding worker disposed"));
    }
}
