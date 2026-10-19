import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const nativeEnv = workerData.probeAddon
    ? createRequire(import.meta.url)(workerData.probeAddon).readNativeEnv()
    : undefined;

parentPort?.on("message", (request: { id: number; texts?: string[] }) => {
    if (request.texts?.[0] === "crash") process.exit(7);
    if (request.texts?.[0]?.startsWith("hang")) return;
    const start = performance.now();
    while (request.texts && performance.now() - start < 350) {
        // A synchronous CPU-bound batch makes accidental host-thread execution observable.
    }
    const vectors = request.texts?.map((text) =>
        text === "pid"
            ? new Float32Array([process.pid])
            : text === "native-env"
              ? new Float32Array([nativeEnv === "1" ? 1 : 0])
              : text === "special-floats"
                ? new Float32Array([-0, NaN, Infinity, -Infinity])
                : new Float32Array([text.length, 0.125, -0.25]),
    );
    parentPort?.postMessage(
        { id: request.id, loaded: true, vectors },
        vectors?.map((vector) => vector.buffer as ArrayBuffer) ?? [],
    );
});
