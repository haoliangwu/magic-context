/**
 * Test worker for raw-ordinal-warmup.test.ts: reports that it runs, then never
 * answers, so the caller's shutdown path has a live worker to stop.
 */
import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ kind: "accepted" });
setInterval(() => {}, 1_000);
