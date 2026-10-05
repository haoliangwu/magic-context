# Post-0.45.0 adversarial cache review

## Verdict

**Two confirmed should-fix cache defects: MEM-2 and MEM-10 publish transaction-local
observations into process caches that survive rollback.** Both are reproduced by
the committed, deliberately failing tests in
`packages/plugin/src/features/magic-context/post045-cache-review.test.ts`.
Fix their transaction fencing before calling the range cache-safe.

The **byte-identical regression test file passes both tests against archived
v0.45.0 source**, with fresh in-memory stores, and fails both at the endpoint.
This isolates new regressions rather than relying only on a suspicious clock.

No new served-prefix or signed-thinking blocker was demonstrated at the reviewed
endpoint. This is **not** an unconditional fleet sign-off: the tests below are
selected source-level checks, not a new whole-range real-provider replay or a
power-loss experiment. Neither finding establishes that today's ordinary tool
dispatch necessarily searches inside a transaction; both establish an incorrect
public storage-helper result after a supported SQLite transaction/rollback.

This delivery changes only this report and the two regression tests. Product
code, architecture/structure documents, configuration, schema and stores remain
unchanged. The new tests are intentionally red, not skipped or inverted.

## Scope and method

- Reviewed **`cb6724d69d` (v0.45.0) through `bf2a127e52504593a58fe796b1a596b3ad9dee0f`**.
  All source locations below refer to the latter endpoint. The net range contains
  300 changed paths, including large trial evidence, generated goldens and audit
  instruments; this is not 300 product-code files.
- Read the protected architecture section first. Examined the changed production
  hunks, their surrounding implementations, relevant tests, generated contract
  inputs, both issue-619 reviews, the SQLite corruption diagnosis, and all ten
  performance-area reports. Reports were treated as claims, not as executed
  evidence from this review.
- Traced cache keys to their actual comparisons and SQL clocks. In particular,
  compared MEM's revision-keyed caches with Pi's and schema discovery's explicit
  transaction bypasses, then constructed rollback counterexamples.
- Archived release source below the worktree's ignored scratch root, linked only
  this worktree's installed dependencies, and ran the same test file against it.
  A file comparison confirmed the two copies of the test were byte-identical;
  the production sources were distinct git revisions, not a self-comparison.
- Checked the intermediate issue-619 accounting repairs, including the subsequent
  terminal-edit repair `f34200a0cf`; the earlier reviews' line numbers and open
  findings cannot simply be carried forward onto the endpoint.
- All executions used in-memory stores or disposable roots. HOME, XDG paths and
  TMPDIR were redirected into `node_modules/.cache/post045/` in this worktree.
  No live OpenCode/CortexKit store or configuration was opened. No host/paid
  provider was launched. Commands had outer `timeout`s; native checks ran
  sequentially with `-j 2`.

## Confirmed findings

### R1 — should-fix: a rolled-back embedding remains in commit-search results

**Location:**
`packages/plugin/src/features/magic-context/git-commits/search-git-commits.ts:38–65`,
consumed at `:246`. Introduced by **MEM-2 / `7356f5784b`**.

The connection-local vector cache uses
`(total_changes(), data_version, schema_version)` as its revision and
`(projectPath, modelId)` as its entry key. This correctly observes ordinary local
writes, sibling commits and schema changes. It does **not** distinguish the state
after an in-transaction read from the state after rollback:

1. Seed two committed git rows. Their vectors are `[1,0]` and `[0,1]`.
2. Search with `[1,0]`: the first row wins.
3. `BEGIN`; change the second vector to `[1,0]`; search again. The newer second
   row wins the equal-score tie and its temporary vector is cached.
4. `ROLLBACK`. A direct BLOB read proves the second vector is `[0,1]` again.
   `total_changes()` still has exactly its pre-rollback value; this connection's
   `data_version` and the schema clock have not changed.
5. Search again: **the second row still wins**, rather than the first.

This is a stale semantic score/result, not just a timing regression. The wrong
vector can survive arbitrary read-only calls until another revision-changing
write, external commit, eviction or process restart. A savepoint rollback after
such a read has the same clock problem. Undo through a *new committed write*
does invalidate correctly and is not this counterexample.

**Executed failing test:**
`post045: commit vector memo discards a rolled-back transactional observation`
(`post045-cache-review.test.ts:32–65`). The last assertion expects SHA ending `1`
and receives SHA ending `2`; the preceding assertions prove both the temporary
state and the successful durable rollback. Expected values are literal vectors
and independent row identities, not a second call to the optimized vector loader.

**Suggested fix:** read live vectors without adopting a memo whenever the handle
is in a transaction, including nested savepoints. Cache only when the backend
authoritatively reports autocommit; unknown/proxy transaction state should bypass
too. Clearing the connection's memo on a transactional read is the conservative
option. Do not fix this with a TTL or `total_changes()` alone. Preserve the current
external-writer and project/model isolation checks.

### R2 — should-fix: a rolled-back memory remains in dream backlog telemetry

**Location:**
`packages/plugin/src/features/magic-context/dreamer/task-gates.ts:494–537`.
Introduced by **MEM-10 / `37646702d1`**.

The backlog and non-expiring-pool eligibility caches use the same revision triple
as R1, again without a transaction fence. Reproduction:

1. Commit one non-expiring, active, unmapped architecture memory. Backlog is
   `{pending:1,total:1}`.
2. `BEGIN`; add a second non-expiring memory; read backlog
   `{pending:2,total:2}`. That transactional observation is memoized.
3. `ROLLBACK`; direct SQL proves only the first memory exists and the change
   counter is unchanged since the transactional read.
4. Read backlog: **it still reports `{pending:2,total:2}`**.

The expiry guard, cloning of returned results, and distinctions among omitted,
null and non-finite options do not fence transaction lifetime. The same flaw can
retain a false zero or an incorrect eligibility result, not only an overcount.
Sidebar/status/manual-dream consumers use this helper; this review does not
claim the autonomous scheduler's separate per-task gate is itself memoized here.

**Executed failing test:**
`post045: backlog memo discards a rolled-back transactional observation`
(`post045-cache-review.test.ts:68–87`). It expects 1/1 and receives 2/2 after an
independent SQL assertion that the temporary memory is gone.

**Suggested fix:** apply R1's authoritative-autocommit/bypass rule to **both**
`entries` and `eligibleProjects`. The already-implemented transaction bypass in
`storage-schema-helpers.ts:19–34` and Pi's snapshot reader shows the intended
local convention. Keep the time/expiry guard; fixing rollback does not replace it.

## Cache-by-cache accounting

“No defect found” here means source analysis plus the listed selections, not an
exhaustive concurrency proof. Rebuilt process-local caches miss on restart;
persistent replay decisions remain the authority for bytes already served.

| Cache/memo added or materially changed | Actual key / lifetime and invalidation | Assessment |
| --- | --- | --- |
| TX-2 per-message hygiene reuse (`tail-hygiene-walk.ts:624–895,1074–1237`) | Previous baseline's parts-array key; detached message id/role/summary/parts, exact nested-value comparisons, current tags/protection/pending drops; contextual tool owners and paired drop sentinels checked separately. Eight snapshots / estimated 128 MiB. | Reused host objects and same-length historical edits do not establish a hit by themselves. Attribution is rebuilt when tag state changes. No new identity/length-only hit found. |
| TX-4 content memo (`tail-hygiene-walk.ts:130–200`) | Kind plus full immutable content string; bounded entries/bytes, FIFO eviction. Streams the original kind/NUL/content UTF-16 FNV input. | Content edits miss, including undo back to exact old content. Reuse is value-based, not owner-based. This memo existed before the range; its key allocation and replay use changed. |
| TX-5 final-wire counts (`final-wire-token-estimate.ts:58–63`) | Entire serialized text plus active tokenizer identity; 100k entries / 128 MiB text budget. Non-text objects are serialized afresh. | In-place nested edits miss. Images, attachment accounting, framing and calibration are outside this memo. `estimateTokens` latches fallback and these entries check the resulting tokenizer identity. |
| Fixed historian/sidebar counts (`read-session-formatting.ts:447–483`, `m0-token-breakdown.ts`) | Full text plus tokenizer object; 64 entries / 8 MiB. | No id/length alias. Same shared helper serves Pi and the TS Rust-mode sidebar; route/model calibration is still live. |
| TX-17 decoded frozen decisions (`merged-reasoning-decisions.ts:4–65`) | Complete encoded immutable decision string; bounded entries/bytes; returned arrays copied. | A caller cannot edit the cached decision array. Session/id collisions with different encoded bytes miss. Persisted first-wins order remains unchanged. |
| SUBC entry projector (`lkg-replay.ts:70–154`) | Session then message id **and exact typed fields**; detached fields; at most 16 sessions / configured 64 MiB default. | A changed leading entry can reuse unchanged successor digests, but each digest is message-local. Duplicate ids still require field equality. Historical metadata edits, contraction and reused wrappers are not accepted by id alone. |
| HR-7 shared pristine digests (`lkg-slot.ts:284–326`) | Id plus exact copied primitive field sequence; 20k entries / 16 MiB estimate. | Even a cross-session same-id lookup compares all typed fields. No mutable message reference is lent. Metadata/types are in the fields, not just visible text. |
| Pi tag snapshot (`tag-snapshot-pi.ts:12–144`) | Database/session; local TEMP tag revision and dirty-number journal, external `main.data_version`; full reload on external change, dirty-number merge on local change. | Transaction reads neither publish snapshots nor consume the journal. Rollback cannot publish its local revision. Returned tags are copied. Session cap is 100. Tests cover local/sibling updates and rollback. |
| Pi fallback negatives (`fallback-tag-probes-pi.ts:18–52`) | Database/session/probe kind plus the same local/external revision; transaction revisions return null and bypass. | Adoption rechecks revisions after preflight; a sibling's fallback insertion is not hidden by a cached negative. This is not a durable tag-identity memo. |
| Pi LKG output and served ledger (`pi-lkg.ts:331–410,673–707,890–910`, `served-array-ledger.ts:194–204`) | Detached JSON-visible typed fields; exact prefix comparison; same-pass serialization returned directly to the ledger. Non-plain serializers/accessors use the old serialization fallback. | Ledger sharing is diagnostic reuse, not authority to rewrite provider messages. Its handoff is immediate and before subsequent host extensions. Session teardown releases ledger/mural/hygiene bodies. |
| MEM-2 commit vectors | Database revision triple; project/model; 16 entries / 32 MiB vectors. | **R1: transaction-local observations survive rollback.** |
| MEM-10 backlogs and eligibility | Database revision triple; project/task order/exact option distinctions; 16-entry bounds; expiring active/permanent pools bypass count reuse. | **R2: transaction-local observations survive rollback.** |
| MEM-5 mural pool/hashes (`resolve-mural.ts:40–66`) | One refresh-local memory/cue snapshot; hash keyed by memory id **and exact content**. | No cross-pass database result cache introduced. The pool is not held across refreshes, and content-hash checks remain; PNG freshness was not replaced with an mtime/id memo. |
| DB-16 schema columns (`storage-schema-helpers.ts:8–48`) | Weak database handle/table map plus live `schema_version`; only known non-transactional handles are cacheable. | Transaction/unknown state discards cache and discovers fresh columns, avoiding rollback/version-reuse aliasing. Local and external DDL are rechecked. |
| Prepared-read caches (tag/source/meta/heal/list/side tables and V2 readers) | Handle plus SQL/projection, not result rows. JSON-list parameters remain bound per execution. | Rollback/external writes are visible to executions. Optional-column list projection assumes the established migrate-then-register/restart-all-hosts lifecycle; a live old host is not newly authorized to survive migration. Statement close is separately reviewed below. |
| RB-13 seed sort keys (`module-state-sync.ts:407–415`) | One invocation; canonical serialized key per seed. | No across-pass cache. Same `localeCompare` and stable tie order; inputs are not altered after key generation. |
| RB-14 page finalizers (`module-wire.ts:529–581,768–773`) | One packing invocation/page; fixed 64-ASCII-byte digest placeholder until page count converges. | Only finalized pages escape. Same canonical page content is hashed; placeholder width preserves admission sizes and field insertion order. No persistent page-hash memo introduced. |
| V2 pooled connections/statements (`store-reader.ts:289–415`) | Resolved path + device/inode/birthtime; generation validation on connect; four retained paths, 128 statement-map entries; reference-counted leases/disposal. | No row cache. WAL updates are queried live; replaced files reopen, absent files throw. In-place destructive restore with open leases is **not** a supported freshness operation; close all native handles first. |
| V2-1 pending synthetic candidates (`channel2.ts:16–51`, `context.ts:1501–1520`) | Weak storage-instance map/session/id; removed after SQL sees the send; disposal clears. | SQL `type='synthetic'` and unprojected local sends are candidates only. Each candidate is still authenticated against storage. No cached admission verdict or prefix-only recognition. |
| V2-3 update checks (`update-check.ts:10–30,61–82`) | Process-module package identity; subscription-local hourly timestamp, persisted timestamp re-read at expiry. | Not served-prompt content. A restart rebuilds it; external timestamp resets inside the hour can be delayed, which is notification throttling rather than a stale prompt decision. |
| Frozen ck-mc role catalog (`lib.rs:3817–3821,12596–12701`) | Project root/session; last successful full catalog with a composition; route lifecycle cleanup. | Preflight/digest-only/failed fetches do not replace it. Compaction comes from composition, not the alias or caller's assertion. See N2 for reconnect obligations. |
| Call-local git/doctor probe maps | Exact paths/timestamps/bases/identity keys for one normalization, evidence or inspection call. | No process-level filesystem memo added. Later invocations re-probe. Existing per-call snapshot semantics and failure fallbacks remain. |
| HR-8 invalidation index / async removal coalescing | Secondary index of the existing exact NUL fields; scheduling state per session, invalidated at clear/start/teardown. | Not a new token-result key. Eviction deletes secondary entries; delimiter-containing ids retain the old scan. A removal during reconciliation can schedule another authoritative rebuild. |

## Defer identity, signed thinking and parity

### Issue 619 endpoint, not its superseded intermediate repairs

The final TS first-edit recorder stores actual message/part locations
(`transform-postprocess-phase.ts:2186–2200`) and checks remaining thinking
(`:3691–3739`) before feeding proactive invalidation (`:3742–3790`). Image,
stale-reduce and sentinel first application feed that recorder; frozen replay
does not. Trailing decisions compare old/new projections before claiming a wire
edit (`:3508–3536`). Thus the first review's unaccounted image edit and the
re-review's terminal over-strip have explicit endpoint repairs, not just a
documentation disposition.

The selected TS suite executed all lane/model combinations for **Opus 5.5,
Sonnet 5.5 and Fable 5.1**, metadata-only/no-op controls, terminal and same-message
controls, frozen replay and the trim-only exception. Those green source tests
are evidence of the repository's binding rules, **not** cryptographic validation
by Anthropic. Primary execute admission is not broadened by the child-only arm.

Pi's positional ledger preserves source order through splices and tests remaining
thinking (`context-handler.ts:5405–5488,7233–7289`). The selected Pi run's thinking
and queued-drop tests passed. The separate generic project-identity fixture had
an environmental failure, disclosed below; it is not counted as green.

Rust keeps an explicitly reductions-only child branch. Its execute permission
does not mint primary-only image/system/stale/age-reasoning strip units
(`transform.rs:5174–5178` and the downstream strip-unit gate). Pi placeholder
discovery remains narrower than execute because it splices messages
(`context-handler.ts:7003–7017`). These are the prior reviews' accepted exclusions,
not evidence that all cleanup lanes share identical semantics. **N3 — note:**
retain those exclusions in fleet documentation/tests; if widening them later,
coalesce actual edits and thinking invalidation on the same priced pass rather
than removing the session-mode checks wholesale.

### Performance changes and byte formulas

- TX-2 compares historical contents before borrowing measurements; TX-4 streams
  the same UTF-16 kind/NUL/content sequence. TX-5 caches the complete text being
  counted. TX-17 keys on full decision bytes, not length or the decoded owner id.
  None introduces a new strip/drop discovery permission on defer.
- RB-13/14 alter allocation/hash timing, not canonical order, digest inputs or
  transmitted page sizes. The page tests compare final canonical digests and
  wire sizes, not the zero-placeholder admission value as an expected digest.
- RT-3 hashes kind bytes, a single NUL byte and content bytes in that order;
  RT-7 still converts borrowed typed fields to the sorted `Value` form before
  hashing. The independent references use the **former concatenation/clone +
  serialize implementations**. Nested key order, identity-namespace omission,
  unknown ingress, Unicode and escapes are represented. RT-9's length-prefixed
  overlay order and RT-14's canonical-number rules are retained too.
- V2-1 filters candidates but does not memoize admission. V2-8 still computes
  the rendered digest and persists each actual identity/cut/render change;
  skipping an unchanged write is not skipping a new fold decision.
- Historian selection is intentionally a prompt-content change, **not** an
  optimization requiring equality with the old 4+6 reference prompt. TS/Pi share
  3 seeds + 3 diverse scored older + 4 unscored recent; Rust mirrors the selection,
  UTF-16 rotation and scored boundary. Fitting selects once, then drops a suffix
  in diverse-before-recent order. Direct band/score assertions supplement the
  TS-generated Rust golden; that golden alone proves parity, not independent
  correctness or improved model summarization quality.
- Rust store changes retain compressor/storage format, literal search semantics
  and eviction order. Date bounds now correctly precede the candidate cap, an
  intentional new-search correction, not a rewrite of prior tool results.

## Notes requiring deployment discipline

### N1 — note: matching NORMAL policies are not cross-file durable atomicity

**Locations:** `shared/sqlite-context-pragmas.ts:12–24`,
`crates/mc-store/src/single_store_domain.rs:77–101`,
`crates/mc-store/src/context_writes.rs:480–516`.

WAL/NORMAL preserves each database's structural consistency but can lose recent
acknowledged commits on power loss. The runtime's two-step pending-publication
protocol replays a surviving pending row; it is not a cross-WAL fsync barrier.
For example, if store.db's final pending-row deletion becomes durable while the
corresponding context.db commit does not, the row is no longer available to drive
that recovery. Giving both handles `synchronous=1` does not make their checkpoint
or device persistence boundaries identical.

This is a reasoned durability boundary, **not a reproduced power-loss defect or
evidence of ordinary WAL corruption**. The reports record an approved policy
choice. Do not promote their commit-latency or process-crash checks into proof of
power-loss pair consistency. Suggested follow-up: document the accepted loss
window explicitly and test asymmetric recovered states with recovery/refusal
assertions before claiming stronger guarantees; use a durable ordering/journal
barrier if acknowledged cross-store state must survive power loss. Back up and
restore both stores from the same consistency point, never one alone.

The offline attached migration deliberately returns to DELETE/FULL for the
super-journal (`single_store_migrate.rs:3274–3294`) and restores WAL/NORMAL afterward.
CLI salvage also restores FULL before leaving WAL. Those exceptions are retained.

### N2 — note: role-catalog lifetime is not a persistent session contract

**Locations:** `crates/mc-module/src/lib.rs:4892–4896,5330–5334,12688–12701`.

The catalog is process-local and is removed when the last route leaves. After a
daemon restart/reconnect, an explicit worker/head `ctx_reduce` call before a new
full catalog fetch sees `compacting=false` and is refused. An omitted-preset call
with no frozen catalog deliberately uses the planless legacy bridge. A fleet
consumer must therefore re-fetch the full frozen composition before resuming
role-aware calls; a digest-only probe cannot restore the grant. Suggested
follow-up: add a reconnect/resume integration test at the consumer boundary, or
persist/re-authenticate the composition if the session API promises continuity
without re-fetch. This review did not establish a consumer violating that rule.

The suspected “one of two routes leaves and destroys the surviving grant” was
tested and **did not reproduce**: `bind_route` checks whether any session route
remains (`:4881–4885`). The temporary test passed and was removed; it is not a
finding or a committed test. The legacy no-plan/versioned-route tests also passed.

### N4 — note: opt-in assertions and bounds are narrower than blanket safety claims

**Locations:** `tail-hygiene-walk.ts:1313–1320`,
`packages/pi-plugin/src/debug-assertions-pi.ts:1–4`, `shared/sqlite.ts:599–610`.

The full post-writer content assertions now require
`MAGIC_CONTEXT_DEBUG_ASSERTIONS=1`, even in development. The production structural
guard explicitly can miss same-length substitutions; it is not an exact-content
proof. The actual TX memo comparisons remain exact. Suggested follow-up: keep
debug-enabled historical-edit/last-writer checks in CI; do not infer their
execution from a default green test run or NODE_ENV.

Statement weak-reference pruning at doubling thresholds is amortized cleanup,
not a hard 256-entry ceiling or an RSS guarantee. A burst of live statements
raises the next sweep threshold; collected references can remain until that
threshold is reached again. That does not make a stale SQL result or prevent
explicit close from visiting the tracked set. Avoid calling it a strict fixed
memory cap; consumers retaining live statements inherently determine that bound.

## SQLite prepare/close review

`shared/sqlite.ts:368–373,559–619` wraps `prepare` without changing run/get/all
binding behavior. Node statements have no `finalize()` and are returned through
the existing Node normalization shim; its savepoint/transaction behavior remains
in that backend, not a new transaction wrapper in this change. Bun preparations
are weakly owned/deduplicated and explicitly finalized **before** native close.
`prepareCachedStatement` also owns direct Bun handles used by the restore tests.

Keeping a statement after close now makes it unusable instead of leaving a native
handle able to checkpoint old pages later. That is the intended correctness
repair, not a supported post-close API promise being silently retained. Close
continues through finalization failures and reports a failure after native close;
it does not declare successful closure while deliberately skipping the handles.
Removing the FinalizationRegistry eliminates the uncaught GC-callback path.

The migration worker closes its finished connection before posting `done`
(`migration-worker.ts:46–55`). A close failure reports an error rather than
announcing migration readiness first. Bun close/restore descriptor tests and the
actual Node transaction smoke passed here. No fresh Linux syscall/host corruption
reproduction was run; the prior diagnosis's FULL-vs-NORMAL control must not be
reinterpreted as “NORMAL caused the corruption.”

## What the previous byte-identity proofs actually cover

| Area | Source of proof inspected | What it proves / what it does not |
| --- | --- | --- |
| TX | `tx-host-replay.ts:116–140` | Compares distinct baseline/candidate **raw body buffers**, six main requests including four defers; does not normalize cache_control. Genuine comparison, but a small deterministic append scenario against `ee9d829…`, not every signed/undo/external-write state or every change since the release. |
| HR | `hr-compare.ts`, `hr-replay-isolated.ts`, HR_REPORT | Reader/ordinal/digest comparisons plus four short real-host defers. This is not a large hot-pass, power-loss or transaction-cache proof. |
| Pi | `pi-wire-compare.ts:30–44` | Four distinct before/after handler-array output files and tag-state hashes at 1k/10k/60k/repeated 60k. It compares actual serialized arrays, **not provider HTTP system/tools/envelope bytes** or later host-extension mutations. |
| RB | `rb-bridge.ts:140–143`, `rb-byte-baseline.json`, RB-results follow-up | Persisted-slot, seed and multipage payload hashes use baseline-captured values, not a current-to-itself oracle. The later replay follows a finite warmed session; sort/page tests additionally pin old formulas. |
| V2 | `v2-wire.mjs:150–202` | Distinct arms restore disposable initial stores and compare captured raw HTTP strings, including an admitted steer and flush. Storage authentication remains separate. Not every restart/admission-lag/pool-replacement combination. |
| MEM | `compare-mem.ts`, MEM-REPORT | Search/backlog/render comparisons on fixed-clock snapshots. The newly added own/external-write tests have **no in-transaction read followed by rollback**; R1/R2 are outside their corpus. |
| DB / RS | sqlite-storage-results, mc-store perf-audit report and tests | Connection pragmas, read/row/compressor/eviction equivalence and process recovery selections. NORMAL latency and fresh-open assertions do not prove cross-file power-loss durability. |
| RT | `perf_audit_compare.py`, raw-wire/state test helpers | Distinct-run raw CK/native-array and SQLite TEXT/BLOB comparisons, with one named housekeeping timestamp excluded. Default reference tests compare prior hash/serialization algorithms. The measured corpus is reconstructed scale fixtures and SOFT+ passes, not exhaustive real-provider histories. |
| UI | UI-report and net diff | Only doctor call-local probing and retina quiet-poll ancestry avoidance landed; dashboard native patch is report material, not deployed product code in this range. No served-prompt memo was added there. |

The fixed audit baseline `ee9d829…` is later than the release. In particular,
issue-619 reductions and historian references intentionally changed behavior
before those optimization differentials. Do not describe the aggregate audit
results as literal equality of every request against v0.45.0.

## Verification executed for this review

Tools: **Bun 1.4.2 (744846f84), TypeScript 5.9.3, Node 24.16.0, Biome 2.5.1,
Cargo 1.99.0 (5f94df478)**. Prefix commands below with an outer timeout and the
isolated HOME/XDG/TMPDIR environment described above.

| Command/check | Result |
| --- | --- |
| `timeout 120s bun test --timeout 30000 packages/plugin/src/features/magic-context/post045-cache-review.test.ts` | **Expected red: 0 pass / 2 fail / 10 assertions**, both exact R1/R2 names. No unrelated failure. |
| `timeout 120s bun test --timeout 30000 ./node_modules/.cache/post045/baseline/packages/plugin/src/features/magic-context/post045-cache-review.test.ts` after `git archive cb6724d69d` | **2 pass / 0 fail / 10 assertions** against release source. Both test files were independently compared and identical. |
| `timeout 300s bun test --timeout 30000` with the 20 plugin files below | **428 pass / 0 fail / 2326 assertions**. |
| `timeout 240s bun test --timeout 30000` with the 8 Pi files below, separate process | **196 pass / 1 fail / 819 assertions**. The unedited project-identity fixture created a “non-git” tmp directory below this git worktree and inherited its git identity, receiving `git:…` where it expected `dir:…`. |
| Filtered retry of that Pi fixture with `GIT_CEILING_DIRECTORIES=$PWD` | **0 pass / 1 fail**, binding unset rather than dir. A further explicit Pi-harness preload did not change this. Neither retry is claimed as green or proof of baseline causality; the temporary diagnostics were not committed. |
| `timeout 180s bun run --cwd packages/plugin typecheck` | **Passed**, all 3 configured compilation commands; compiler version 5.9.3. |
| `timeout 180s bun run --cwd packages/plugin lint` | **Passed**, 1218 files checked, 1 existing warning / 2 infos, no errors or fixes. Biome 2.5.1. |
| `timeout 120s node packages/plugin/scripts/smoke-node-sqlite.ts` | **15 checks passed**, including nested rollback, array binds, readonly and writer-admission behavior; Node 24.16.0. |
| `cargo test --locked -j 2 -p mc-module --lib perf_audit -- --test-threads=1` | **6 pass / 1 ignored**; prior owned canonical/decode/overlay references and raw-wire controls. |
| Same cargo command with filter `digest` | **13 pass**, including borrowed decoded fingerprint, streamed JSON and every-byte hex reference. |
| Same cargo command with filter `streamed_part_hash` | **1 pass**, every kind and edge-content concatenation reference. |
| Same cargo command with filter `issue_619` | **5 pass**, including executed reductions with inherited advisories. |
| Same cargo command with filter `historian_prompt` | **7 pass**, direct selection/score and TS parity goldens. |
| Same cargo command with filter `tests::tool_catalog::` | **23 pass**, role/compaction matrix, shared catalog and planless legacy dispatch. All six selections ran serially under one `timeout 900s`. |
| Temporary two-route catalog control, then removed | **1 pass**, disproved the suspected premature cleanup. Its source was fully restored before delivery. |
| Scoped AFT inspection of the added test | **Partial**, Biome producer unavailable; not an authoritative clean-diagnostics claim. Package tsc/lint above provide the compiler/linter gates. |

Plugin selection files: `transform-postprocess-phase`, `tail-hygiene-walk`,
`final-wire-token-estimate`, `lkg-entry-projector`, `lkg-slot`, `module-wire`,
`module-state-sync`, `reference-retrieval`, `historian-prompt-fit`,
`sqlite-context-pragmas`, `storage-close-replay`, `storage-schema-columns`,
`storage-transform-reads`, `storage-read-admission`, `search-git-commits`,
`dreamer/task-gates`, `v2/store-reader-pool`, `v2/hooks/channel2-candidates`,
`v2/fold/owner`, `plugin/subagent-tool-policy` (each its existing `.test.ts`).
Pi selections: `context-handler`, `tag-snapshot-pi`, `fallback-tag-probes-pi`,
`pi-lkg`, `served-array-ledger`, `reminder-strip-pi`, `message-end-index-pi`,
`read-session-pi`.

No full workspace suite, new whole-range host differential, fleet reconnect test,
Linux restore reproduction or physical power-loss test was run. No product
mutation controls were applied. The regressions are direct functional assertions
that fail on the actual code, not performance fences that can pass without the
code path executing. Install/build supplied with the prepared worktree are not
reported as newly executed review gates. Final diff/status checks must show only
this report and the new test file before committing.
