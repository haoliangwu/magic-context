import { type ChildProcess, fork } from "node:child_process";
import { Worker } from "node:worker_threads";
import { log } from "../../../shared/logger";
import { inRootAsyncContext } from "../../../shared/sqlite";
import type { EmbeddingFailure } from "./embedding-failure";
import type { LocalEmbeddingNativeMemoryStats } from "./embedding-local";
import { prepareNativeOnnxTelemetry } from "./onnx-telemetry";

export type EmbeddingWorkerReply = {
    id: number;
    loaded: boolean;
    vectors?: (Float32Array | null)[];
    failure?: EmbeddingFailure | null;
    error?: string;
    stats?: LocalEmbeddingNativeMemoryStats;
};

// JSON IPC works in both Node and Bun; base64 preserves all float32 bits, including NaN and -0.
export type EmbeddingWorkerWireReply = Omit<EmbeddingWorkerReply, "vectors"> & {
    vectors?: (string | null)[];
};

let warnedWindowsTelemetry = false;

/** One model owner; a dead or unresponsive worker rejects every outstanding request. */
export class EmbeddingWorkerClient {
    private worker: ChildProcess | Worker | null = null;
    private startPromise: Promise<ChildProcess | Worker> | null = null;
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
        private readonly prepareTelemetry = prepareNativeOnnxTelemetry,
    ) {}

    private start(): Promise<ChildProcess | Worker> {
        if (this.startPromise) return this.startPromise;
        this.startPromise = inRootAsyncContext(() => this.startOwner()).finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private async startOwner(): Promise<ChildProcess | Worker> {
        if (this.disposed) throw new Error("embedding worker disposed");
        if (this.worker) return this.worker;
        // Compiled Bun 1.4.2 disk-worker probes fail on external sharp imports; the Bun-CLI child loads them.
        // Ordinary Bun and main-thread Node can set ORT_DISABLE_TELEMETRY in native memory first.
        const compiledBun =
            process.versions.bun &&
            (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
                ?.isStandaloneExecutable;
        const inProcess = !compiledBun && (await this.prepareTelemetry());
        if (this.disposed) throw new Error("embedding worker disposed");
        const worker = inProcess
            ? new Worker(this.entry, { workerData: this.data })
            : fork(
                  new URL(
                      new URL(import.meta.url).pathname.endsWith(".ts")
                          ? "./embedding-worker-process.ts"
                          : "./embedding-worker-process.js",
                      import.meta.url,
                  ),
                  [],
                  {
                      env: {
                          ...process.env,
                          ORT_DISABLE_TELEMETRY: "1",
                          // Set BUN_BE_BUN so a compiled Bun executable runs the worker script, not the host app.
                          ...(process.versions.bun ? { BUN_BE_BUN: "1" } : {}),
                      },
                      execArgv: [],
                      serialization: "json",
                      ...{ windowsHide: true },
                      stdio: ["ignore", "inherit", "inherit", "ipc"],
                  },
              );
        if (process.platform === "win32" && this.data.runtimePreference !== "wasm") {
            // Windows uses Event Tracing for Windows (ETW); this environment opt-out only applies to POSIX uploads.
            if (!warnedWindowsTelemetry) {
                warnedWindowsTelemetry = true;
                const warning =
                    "[magic-context] ORT_DISABLE_TELEMETRY=1 prevents ONNX uploads on POSIX. Windows native ONNX uses OS-controlled ETW diagnostics instead and exposes no JavaScript telemetry-disable API; Windows diagnostic settings and trace collectors govern collection.";
                log(warning);
            }
        }
        this.worker = worker;
        worker.unref();
        if (!(worker instanceof Worker)) worker.channel?.unref?.();
        worker.on("message", (wire: EmbeddingWorkerWireReply | EmbeddingWorkerReply) => {
            const reply: EmbeddingWorkerReply =
                worker instanceof Worker
                    ? (wire as EmbeddingWorkerReply)
                    : {
                          ...wire,
                          vectors: (wire as EmbeddingWorkerWireReply).vectors?.map((vector) =>
                              vector === null
                                  ? null
                                  : new Float32Array(
                                        Uint8Array.from(Buffer.from(vector, "base64")).buffer,
                                    ),
                          ),
                      };
            if (this.worker !== worker) return;
            const request = this.pending.get(reply.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(reply.id);
            if (reply.error) request.reject(new Error(reply.error));
            else request.resolve(reply);
            if (this.pending.size === 0) {
                worker.unref();
                if (!(worker instanceof Worker)) worker.channel?.unref?.();
            }
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
            if (worker instanceof Worker) void worker.terminate();
            else worker.kill();
        };
        worker.on("error", fail);
        worker.on("exit", (code, signal) =>
            fail(new Error(`embedding worker exited (${signal ?? code})`)),
        );
        if (!(worker instanceof Worker)) worker.send({ entry: this.entry.href, data: this.data });
        return worker;
    }

    isRunning(): boolean {
        return this.worker !== null;
    }

    async request(texts?: string[], signal?: AbortSignal): Promise<EmbeddingWorkerReply> {
        if (signal?.aborted) return Promise.reject(new Error("embedding request aborted"));
        const worker = await this.start();
        if (this.disposed) throw new Error("embedding worker disposed");
        if (signal?.aborted) throw new Error("embedding request aborted");
        return new Promise((resolve, reject) => {
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
                if (this.pending.size === 0) {
                    worker.unref();
                    if (!(worker instanceof Worker)) worker.channel?.unref?.();
                }
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
            if (!(worker instanceof Worker)) worker.channel?.ref?.();
            try {
                if (worker instanceof Worker) worker.postMessage({ id, texts });
                else
                    worker.send({ id, texts }, (error) => {
                        if (error && this.worker === worker) void this.stop(error);
                    });
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
        if (worker instanceof Worker) {
            await worker.terminate();
        } else if (worker && worker.exitCode === null && worker.signalCode === null) {
            worker.ref();
            worker.channel?.ref?.();
            await new Promise<void>((resolve) => {
                worker.once("exit", () => resolve());
                worker.kill();
            });
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.startPromise?.catch(() => {});
        await this.stop(new Error("embedding worker disposed"));
    }
}
