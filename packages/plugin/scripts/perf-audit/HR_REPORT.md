# HR performance audit delivery

Baseline: task worktree commit `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`.
Tools: Bun 1.4.2, SQLite 3.54.0, project TypeScript 5.9.3, Biome 2.5.1.
No database migration, persisted cache/epoch change, configuration change, public
CLI change, or protected architecture/documentation edit was made.

## Measurement and classification

Fixtures contain 1k, 10k and 60k messages, timestamp ties, 300-character message
metadata, alternating roles, text, and 14 KiB tool outputs every tenth message.
The live measurements used a credential/account-scrubbed, read-only VACUUM copy
of the 39,024,107,520-byte OpenCode database. The two measured sessions contain
152,375/132,923 stored rows and 152,371/132,921 canonical rows. Timings are wall
clock, not a CI latency guarantee; the shared machine's load varied substantially.
Paired range/store/notice measurements report medians of five runs. Other
measurements are single passes, with cold and warm runs distinguished below.

| Finding | Classification | Before → after | Commit | Regression evidence / notes |
| --- | --- | --- | --- | --- |
| HR-1 | CONFIRMED | 60k: page-100 traversal 5,408.90 → 641.84 ms; page-32 traversal 16,879.84 → 955.38 ms; tag keys 16,248.67 → 617.22 ms. Live late page: 152k 359.13 → 5.63 ms; 133k 238.96 → 4.45 ms. | `2a8927d71c` | `forwards the cursor through raw page and tag-key readers without changing part indexes`; full page/tag-key hashes unchanged. Underlying paging was already fixed in `96fe1cb15c` (release note `355c562e`), but the public wrapper, FTS traversal and tag scan missed the cursor. |
| HR-2 | CONFIRMED, audit overstates rebuild multiplicity | Eight removals, actual live source with HR-1 keyset held constant: 152k 48,888.58 → 14,906.43 ms, 3,048 → 1,524 pages; 133k 37,668.45 → 13,291.47 ms, 2,660 → 1,330 pages. Clears 8 → 1. | `2a8927d71c` | `coalesces a removal burst into one authoritative rebuild`; `rebuilds again when a removal lands during paged reconciliation`. The burst produced two full rebuilds, not eight, because the old reconciliation latch already suppressed some work. Live FTS stores were disposable files. |
| HR-3 | CONFIRMED; stopped with parent approval | 60k chunk: 267.86 ms, warm 244.86 ms. Live full-range hydration lower bound: 152k 35,244.63 ms / 2,048,158,254 serialized bytes; 133k 28,654.44 ms / 1,541,094,847 bytes. COUNT: 270.91 / 217.04 ms. No production change. | — | Complete eligible-range tool arcs and distant results are observable chunk output; bounded lookahead would change bytes/metadata. See redesign requirements below. |
| HR-4 | CONFIRMED; bounded hydration fixed, ordinal scan remains | Paired live two-id query: 152k 381.31 → 316.62 ms, 152,371 → 2 hydrated rows; 133k 241.69 → 210.34 ms, 132,921 → 2 hydrated rows. | `2a8927d71c` | `hydrates only the requested id range while preserving malformed-row ordinal holes`. LIMIT/OFFSET remains an O(n) SQLite ordinal seek, but no whole-history JS JSON parsing/map construction. A true O(1) ordinal lookup needs an authoritative anchor. |
| HR-5 | CONFIRMED; existence fixed, point ordinal derivation stopped | Existence: 60k 15.36 → 0.13 ms; live 152k 227.41 → 0.39 ms, 133k 242.11 → 0.23 ms. Full point lookup remains 237.80 / 236.39 ms on the live baseline. | `2a8927d71c` | `checks existence without parts and excludes malformed, summary and cross-session rows`; legacy numeric-summary edge behavior retained. No ordinal/part load for ordinary existence queries. |
| HR-6 | CONFIRMED; payload retention and probe allocation fixed | 60k exact serialized retained-part representation: 119,146,893 → 3,684,000 bytes, measured with projection neutralized/restored. Probe 9.49 → 3.23 ms. | `855de76c68` | `retains only turn flags for both pending and known parts`; `reveals prior turn flags after removal and keeps equal-time insertion order`. Historical flags remain to support removals. These are representation bytes, not process RSS; session/history cardinality is not newly bounded. |
| HR-7 | CONFIRMED | 10k-wire repeated note: uncached 83.31 → warm 8.36 ms. Cold after is 139.12 ms and still hashes. | `2f8b3f3943` | `shares exact digests but rehashes same-id metadata, type and nested content changes`; existing bounded-projector and LKG replay tests retained. Shared in-memory memo is capped at 16 MiB estimated retained bytes and 20k entries. |
| HR-8 | CONFIRMED; common message path fixed | One message invalidation among 60k keys: 1.93 → 0.06 ms. | `7261a237c9` | Revision/session isolation, id prefixes, delimiter-containing ids and non-id field matching tests. Indexes all NUL-enclosed fields to preserve the old predicate; deletes/evictions unlink secondary entries. Session-only substring invalidation intentionally still scans. |
| HR-9 | CONFIRMED for tags; NEGLIGIBLE for compartment id slice | Paired 60k-tag publication query: all-then-active 25.63 → active-only 2.97 ms. 600-compartment id slice: 0.89 ms, unchanged. | `6669265941` | Existing composite-owner drop-queue tests and active-result hashes. Same ordered active subset and same pending drops. No new compartment query for a sub-millisecond cost. |
| HR-10 | NEGLIGIBLE on measured trigger chunk | 60k, 4,096-token budget: entire resident formatting/arc stage 6.37 ms, an upper bound on running-sum BPE, versus 244.86 ms DB-backed chunk (<2.7%). | — | An exact memo candidate retained identical output but did not produce a material stage improvement; it was reverted. No chars/4 heuristic or threshold change. |
| HR-11 | POLICY | Prefix-fit search 34.54 ms on a 60k-paragraph / approximately 3.5M-character prompt; unchanged. | — | BPE of each rendered prefix plus truncation marker defines the current selected character boundary. Token offsets from the original prompt do not preserve that selector. `historian-prompt-fit.ts` is owned by another worker and was not edited. |
| HR-12 | CONFIRMED; stopped with parent approval | Live seed last 100: 152k 331.62 ms; 133k 307.14 ms. 60k fixture 36.92 ms. No production change. | — | Global canonical ROW_NUMBER has no trusted supplied ordinal anchor. Existing seed output hashes unchanged; see redesign requirements below. |
| HR-13 | POLICY | Active-tag query 2.97 ms with 60k tags / 100 active rows; unchanged. | — | `estimateProjectedPostDropPercentage` uses all active bytes as its denominator and global maximum tag as the reasoning-age basis. Scoping to taggerFloor changes decisions. At the trigger call, the transform has no preloaded whole-session active list; its later tagger initialization is floor-scoped, not an equivalent snapshot. |
| HR-14 | NEGLIGIBLE | Closed-assistant worst path on 60k rows: 0.088 ms median, confirmed three assistant queries and two real-user queries; unchanged. | — | `hr-notice.ts` measures the actual predicate's non-short-circuit path, not a tool-wait early return. |
| HR-15 | NEGLIGIBLE on measured reader stage | Actual 60k fixture message JSON: twice 23.73 ms, once 9.95 ms; avoidable 13.78 ms is 3.3% of the same-run 415.98 ms full reader. | — | Measured actual stored row JSON, not only tiny role/finish records. No parse refactor for this below-5% stage cost. |
| HR-16 | NEGLIGIBLE | 73,728-byte response dump, mkdir/write and artifact gitignore helper: 0.39 ms on 60k fixture run; unchanged. | — | Only throwaway artifact paths used. No change to response diagnostics or failure behavior. |
| HR-17 | NEGLIGIBLE | Usage TTL scan over 1k sessions: 0.047 ms; unchanged. | — | No throttling or delayed expiry decision. |
| HR-18 | NEGLIGIBLE | Connection plus two schema queries 0.63 ms; actual 60k model probe 34.76 ms (fixture deliberately has no model-bearing row). Connection overhead <2% of that stage; unchanged. | — | V1 and V2 guards/connection ownership left intact. |

## Stopped work and remaining contracts

The parent explicitly approved leaving byte-changing/durable-anchor portions
unchanged and requested live 133k–152k measurements. The measurements above meet
that request without retaining multi-gigabyte message arrays in the worker:
HR-3's full-read time is the sum of actual bounded raw-page hydration times, a
lower bound that excludes all-history arc building, tool expansion and formatting.
Repeat unchanged live hydration took 50.32/55.31 seconds under higher machine
load, illustrating why single-pass times are not CI limits.

- **HR-3:** `readSessionChunk` exposes `completedToolArcs` for the entire eligible
  range, and tool results anywhere in that range can alter an earlier invocation's
  preview. A streaming redesign needs a contract separating whole-range arc
  metadata from budgeted emitted text, or a cheap complete arc/expansion prepass
  that demonstrably retains every emitted byte. A persisted arc index would need
  a migration and source revision/deletion invalidation. A runtime prepass need
  not migrate, but cannot promise bounded lookahead or eliminate the whole scan.
  Hoisting COUNT needs a run-owned snapshot/total invariant across concurrent
  source appends, removals and summary filtering, not a stale count cache.
- **HR-5 point ordinal:** callers supply only session and message id. Avoiding
  prefix COUNT needs a trustworthy `(ordinal, time_created, id)` anchor for this
  canonical filtered message space. Reusing a durable shadow ordinal registry
  requires an explicit freshness contract for deletes/reverts/compaction and
  timestamp ties; adding one for v1 is a migration. A run-scoped validated anchor
  could avoid a migration but must be passed through the caller contract.
- **HR-12 seed:** callers supply only boundary id. Local ROW_NUMBER can replace
  the global window only with that boundary's known canonical ordinal and keyset
  tuple. Computing the ordinal via COUNT merely substitutes another O(n) JSON
  scan. The same durable/run-scoped anchor choices apply as for HR-5, while
  preserving missing-boundary errors, summary exclusion and absolute ordinals.
- **HR-4:** the safe change bounds hydration, not SQLite ordinal seek work.
- **HR-6:** arbitrary cardinality eviction without a reliable source fallback
  could change turn holds after the newest row is removed. Only heavy payload
  retention and sort/copy work were removed; historical lightweight flags remain.
- **HR-8:** session matching was historically an arbitrary key substring. An exact
  session secondary index needs a stronger namespace contract; only the frequent
  exact-field message invalidation was optimized here.

Existence fast-path parity assumes ordinarily valid OpenCode message JSON. The
legacy point lookup's prefix COUNT can throw on a malformed *predecessor* row;
the new existence query does not evaluate unrelated rows and therefore need not
reproduce that incidental error. Malformed target rows still return false, and
full point lookup/ordinal behavior is unchanged. No wire divergence was observed
on the scrubbed live sessions or the canonical reader fixtures.

The historian reference/prompt-fit files were not edited. Shared readers and
token invalidation benefit Pi and TS/Rust host lanes without changing their
contracts. LKG note reuse also benefits the Rust host wrapper; Pi's independent
LKG implementation and Rust crates are not twins of this particular shared memo
and were not changed. No native Rust build was required.

## Byte identity, non-vacuity and verification

- `hr-compare.ts`: 81 before/after fixture hashes and 18 live hashes matched.
  They cover raw pages (including full 60k traversals at both page sizes), chunks,
  tag keys, full readers, ordinal ranges, point/exists lookups, seed tails and
  pristine LKG digests. Live hydration hashes cover the complete two sessions.
- Real-host differential via `hr-replay-isolated.ts ee9d829... 6669265941`:
  four defer passes were IDENTICAL for wire, system and tool hashes, with wire
  sizes 588, 754, 920 and 1088 bytes. This runs the existing
  `pure-replay-differential.ts --ts-only` instrument unchanged except for a host
  fd inventory after prompts, held constant for both refs.
- `lsof` sampled host pids 17868 and 33315 on every prompt: all opencode.db and
  context.db handles/sidecars were under their respective throwaway e2e roots.
  Live reader pid 48406 and live FTS pids 61986/69338 likewise held only copies
  and disposable stores under the throwaway audit root. The large live copy and
  its sidecars were deleted; FTS copies and fixture stores were deleted as well.
- Actual query plans: OFFSET seeks only `session_id`; keyset seeks
  `message_session_time_created_id_idx (session_id=? AND time_created>?)`.
- Neutralizing removal coalescing: only `coalesces a removal burst into one
  authoritative rebuild` failed (clears 8 instead of 1); 15 peer tests passed,
  including removal-during-reconciliation and boot-quiet overtaking.
- Neutralizing part projection: only `retains only turn flags for both pending
  and known parts` failed (1,980,258 retained bytes vs <1,024); 42 peer tests
  passed, including removal recovery, equal-time order and real/ignored users.
- Neutralizing bounded range hydration: only `hydrates only the requested id
  range while preserving malformed-row ordinal holes` failed (1,002 rows vs 4);
  cursor/part-index and existence tests remained green. Each mutation was staged
  before changing code, captured a non-empty diff, and restored to an empty diff.
- Full plugin suite: `timeout 1800 bun run --cwd packages/plugin test`:
  6,777 pass, 4 skip, 0 fail; 6,781 tests / 652 files, 203,534 assertions.
- Full Pi suite: `timeout 900 bun run --cwd packages/pi-plugin test`:
  1,511 pass, 3 skip, 0 fail; 1,514 tests / 139 files.
- Plugin and Pi package `typecheck` scripts passed (project TypeScript 5.9.3).
  Plugin scripts were typechecked again after the final measurement scripts.
- Plugin/Pi `bun run lint` passed: Biome 2.5.1, 1,200 / 225 files. Existing
  unrelated warnings remain (one warning in each package; plugin also two infos).
- `timeout 900 bun run build` passed for plugin, Pi and CLI, including four v2
  server export/load tests. No manifest or lockfile drift.
- After restoring the last controls, 62 impacted reader/event tests passed with
  150 assertions; final types and lint passed. Comments were reviewed before
  committing. No existing test was weakened, renamed or reversed.

All benchmark/test/script commands used an outer timeout. Re-run entry points
are documented at the top of each script. Large live runs require a freshly
scrubbed read-only copy under `$TMPDIR/magic-context/perf-hr/`; scripts reject
unscrubbed tables and paths outside that throwaway root.

## Tool issues

- The initial VACUUM copy timed out at 180 seconds after writing 19 GB. The
  incomplete copy was deleted; a 1200-second copy succeeded. Live source was
  opened with `mode=ro` only.
- Initial fd validation compared `/var/...` to macOS lsof's `/private/var/...` and
  incorrectly rejected a safe copy. Validation now uses the root's realpath;
  later live runs and host fd inventories passed.
- AFT inspection was partial because its Biome/Tier-2 producer was unavailable
  in this worktree. Repository types and lint supplied authoritative verification.
- A package-runner version-only probe resolved a different tsc (7.0.2). It was
  not a verification gate. Project-local `typescript/bin/tsc --version` confirmed
  5.9.3; every type gate used the repository's named package script.
