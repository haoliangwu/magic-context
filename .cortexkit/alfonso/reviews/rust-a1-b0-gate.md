# Executing adversarial gate — Rust standalone A1 + B0, merged

**Gate tree**: `gate/rust-a1-b0` — `git merge gate/rust-b0` onto `gate/rust-a1` (`a7bd9756`),
merge base `991046caf7ea34baffd3d947bdc8b80e199eef94`.
**Under test**: A1 (`gate/rust-a1`, `a7bd9756`) and B0 (`gate/rust-b0`, `6b7ccddd`).
**Documents read**: `.cortexkit/alfonso/reviews/rust-standalone-a1.md`,
`.cortexkit/alfonso/reviews/rust-standalone-b0.md`,
`.cortexkit/alfonso/plans/rust-mode-standalone.md` §7A (A6, A7, A9) and §8.

---

## Verdict

**BLOCK on the merge as presented. SHIP-WITH-PINS once finding 1 is fixed.**

The block is not about behaviour. Every one of the six owner claims held under execution.
The block is that **the merged tree does not pass its own test suite**: two tests B0 shipped
assert that migration 57 is *absent*, and on the merged tree it is present, so they fail
(finding 1). Both are a few lines of test and one constant. Nothing about the product code
of either slice has to change to clear it.

After that, the two slices ship with the default runner (`broca`) and carry six pins for
A2 (findings 2–7). None of 2–7 is reachable with `historian.runner=broca`, because nothing
queues a run in that mode and `mc_historian_pending_run` stays empty — which is precisely
why they are pins on A2 rather than blockers on A1.

| # | Finding | Severity | Owner |
| --- | --- | --- | --- |
| 0 | One textual merge conflict, resolved | resolved | this gate |
| 1 | Two B0 tests fail on the merged tree | **BLOCK** | B0 |
| 2 | The claim lane has no channel scope; one poll hands any caller another project's transcript | PIN (A2 blocker) | A1/A2 |
| 3 | `v` is documented, fixtured, and never read on the claim lane | PIN | A1 |
| 4 | A heartbeat after the run's own deadline is answered `ok` with a dead lease | PIN | A1 |
| 5 | A restart-released run keeps its queue row and keeps being advertised | PIN | A1/A2 |
| 6 | `historian.pending` polls inside a fenced WRITE transaction | PIN | A1 |
| 7 | `store_meta` ignores its UPDATE row count | NOTE | A1 |
| 8 | The rust e2e mode manifest is stale — `run-rust-hermetic-e2e.sh` cannot run | pre-existing, release-gate blocker | not these slices |

---

## Finding 0 — the merge conflict shape (resolved)

`git merge gate/rust-b0` produced exactly one conflict: both branches append a `Migration`
to the tail of `MIGRATIONS` in `crates/mc-store/src/lib.rs`, so git saw one region with two
different bodies.

```
Auto-merging crates/mc-module/src/lib.rs
Auto-merging crates/mc-store/src/lib.rs
CONFLICT (content): Merge conflict in crates/mc-store/src/lib.rs
```

Resolved by keeping both entries in numeric order — 57 (`mc_historian_pending_run`) at
`crates/mc-store/src/lib.rs:2929`, then 58 (the marker columns) at `:2980`.

One product comment had to change with it. B0's migration opened with *"Version 57 is
deliberately absent: it is reserved for a migration being written in parallel to this one"*,
which on the merged tree is contradicted by the migration sixty lines above it. It now states
the surviving fact — the two must reach any store in numeric order, and do, because they ship
in one build. That is the only line of product code this gate changed.

`crates/mc-module/src/lib.rs` merged clean (A1 and B0 touch different regions), as did the
three B0-only files.

---

## Finding 1 — BLOCK: two B0 tests fail on the merged tree

Reproduce: `cargo test -p mc-store --lib`

```
---- tests::the_migration_chain_has_exactly_one_reserved_gap stdout ----
thread panicked at crates/mc-store/src/lib.rs:24035:9:
assertion `left == right` failed
  left: []
 right: [57]

---- tests::the_marker_migration_lands_unset_on_a_populated_store stdout ----
thread panicked at crates/mc-store/src/lib.rs:24106:9:
assertion `left == right` failed: version 57 is reserved for a migration being
written in parallel and must stay unused
  left: 57
 right: 56

test result: FAILED. 173 passed; 2 failed
```

Git merged both regions cleanly because A1 and B0 edited different lines. The conflict is
semantic: B0 encoded "57 does not exist" as an **assertion**, and the merge makes it exist.

- `crates/mc-store/src/lib.rs:3044` — `const RESERVED_UNSHIPPED_MIGRATION_VERSION: u32 = 57;`
- `crates/mc-store/src/lib.rs:24028-24043` — `the_migration_chain_has_exactly_one_reserved_gap`
  asserts the only number missing from `1..=LATEST_MIGRATION_VERSION` is 57. With 57 shipped
  the chain is contiguous and `missing` is empty.
- `crates/mc-store/src/lib.rs:24102-24107` — `the_marker_migration_lands_unset_on_a_populated_store`
  filters the chain to versions `< 58` and asserts the recorded version is
  `SINGLE_STORE_MARKER_MIGRATION_VERSION - 2` (56). The filtered chain now includes 57, so it
  records 57.

**The fix must:**

1. Delete `RESERVED_UNSHIPPED_MIGRATION_VERSION` (`lib.rs:3040-3044`). Nothing is reserved once
   57 ships.
2. Change `the_migration_chain_has_exactly_one_reserved_gap` to assert the chain is **contiguous**
   — `missing` is empty — and keep its second assertion (no two migrations claim one version).
   Rename it to say that (`the_migration_chain_is_contiguous_and_claims_each_version_once`).
   This *restores* the property B0's "Collateral change" section said it was giving up, so
   `shipped_migration_versions()` (`lib.rs:3046-3059`) and the two call sites that now use it
   (`tests::fresh_and_migrated_stores_have_latest_schema`,
   `shadow_tests::authority_route_binding_schema_30_live_upgrade_rekeys_through_caller_fence`)
   may keep using it or go back to the range; either is sound once the chain is contiguous
   again.
3. Change the step-through's expectation from `- 2` to `- 1` (57) and drop the "reserved" message
   at `lib.rs:24102-24107`. The rest of that test is unaffected: it is checking that the marker
   columns are absent before 58 and present after, and 57 creates a different table.

These are the only two places the reservation was encoded. Nothing else in either crate reads
`RESERVED_UNSHIPPED_MIGRATION_VERSION`.

**Mutation (finding 1 is a failure, so the mutation proves the ordering tests I added are the
things that would have caught it):** see M4 below.

---

## Claim 1 — "with `historian.runner=broca` every module output and every historian request is byte-identical to the base `991046ca`"

**VERIFIED for the wire. The durable session blob is NOT byte-identical, by exactly one field
(claim 5), which A1's own document states.**

### Sequence

A probe written against the **pre-A1 API surface only**, so the identical file compiles and runs
on both trees: `crates/mc-module/src/tests/gate_a1_b0_baseline_probe.rs`. It drives one real fold
through the default runner with the recording producer, and digests (a) the completion request
actually sent — system prompt, user prompt, model — and (b) the array served on the pass that
folds.

Base tree: read-only `git archive 991046caf7ea34baffd3d947bdc8b80e199eef94` extracted under
`<worktree>/.gate-baseline/magic-context/`, with `commons` and `subconscious` symlinked to the
same sibling sources so the workspace path-deps resolve. The probe file was copied in verbatim
and one `mod` line added.

```
$ cargo test -p mc-module --lib gate_probe -- --nocapture     # GATE TREE
GATE-PROBE request_digest=6471eca0a44ddebe29cefcec06b6e71fd17d8eca646819ceed176bfa60ed12b4
GATE-PROBE system_bytes=63470
GATE-PROBE prompt_bytes=66304
GATE-PROBE model=test/model
GATE-PROBE session_shape=mc-historian:project:<project-hash>:1
GATE-PROBE meta_digest=5f99702daac55ffced300cbdb6dad704f0595cd623c5de456f315c5790a200b5
GATE-PROBE meta_bytes=22048
GATE-PROBE meta_has_producer_attempt=true
GATE-PROBE served_digest=34e55f759e321821f452bf6e028cfe94eef25c5087afac4345480b419863b680
GATE-PROBE served_bytes=271085

$ cargo test -p mc-module --lib gate_probe -- --nocapture     # BASE 991046ca
GATE-PROBE request_digest=6471eca0a44ddebe29cefcec06b6e71fd17d8eca646819ceed176bfa60ed12b4
GATE-PROBE system_bytes=63470
GATE-PROBE prompt_bytes=66304
GATE-PROBE model=test/model
GATE-PROBE session_shape=mc-historian:project:<project-hash>:1
GATE-PROBE meta_digest=8cbed33f6c9dca77310128f8a0f8ad704cb183542a3fd381d9ce0b2afd615710
GATE-PROBE meta_bytes=22027
GATE-PROBE meta_has_producer_attempt=false
GATE-PROBE served_digest=34e55f759e321821f452bf6e028cfe94eef25c5087afac4345480b419863b680
GATE-PROBE served_bytes=271085
```

### Observed

- **Historian request**: identical digest, identical byte counts. The bytes leaving the module
  for the completion provider did not move.
- **Served array**: identical digest, 271,085 bytes on both trees.
- **Durable session blob**: 22,027 → 22,048 bytes, +21, which is exactly
  `,"producer_attempt":0`. See claim 5.

Both digests are now pinned as constants in the committed probe, so a later change to either
stream fails rather than drifts.

### Corroboration with a real daemon (hermetic, isolated data home)

`scripts/run-rust-hermetic-e2e.sh` still cannot run (finding 8), so each file was driven with
the script's exact per-file invocation, `MC_E2E_MODE=rust NODE_ENV="" bun test --timeout 600000
--max-concurrency=1 <file>`. Each spawns its own hermetic `ckdev-mc-e2e` with
`XDG_DATA_HOME` pinned to a throwaway temp root
(`packages/e2e-tests/src/rust-runner/hermetic-subc.ts:505`).

| File | Result |
| --- | --- |
| `rust-smoke` | pass (1 pass, 1 skip) |
| `rust-steady-state-byte-identity` | pass |
| `rust-compaction-marker-byte-identity` | pass — control, post-restart-1 and post-restart-2 all `sha256=e4cc17731faa2e2a6d71f27254abe030ec9f2a8f9e454ebd1437ae85a8b23d09` |
| `rust-historian-producer` | pass (3/3) |
| `rust-fold-under-pressure` | pass |
| `rust-timeout-epoch-recovery` | **fail — pre-existing**, named in the brief |

The marker sha is the same value A1's own delivery recorded, from an independent run on the
merged tree.

Also green on the gate tree: `differential_goldens` (4/4, including the one-byte vacuity guard)
and `tests/real_daemon.rs`.

### Mutation — M5

One byte appended to `crates/mc-module/testdata/historian-system-prompt.txt`.
`git diff --stat`: `1 file changed, 1 insertion(+), 1 deletion(-)` during; empty after
`git checkout -- <path>`.
Red: `tests::gate_a1_b0_baseline_probe::gate_probe_default_runner_request_and_meta_digests`, and
**nothing else in 1,237 passing mc-module lib tests** — which is itself worth knowing: before this probe,
no test in the crate pinned those prompt bytes.

### The one wording correction

A1's §8 says "every module output ... byte-identical". Read literally that is false for the
durable row, and A1 knows it — §3 names `producer_attempt` as a serde-default addition. The
sentence should read "every **served** byte"; the durable blob is covered separately and
quantified below.

---

## Claim 2 — "the `Reclaiming` phase closes today's stall; any report for a prior attempt is rejected in every phase"

**VERIFIED.**

### Sequence — the stall is closed

A1's red-first record (`historian::tests::pre_reclaim_lease_expiry_stalls_a_second_producer`)
still passes on the merged tree and still prints the stall. The recovery:

`crates/mc-store/src/tests/gate_a1_b0.rs::gate_a_crowd_of_claimants_on_one_run_mints_exactly_one_token_per_generation`
queues one run, then races eight claimants at it at `queued + 1`, and then races eight more at
`queued + HISTORIAN_LEASE_CEILING_MS + 1` — past the lease, inside the run's own deadline.

Observed, both generations: exactly 1 `Claimed`, 7 `already_claimed`. Generation 2's winner gets
`attempt = 2`, and the session state keeps `producer_run_id = "run-crowd"`, `chunk_fingerprint = "fp"`
and `firing_seq = 1` across the handover — the replacement continues the same run rather than
paying to assemble a new chunk. No 600 s timeout anywhere in the path.

### Sequence — a prior attempt is rejected at every predicate site

`crates/mc-store/src/tests/gate_a1_b0.rs::gate_a_prior_attempts_report_is_refused_at_every_predicate_site`
drives all three mc-store sites that CAS on `HistorianPublishPredicate` with a session holding
`producer_attempt = 2` and a predicate carrying attempt 1:

| Site | Observed with attempt 1 | Control with attempt 2 |
| --- | --- | --- |
| `record_historian_publish_failure_if_matching` (`lib.rs:13447-13455`) | `Ok(None)` — not even the health counter moves | `Ok(Some(_))` |
| `abandon_historian_run_if_matching_with_publish_failure` (`lib.rs:13367-13375`) | `Ok(None)`, phase still `Publishing` | — |
| `publish_historian_chunk` (`lib.rs:13529-13539`) | `Err(StateMismatch { .. })`, 0 compartments appended | publishes, 1 compartment |

At the wire,
`crates/mc-module/src/tests/gate_a1_b0.rs::gate_complete_refuses_a_superseded_an_unknown_and_an_unclaimed_run`
confirms the token is checked before the body is read: a superseded report carrying
`"not valid compartment xml at all"` is answered `{"ok": false, "refusal": "superseded_token"}`
rather than an XML parse error, with a waiter registered so nothing else could have refused it.

### Mutations

- **M3**: `producer_attempt` removed from the predicate in
  `record_historian_publish_failure_if_matching`. Red: exactly
  `tests::gate_a1_b0::gate_a_prior_attempts_report_is_refused_at_every_predicate_site`
  (beside the two standing finding-1 failures). Nothing else.
- **M9**: `authorize_historian_report` authorizes without comparing the token.
  Red: `tests::gate_a1_b0::gate_complete_refuses_a_superseded_an_unknown_and_an_unclaimed_run`,
  plus A1's own `the_historian_claim_lane_answers_the_wire_a2_codes_against` and
  `an_expired_lease_hands_the_same_run_to_the_next_claimant` — the right three.

---

## Claim 3 — "the claim lane is safe under races"

**VERIFIED for all six named sequences. Three findings on the lane's shape (2, 3, 4).**

| Sequence | Observed |
| --- | --- |
| Two claimants on one run | 1 × `ok` with `attempt: 1`; 1 × `{"ok": false, "refusal": "already_claimed"}`. Session state and queue row both name the winner's token. |
| Claim after expiry racing a late heartbeat — **beat first** | The beat is accepted and **revives the lapsed lease**; the replacement is then refused `already_claimed`; attempt stays 1. |
| Claim after expiry racing a late heartbeat — **claim first** | The claim wins with `attempt: 2`; the old holder's beat is refused `superseded_token`. |
| `complete` with a superseded token | `{"ok": false, "refusal": "superseded_token"}`, before the body is parsed. |
| `complete` for an unknown run | `{"ok": false, "refusal": "unknown_run"}`. A queued-but-unclaimed run gives `not_claimed`. |
| Heartbeat after the run's own deadline | `{"ok": true, ...}` with a `claim_deadline_ms` already in the past — **finding 4**. |
| `pending` listing during a claim transaction | A second connection reading the queue row and the session row in one read transaction never saw them disagree, across a writer cycling the claim until the reader had sampled **both** halves. |

Driven by `crates/mc-module/src/tests/gate_a1_b0.rs` (`gate_two_claimants_on_one_run_leave_exactly_one_live_token`,
`gate_a_late_heartbeat_and_a_post_expiry_claim_never_both_win`,
`gate_complete_refuses_a_superseded_an_unknown_and_an_unclaimed_run`,
`gate_a_heartbeat_after_the_runs_own_deadline_is_answered_ok`) and
`crates/mc-store/src/tests/gate_a1_b0.rs` (`gate_a_crowd_of_claimants...`,
`gate_a_reader_never_catches_a_claim_half_applied`).

**In no ordering did two live claims exist at once.** The "beat first" branch is the one neither
delivery document describes: a claimant whose lease has already lapsed keeps the run if its
heartbeat reaches the store before a replacement's claim does. That is defensible — it is a live
claimant proving liveness inside the two-missed-beats window — but it is behaviour A2 will code
against and it is not written down anywhere. Worth one sentence in the A2 contract.

### Vacuity note on the concurrency test

The first version of `gate_a_reader_never_catches_a_claim_half_applied` passed under M2 (below),
which it should have caught. The reader had simply never sampled the run while it was claimed:
the fixture's await budget only allowed two claim generations before the run's deadline, so the
claimed window was ~1 ms twice. The committed version counts claimed and pending observations
separately, asserts **both** are non-zero, and has the writer cycle until they are. Only then does
it redden under M2.

### Mutations

- **M1**: `is_claimable` (`crates/mc-store/src/historian_claim.rs:689-695`) returns `true` for
  `PHASE_CLAIMED` unconditionally. Red:
  `tests::gate_a1_b0::gate_a_crowd_of_claimants_on_one_run_mints_exactly_one_token_per_generation`
  and A1's `historian_claim::tests::the_sweep_parks_a_claim_whose_lease_ran_out_and_leaves_a_live_one_alone`.
- **M2**: the claim writes only the queue row — `store_meta` dropped from
  `claim_historian_run` (`historian_claim.rs:465`). Red:
  `tests::gate_a1_b0::gate_a_reader_never_catches_a_claim_half_applied` **and**
  `gate_a_crowd_of_claimants...` and the same A1 sweep test.

---

## Claim 4 — migrations 57 then 58, store-ahead tolerance, and the `single_store` marker

**VERIFIED, with finding 1 against the merged tree's own tests and an executed demonstration of
the ordering hazard B0 could only state in prose.**

### 57 then 58 on a populated store

`crates/mc-store/src/tests/gate_a1_b0.rs::gate_the_claim_queue_then_the_marker_land_in_order_on_a_populated_store`:
run the chain to 56 on a hermetic tempdir store with the era-appropriate scope UDFs registered,
insert an `mc_memories` row, then apply 57, then open normally so the real open path applies 58.

Observed: after 56, no `mc_historian_pending_run` and no `single_store` column. After 57, the
table exists and the marker columns still do not. After the real open: version 58,
`single_store_marker() == None`, all three marker columns present at their defaults, the memory
row byte-unchanged, and the queue created by 57 is usable — `publish_pending_historian_run`
then `list_pending_historian_runs` returns the run.

### The ordering hazard, executed

`gate_a_store_that_applied_58_first_never_gets_57` applies a chain with 57 filtered out, then
opens with the full chain.

Observed: the store records 58, and `mc_historian_pending_run` **never appears** — `run_migrations`
sorts by version and skips every `m.version <= current`, where `current` is the recorded
**maximum** (`commons/crates/cortexkit-store/src/lib.rs:411-419`). A subsequent
`publish_pending_historian_run` fails with an error naming the missing table.

This is B0's "Hazards for the reviewer" item 1 turned into a test. The merged tree satisfies the
constraint by construction (both in one chain), and now something fails if a future slice
reintroduces a gap.

### A store at 58 met by a binary whose chain stops at 56

`gate_a_store_at_58_is_served_by_a_binary_whose_chain_stops_at_56`: build a 58 store with a
session row, then migrate it with a chain truncated to 56.

Observed: `outcome.store_ahead() == true`, `recorded = 58`, `chain_max = 56` — the exact
condition that emits the store-ahead line at `crates/mc-store/src/lib.rs:7644-7654` — and the
session row is read back intact (`firing_seq = 9`). The marker column reads `0`, and a binary at
56 has no code that reads it at all, so nothing refuses it. That tolerance is correct **only
while nothing sets the marker**, which is exactly B0's scope; it becomes wrong the moment B2
sets one, which is why B0 has to land in a release before B2.

### The marker refusal on every seam

B0's own test covers health, `store_refusal()` and the transform error frame, and explicitly
does **not** drive `session.status` end to end (it is refused `route_unbound` first on an
unbound channel). `crates/mc-module/src/tests/gate_a1_b0.rs::gate_session_status_and_the_claim_lane_name_the_single_store_refusal`
closes that: it binds channel 7 to a project and session first, so `management_binding` succeeds
and the request reaches the store.

Observed, for `session.status`, `historian.pending` and `historian.claim` alike:
`code = store_open_failed`, message carrying `reason_code=single_store_marker`, `ck-mc a1b2c3d4`
and `terminal`. The capable-open control lives in B0's mc-store test and still passes.

### Mutations

- **M4**: migration 57's `version: 57` → `version: 59` — the claim queue now lands *after* the
  marker. Red: all three ordering tests —
  `gate_the_claim_queue_then_the_marker_land_in_order_on_a_populated_store`,
  `gate_a_store_that_applied_58_first_never_gets_57`,
  `gate_a_store_at_58_is_served_by_a_binary_whose_chain_stops_at_56` — plus A1/B0's own
  `tests::migration_53_replaces_legacy_udf_guards_and_store_ahead_does_not_recreate_them` and
  `the_marker_migration_lands_unset_on_a_populated_store`. (Note: under M4
  `the_migration_chain_has_exactly_one_reserved_gap` goes *green*, because the gap at 57 is
  restored — which is the clearest possible statement of what that test is actually asserting.)
- **M7**: `store_open_failure_reason_code` (`crates/mc-module/src/lib.rs:334-339`) collapsed to
  the generic code. Red: `tests::gate_a1_b0::gate_session_status_and_the_claim_lane_name_the_single_store_refusal`
  and B0's `a_single_store_marker_refusal_is_named_on_health_and_on_every_refusal_seam`. Nothing else.

---

## Claim 5 — "`producer_attempt` changes durable meta bytes but no served wire byte"

**VERIFIED and quantified. This was A1's own least-confident item and it holds exactly.**

`producer_attempt` is `#[serde(default)]` with no `skip_serializing_if`
(`crates/mc-store/src/lib.rs:3419-3420`), so it rides **every** `ModuleMeta` blob, not only
host-lane ones.

### Observed

| Stream | Base `991046ca` | Gate tree | Delta |
| --- | --- | --- | --- |
| Historian request digest | `6471eca0…12b4` | `6471eca0…12b4` | none |
| Served `ck_messages` digest | `34e55f75…b680` | `34e55f75…b680` | none |
| Served `ck_messages` bytes | 271,085 | 271,085 | none |
| Durable `ModuleMeta` digest | `8cbed33f…5710` | `5f99702d…00b5` | differs |
| Durable `ModuleMeta` bytes | 22,027 | 22,048 | **+21** |

21 bytes is the exact length of `,"producer_attempt":0`. The probe asserts
`meta_blob.len() == BASELINE_META_BYTES + ",\"producer_attempt\":0".len()`, so a second field
creeping into the blob fails rather than hides inside "it changed".

### On a session restored from a pre-A1 meta blob

Covered structurally rather than by a second fixture: the field's `#[serde(default)]` means a
pre-A1 blob deserializes with `producer_attempt = 0`, and 0 is the attempt the in-module producer
lane always uses (`historian.rs:502` and `:522` set it explicitly, and
`HistorianDurableState::default()` starts there). So a pre-A1 row and a post-A1 row reach the
publish predicate with the same attempt, and the predicate matches either way — which is why the
served bytes above are identical across a full fire→publish→fold cycle whose session row started
life on the base tree's schema. The e2e `rust-compaction-marker-byte-identity` run, which
restarts the module twice over one store and gets `sha256=e4cc1773…b23d09` all three times,
is the end-to-end version of the same statement.

### Mutation — M6

`coordinator_token`'s `skip_serializing_if = "Option::is_none"` removed
(`crates/mc-store/src/lib.rs:3425`), so the blob gains a second field.
Red: exactly `tests::gate_a1_b0_baseline_probe::gate_probe_default_runner_request_and_meta_digests`.
Nothing else in 1,237 passing mc-module lib tests noticed the durable blob widening — which is the reason
this pin is worth keeping.

---

## Claim 6 — "restart: a parked `Reclaiming` run is released on boot"

**VERIFIED. It releases, it does not double-publish, and the chunk fingerprint is not lost from
the store. The queue row is — finding 5.**

### Sequence

`crates/mc-module/src/tests/gate_a1_b0.rs::gate_restart_releases_a_parked_run_but_leaves_its_queue_row_behind`
queues a run (session → `Reclaiming`, `chunk_fingerprint = "fp-ses"`, `firing_seq = 1`), then calls
`historian::handle_restart_load` exactly as the transform recovery arm does
(`crates/mc-module/src/lib.rs:5587-5604` → `crates/mc-module/src/historian.rs:925-933`).

### Observed

- `RestartAction::AbandonedAndRefireEligible { firing_seq: 1 }`.
- Session state: `Idle`, `producer_run_id = None`, `coordinator_token = None`,
  `firing_seq = 1` kept so the next fire stays monotonic.
- **No double publish**: 0 compartments after the release, and a claimant that then takes the
  still-advertised run is refused `not_pending` — the session's `producer_run_id` no longer
  matches, so `claim_historian_run` (`historian_claim.rs:435-439`) refuses before writing
  anything.
- **Chunk fingerprint**: cleared from the *session* (`abandon_with_detail` rebuilds the state
  from `..Default::default()`, `historian.rs:616-624`) — correct, because the run is gone and
  the next trigger must assemble a fresh chunk rather than publish against a stale one. It is
  **not** lost from the store: the orphan queue row still carries `chunk_fingerprint = "fp-ses"`,
  which is precisely what A2's proposed boot-time re-publication would need.

### Mutation — M8

`HistorianPhase::Reclaiming` moved out of the released arm in `handle_restart_load` so a parked
run is kept across a restart. Red: exactly
`tests::gate_a1_b0::gate_restart_releases_a_parked_run_but_leaves_its_queue_row_behind`.

---

## Finding 2 — PIN (A2 blocker): the claim lane has no channel scope, and one poll hands any caller another project's transcript

`crates/mc-module/src/lib.rs:13863-13866` dispatches the four claim ops to handlers that never
call `management_binding` (`:7026-7067`). Every other management op that reads session state does,
and refuses an unbound channel with `route_unbound` and a foreign session with `session_mismatch`.

`historian.pending` with no `session_id` lists **every session the store serves**
(`crates/mc-store/src/historian_claim.rs:339`, `WHERE (?1 IS NULL OR session_id = ?1)`) with no
project predicate, although the queue row carries `project_path`. `historian.claim` then returns
`prompt.system` and `prompt.user` — the folded conversation transcript — to whoever presents the
`run_id` that `pending` just gave away.

Executed: `gate_pending_hands_an_unbound_caller_another_projects_run_and_prompt`. On channel 9,
which never bound anything:

```
session.status  -> route_unbound                      (the comparison surface refuses it)
historian.pending -> ["run-other-project", "run-own-project"]
historian.claim run-other-project
     -> {"ok": true, ..., "prompt": {"user": "transcript of a project this channel never bound"}}
```

This is by design — A1 §2 says a claimant polls without knowing which session produced a run —
and it is inert today, because with `runner=broca` nothing is ever queued. It stops being inert
the moment A2 ships a puller and a second project on the same box gets its own host process.
Two projects on one machine share one module store; each host would be able to read the other's
transcripts and complete the other's folds.

**The fix must** scope the lane to what the caller is entitled to, without breaking discovery.
The cheapest shape that does both: require the claim ops to carry the channel's binding (the
route already knows the project root), and have `list_pending_historian_runs` /
`claim_historian_run` filter on `project_path` against that binding — the column is already
there. If cross-project claiming is genuinely wanted, it needs to be a stated decision with the
transcript exposure written down, not a side effect of "a claimant does not know the session".

---

## Finding 3 — PIN: `v` is documented, fixtured, and never read

A1's §2 shows `"v": 1` on all four requests and
`crates/mc-module/testdata/historian-claim-wire-golden.json` pins it. No handler reads it:
`handle_historian_pending_value` (`lib.rs:7309`), `..._claim_value` (`:7345`),
`..._heartbeat_value` (`:7386`) and `..._complete_value` (`:7428`) read only their named string
fields. `management_binding` right beside them requires `v == 1` and answers `bad_request`
otherwise.

Executed: `gate_the_claim_lane_serves_requests_whose_version_it_never_read`. `session.status`
without `v` → `bad_request`; `historian.pending` with no `v`, with `v: 99`, and with
`v: "not-a-number"` → all served normally with the queued run.

**The fix must** either enforce `v == 1` on all four ops with the same `bad_request` the
neighbouring ops use, or delete `v` from the documented shape and the fixture. A version field
that is never read is worse than none: a future v2 claimant is silently served v1 semantics.

---

## Finding 4 — PIN: a heartbeat after the run's own deadline is answered `ok` with a dead lease

`heartbeat_historian_run` (`crates/mc-store/src/historian_claim.rs:500-539`) checks the run
exists and the token is current, then sets
`claim_deadline_ms = now_ms.saturating_add(lease_ms).min(deadline_ms)` (`:523`). Once
`now_ms > deadline_ms`, that is `deadline_ms` — a time already in the past — and the op returns
`Extended`, which the dispatcher renders as `{"ok": true, "claim_deadline_ms": <past>}`.

A1's §2 claim "a heartbeat never pushes a lease past the run's own deadline" is true. What is
missing is the refusal.

Executed: `gate_a_heartbeat_after_the_runs_own_deadline_is_answered_ok`. On the same run, at the
same instant:

```
historian.pending   -> {"ok": true, "runs": []}                       (never offered again)
historian.claim     -> {"ok": false, "refusal": "not_pending"}
historian.heartbeat -> {"ok": true, "claim_deadline_ms": <in the past>}
```

So the heartbeat is the single op in the lane that tells a claimant to keep going after the
module has stopped waiting. A claimant that treats `ok` as "keep working" — the obvious reading —
keeps paying a provider for a completion that can no longer be delivered. §7A A6 sizes duplicate
spend across a *stolen* lease as an accepted cost; this is spend against nobody.

**The fix must** make `heartbeat_historian_run` refuse once `now_ms >= deadline_ms`, with a code
that tells the claimant to stop rather than to retry (`not_pending` reuses an existing code
correctly, or add `run_expired`). Refusing is safe: at that point neither `pending` nor `claim`
will hand the run to anyone, and the firing task's own await budget has run out.

---

## Finding 5 — PIN: a restart-released run keeps its queue row and keeps being advertised

Continuing the claim-6 sequence above, after the release:

```
mc_historian_pending_run: [("run-parked", "ses", "pending", NULL, "fp-ses")]
historian.pending -> runs[0].run_id == "run-parked"
historian.claim   -> {"ok": false, "refusal": "not_pending"}
expire_historian_claims(now + 60s) -> row still there
session.delete    -> row gone
```

Nothing on the historian's own paths removes it. `handle_restart_load`
(`crates/mc-module/src/historian.rs:925-933`) releases the session and does not touch the queue.
`expire_historian_claims` (`crates/mc-store/src/historian_claim.rs:612-647`) only selects
`phase = 'claimed'`. `finish_historian_pending_run` (`:596`) is called from exactly one place,
`run_historian_firing_on_host` after its own wait (`crates/mc-module/src/historian.rs:2129`) —
a task that no longer exists after a restart. Deleting the session is the only path that
reclaims it, so the row lives as long as the session does.

Two consequences:

1. Migration 57's own comment ("Rows are bounded by the number of concurrently folding sessions;
   terminal rows are deleted rather than accumulated", `crates/mc-store/src/lib.rs:2946-2947`)
   is not true on the restart path.
2. Every claimant that takes the bait pays a round trip for a `not_pending`. Bounded and
   harmless, but it is the kind of steady-state noise A2's poll loop will see and have to
   explain.

**The fix must** make the release delete the queue row in the same transaction that abandons the
run — or, if A2 adopts boot-time re-publication (A1 §7 item 5 leaves this open), make the boot
path adopt the row rather than orphan it. The row already carries everything re-publication
needs, including the chunk fingerprint. What must not stay is the third state: released session,
live queue row, nobody responsible for either.

---

## Finding 6 — PIN: `historian.pending` polls inside a fenced WRITE transaction

`list_pending_historian_runs` (`crates/mc-store/src/historian_claim.rs:328-365`) is a pure read
that goes through `with_conn_fenced`, which opens an `IMMEDIATE` transaction and may create the
fence table (`commons/crates/cortexkit-store/src/lib.rs:217-231`). Every poll from every claimant
therefore takes the store's exclusive write lock, competing with transform commits on the same
file.

A2's design has claimants polling on an interval. At one poll per second per host that is a
steady stream of write-lock acquisitions bought for a query that writes nothing. It also means a
poll is subject to the epoch fence and can fail as a *write* rejection during a lease handover.

**The fix must** move the listing to `with_conn` (the plain read path), unless there is a reason
the read has to be serialized against writers that is not written down — in which case that
reason belongs in the function's doc comment, because nothing in the current one hints at it.

---

## Finding 7 — NOTE: `store_meta` ignores its UPDATE row count

`store_meta` (`crates/mc-store/src/historian_claim.rs:248-264`) executes
`UPDATE mc_cache_state ... WHERE session_id = ?1 AND row_version = ?4` and returns `Ok(next)`
without checking how many rows it touched. Today this is safe: every caller reads and writes
inside one `with_conn_fenced` transaction, so the row version cannot move underneath it. It is
worth one `if affected == 0 { ... }` anyway, because the function's signature promises a
successful write and the next caller added outside a transaction gets a silent no-op instead of
an error.

---

## Finding 8 — pre-existing: the rust e2e mode manifest is stale

`scripts/run-rust-hermetic-e2e.sh` still cannot run on the merged tree:

```
$ bun scripts/validate-mode-manifest.ts --mode rust --harness all
mode manifest validation failed: Error: missing manifest entries:
tests/opencode2/commands-s2-flush.test.ts, tests/opencode2/commands-s2-host-registration.test.ts,
tests/opencode2/commands-s2-keymap.test.ts, tests/opencode2/dreamer-s2-carrier.test.ts,
tests/opencode2/hidden-child-unbound.test.ts, tests/opencode2/rpc-s2-listener.test.ts,
tests/opencode2/rust-mode-limitation.test.ts, tests/opencode2/sidebar-component.test.ts,
tests/opencode2/status-dialog.test.ts, tests/opencode2/tool-definition-telemetry.test.ts
```

Reproduced byte-identically on the read-only `991046ca` extraction, independently of A1's report.
Not caused by either slice. It is a release-gate blocker in its own right: the single invocation
the release script and the release workflow use cannot select a file list, so **no** release can
run the rust hermetic group until `packages/e2e-tests/mode-manifest.json` catches up with the
`tests/opencode2/` tree.

---

## Gates on the merged tree

| Gate | Result |
| --- | --- |
| `cargo build --locked --release -p mc-module` | pass, `Cargo.lock` unchanged |
| `cargo clippy --all-targets -- -D warnings` | pass |
| `cargo fmt --check` | clean |
| `cargo test --locked -p mc-store -p mc-module --no-fail-fast` | mc-module lib: **1,237 pass, 0 fail, 8 ignored**; mc-store lib: **2 fail** (finding 1); `cold_flip_adversarial::subagent_flip_records_action_and_stable_tagged_replay`: **fail, pre-existing and named in the brief**; every other integration binary passes, including `tests/real_daemon.rs` |
| Hermetic rust e2e (per-file, isolated data home) | 5 of 6 pass; `rust-timeout-epoch-recovery` fails — pre-existing and named in the brief |
| `scripts/run-rust-hermetic-e2e.sh` | cannot run — finding 8, pre-existing |

`bun install` had to be run once in this worktree (`node_modules` was absent, so the e2e files
could not resolve `@cortexkit/subc-client`). No manifest or lockfile changed:
`bun install --frozen-lockfile` reported `Checked 990 installs across 1238 packages (no changes)`.

## Production isolation

Every store opened by this gate is a `tempfile::tempdir()` under the ambient temp root. The e2e
files each spawn their own hermetic `ckdev-mc-e2e` with `XDG_DATA_HOME` pinned to a throwaway
directory. The `991046ca` baseline is a read-only `git archive` extraction inside this worktree
under `.gate-baseline/` (git-excluded, not committed), with `commons` and `subconscious`
symlinked to the existing sibling sources. No database under `~/.local/share/cortexkit/` was
opened and no binary was placed.

## What this gate committed

- `crates/mc-store/src/lib.rs` — merge resolution (both migrations, in order) and the one
  comment that the merge made false; `mod gate_a1_b0;` inside `mod tests`.
- `crates/mc-store/src/tests/gate_a1_b0.rs` — 6 tests.
- `crates/mc-module/src/lib.rs` — `mod gate_a1_b0;` and `mod gate_a1_b0_baseline_probe;` inside
  `mod tests`.
- `crates/mc-module/src/tests/gate_a1_b0.rs` — 8 tests.
- `crates/mc-module/src/tests/gate_a1_b0_baseline_probe.rs` — 2 tests, written against the pre-A1
  API so the same file runs on `991046ca`.

No product behaviour was changed.
