# TypeScript transform performance audit

## Scope and method

Baseline: the supplied worktree base, `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. Measurements started before any runtime edits. No parent checkout, live database, migration, persisted format/epoch, config schema, or public CLI was changed. The original measurements used library fixtures; subsequent real-host verification is reported separately. Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1, macOS arm64. Timings are medians of three warm samples; the shared machine introduces noticeable variance.

The fixture has 1k, 10k, or 60k tagged messages with distinct ~600-character bodies and stored token counts. Head-injection measurements use ~48 KiB m0 and ~12 KiB m1; a separate clone measurement includes a 2 MiB mural URL. The 60k *full wire* is an intentionally oversized stress fixture, not a claim that a real provider accepts millions of tokens. SQLite fixtures are throwaway files or `:memory:` databases. Before/after differential code is extracted from git into a temporary directory inside this worktree, with dependencies linked only to this worktree; it is removed afterward. The original library fixtures did not launch hosts; the follow-up host instrument collects `lsof` ownership evidence.

The parent explicitly chose **safe reductions with exact historical-edit detection**, rather than weakening undo/edit safety to claim a strictly tail-only pass. TX-9 stops at measurement. Whole-message validation remains linear, but tokenizing, serializing and hashing unchanged message content no longer happens in the append baseline refresh.

## Main before/after results

Milliseconds per pass, same fixtures and benchmark:

| Stage | 1k before → after | 10k before → after | 60k before → after |
|---|---:|---:|---:|
| Genuine append hygiene refresh (new last id on every sample) | 6.673 → 1.770 | 57.505 → 15.202 | 3291.659 → 116.504 |
| Default assertion walk | 1.893 → <0.001 | 19.818 → <0.001 | 2920.647 → <0.001 |
| Final-wire token estimate | 6.475 → 0.178 | 68.917 → 1.428 | 418.860 → 11.665 |
| Token-total SQL for one uncached owner | 0.309 → 0.035 | 2.828 → 0.023 | 24.901 → 0.024 |
| Real full transform, DEFER median, in the paired wire comparison | 20.023 → 10.420 | 137.504 → 93.322 | 23797.752 → 885.866 |

The opt-in assertion is still a full walk: with `MAGIC_CONTEXT_DEBUG_ASSERTIONS=1`, it costs 1.371 / 12.569 / 2271.020 ms at 1k / 10k / 60k. Its content signature remains identical. NODE_ENV does not enable or disable this explicit flag.

A separately rerun paired append-only measurement gave 4.139 → 4.875 ms at 1k, 54.271 → 45.665 ms at 10k, and 2795.904 → 137.096 ms at 60k. Small-fixture timings are noisy and do not establish a reliable 1k speedup; the removal of the 60k eviction/rehashing cliff is clear in both runs.

## Finding table

Unless noted otherwise, times below are the 60k fixture, milliseconds per stage/pass. “Unchanged” means no runtime edit for that finding, not a claimed speedup from incidental timing variance.

| Finding | Classification | Before → after | Commit | Regression test / evidence | Notes |
|---|---|---|---|---|---|
| TX-1 | NEGLIGIBLE | cached head inject 0.661; unchanged | — | `tx.ts`, head-injection fixture | Under 1 ms; left unconditional tokenization alone, as the parent requested. |
| TX-2 | CONFIRMED | append refresh 3291.659 → 116.504 | `a2e875679639` | `reuses unchanged message content on append while detecting historical in-place edits`; cross-message sentinel test | Immutable snapshots share immutable strings and unchanged containers; only differing messages do expensive content work. Still compares all historical messages. |
| TX-3 | CONFIRMED | default assertion 2920.647 → <0.001 | `a2e875679639` | `requires the explicit debug flag for content assertions regardless of NODE_ENV` | Only `MAGIC_CONTEXT_DEBUG_ASSERTIONS=1` enables it. Production structural guard retained. PI-4 is the Pi worker's separate flag change. |
| TX-4 | CONFIRMED | append refresh 3291.659 → 116.504; standalone full walk 3171.838 → 2069.315 | `a2e875679639` | Existing image/zero-token/content-hash tests, new append test, differential | Content maps use kind + immutable content rather than copying composite keys; streaming kind/NUL/content FNV gives the same digest. Standalone full-walk memo still has the 64 MiB cap and can thrash. |
| TX-5 | CONFIRMED | final estimate 418.860 → 11.665 | `a2e875679639` | `invalidates exact-content counts for in-place historical text and nested tool edits`; existing fit/attachment tests | Exact serialized-content memo; tokenizer identity/fallback invalidates counts. Non-string fields are still serialized on every estimate. |
| TX-6 | NEGLIGIBLE | unchanged write 0.072; unchanged | — | `tx.ts`, actual file-backed SQLite write | Left writes alone, as the parent requested; avoiding them remains relevant to a separate writer-lock/cache-clock audit. |
| TX-7 | NEGLIGIBLE | three decisions 0.111; unchanged | — | `tx.ts`, real `mustMaterialize` | Under 1 ms for the 48/12 KiB memory-disabled head fixture. |
| TX-8 | CONFIRMED, partly fixed | one-owner totals 24.901 → 0.024; three active reads 146.594 → 115.025 (not optimized) | `3085f0fab434` | `scopes token totals to exact missing owners without losing old tool or content-derived tags`; existing hot-pass guard | Uses existing indexes and requests only missing ids, not a tag-number floor. Preserves old invocation owners, NULL owners, content-derived ids, null counts and overlapping ranges. Active-row duplication still needs mutation-aware sharing; no per-session meta version added. |
| TX-9 | CONFIRMED, stopped | invalidated replay 58.964; warm copy 0.350; unchanged | — | `tx.ts`, existing rollback/external-commit replay cache tests | Proposed meta-version clock needs a prohibited schema change. Parent explicitly directed measurement only. |
| TX-10 | CONFIRMED, partly fixed | source read 52.880 → 41.637 | `ef5a4fd7fcc0` | `reads large source-id sets with one reusable statement and no stale content`; mixed served-wire digest | One cached JSON-list statement instead of changing IN-list compiles. Still retrieves required original text and scans assignments: restricting to present part indices would omit source needed by ordinal/remapped-part replay. |
| TX-11 | CONFIRMED | scoped inert lookup 180.817 → 7.527 | `ef5a4fd7fcc0` | `batches exact inert owners, including wildcard characters and duplicate ids`; whitespace replay suites | One statement with per-owner indexed ranges. Kept complete owners JSON key; first/last/count alone would miss interior edits. |
| TX-12 | NEGLIGIBLE | head clone 0.008, presence read 0.012; unchanged | — | `tx.ts`, additional 2 MiB mural clone 0.231 ms | No clone or baseline-presence query change. |
| TX-13 | CONFIRMED | 60k × three whitespace probes 128606.408 → 1913.024 | `ef5a4fd7fcc0` | Existing whitespace/retirement tests; indexed-query plans | Root cause includes SQLite choosing tag-order scans for the LIMIT lookup. Seek existing message-id index; cache tag/source statements. `getTagNumberByMessageId` was already prepared-cached, contrary to that portion of the static audit. Per-part calls remain; this is an extreme all-parts probe stress case, not an ordinary pass. |
| TX-14 | CONFIRMED | paired 98%-active read 41.216 → 25.755; compiles across four passes 268 → 1 | `ef5a4fd7fcc0` | Existing visible-target dropped-row guard; `preserves dropped replay chunk ordering and reloads statuses on cached statements`; `tx-replay.ts --reads-only` | Kept 900-id chunk ordering and cross-chunk duplicate behavior. Cold one-time JSON statement compile, zero additional warm compiles. All-active stage timing alone is noisy (26–53 ms after); paired mixed-state read is the stronger evidence. |
| TX-15 | CONFIRMED | half-wrapper removal 95.671 → 9.656 | `8b329bebb87e` | `compacts many removed wrappers in place while preserving survivor references and order` | Single write-index compaction, same array and survivor objects. Legacy/scoped sweep policy unchanged. |
| TX-16 | POLICY, outer bound already fixed | 60k-entry scalar-map construction 8.642; unchanged | prior `38fe5c6dbff2` | Baseline fixture retains 59,999 frozen prefix parts; `transform.ts` outer token map already bounded to 100 sessions | This benchmark does not establish an idle-host lifetime leak. Unbounded live baselines/inner maps remain. Evicting decision-related baselines can reset generation/reduced-since-refresh state and affect nudges; left to an ownership/reconstruction design, not silently weakened here. |
| TX-17 | CONFIRMED | frozen decision parse 46.967 → 11.676 | `3a2c004cd153` | `isolates decoded frozen decisions from callers and keys on complete encoded bytes` | Bounded exact encoded-string memo; copies returned arrays; first-wins and malformed-decision behavior unchanged. |
| TX-18 | CONFIRMED, deferred for correctness | actual all-status preload 16.704 ms in isolation; 16.7–34.6 ms across runs; unchanged | — | `tx.ts`, actual `getAllStatusTagTokenTotalsFlat`; hypothetical 32-owner range 0.040 ms | Did not pass the live-wire floor into raw-history recovery: native host compaction can omit raw eligible messages not covered by MC compartments. Losing their stored mass can change a persisted boundary. Needs a separately proven raw-range floor, not the tempting wire-floor shortcut. |

The adjacent double structural signature costs 17.655 ms at 60k and remains a diagnostic guard. Rust-mode served-ledger JSON work is owned by the Rust-bridge area, not changed here.

## Cache safety and residual work

- Replay snapshot memo: at most eight snapshots, estimated 128 MiB total (previously 32 MiB). The old 32 MiB limit excluded the 60k fixture on every pass. Snapshots copy all mutable containers; strings are immutable shared values. Every message is compared exactly, including same-length nested edits through reused objects. Tool ownership and paired dropped sentinels are revalidated, and tags/protection/queue state recompute attribution rather than borrowing stale U.
- Content memo: still 100k entries / estimated 64 MiB; digest byte sequence unchanged. No content is skipped merely because its message id, count, tail id, or length matches.
- Final-wire count memo: 100k entries / 128 MiB **text budget**, keyed by complete serialized text and actual tokenizer object identity. Falling back invalidates native counts. Images, route calibration, tool definitions, completeness and framing policy remain uncached/live. These budgets trade bounded process memory for avoiding repeated BPE work; they are not RSS guarantees.
- Frozen reasoning decode memo: 100k entries / estimated 32 MiB; entire encoded string is the key, and callers receive fresh mutable arrays.
- SQL caches retain **statements only**, keyed weakly by the database. They never retain rows or source content. Local changes, external commits and rollback are observed by the next execution.
- Historical comparison, tool attribution, prefix comparison/calibration/signature construction and structural alarms remain linear. At 60k, append hygiene is ~116–137 ms, final estimate ~12 ms, structural alarm pair ~18 ms, source reads ~42 ms, and three independent active-row reads ~115 ms. The full oversized-wire defer pass is ~886 ms. The missing-owner SQL is ~0.024 ms, independent of stored history size in this fixture. **This is not a claim of a strictly O(new-tail) entire pass.**

Pi imports the shared hygiene, token-estimate, tag/source and frozen-decision code, so those changes stay in step automatically. No Pi host file was edited; the explicit PI-4 assertion flag is owned by its worker. Rust has its own measurement implementation and was not edited; token/digest formulas and persisted decisions were retained, with existing TS/Rust-mode host parity tests passing.

## Byte identity and verification

`tx-replay.ts` runs the actual before/after `createTransform`: one initial HARD render and three DEFER append passes per size. All **12 returned transform arrays**, three persisted tag-decision snapshots, effective U/T pairs, and persisted m0/m1 plus frozen-strip decisions matched. This is an isolated equivalent before/after wire comparison, not a live-host capture. The extra dropped-read comparison matched 12 before/after array pairs at 98% active tags. Existing pinned served-wire digest, replay, image/mural, whitespace, fold, pressure and TS/Rust-mode host parity tests passed in the full suites.

### Follow-up: real OpenCode 1 host

The requested `packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only` comparison was subsequently run between `ee9d82912cd8105322672a1f5dd1bbb7172a2f46` and the verified runtime branch commit `882e2413d9e65b1e377133db98bcec20cafa68bc`, on the installed **OpenCode 1.18.30** host with Bun 1.4.2. It ran alone as a background command under an outer 3,600-second timeout and exited 0 after ~29 seconds. Baseline and candidate hosts were sequential, with fresh throwaway HOME/XDG/config/data roots inside this worktree. No further optimization or product/harness change was made.

The standard instrument reported **`RESULT IDENTICAL defer_passes=4`**: all four paired DEFER message arrays, system prompts and tool definitions matched, and neither host changed its warmed m0 generation. `tx-host-replay.ts` adds only archive-root plumbing and read-only observations to a temporary copy of that instrument. Its stronger check compares the actual mock-provider `rawBody` buffers, without parsing/re-serializing or removing `cache_control`/metadata. **All six paired main-provider HTTP request bodies matched byte-for-byte**, including both warmups and all four DEFER passes:

| Main request | Bytes, each host | SHA-256, identical on both hosts |
|---|---:|---|
| Warmup 1 | 49,828 | `a2ef8fbd2bc3e9e4a18386871cc472d8863fda45bcf557466aa9c27582f8cdab` |
| Warmup 2 | 49,991 | `15230c2179ff764cb3a9c6ed25c46f5659b8f26d6625e2441fbb59d780a1f9ff` |
| DEFER 1 | 50,157 | `ac73819f638194a9053983827f80b11b1a0768cec7060070c9d8c259658daf1b` |
| DEFER 2 | 50,323 | `913220f7970291aaf4b067c82f64a24fb2d74acf3c024debdec56a44450b3d5f` |
| DEFER 3 | 50,489 | `13f87077c5b7260c8ecd527d1244a6920697f38f51be16eabcb66fee8a76af4b` |
| DEFER 4 | 50,657 | `c0a18968d8439c7067a9e8b0702b4ea3d613085d3e157b1c58c1c1d2f680f888` |

After every main request, `lsof -nP -p <host pid> -Fin` inventories were checked against the actual `stat` inodes of both databases, not merely against path strings or a wrapper PID. All open database/WAL/SHM paths were inside that host's fixture, and no operator OpenCode/CortexKit store/config path was present. The existing lsof guard's three positive/negative ownership tests also passed.

| Ref | Host PID | Fixture below `.tx-host-replay-HvgEC9/tmp/` | context.db inode | opencode.db inode | Last lsof inventory SHA-256 |
|---|---:|---|---:|---:|---|
| Baseline | 25236 | `opencode-e2e-RDVAUO` | 2283789320 | 2283789463 | `09ea175e53ea0eb7d10c5bdde67d7a85195f88a580656d3bc156b9fb58689780` |
| Candidate | 26221 | `opencode-e2e-nqfYyS` | 2283804305 | 2283804444 | `e36978e09020f0c23b770dc9f4149c74d482f31d5fe97f6c74dc3f6df558981e` |

Both hosts were disposed and the entire temporary launcher/archive/config/data/proof tree was removed. `/tmp/mc-tx-real-host-final.log` contains the standard comparison, all raw-body hashes and the per-request lsof evidence; no raw log or database was committed. The follow-up changes are solely this report and the reproducible verification wrapper. Plugin script typecheck passed again; the previously recorded complete product suites remain applicable because no runtime code changed.

| Gate | Result |
|---|---|
| `timeout 1200 bun run --cwd packages/plugin test` | Bun 1.4.2: 6,777 passed, 4 skipped, 0 failed; 6,781 tests / 652 files |
| `timeout 180 bun run --cwd packages/plugin typecheck` | TypeScript 5.9.3: all three configured tsc invocations exit 0, including benchmark scripts |
| `timeout 180 bun run --cwd packages/plugin lint` | Biome 2.5.1: 1,200 files checked; exit 0, one pre-existing warning and two infos |
| `timeout 600 bun run --cwd packages/plugin build` | Passed; 667 v1 / 713 v2 bundled modules, declarations, and 4 v2 loader tests |
| `timeout 1200 bun run --cwd packages/pi-plugin test` | Bun 1.4.2: 1,511 passed, 3 skipped, 0 failed; 1,514 tests / 139 files |
| `timeout 180 bun run --cwd packages/pi-plugin typecheck` | TypeScript 5.9.3: both configured tsc invocations exit 0 |
| `timeout 180 bun run --cwd packages/pi-plugin lint` | Biome 2.5.1: 225 files checked; exit 0, one pre-existing warning |
| `timeout 600 bun run --cwd packages/pi-plugin build` | Passed; 966 bundled modules |
| Rust native gates | Not run: no Rust package/code changed; existing TypeScript Rust-mode host parity tests passed |

The package test scripts ran frozen-lockfile installation in this worktree; no manifest or lockfile drift. One intermediate plugin run hit two unrelated 10-second git-commit timeouts in dreamer verify tests; the three matching tests passed on narrow retry, and the final full suite above passed. The dropped-chunk and hot-pass SQL observers were updated to observe logical id chunks and **executions**, respectively, rather than obsolete parameter/compile counts; their contracts were not inverted. Five NON-VACUITY controls each made only its named guard test fail and restored to an empty working diff (details are in the delivery record). Comments were reviewed before each runtime commit.

## Re-run from the repository root

```sh
timeout 180 bun packages/plugin/scripts/perf-audit/tx.ts --after
timeout 1200 bun packages/plugin/scripts/perf-audit/tx-replay.ts --stages-only
timeout 180 bun packages/plugin/scripts/perf-audit/tx-replay.ts --stages-only --only='TX-2 append refresh'
MAGIC_CONTEXT_DEBUG_ASSERTIONS=1 timeout 120 bun packages/plugin/scripts/perf-audit/tx.ts --after --only='TX-3 assertion'
timeout 600 bun packages/plugin/scripts/perf-audit/tx-replay.ts
timeout 180 bun packages/plugin/scripts/perf-audit/tx-replay.ts --reads-only
timeout 3600 bun packages/plugin/scripts/perf-audit/tx-host-replay.ts
```

`--base=<commit>` selects another baseline for the differential driver. `--stages-only` copies the *same current stage fixture* into the archived baseline and runs both versions; it can take several minutes because the old all-whitespace probe is quadratic. These are benchmark-only options, not product CLI/settings.

## Tool issues

- The first bash/read calls briefly returned “tool plane unavailable”; retry succeeded, with an initially clean worktree.
- AFT inspection was PARTIAL (Biome producer unavailable; later TypeScript publication timed out); authoritative package tsc and Biome commands above passed instead. The borrowed call graph warned that its parent index was ahead of this task's base; source was checked in this worktree.
- Targeted formatter initially used the root path and encountered a nested Biome config; running the installed tool from the plugin package resolved it. Product lint always used `bun run lint`.
- The first follow-up verifier attempt stopped before launching a host because git archive was invoked from the nested launcher and emitted an empty subtree. The wrapper now archives from this worktree's real git root while extracted child imports retain their own roots; the corrected real-host run passed.
