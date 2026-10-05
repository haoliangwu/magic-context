# OpenCode 2 / shared-config / TUI performance audit

Baseline: `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. Measurements began before
production edits, using the worktree's prepared baseline build. Its complete
`packages/plugin/dist` was preserved for the production-bundle and provider-wire
comparisons. No live store or configuration was copied or opened.

## Reproduction and method

Preserve the baseline build's complete `dist` directory, not just its entry file:
both entries have relative chunk imports. After building the candidate:

```sh
timeout 180 bun packages/plugin/scripts/perf-audit/v2.ts /absolute/path/to/baseline-dist/index.js
timeout 300 bun packages/plugin/scripts/perf-audit/v2-wire.mjs /absolute/path/to/baseline-dist/v2/server.js
timeout 60 bun packages/plugin/scripts/perf-audit/v2-logger.mjs
```

The timing script creates and removes private HOME/XDG/config/log/SQLite roots.
It uses 1,000, 10,000 and 60,000 messages, roughly 1.1 KB of body per message,
session/seq and session/type/seq indexes, WAL, and real SQLite-backed async storage
reads/writes. Every timed operation is warmed once. It reports 70 timing probes,
three heap-retention probes, read/write/decode counts, and three query plans.
The media microbenchmark uses ten class-backed 1 MiB assets; actual host media is
covered separately by the existing real-host image tests.

Environment: Bun 1.4.2, SQLite 3.54.0, macOS arm64. Concurrent machine load made
absolute timings noisy: e.g. the same 60k restore ranged from 164 to 434 ms.
Counts and same-run comparisons are more reliable than small time differences.
The table preserves that distinction instead of attributing incidental speedups
in unchanged code to the fixes.

## Findings

All times below are milliseconds unless explicitly labeled otherwise. "Unchanged"
means no production edit for that finding.

| Finding | Classification | Before → after / measurement | Commit | Regression evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| V2-1 (top-25 #22) | CONFIRMED | Initial serial admission: 6.36 / 59.41 / 422.50 ms at 1k / 10k / 60k. Same-run old lookup vs SQL candidate filter: 5.81→0.066 / 75.99→0.495 / 708.18→16.26 ms. Ordinary 60k passes: 60,000→0 storage reads. Another run was 478.46→2.44 ms. | `cc34c7c002` | `synthetic candidates bridge a delayed SQL projection without bypassing admission`; real-host I15; raw provider differential | Query native `synthetic` row ids, plus pending sends not yet projected by SQL. These are candidates only: storage still authenticates every one. No id-prefix heuristic and no cached negative/positive admission decision. |
| V2-2 (top-25 #22) | CONFIRMED | Initial 60k reopen/point read 0.166 ms vs held 0.011 ms. Final same-run fresh vs pooled leases: 0.231→0.014 / 0.162→0.008 / 0.226→0.008 ms at 1k / 10k / 60k. | `cc34c7c002` | `pooled readers reuse one handle but see WAL edits and reject a closed lease`; `pool bounds retained handles and rechecks generation after file replacement`; host reader tests | Boot-scoped pool, explicit disposal, inode replacement detection, bounded statements and retained handles. Caches statements, not rows or decisions. |
| V2-3 | CONFIRMED | Initial 1k / 10k / 60k event bursts: 7.13 / 50.80 / 373.77 ms. Final: 8.98 / 2.33 / 19.10 ms. Reads per 60k stream: 60,000→1 (script runs each stream twice and prints 120,000→2). | `c590ef2ed4` | `reads the persisted throttle once for an hourly burst of host events`; `rechecks storage at expiry before starting another host's duplicate check`; existing subscription teardown test | Memo is scoped to one subscription and re-reads storage at expiry. Package version/development identity is process-module scoped. No timer or new setting. |
| V2-4 | ALREADY FIXED; remaining copy cost POLICY; proposed SQL substitution NEGLIGIBLE | Restore cache commit already present: warm 60k restore decodes **0 rows**, not 60k. Warm cost 164–434 ms remains. Initial CAST vs octet query: 37.35 vs 36.75 ms (<2%); subsequent paired samples 37.55 vs 51.20 and 51.40 vs 79.43 ms, not a reliable win. | Existing `945c6d7869`; unchanged | Existing restore-row cache and real-host same-process/restart image restore tests | `restore-rows.ts:43,60` already reuses unchanged decoded rows. The copy at `:75` isolates the cached raw data from a mutating transform. Removing it or caching by mutable object identity risks changed replay bytes. |
| V2-5 | CONFIRMED (startup); per-toast freshness POLICY | Unavailable RPC takes 13.54–13.60 **seconds**. Executing the actual initialization/registration block against a controlled 50 ms RPC: 52.26→0.087 ms to register the sidebar. | `23b8763250` | `TUI registration is not gated by toast RPC discovery in source or shipped copy`, with a mutation control | Register immediately and resolve the initial duration in the background. Each toast still awaits its current duration; no stale config-generation cache was invented. Generated TUI copy rebuilt. |
| V2-6 | POLICY; unconditional twice-per-pass image claim NOT REPRODUCIBLE | Initial text adapt+commit at 1k / 10k / 60k: 0.89 / 4.98 / 48.35 ms. Final 60k 157.92 ms under load; replay capture 27.16 ms. Ten 1 MiB class-backed assets: 26.55 ms. Unchanged. | — | Existing payload/generate tests; actual host image tests | Mutable tool input/messages require isolation (`payload.ts:235,292`; `generate.ts:24-26,50-56`). `contentKey(part)` at `payload.ts:190` is the initial key; the second key at `:425` is conditional on the pipeline having flattened a host instance. An identity-only WeakMap cannot detect in-place changes or identify a flattened clone. |
| V2-7 | POLICY | 60k replay adds about 11.0 MB of heap and `forget` releases about 11.0 MB (GC-sensitive); serialized history is 71,748,891 bytes, **not** the heap estimate. 10k adds/releases about 1.84 MB. Unchanged. | — | Existing generate/replay tests, including byte identity with/without side requests | Dropping a loaded session's replay entry would make `/btw` serve raw host history instead of the last managed request on revisit (`generate.ts:16,35`). No equivalent durable snapshot of system+messages+tools is available here. A blind LRU violates the byte-preservation fence. |
| V2-8 | CONFIRMED | Initial unchanged observe 0.45–1.33 ms; final 60k fixture 0.148 ms. 21→0 writes across the warmup plus 20 timed unchanged observations. | `0732654bac` | `unchanged observations preserve persisted identity without rewriting it`; existing rebind/divergence tests | Every actual state change still persists. Digests are still recomputed; mutable rendered objects are not identity-memoized. |
| V2-9 | CONFIRMED (connection churn); polling cadence POLICY | Final fresh vs pooled poll pair: 0.247→0.012 / 0.543→0.049 / 0.190→0.017 ms at 1k / 10k / 60k. | `cc34c7c002` | Pool lifecycle/WAL tests; existing hidden-completion tests in full plugin suite | Hidden completion uses the same boot-scoped reader pool. Retains the 200 ms fallback: terminal/usage rows can arrive without a corresponding adapter wake event; removing the fallback changes completion and budget decisions. |
| V2-10 | NOT REPRODUCIBLE for "one snapshot RPC per event" burst claim; refresh coverage POLICY | 1k / 10k / 60k bursts issue **one** snapshot RPC each; final dispatch/I/O (excluding controlled 100 ms drain) 4.50 / 3.21 / 3.75 ms. Unchanged. | — | Benchmark executes `setupWithJsx` text fallback against a real local RPC server | `v2/tui/index.ts:189` rejects concurrent refreshes. The mounted component also debounces. `:510` does force refreshes for spaced events; narrowing the event set would alter visible update coverage rather than merely eliminate one RPC per event. |
| V2-11 | NEGLIGIBLE; identity-only memo POLICY | 40 tools × 20 nested properties: initial 0.463 ms, later 0.484–0.964 ms (one loaded sample 1.055 ms). Unchanged. | — | Existing nested-schema mutation/token-measurement tests in full suite | Shared fingerprint explicitly catches nested mutable schema edits; an identity-only memo loses that contract. |
| V2-12 | NEGLIGIBLE | Initial sanitizer: 22 lines 0.031 ms; 50 objects 0.154 ms. Real logger including synchronous flush: 50 lines 0.156 ms, 50-object payload 0.197 ms. The log file confirms 5,000 / 100 new lines across 100 passes. Unchanged. | — | Existing logger/redaction tests in full suite; private real-write benchmark | No debug setting, asynchronous flush semantics, or redaction behavior change. |
| V2-13 | NEGLIGIBLE | Three full config loads: initial 0.828 ms; subsequent 0.554–2.489 ms total per boot, not per pass. Unchanged. | — | Existing config/live-reader tests in full suite | This is well below 5% of the real host boot/activation stage. Seeding a reader without proving a matching file snapshot can miss a boot-time edit. |
| V2-14 | CONFIRMED ordinal scaling; STOPPED before a persistent ordinal/index design. Other subclaims NEGLIGIBLE or ALREADY FIXED | Initial 60k ordinal: 3.189 ms; late 100-id range: 38.179 ms. Final 6.094 / 52.148 ms. Newest assistant 0.009 ms; absent compaction 0.102 ms in final run. Unchanged SQL semantics. | — | Existing keyset/raw-reader tests; benchmark EXPLAIN QUERY PLAN | Ordinal APIs require positions, not seq: `seq` includes non-conversation rows. Query plan scans session/seq and filters types; persistent covering ordinal metadata/indexing belongs to the host schema. An ordinal-result cache cannot remain correct across deletion/in-place edits without a reliable revision. Do not add host indexes, a migration or a cache epoch in this worker. `messagePage` already accepts a carried keyset anchor. |
| V2-15 | NOT REPRODUCIBLE on this platform; Windows not adjudicated | Zero `tasklist` calls on darwin; Windows timing unavailable. Unchanged. | — | Platform branch at `shared/rpc-utils.ts:141-143` | No Windows host available. Do not remove liveness checks based on an unmeasured Windows claim. |
| V2-16 | CONFIRMED eager dependency loading; timing benefit is noisy | Production index entry 1.82 MB→0.50 MB after splitting (shared chunks still load). Cold five-process median: 152.51→136.84 ms in one comparison; 115.07→125.80 ms in another. Do **not** claim a stable wall-clock win from these samples. | `b9afc05c69` | `the union server defers the context adapter until after the host-shape check`, with a mutation control; existing union-loader/setup tests | Move the dynamic import into the existing v2 setup **after** the unsupported-host return, rather than changing the public union entry or setup callback identity. V1's secondary setup probe never loads the adapter. This is the least certain timing benefit and the first optional hunk to review. |

## Cache and byte safety

- No database version, cache format/epoch, user-visible config schema, setting, CLI
  flag, or persisted fold/admission decision changed.
- Pool key: resolved store path plus device/inode/birthtime; missing files fail,
  replacements reconnect and re-check generation, WAL writes remain visible,
  leases close in caller `finally`, and host disposal closes retained handles.
  Statement cache is capped at 128, pool retention at four paths. No result cache.
- Synthetic candidate bridge is keyed by the actual storage instance and
  session/id, removed once SQL observes a send, and cleared on disposal. A stale
  candidate cannot authorize anything: admission is still read from storage.
- Version-check throttle expires after the existing hour and consults persisted
  storage again; package identity resets when the module/process is reloaded.
- The transform core, Rust and Pi were not edited. These fixes concern OC2's
  native storage/event/checkpoint boundaries, which have no Rust/Pi twin. Shared
  tool fingerprint and redaction findings were left unchanged. Both shared TUI
  source and its shipped compiled copy were kept in step.

The equivalent before/after wire check ran on **real OpenCode 2.0.22**, not an
adapter-only serializer. It snapshots only throwaway stores before the first
turn and reuses the host session id between arms; scripted response item ids are
also deterministic. It compares the mock's **raw HTTP body text** without
normalizing or stripping any field, including `prompt_cache_key`.

Five requests (first pass, defer, admitted synthetic steer, post-synthetic defer,
explicitly priced flush) were byte-identical. Final run:

| Request | Bytes | SHA-256, equal in both arms |
| --- | ---: | --- |
| 0 | 36,438 | `691ae7fa7e76568a40726bc80bdbf9b666c3dedd762d3789e83fed9d5145e7d4` |
| 1 | 36,688 | `c651d2dd15465abd33dfce4da3e48c3fd7c063aa39e6d70503b7a31878b085ee` |
| 2 | 36,945 | `3822675af7853e7fedb4e2b2cda73322e30125e011e44f762bdd959139b373fc` |
| 3 | 37,200 | `0d45075366065d19b6d1b74828fe39d440a205d8d2c5594fb6fca8f1d91cbcb6` |
| 4 | 37,452 | `cf883af74a1a584716a0e0e69b4e2455204ba88a982a4433249a24ceee6a80c7` |

Each arm's `lsof` inventory and the runner's inode/write-fence checks passed.
All database descriptors were under that run's private HOME/XDG root
`.../mc-opencode2-FY4EBc`; the throwaway stores were deleted afterwards. This real
OC2 comparison is the equivalent requested wire differential in place of the
v1/Rust-oriented `pure-replay-differential.ts` script.

## Verification

- `timeout 600 bun run --cwd packages/plugin test`: **6,775 passed, 4 skipped,
  0 failed**, 203,554 assertions, 655 files, Bun 1.4.2. Includes existing
  byte-identity, replay and TypeScript/Rust-mode-host parity tests. An initial
  run caught the new pool test's direct temp allocation; it was corrected to
  use the repository's registered helper (`7970f24a0b`), not by weakening the
  temp-root guard.
- `timeout 180 bun run --cwd packages/plugin typecheck`: passed all three
  TypeScript project checks, TypeScript **5.9.3**; re-run after the final timing
  script additions.
- `timeout 120 bun run --cwd packages/plugin lint`: passed **1,205 files**,
  Biome **2.5.1**, with one pre-existing non-null warning and two existing
  style infos in unrelated files. No unrelated formatting changes.
- `timeout 240 bun run --cwd packages/plugin build`: passed browser/Node/OC2
  bundles and declaration emission; build's union-loader gate **4/4 tests**.
  TUI generator wrote nine files, only the intended compiled index changed.
- `timeout 300 bun packages/plugin/scripts/perf-audit/v2-wire.mjs ...`: **5/5
  literal provider body comparisons passed** on OpenCode 2.0.22, with `lsof`
  and teardown fences.
- `timeout 600 bun run test:e2e-opencode2` with the seven relevant files and
  `--test-name-pattern '^(?!.*(host fold costs zero requests|on a poisoned shared draft)).*$'`:
  **35 passed, 3 filtered out, 0 failed**, 297 assertions. Covers native
  synthetic admission, v1 fixture contribution parity, three defer passes,
  bounded 10k reads, checkpoint images before/after restart, and `/btw` bytes
  and unchanged durable state.
- Unfiltered selection first ran **35 passed / 3 failed**. All three failures
  were reproduced by rebuilding with the five pre-audit production files from
  `ee9d829` (the live implementation had been staged first, then restored):
  `I6a I7 I8 I9 R39 local: host fold costs zero requests and restores unarchived tail`,
  its `provider` counterpart (TTL stamp stayed exactly `idleTime - 1`), and
  `I9b hook_never_throws on a poisoned shared draft` (expected one provider
  request, received zero). They were not rewritten. The targeted baseline
  run had **0 passed / 3 failed / 10 filtered**; the final healthy selection
  explicitly filters just those known baseline failures.
- Both source guards were proved non-vacuous by individually restoring the
  awaited startup RPC / static context import, observing only the named guard
  fail (one test per run), then restoring the staged implementation. The
  worktree diff was nonempty during each control and empty after restore.
- Reviewed comments in the uncommitted implementation before each commit.
  No existing behavior test was changed to accept the opposite contract.

Only the plugin package was changed, so its full test/typecheck/lint suite is
the full-package gate. Relevant existing e2e tests were run without modifying
the e2e package or manifest. No Rust package or lockfile changed. The test
script's frozen install checked 995 installs / 1,250 packages and made no changes.

## Stops and residual risks

- **V2-14:** stop before host-owned persistent ordinal/index metadata, DB
  migration or cache-version design. No such work was started. Random ordinal
  queries remain linear; carried-anchor paging already avoids repeated OFFSET
  when the caller has an anchor.
- **V2-7:** no blind replay eviction; an equivalent durable replay design would
  be required to preserve revisited sessions' bytes.
- **V2-15:** Windows must be measured on Windows before changing the probe.
- **V2-16:** dependency deferral is verified; cold-load timings overlap and even
  reverse under load. Keep or drop its isolated commit based on the reviewer's
  tolerance for a small one-time import optimization, not a claimed stable 16 ms
  host-boot reduction.

## Tool issues

- AFT inspection remained PARTIAL (Biome unavailable to AFT, and some TypeScript
  diagnostic publications timed out). The authoritative project `tsc` and
  `bun run lint` gates above passed; no "clean LSP" claim is made.
- Biome `--changed` did not include uncommitted changes; formatting was run
  through the repository's `bun run lint -- --write --staged` command instead.
- During development, one real-host run's unchanged-directory fence observed
  the operator's `.claude.json` changing concurrently. The fence was not
  bypassed or loosened; subsequent final host runs passed it.
- The wire script was corrected to reuse private session stores and deterministic
  response item ids, rather than erase the host's varying cache key or provider
  ids from its comparison. An early raw comparison intentionally failed on those
  differences. It also closes the runner's fixture DB before removing its private
  stores; the earlier reset had correctly failed with an open-inode I/O error.
