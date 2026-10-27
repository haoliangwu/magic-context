// Test-only worker entry: runs the real auto-search worker in this thread,
// then tells the parent once that module has finished evaluating. The paired
// test withholds every embedding reply until it sees "evaluated", which
// reproduces Bun releases (1.3.14 confirmed) that deliver no parent message to
// a worker before its entry module has settled.
import { parentPort } from "node:worker_threads";

// A URL keeps tsc from resolving a .ts specifier; Bun loads the source file.
await import(new URL("./auto-search-worker.ts", import.meta.url).href);
parentPort?.postMessage({ kind: "evaluated" });
