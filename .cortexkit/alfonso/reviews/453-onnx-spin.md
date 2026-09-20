# Issue 453 — ONNX WASM idle-spin investigation

## Result

The local WASM path now sets `onnxruntime-web`'s `env.wasm.numThreads` to `1` before Transformers.js is imported and before its feature-extraction pipeline is constructed. The native `onnxruntime-node` path does not import or modify the web runtime.

The installed runtime is `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`. Its actual `Env.WebAssemblyFlags` surface documents that `numThreads = 1` spawns no worker thread. Its backend honors a positive user value and otherwise chooses up to four threads; the WASM factory creates `numThreads - 1` workers. The package's dispose implementation also records that pthread termination is not exposed and is not called. No additional ORT setting is needed for single-threaded execution; `proxy` would only move execution to another Worker and does not disable the intra-op pool.

## Measurements

Host: macOS 27.0 arm64, 18 logical CPUs. Model: `Xenova/all-MiniLM-L6-v2`, fp32, 384 dimensions. Pair: “The cat sits on the mat.” / “A cat is sitting on a mat.” CPU is `process.cpuUsage()` across a 20-second no-work window after loading and one embedding pair. The multi-thread control explicitly set four ORT WASM threads; the fixed path exercised `LocalEmbeddingProvider` and observed one configured thread before inference.

| Runtime | Bun | ORT threads | idle wall | idle CPU | one-core equivalent | cosine |
|---|---:|---:|---:|---:|---:|---:|
| pre-fix control | 1.3.14 | 4 | 20.002 s | 0.319 s | 1.59% | 0.9717575373 |
| fixed WASM | 1.3.14 | 1 | 20.002 s | 0.076 s | 0.38% | 0.9717575373 |
| pre-fix control | 1.4.2 | 4 | 20.003 s | 0.257 s | 1.29% | 0.9717575373 |
| fixed WASM | 1.4.2 | 1 | 20.003 s | 0.071 s | 0.36% | 0.9717575373 |
| native control | 1.4.2 | n/a | 20.001 s | 0.123 s | 0.61% | 0.9717575877 |

This host did not reproduce the reporter's Linux 100%-of-one-core failure, even when four threads were forced, but the same configuration direction was measurable: the Bun 1.3.14 four-thread control consumed 4.22 times the idle CPU of the fixed single-thread path. The fixed path eliminates extra ORT worker threads rather than relying on this host to reproduce the upstream spin.

Embedding output is unchanged within floating-point tolerance. Fixed single-thread WASM and four-thread WASM produced byte-identical vectors for both inputs (maximum absolute component delta 0; cosine delta 0). Native versus four-thread WASM differed by at most `1.63e-7` per component and `5.04e-8` in cosine.

With an empty model cache, fixed WASM initialization took 3.214 s wall / 0.698 s CPU; the event-loop delay probe observed a maximum 72 ms delay. With a warm cache it took 0.153 s wall / 0.473 s CPU and the first inference took 10.4 ms. The cold multi-second duration is primarily asynchronous download/cache time, not a multi-second event-loop block. It is a latency finding for the first request, but does not justify shipping isolation in this change.

## Upstream root-cause check

- microsoft/onnxruntime#26026 directly reports high CPU for multi-thread WASM and says no WASM equivalent of native `forceSpinningStop` appears to exist. This is credible supporting evidence, although that report measured browser workloads rather than Bun and does not itself prove this repository's exact 100% Linux symptom.
- xenova/transformers.js#488 was originally a Node multi-thread WASM failure and includes a Bun reproduction report. The thread says the original problem was fixed in March 2025, so it is historical evidence for runtime sensitivity, not proof that current Transformers.js still has that exact defect.
- The decisive evidence for the mitigation is the installed ORT source: automatic Node selection can choose up to four threads, one thread creates no workers, and current WASM disposal cannot terminate pthreads.

## Isolation assessment

Recommendation: do not move embeddings to a Worker or child process after the single-thread fix.

- A Worker would need its own Transformers/ORT module identity, WASM instance, tokenizer, and model pipeline. The current project registry lazily keeps one provider per project registration in-process; a worker-per-project design would multiply model memory and repeat load work (the measured model cache occupies 97 MiB on disk, before runtime heap). A singleton worker would avoid multiplication but would require request IDs, cancellation and disposal protocols, failure recovery, registration-generation fencing, and lifecycle ownership.
- Each 384-element `Float32Array` is 1,536 bytes. Vectors can cross IPC cheaply via transferable `ArrayBuffer`s, but batches and error/cancellation metadata still need a protocol and copies must be avoided explicitly.
- A Bun Worker still uses WASM and does not cure ORT intra-op spinning; it only protects the server loop while retaining the CPU burn. A child process provides stronger failure and CPU isolation but adds process startup, packaging/path resolution, model ownership, shutdown, and crash-restart complexity.
- SQLite should remain in the host. The registry's background “worker” is an async loop over host-owned `Database` objects, and storage caches synchronous connections by path. Bun test-worker probes demonstrate that separate processes sharing one data home can hit the 5-second busy timeout. Passing database handles is not viable; moving database writes would require a second connection and contention-safe IPC. Keeping DB selection/writes in the host and sending only text/vectors is feasible but broadens the protocol substantially.
- Measured residual blocking is tens of milliseconds, while the 3.2-second cold load is mostly yielding download/cache activity. Isolation is therefore disproportionate once extra ORT workers are disabled. Reconsider a singleton child process only if Linux production telemetry still shows event-loop starvation or if a future model introduces long synchronous inference.

## Verification design

The regression test injects a real-shaped ORT environment, records `numThreads` when the Transformers module is imported and when the pipeline constructor runs, and requires `1` at both points. A native-selection test supplies a sentinel `numThreads = 4`, rejects any web-runtime import, and verifies the sentinel remains unchanged.
