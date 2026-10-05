# Memory, dreamer, search and tools performance measurements

## Baseline and isolation

Baseline: the prepared task checkout, `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`.
The source already contains the session-first message-FTS work recorded by
`71530e49de` and the shared 3-second auto-search deadline (`1c0450f670`). Neither
was mistaken for a memory-search fix. No parent checkout was used or rebased.

Tools: Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1, Bun SQLite 3.54.0,
Node v24.16.0 / SQLite 3.53.0.

A read-only live `context.db` connection was used only for `VACUUM INTO` a
throwaway `$TMPDIR/magic-context/perf-mem/context.db`. All subsequent corpus
reads used that immutable copy. No live store/config was opened by the probes.
The benchmark's `lsof -p <its pid>` database-descriptor capture contained only
the throwaway copy, opened read-only. No real embedding provider was invoked.
Copies and replay roots were removed after verification.

The copy has 345,030 indexed messages, 20,481 memories and 47,905 commits.
The selected project has 1,256 live memories, 1,558 stored 4,096-dimensional
vectors and five missing vectors. The commit probe uses 2,000 vectors; the
largest tag session has 201,120 tags. The mural coverage gate is actually reached:
1,225/1,256 memories have current cues and 1,162 entries overflow the text budget.

Numbers below are milliseconds, warm medians after one warm-up: 11 samples for
copy probes, five for large-id/provider histories, three for git/delete probes.
Git evidence uses a throwaway 50-file repository and 50 claims sharing a timestamp.
Host scheduling/GC varied noticeably: unchanged cold-vector loads ranged roughly
60–220 ms between runs. No apparent improvement of an unchanged operation is
credited as an optimization. Cache speedups are **quiescent, same-handle hits**;
any write or replacement database handle can make them cold again.

## Findings

| Finding | Classification | Before → after; fixture | Commit | Regression/evidence | Notes |
|---|---|---|---|---|---|
| MEM-1 | POLICY (measured cost) | Full memory load 4.05 ms; cold vectors 132.02 ms; full cached-vector cosine probe 6.01 ms. Algorithm unchanged. | — | Real-copy search comparison below | Exact semantic-only recall requires the full eligible pool (`search.ts:813–829`). FTS-only pruning changes results; stored normalization changes vector format/numeric scores. Existing TTL/invalidation behavior was preserved. A byte-neutral query-norm prototype saved only 0.13 ms in the final paired probe (4.19 → 4.05 ms), so it was discarded as negligible. This finding's large cold-load cost is **not resolved**. |
| MEM-2 | CONFIRMED | Semantic commit search 53.78 → 26.73 ms; 2,000 vectors | `7356f5784b` | `cached commit vectors observe own writes, external commits and distinct database handles` | Revision-keyed, bounded vector reuse. Full metadata retrieval, date filters and stable tie ordering remain unchanged; no unsafe top-k-before-date/tie filtering. |
| MEM-3 | POLICY (unbounded submissions confirmed) | Five missing live vectors; preparation 0.031 ms. Counting provider receives two full 1k/10k/60k batches on repeated failed-vector searches. | — | `mem-provider.ts`; existing embedding-backfill tests | Removing/capping backfill or remembering failures can change the current/next search's results. No such behavior change was made. Null-vector counting controls exclude inference/network latency, not estimates of a real model's cost. The existing 3-second hint deadline is retained. |
| MEM-4 | CONFIRMED; migration stopped | 313.08 ms for 2,000 absent-SHA pre-deletes against 2,000 FTS rows (steady-state 4M row visits) | — | `EXPLAIN QUERY PLAN`: `SCAN git_commits_fts VIRTUAL TABLE INDEX 0:` | Covers the top-25 and quick-win entry too. Changing the trigger/FTS rowid relationship requires a migration. No migration or trigger replacement was constructed. |
| MEM-5 | CONFIRMED | Coverage + overflow resolution 35.95 → 21.83 ms; real cued pool above | `aa0b133e99` | `a shared refresh pool preserves coverage and ordered entries including blank and stale cues` | Two full memory loads become one; raw-content hashes are shared only within that refresh and validate the exact content. PNG reads/byte comparisons remain, so external PNG changes cannot be hidden. |
| MEM-6 | CONFIRMED | Evidence 1,443.70 → 640.40 ms; 50 claims/50 files | `5b9a717a84` | `shared timestamp bases produce byte-identical ordered evidence to explicit commit bases` and existing rename/deletion/ranges tests | Timestamp lookups are memoized per call; name-status parsed once per base. Each committed/pending pair runs concurrently, at most two git children at once. Output order and formatting are unchanged. |
| MEM-7 | CONFIRMED | Normalizing 50 tracked paths 583.36 → 21.28 ms | `5b9a717a84` | `normalizing fifty exact tracked files uses one repository lookup and one tracked inventory`; inventory-failure test | Inventory is lazy and call-local, not process-persistent or shared across an entire multi-memory run. Exact hits need no per-file git process; unusual/missing paths preserve the old lookup. Optional inventory errors fall back instead of introducing failures. |
| MEM-8 | CONFIRMED (git repetition) | Incremental git probes 59.07 → 39.10 ms; root lookups 3 → 1 on a usable repository | `5b9a717a84` | `incremental verification resolves the repository once and preserves skipped ids`; failed-top-level/full-mode test | Broad membership uses a Set with unchanged order/ids. Git log/pathspec, maxBuffer failure policy and unavailable-repository full verification are preserved: narrowing history could change persisted verification decisions. |
| MEM-9 | CONFIRMED | 135.39 ms full tag load → 0.026 ms for five requested tags; 201,120-tag session | `e5e969c82b` | Existing 18 `ctx_reduce` tests, including unknown, compacted, inert, duplicate and protected tags | Uses the existing bounded tag-number reader. The numbers isolate this read, not the whole tool/protection-window stage. Rust capability routing was untouched. |
| MEM-10 | CONFIRMED | Complete sidebar backlog 14.81 → 0.006 ms, warm/no writes | `37646702d1` | Own/external-write, caller-mutation, expiry, empty-registry and non-finite-watermark tests | At most 16 snapshots per database. Any active/permanent expiring row disables reuse. Exact omitted/null/non-finite options are distinguished. This does not promise gains during constant writes or through freshly allocated database proxies. |
| MEM-11 | NEGLIGIBLE | `table_info` 0.008 ms, about 1% of the 0.75 ms workspace-FTS probe | — | `mem.ts` | No production change. |
| MEM-12 | CONFIRMED on Node; bound not reproduced on Bun | 60k-id cue/verification/classification reads: 21.22/19.91/16.48 → 20.63/16.38/17.61 ms on Bun. Node positional form fails; JSON form returns ids 1 and 60,000. | `9bf623185b` | `memory side-table readers handle 60k ids while preserving input and file ordering`; Node control | Bun's measured limit is 500,000, Node's 32,766. One JSON parameter removes the Node failure. Some timings are neutral/slower; correctness at the Node bound is the primary result. |
| MEM-13 | CONFIRMED | Ten architecture entries 2.34 → 0.482 ms; real project | `9bf623185b` | `bounded memory lists preserve full-reader ordering, legacy categories and invalid-row filtering` | SQL category filtering/bounded pages retain ordering and keep invalid legacy rows from consuming the limit. |
| MEM-14 | CONFIRMED | JSON-backed provider: 1k/10k/60k histories 0.30/3.48/25.34 → 0.021/0.022/0.014 ms; rows read N → 1 | `047ce62230` | `Pi tool recovery visits only the first result after its owner and closes the iterator` | Exact rendered strings match for all three sizes. The fixture isolates the extra whole-history read, not cold Pi startup. Reused call ids still stop recovery; iterator resources are released. |
| MEM-15 | NEGLIGIBLE | Boolean list gates 0.256 ms on the real copy | — | `mem.ts` | No production change. |
| MEM-16 | POLICY | Ten identical queries make ten provider calls; counting-provider wrapper cost 0.156 ms total, excluding inference | — | `mem-provider.ts` | Model/generation/text alone cannot prove that a remote provider's response is immutable. Query caching needs an explicit freshness/determinism decision under the byte-identity constraint. No network-latency claim is made. |
| MEM-17 | NEGLIGIBLE | Cue selection/hashing 0.585 ms; real live pool | — | `mem.ts` | No production change. An updated-at-only prefilter also misses raw-content edits without a strictly newer timestamp, so it cannot replace hash validation. |

## Byte identity, parity and cache invalidation

The same committed benchmark script was executed in an archive of the untouched
baseline and in the edited worktree against the **same immutable store copy**.
The script's optional new-helper lookups fall back to the original APIs in the
baseline archive. A fixed clock (`MEM_AUDIT_NOW=1791072000000`) prevents age/expiry
formatting from contaminating comparison. No retrieval counters or search metrics
were persisted.

`compare-mem.ts` passed **34 independent comparisons**: ten unified queries
(`cache`, `dreamer`, `embedding`, `context`, `ctx_reduce`, `git`, `mural`, `sqlite`,
`FTS`, `memory`) compare ordered result hashes **and formatted served-text hashes**;
twenty commit queries compare ordered rows (each query with/without a date bound);
four more compare mural coverage/ordered entries, backlog, ordered tool-list rows
and git evidence. Every unified query returned ten rows. Provider expansion text
also matches the pre-edit capture at all three history sizes.

The existing pure replay differential ran archived `ee9d82912c` vs
`047ce62230` with `--ts-only --neutral`: **four defer passes identical**, including
wire, system and tool hashes (588/754/920/1,088 bytes). The existing Pi parity and
mural suites passed; a final focused parity run passed 19 tests across four files.
No new e2e test or mode-manifest entry was added.

Both long-lived memos use weak database ownership and
`total_changes()` + `pragma_data_version` + `pragma_schema_version` to reject
own writes, external commits and table rebuilds. Commit vectors also key project
and model and cap retained vector bytes at 32 MiB/16 pools. Backlog keys include
project/task order/exact options; returns are cloned and expiring pools bypass it.
Mural hashes live only within one refresh and are keyed by id plus exact raw
content. No persisted cache format, epoch, schema, config, CLI flag or decision
format changed.

Negative controls neutralized each revision-invalidating branch after staging
the live implementation. Each mutation produced `1 file changed, 1 insertion(+),
1 deletion(-)`; restore used `git checkout -- <path> && touch <path>` and left
`git diff --stat` empty. Only the named freshness test failed: commit search
2 pass/1 fail, backlog 9 pass/1 fail. Both suites then passed after restoration.
Detailed named evidence is included in the delivery declaration.

OpenCode and Pi use the same edited TypeScript helpers. Their tool wrappers,
Rust routing and native query/arithmetic implementations were not changed. No
matching native implementation of these measured dreamer/search helpers was
modified; no Rust migration, cache codec or Cargo lockfile was touched.

## Verification

All commands had outer `timeout` limits.

- `timeout 1200 bun run --cwd packages/plugin test`: Bun 1.4.2,
  **6,781 pass / 4 skip / 0 fail**, 6,785 tests across 654 files.
- `timeout 1200 bun run --cwd packages/pi-plugin test:serial`: Bun 1.4.2,
  **1,511 pass / 3 skip / 0 fail**, 1,514 tests across 139 files.
- Plugin and Pi `timeout 300 bun run --cwd <package> typecheck`: TypeScript
  5.9.3, exit 0 (silent typecheck scripts; plugin includes scripts).
- Plugin/Pi `timeout 300 bun run --cwd <package> lint`: Biome 2.5.1,
  1,202/225 files checked, exit 0. Existing warnings/info were not modified.
- `timeout 600 bun run build`: Bun 1.4.2 / TypeScript 5.9.3, plugin/Pi/CLI
  bundles and declarations succeeded; v2 build gate 4 pass/0 fail.
- Focused git regression run: all tests passed, including full/unavailable-root
  behavior and optional inventory fallback. Final focused Pi parity: 19 pass.
- Pure replay command: `MC_REPLAY_SCRATCH_ROOT=<throwaway> timeout 1200 bun
  packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only --neutral
  ee9d82912cd8105322672a1f5dd1bbb7172a2f46 047ce62230`, four comparisons passed.
- Comment review completed before each finding commit; no existing test's
  assertion was changed to accept a new contract.

## Reproduction

Create the seed with the common guide's read-only `VACUUM INTO` command. Archive
the baseline into a throwaway root, copy `mem.ts` into that archive's corresponding
script directory, and link its node_modules to this worktree's installed modules.
The archive must not point its source files at the edited checkout.

```
MEM_AUDIT_NOW=1791072000000 timeout 600 bun <base>/packages/plugin/scripts/perf-audit/mem.ts <seed> > before.json
MEM_AUDIT_NOW=1791072000000 timeout 600 bun packages/plugin/scripts/perf-audit/mem.ts <seed> > after.json
timeout 120 bun packages/plugin/scripts/perf-audit/compare-mem.ts before.json after.json
timeout 120 bun packages/plugin/scripts/perf-audit/mem-provider.ts
```

## Tool issues and stopped work

- MEM-4 is measurement-only pending migration approval. MEM-1/3/16 preserve
  search freshness/result contracts instead of introducing approximate or
  failure-suppressing behavior. This delivery does not claim those costs solved.
- The first delete-plan probe hit Bun's “SQL statements in progress” when the
  DELETE EXPLAIN statement preceded a transaction; running the plan after the
  timed deletes fixed the benchmark, not production code.
- AFT inspection reported fresh TypeScript diagnostics but unavailable Biome
  producer/Tier-2 analysis. Real package typecheck/lint commands above passed.
  Callgraph results were marked borrowed/name-resolved; they were not treated as
  authoritative line numbers for this checkout.
- Earlier parallel suites hit host-contention timeouts in unchanged git-fixture
  setup and Pi startup maintenance. Focused reruns and the final full plugin /
  serial Pi suites passed. No timeout budget or pre-existing test was relaxed.
- Package installs were the existing frozen-lockfile suite step; no manifest or
  lockfile changed. Rust verification was not run because no Rust target changed.
