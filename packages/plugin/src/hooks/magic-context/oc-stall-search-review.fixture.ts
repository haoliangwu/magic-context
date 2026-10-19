import { parentPort, workerData } from "node:worker_threads";

// Exercise the client's failure protocol without any database or host access.
if (workerData.messageRequest.query === "review-error") {
    parentPort?.postMessage({ kind: "error", error: "fixture worker failure" });
} else {
    // The worker stays alive but sends no recognized reply. Exit eventually so
    // the report-only timeout assertion cannot leave an orphan worker behind.
    setTimeout(() => process.exit(0), 2000);
}
