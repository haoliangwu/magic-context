import { parentPort } from "node:worker_threads";

// Accepts a message-search job like the real worker, then never answers. Exit
// eventually so a test cannot leave an orphan worker behind.
parentPort?.postMessage({ kind: "accepted" });
setTimeout(() => process.exit(0), 5000);
