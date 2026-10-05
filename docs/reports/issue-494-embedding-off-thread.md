# Issue 494: local embedding inference off the host thread

## Environment and isolation

Measured on macOS arm64, using the **official OpenCode 1.18.33 release binary**, downloaded into `$TMPDIR/magic-context/issue-494/opencode-1.18.33/`. The diagnostic plugin reported **embedded Bun 1.3.14**. The build/test runner was Bun 1.4.2. The installed OpenCode 1.18.30 binary on this machine reported Bun 1.4.2 inside the plugin, so it was not used as evidence for the affected embedded runtime.

All host HOME, XDG config/data/cache/state, OpenCode DB, plugin storage/model cache, logs and results were under `$TMPDIR/magic-context/issue-494/host-wasm/`. A local Anthropic-compatible mock supplied the language-model completion; no real LLM provider or credentials were enabled. Default auth plugins and remote model-catalog fetching were disabled. Dependencies were resolved through a symlink to this worktree's `packages/plugin/node_modules`; model files were downloaded directly into the throwaway embedding cache, not read from a live store.

`lsof -Fn -p <OpenCode process ID>` was checked before and after each prompt. Final run:

```text
lsof pid=65109 forbidden=0 mode=inline
lsof pid=65109 forbidden=0 mode=inline
lsof pid=65740 forbidden=0 mode=worker
lsof pid=65740 forbidden=0 mode=worker
```

The probe's file-descriptor check rejects any descriptor below the operator's `~/.local/share/opencode`, `~/.local/share/cortexkit/magic-context`, `~/.config/opencode` or `~/.config/cortexkit`. Descriptor listings remain at `inline/lsof.txt` and `worker/lsof.txt` in the throwaway root. No live-store migration or modification was performed.

## Before/after on the real server

`issue-494-probe-plugin.ts` runs the real `LocalEmbeddingProvider` in an OpenCode `chat.message` hook. Inline mode uses the existing loader/pipeline implementation with the worker bypassed through the `__setLocalEmbeddingTestHooks` test-only mechanism; worker mode uses the production worker transport. Both explicitly select WASM and use `Xenova/all-MiniLM-L6-v2`, fp32, mean pooling and normalization. The model is initialized before collecting inference timings.

The hook exercises representative provider workloads: one auto-search query, ten proactive-memory texts, and a 32-text backfill batch. Each text contains approximately 300 words. These are **provider-level workloads on the real host**, not a full historian/Rust transform, proactive-store scheduler or history-drain end-to-end scenario. Registry tests separately cover streaming-time scheduling and resumption against real throwaway SQLite fixtures.

A 50 ms `setInterval` runs **inside the plugin**, recording `max(0, actual interval - 50 ms)`. The probe waits another interval after inference so inline starvation cannot silently lose its last sample. A separate client polls `/health` every 50 ms. Final measurements:

| Workload | Inputs | Inline inference ms | Inline p99 lag ms | Worker inference ms | Worker p99 lag ms | Worker max lag ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Auto-search | 1 | 1203.31 | 1188.37 | 717.47 | 17.96 | 17.96 |
| Proactive memory | 10 | 9164.97 | 9118.09 | 4987.33 | 21.27 | 21.27 |
| Backfill | 32 | 22622.72 | 22585.11 | 19794.53 | 32.16 | 48.33 |

Inline had only 1–2 timer samples per workload: virtually the whole batch prevented timer dispatch. Worker mode produced 13, 90 and 352 samples respectively. Maximum whole-run `/health` latency was **22635.56 ms before**, **707.76 ms after** (13 versus 462 samples). Whole-run health includes initialization and host/provider setup, so it is not a claim that every request takes less than 100 ms. Warm inference's plugin-thread p99 was below 100 ms in all three final workloads.

All 43 vectors (384 dimensions each) were compared component by component between modes. **Maximum absolute difference: 0**, stronger than the required 1e-6 tolerance. The comparison fails if a vector is missing, and the plugin rejects an incomplete phase run.

An earlier unsliced 32-input worker batch on Bun 1.3.14 had p99 lag 262.54 ms and took 85.63 seconds. The final worker therefore bounds temporary inference tensors to **two texts per pipeline invocation**, assembling and transferring the complete result for the caller. Earlier runs on this shared machine also showed substantial scheduling variability (one bounded run reached 182.65 ms p99); this is not a universal latency SLA. The important guarantee is that model initialization, tokenization and ONNX computation are owned by another worker, never the server thread. The CPU-bound transport regression independently enforces a 100 ms p99 timer-lag bound.

## Worker lifecycle and runtime safety

The host retains `initialize`, `embed`, `embedBatch`, `isLoaded`, failure classification and `dispose`. Requests carry IDs and texts; replies carry typed vectors, failure information and runtime-memory metadata. Vector buffers are transferred, not serialized to JSON in production. Model use is serialized inside each provider's dedicated worker. Idle workers are unreferenced; outstanding requests keep them alive. Worker errors/exits reject all pending requests, record an embedding failure through the provider's existing null/error-reporting contract, and allow a later request to restart lazily. A five-minute deadline bounds model downloads, load-lock waits and unresponsive inference. Abort settles the caller immediately; already-dispatched compute is not forcibly interrupted. Explicit disposal rejects pending callers and terminates the worker.

The worker sets ORT WASM `numThreads = 1` through the existing loader. The model-load lock, cache permissions, offline Node WASM bundle, runtime fallback and embedding identity recipe remain shared with the original implementation.

### Native on old Bun was measured, not assumed safe

Before adding the safety fallback, a real MiniLM inference in a **native** worker on standalone Bun 1.3.14 behaved as follows:

| Runtime | Idle worker at process exit | Explicit worker termination |
| --- | --- | --- |
| WASM | exit 0 | exit 0 |
| Native | exit 0 | **exit 133 / SIGTRAP** |

The native-worker explicit-termination run on Bun 1.3.14 printed:

```text
Features: ... workers_spawned workers_terminated process_dlopen(2)
panic: NAPI FATAL ERROR: Error::New napi_create_error
```

Moving native ONNX into a worker does **not** eliminate the old Bun native-addon cleanup crash. Consequently auto remains WASM before Bun 1.4.0. **Explicit `native` requests on those versions now also select WASM inside the worker**, with a logged upgrade suggestion. This is an intentional safety contract change: the previous risky override is no longer allowed to take down the host on disposal. The pure in-thread runtime resolver remains available for its existing loader tests; production worker selection and doctor use the safety-aware resolver. Native remains available under Node and Bun 1.4.0+.

After the protection was applied, both configured runtime values (`wasm` and `native`) passed real model initialization/inference and both idle and explicit-disposal exit modes on Bun 1.3.14; the effective runtime for both is WASM. Native/WASM exit probes also run on Bun 1.4.2, where native is actually selected. This is arm64/macOS evidence; Linux x64 teardown has not been independently remeasured. Keeping the conservative pre-1.4 WASM policy avoids betting on that platform difference.

## Streaming priority, Pi and doctor

OpenCode already supplies `session.status`, `session.idle` and `session.deleted` to its notification event observer. A cheap process-local busy-session set uses those events; it does not poll a database or server. Background proactive memory embeds, missing-memory backfill, automatic history bootstrap and project/history backlog drains defer while any observed session is busy or retrying. Drain loops recheck between batches. Work already in flight can complete, and unknown sessions do not block background work. Query embedding remains available during a turn and now runs off-thread. The automatic bootstrap latch is not consumed when a busy host causes deferral.

Pi uses the same local provider through its shared project embedding registry. Its package build now ships the same worker entry and sibling runtime bundles. Pi `agent_start`, `agent_end` and `session_shutdown` adapt to the same busy signal without awaiting background work in `agent_end`.

OpenCode and Pi doctor now render selected WASM as a warning, naming `onnxruntime-web`, the **doctor process's** Bun version, worker execution, and the suggestion to upgrade the host to Bun >=1.4.0 or use a remote `openai-compatible` provider. Fallback warnings include the same runtime/version transparency. Doctor's process may use a different Bun than OpenCode's embedded runtime; the message explicitly says so. This change does not introspect an arbitrary installed OpenCode binary's embedded Bun version.

## Reproduction

Run from a clean worktree with dependencies installed. Use an absolute throwaway root; the probe refuses a root outside the issue directory.

```sh
ROOT="${TMPDIR:-/tmp}/magic-context/issue-494/host-wasm"
mkdir -p "$ROOT/dist"
ln -s "$PWD/packages/plugin/node_modules" "$ROOT/node_modules"
bun build packages/e2e-tests/scripts/issue-494-probe-plugin.ts \
  packages/e2e-tests/scripts/issue-494-exit-probe.ts \
  packages/plugin/src/features/magic-context/memory/embedding-worker.ts \
  --outdir "$ROOT/dist" --entry-naming '[name].[ext]' --target node --format esm \
  --splitting --external onnxruntime-node --external onnxruntime-web --external sharp
bun packages/plugin/scripts/build-transformers-node-wasm.ts "$ROOT/dist"
bun build packages/plugin/src/features/magic-context/memory/transformers-web-entry.ts \
  --outfile "$ROOT/dist/transformers-web.js" --target browser --format esm \
  --external onnxruntime-web
MC_494_ROOT="$ROOT" MC_494_PLUGIN="$ROOT/dist/issue-494-probe-plugin.js" \
  MC_494_OPENCODE="$TMPDIR/magic-context/issue-494/opencode-1.18.33/opencode" \
  bun packages/e2e-tests/scripts/issue-494-host-probe.ts
```

Official host download: `https://github.com/anomalyco/opencode/releases/download/v1.18.33/opencode-darwin-arm64.zip`. Old-Bun exit runner: `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip`. Keep both archives and binaries under the same throwaway issue directory. On Linux select the corresponding release asset, rather than reusing the macOS binary.

Exit probes use `MAGIC_CONTEXT_STORAGE_DIR="$ROOT/embedding-storage"`, `MC_494_RUNTIME=wasm|native`, and `MC_494_DISPOSE=0|1`, executing `$ROOT/dist/issue-494-exit-probe.js` with the chosen Bun binary. Outputs report requested and effective runtimes; every protected mode must exit zero.

## Regression coverage

- Host timer responsiveness during a synchronous CPU-bound 128-text worker batch, p99 <100 ms.
- Float32 transport preservation and the real-model before/after vector comparison above.
- Transport crash rejects pending work; provider exposes the failure and the next call recovers.
- Caller abort settles without waiting for inference.
- An idle worker does not prevent process exit.
- Old-Bun explicit-native selection is safely overridden, including doctor selection.
- Streaming defers proactive memory/history backfill; query embedding stays available and backlog work resumes when idle.
- Existing loader, native/WASM fallback, cache, model identity and Pi nonblocking shutdown tests remain in place.

## Non-vacuity controls

The streaming regression was run with the busy predicate temporarily returning false: only `defers proactive memory and history backfill during a stream but keeps query embedding available` failed (expected 0 embeds, received 1); the unchanged-memory backfill test still passed. The timer-lag regression was run with 350 ms of synchronous host-thread work inserted before dispatch: only `host timers remain responsive during a synchronous large batch` failed (p99 309.26 ms versus the 100 ms bound); Float32 transport preservation still passed. Both mutations were marked `NON-VACUITY BREAK`, made against staged implementation snapshots, and restored to an empty unstaged diff before the final gates. No mutation is part of the delivery.

Regenerating the runtime-selection documentation also synchronized a pre-existing stale `historian.disallowed_tools` description in the schema and reference; these two mechanical generated-text updates were explicitly approved and change no historian behavior.

## Verification gates

- Plugin: `bun run typecheck`, `bun run lint`, `bun run test` passed (6169 pass, 3 skip, 0 fail); `bun run build` passed. The build was rerun separately after a combined suite/build command exhausted its 360-second deadline after the tests had passed.
- Pi: typecheck, lint, full tests (1361 pass, 3 skip, 0 fail) and build passed. Lint retains two pre-existing warnings and one informational diagnostic in unrelated tests.
- CLI: typecheck, lint, full tests and build passed, including safety-aware WASM doctor coverage.
- All eight real-model exit combinations passed: requested WASM/native × idle/disposed × Bun 1.3.14/1.4.2. Effective native inference was verified on 1.4.2; 1.3.14 safely used WASM for both preferences.
- The three diagnostic scripts passed a narrow TypeScript check using the plugin compiler settings. The optional whole-e2e-package typecheck still reports pre-existing errors in other scripts/tests (SQLite type mismatches, missing retina resolution, host fixture API mismatches); none names an issue-494 script.
- `git diff --check` passed; comment review was run and genuine clarity issues were rewritten. No dependency versions or lockfiles changed; frozen-lockfile installs completed without changes.

The standalone OpenCode 2 build was also updated to emit its own worker and Node/browser WASM siblings, so its relative worker URL does not point at a missing file. Real MiniLM smoke requests against the built OpenCode 1, standalone OpenCode 2 and Pi worker entries passed on Bun 1.3.14 with isolated storage.
