# OpenCode local-embedding runtime check (2026-10-05)

## Release/runtime finding

The newest OpenCode 1.x release available on 2026-10-05 is **v1.18.34** ([GitHub release](https://github.com/anomalyco/opencode/releases/tag/v1.18.34), published 2026-09-30). Its tagged [`package.json`](https://github.com/anomalyco/opencode/blob/v1.18.34/package.json) declares `"packageManager": "bun@1.3.14"`. The preceding control release, [v1.18.30](https://github.com/anomalyco/opencode/releases/tag/v1.18.30), declares the same Bun package-manager version.

I downloaded the official macOS arm64 release binaries and independently measured their embedded runtime from a temporary plugin loaded by each live `opencode serve` process. Both reported:

```text
[bun-probe] Bun=1.3.14 process.versions.bun=1.3.14
```

Thus the premise that the newest released OpenCode 1.x embeds Bun >=1.4.0 is not true for the release inspected. There is no new-Bun 1.x release on which to confirm native auto-selection. No native attempt was made on v1.18.34, and no native-load error was observed; the auto-selection branch correctly chose WASM for Bun 1.3.14.

## Isolated host runs

Both releases were run with `embedding.provider: "local"`, `embedding.local_runtime: "auto"`, memory enabled, and the model provider restricted to a local mock Anthropic-compatible server. No real LLM provider was configured or contacted. The local MiniLM model was available in the throwaway storage (`modelCacheBytes: 91,100,283`).

| Host | Embedded Bun observed in host | Doctor embedding probe | Plugin/runtime evidence |
|---|---:|---|---|
| OpenCode **1.18.34** (latest 1.x) | 1.3.14 | `Embedding provider: local — onnxruntime-web (WASM) selected by embedding.local_runtime/host ... Doctor process Bun 1.3.14 (the host's embedded Bun may differ). The native addon was not probed or loaded.` | Plugin log: `[magic-context] embedding model loaded: Xenova/all-MiniLM-L6-v2`; `debug.memoryUsage` reported `loaded:true`, `runtimes:["wasm"]`, `providerCount:1`. |
| OpenCode **1.18.30** (requested control) | 1.3.14 | The same WASM-selected line and `Doctor process Bun 1.3.14`; native addon not probed. | Plugin log showed model load; `debug.memoryUsage` reported `loaded:true`, `runtimes:["wasm"]`, `providerCount:1`. |

The provider was exercised, not just initialized: each host's `ctx_memory` write returned `Saved memory [ID: 1] in ARCHITECTURE` and computed/persisted one local embedding (`memory_embeddings` row count 1). The subsequent `ctx_search` returned `Memories: 1 match found, all already visible in your project-memory block (ids 1)`. It matched the written memory, but Magic Context suppressed its content because it was already in the project-memory block.

An additional v1.18.30 run set `local_runtime: "native"` explicitly to exercise the guard rather than auto-selection. The plugin logged:

```text
[magic-context] native embedding worker teardown is unsafe on this Bun version; using WASM. Upgrade the host to Bun >=1.4.0 for native inference.
```

That run also computed an embedding and reported `runtimes:["wasm"]`. On the auto path, the current plugin does not log a runtime-named success line; the generic `embedding model loaded` line and the runtime statistics are the available plugin-side evidence. The explicit-native guard run supplies the requested runtime-named plugin log line for the old-Bun control.

## OpenCode 2.0.22 follow-up

### Release and in-host runtime

The `v2.0.22` source tag's [`package.json`](https://github.com/anomalyco/opencode/blob/v2.0.22/package.json) declares `"packageManager": "bun@1.4.2"`. The installed `@opencode/cli` package was version 2.0.22 and its throwaway-root `--version` check returned `opencode v2.0.22`.

The live host's own `debug.memoryUsage` returned `bunVersion:"1.4.2"`. With `embedding.provider:"local"` and `local_runtime:"auto"`, that same host returned `native.localEmbedding` with `loaded:true`, `providerCount:1`, `models:["Xenova/all-MiniLM-L6-v2"]`, `runtimes:["native"]`, and `modelCacheBytes:91,100,283`. The OpenCode doctor probe printed `Embedding provider: local (native runtime selected and OK; Xenova/all-MiniLM-L6-v2 bundled)`. Doctor exited 0; its overall summary had unrelated temporary-config findings (one compaction conflict was repaired, and the hidden-agent model catalog was unreadable).

### Write/search proof

The first v2 host's mocked-provider `ctx_memory` write returned `Saved memory [ID: 1] in ARCHITECTURE`; the throwaway `context.db` contained that memory and one `memory_embeddings` row. `ctx_search` returned `Memories: 1 match found, all already visible in your project-memory block (ids 1)`.

After restarting OpenCode 2.0.22 against the same data and disk-cached model, the second host wrote memory ID 2. Its search completed and returned an actual hybrid result, `Found 1 result ... [1] [memory] score=0.88 id=2 category=ARCHITECTURE match=hybrid`, followed by the written memory text. This is a successful search result, not an embedding or search failure.

### Teardown and the partial restart check

For the first host, after the native runtime was loaded, the probe sent SIGTERM to the host process. The server logged normal watcher shutdown and `InterruptError: All fibers interrupted without error`; the host process group disappeared, and no worker process remained. The wrapper recorded status **130**. There was no observed crash or hang during this first shutdown; the nonzero status is recorded rather than hidden.

The restart itself succeeded and completed the second write/search. The temporary probe then failed on its own v1-specific assertion, expecting `Memories: 1 match found`; OpenCode 2 correctly returned `Found 1 result ... match=hybrid` instead. Exact failure:

```text
error: OpenCode 2 search did not report a memory hit: "§5§ Found 1 result for \"OPENCODE2_2026_V2_RUN_2_EMBED_SENTINEL\":\n\n[1] [memory] score=0.88 id=2 category=ARCHITECTURE match=hybrid\nOpenCode 2 local native embedding proof OPENCODE2_2026_V2_RUN_2_EMBED_SENTINEL is isolated to this host.\n\nMemories: 1 additional match suppressed because it is already visible in your project-memory block (ids 1).\nGit commits: no git repository — commit search unavailable for this project."
```

Because that assertion ran before the restarted host's `debug.memoryUsage` query and graceful-stop step, this run **does not establish** the restarted process's runtime stats or clean teardown. The harness's `finally` cleanup forcibly stopped that process group after the assertion. No hang was observed before the assertion, but restart teardown/leak behavior remains unverified. This is a probe assertion mismatch, not a product embedding/search failure.

Both v2 host starts used the task-local XDG roots, `OPENCODE_DB`, Magic Context storage, and mock LLM provider. The v2 runner's lsof checks and the first host's `lsof -p 15521` showed only throwaway database files under the task root, including ONNX Runtime's own `onnxruntime.db-shm` under the throwaway HOME. No live store/config was opened.

## Live-store isolation

Each OpenCode 1.x host's `HOME`, XDG config/data/cache/state/runtime roots, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` were under `$TMPDIR/magic-context/verify-native-local-embeddings/`. The recorded `lsof -p <host pid>` database descriptors for every host were only throwaway `opencode.db` and `context.db` files and their WAL/SHM companions beneath that task root. The probe asserted this containment for the host PIDs (latest 78004, auto control 16351, explicit-native control 23705). No live OpenCode or Magic Context store/config path was opened or changed. `doctor` made its normal temporary TUI config repair only inside the throwaway roots.

## Recommendation / adoption data

**Keep the Bun <1.4 WASM injection arm for OpenCode 1.x.** Both tested 1.x releases still embed Bun 1.3.14, and the v1.18.30 control demonstrably selects and executes WASM. OpenCode 2.0.22's in-host Bun 1.4.2 selected and executed native inference, passed doctor, and completed the first loaded-runtime shutdown without a crash or hang. The restart then wrote and searched successfully, but the probe stopped before checking restarted-host stats or clean teardown because of the assertion mismatch above. Do not remove the guard based on this partial lifecycle check; rerun the restart phase with an assertion that accepts OpenCode 2's `Found 1 result` format and record native stats plus graceful shutdown before revising that conclusion.

The number of users still on older OpenCode/Bun versions is **unknown**. Release tags and asset-download totals do not identify active installs or which downloaded version a user currently runs; no release-note or public GitHub data found here supports a user count.

## Scope

No product code was changed. This report is the only repository change. All downloaded binaries, temporary drivers, host configs, databases, model cache, and logs remain under the task's throwaway temp root.
