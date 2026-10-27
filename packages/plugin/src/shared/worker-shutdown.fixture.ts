// Worker for worker-shutdown.test.ts. "cooperative" closes its connection
// when asked; "deaf" never reads parent messages, so only terminate() stops it.
// "finish" installs the close listener, finishes its work and closes its own
// port through the helper's `closePort()`; the thread must then exit by itself.
import { parentPort, workerData } from "node:worker_threads";
import { Database } from "./sqlite";
import { exitOnWorkerClose } from "./worker-shutdown";

const { path, mode } = workerData as {
    path: string;
    mode: "cooperative" | "deaf" | "finish";
};
const db = new Database(path);
db.prepare("SELECT 1").get();
if (mode === "finish") {
    const { closePort } = exitOnWorkerClose(parentPort, () => db.close());
    db.close();
    parentPort?.postMessage("ready");
    closePort();
} else {
    if (mode === "cooperative") exitOnWorkerClose(parentPort, () => db.close());
    // Keep the thread alive until it is asked to close or is terminated.
    setInterval(() => {}, 1_000);
    parentPort?.postMessage("ready");
}
