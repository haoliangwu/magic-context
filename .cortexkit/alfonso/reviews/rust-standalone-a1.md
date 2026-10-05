# Rust standalone — slice A1 delivery

Design of record: `.cortexkit/alfonso/plans/rust-mode-standalone.md` (§0, §2 Part A,
§6A, §7A A6–A9, §7C "A1", §8).

Acceptance for this slice is **zero behaviour change with the default runner**. The
default is `broca`; the host lane exists, is durable, is tested, and is off.

Stated precisely (corrected after the A1+B0 gate measured it): with
`historian.runner=broca`, **every served byte** and every historian request is
byte-identical to the base `991046ca`. The durable session blob is not: it grows by
exactly 21 bytes, the length of `,"producer_attempt":0`. See §8.

The fixes the A1+B0 gate's findings led to are recorded in
`.cortexkit/alfonso/reviews/rust-a1-b0-gate-fixes.md`; §2 below is kept current with
them, because it is what A2 codes against.

---

## 1. What landed

| Piece | Where |
| --- | --- |
| Runner selector | `crates/mc-module/src/historian_runner.rs`, read in `config.rs` |
| Host lane firing | `historian::run_historian_firing_on_host` (`crates/mc-module/src/historian.rs`) |
| In-process waiters | `crates/mc-module/src/historian_host.rs` |
| Claim durability + ops | `crates/mc-store/src/historian_claim.rs`, mc-store migration **57** |
| `Reclaiming` phase, `(run_id, attempt)`, token | `crates/mc-store/src/lib.rs` (`HistorianPhase`, `HistorianDurableState`, `HistorianPublishPredicate`) |
| Facade ops | `crates/mc-module/src/lib.rs` dispatch arms + handlers |
| Wire fixture | `crates/mc-module/testdata/historian-claim-wire-golden.json` |
| Install identity | `packages/plugin/src/features/magic-context/install-instance-id.ts` |
| Project-tier strip | `packages/plugin/src/config/project-security.ts` |

---

## 2. Op wire shapes (this is what A2 codes against)

All four ride the module's management surface as flat `method`-tagged bodies, the
same envelope `session.flush` / `session.status` use. The fixture
`crates/mc-module/testdata/historian-claim-wire-golden.json` pins these bytes; the
test `tests::the_historian_claim_lane_answers_the_wire_a2_codes_against` drives every
case through the real dispatcher.

### Refusal convention

A lost claim race, an expired lease and a superseded token are **normal responses**
with `{"ok": false, "refusal": "<code>"}`, not error frames. They are ordinary
operation for a poller: the caller's response is to move to the next run, not to
treat the request as failed. Only malformed requests produce an error frame
(`code: "invalid_params"`).

Two things are checked before any of that, on all four ops, and both answer with an
error frame rather than a refusal:

- **`v` must be `1`** (`bad_request`), as on every other management op. A version
  field that were never read would silently serve v1 semantics to a future v2
  claimant.
- **The channel must be bound** (`route_unbound`). The lane is scoped to the bound
  project: one module store serves every project on the machine, and a claim hands
  back the folded conversation transcript. A run queued by another project is
  answered `unknown_run` — the same answer as a run that does not exist, so nothing
  about it leaks. A claimant still discovers runs by polling without naming a
  session; what it cannot do is poll outside its own project.

**A lapsed lease is not lost until someone else takes it.** A heartbeat that arrives
after the lease expired but before a replacement's claim is accepted and **revives**
the claim; the replacement is then refused `already_claimed` and the attempt number
does not move. In the other order the replacement wins and the late beat is refused
`superseded_token`. Both orders leave exactly one live claim. This is deliberate — a
beat inside the two-missed-beats window is a live claimant proving liveness, and
taking the run from it would throw away a completion still being produced — and it is
what A2 must code against: a claimant that missed a beat should send one rather than
assume it has lost the run. Pinned by
`historian_claim::tests::a_heartbeat_revives_a_lapsed_lease_and_the_replacement_is_then_refused`
and, at the wire, `tests::gate_a1_b0::gate_a_late_heartbeat_and_a_post_expiry_claim_never_both_win`.

### `historian.pending`

```json
{"method": "historian.pending", "v": 1, "session_id": "ses"}
```

`session_id` is optional; omitting it lists every session **of the caller's own
project**, because a claimant discovers runs by polling and does not already know
which session produced them. A present-but-blank `session_id` is refused rather than
silently widened. Runs queued by any other project are never listed.

```json
{"ok": true, "runs": [{
  "run_id": "mc-historian:project:a1a1a1a1a1a1a1a1:1",
  "session_id": "ses",
  "chunk_fingerprint": "fp-a1",
  "prompt_bytes_len": 44,
  "deadline_ms": 1758461234567
}]}
```

- `prompt_bytes_len` — UTF-8 bytes of **system + user**, exactly the two strings
  `historian.claim` hands back, so a claimant can size the request before taking it.
- `deadline_ms` — when the **run** stops being worth running (queue time + await
  budget). Not the lease. A run past it is never listed and never claimable.
- Ordering is queue order (`created_at_ms`, then `run_id`).
- A run held under a live lease is not listed; a run whose lease lapsed is.
- A **parked** run is not listed. Parked is what a run becomes when the module
  process that was waiting for its report restarted: the row is kept for its chunk
  fingerprint and prompt bytes (what a boot-time re-publication would adopt) but is
  offered to nobody, and the claim sweep deletes it once `deadline_ms` passes.

### `historian.claim`

```json
{"method": "historian.claim", "v": 1,
 "run_id": "mc-historian:project:a1a1a1a1a1a1a1a1:1",
 "claimant_instance_id": "install-uuid-one"}
```

```json
{"ok": true,
 "run_id": "mc-historian:project:a1a1a1a1a1a1a1a1:1",
 "session_id": "ses",
 "attempt": 1,
 "token": "5f3c…",
 "prompt": {"system": "…", "user": "…"},
 "model_chain": ["test/first", "test/second"],
 "await_budget_ms": 660000,
 "claim_deadline_ms": 1758460634567,
 "heartbeat_interval_ms": 30000}
```

Refusals: `unknown_run` (never queued, already terminal, removed, or belonging to
another project), `not_pending` (the run moved on, was parked by a restart, or its
own deadline passed), `already_claimed` (held under a live lease).

- `attempt` is minted by the module, monotonic per run, starting at 1.
- `token` is a 32-char hex digest, unique per `(run_id, attempt)`.
- `model_chain` is passed through, not walked module-side: fallback is the
  claimant's to do because only it knows which of those models it can reach. What
  comes back is one text or one failure.
- `claim_deadline_ms = min(now + lease, run deadline)`. Lease =
  `min(await_budget_ms, 600_000)`.

### `historian.heartbeat`

```json
{"method": "historian.heartbeat", "v": 1, "run_id": "…", "token": "…"}
→ {"ok": true, "claim_deadline_ms": …, "heartbeat_interval_ms": 30000}
```

Refusals: `unknown_run`, `not_claimed`, `superseded_token`, `run_expired`. A
heartbeat never pushes a lease past the run's own deadline, and once `now >=
deadline_ms` it refuses `run_expired` instead of handing back a lease that is already
in the past. `run_expired` means **stop**, not retry: by then `pending` no longer
offers the run and `claim` refuses it, so nothing can accept a report for it.

### `historian.complete`

```json
{"method": "historian.complete", "v": 1, "run_id": "…", "token": "…",
 "output": {"text": "<compartments>…</compartments>", "length_capped": false}}
```

or

```json
{"method": "historian.complete", "v": 1, "run_id": "…", "token": "…",
 "error": {"code": "chain_exhausted", "message": "…"}}
```

`→ {"ok": true, "accepted": true}`

Refusals: `unknown_run` (including a run belonging to another project),
`not_claimed`, `superseded_token`, `no_waiter` (nothing in this process is waiting on
that run), `already_reported` (a terminal report for this claim was already taken).

Rules worth restating for A2:

- **The token is checked before the body is read.** A claimant that was replaced
  still holds a real token; parsing its output first would spend validation on a
  document that can never be published.
- Exactly one of `output` and `error` must be present. Both is refused; neither is
  refused.
- `length_capped` defaults to `false` when absent and is **never inferred from the
  text**: a document that looks complete can still have been cut at the model's
  output ceiling. The module refuses a length-capped output before validation, the
  same as the in-module producer path does.
- Accepting a report does **not** publish it. It hands the text to the firing task
  that queued the run, which validates and publishes through exactly the same code
  the in-module producer path uses — same parser, same length-cap refusal, same
  `publish_historian_chunk` CAS.

---

## 3. The phase diagram as implemented

```
                       fire (unchanged)
          Idle ───────────────────────────────▶ Firing
            ▲                                    │  │
            │                        broca lane  │  │  host lane
            │                   producer_started │  │ pending_published
            │                                    │  │
            │                                    ▼  ▼
            │                     AwaitingProducer  Reclaiming
            │                              │   ▲        │
            │              lease_expired   │   │        │
            │                              └───┼────────┘
            │                                  │   reclaimed(attempt, token)
            │                                  │
            │        output_received           ▼
            │        ◀───────────────  AwaitingProducer
            │                                  │
            │                                  ▼
            │                             Validating
            │                                  │ validation_ok
            │                                  ▼
            └────────── tx_committed ─────  Publishing
                     (abandon from any phase on failure)
```

New transitions:

| Event | From | To | Effect |
| --- | --- | --- | --- |
| `pending_published` | `Firing` | `Reclaiming` | sets `producer_run_id`, `attempt = 0`, no token |
| `lease_expired` | `AwaitingProducer` | `Reclaiming` | clears token + claim deadline; keeps `run_id`, chunk fingerprint, selected identities, `firing_seq` |
| `reclaimed(attempt, token, deadline)` | `Reclaiming` | `AwaitingProducer` | attempt must be strictly greater than the current one |

`Reclaiming` means exactly one thing: **the run exists and owns its chunk, but nobody
is producing for it.** That is true both right after queueing and right after a lease
lapses, which is why both edges land there.

Run identity is the pair `(producer_run_id, producer_attempt)`:

- `HistorianPublishPredicate` carries `producer_attempt`, and all three
  predicate-match sites in mc-store compare it (`publish_historian_chunk`,
  `abandon_historian_run_if_matching_with_publish_failure`,
  `record_historian_publish_failure_if_matching`).
- A report produced under attempt *N−1* therefore fails the predicate in **every**
  phase, before any row is appended.
- The in-module (broca) producer lane is always `attempt = 0` with no token: it holds
  its run for as long as it runs and cannot be taken over, so there is nothing to
  supersede.

Restart handling: `Reclaiming` is treated like `Firing`/`Validating`/`Publishing` —
the run is released and a later trigger assembles a fresh chunk. Nothing
re-publishes a parked run to the queue after a restart yet, so keeping it would hold
the session's single-flight slot with no claimant able to arrive. **A2 should replace
this with re-publication** (see §7).

### Durability

mc-store **migration 57** creates `mc_historian_pending_run` (`phase`, `attempt`,
`claimant_instance_id`, `coordinator_token`, `claim_deadline_ms`, `lease_ms`,
`deadline_ms`, the prompt bytes and model chain, plus the session/fingerprint/seq the
run belongs to). B0 owns 58 and was not taken.

The session's own durable state inside `mc_cache_state.meta` remains the authority on
the firing. The queue table exists for two things that state cannot do: it is
addressable by `run_id` without knowing the session (which is all a claimant has), and
it holds the request bytes a claimant needs. `phase` and `attempt` are the claim's own
copy of the pair the session state carries, and **every** claim/expiry write updates
both rows in one transaction — a queue row whose session is not parked would be handed
to a claimant whose claim could never be admitted.

---

## 4. Stall reproduction (red-first, on today's machine)

Before the phase existed, commit `f44d594385` added
`historian::tests::pre_reclaim_lease_expiry_stalls_a_second_producer`, which drives
the pre-change machine: fire → `producer_started` → a second producer arrives after
the lease lapses.

```
$ cargo test -p mc-module --lib pre_reclaim_lease_expiry_stalls_a_second_producer -- --nocapture

running 1 test
STALL REPRODUCED: phase=awaiting_producer producer_run_id=Some("run-1"); producer_started refused (historian invalid transition: event producer_started cannot run from awaiting_producer); refire=Busy
test historian::tests::pre_reclaim_lease_expiry_stalls_a_second_producer ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1210 filtered out; finished in 0.00s
```

Both exits are closed on the pre-change machine:

- `producer_started` requires `Firing` → `InvalidTransition { from: awaiting_producer }`.
- `fire` refuses every non-`Idle` phase → `FireOutcome::Busy`.

So the run sat in `AwaitingProducer` until the 600 s producer await gave up, which is
§7A A7's claim, reproduced rather than asserted.

That test is kept as the record of the defect. The recovery it was missing is now
asserted by `lease_expiry_then_reclaim_admits_a_second_producer`,
`the_publish_predicate_names_the_attempt_not_just_the_run`, `attempts_only_move_forward`,
`the_reclaim_transitions_refuse_every_phase_they_do_not_belong_to` and, end-to-end
through the real store and the real dispatcher,
`an_expired_lease_hands_the_same_run_to_the_next_claimant`.

The guard the stall came from is deliberately **kept**: `producer_started` still
refuses `AwaitingProducer` and `Reclaiming`. A second producer cannot barge in; it has
to go through the lease.

---

## 5. Configuration

`historian.runner: "broca" | "host"`, **user tier only**, default `broca`.

- Rust reader: `crates/mc-module/src/config.rs` reads `/historian/runner` from the
  user tier and warns (`ignoring …/historian/runner from project tier`) when a
  project config sets it.
- An unreadable value (typo, empty, non-string) warns and **keeps `broca`**. A typo
  leaves folds running exactly where they ran before rather than rerouting every
  completion to a lane the user did not ask for.
- TS: `runner` added to `HistorianConfigSchema` (optional, no default, so nothing is
  injected into merged config) and to the historian user-only strip list in
  `project-security.ts`, covering both the top-level block and every per-harness
  block. A cloned repo cannot move the completion to a different process or provider
  account.
- Generated `CONFIGURATION.md` and `assets/magic-context.schema.json` were
  regenerated from the schema (their tests compare committed files to generator
  output).
- The runner is resolved once, when the firing is prepared, and carried on the firing
  task, so a config edit mid-run cannot move a firing already in flight.

---

## 6. Install instance uuid

`packages/plugin/src/features/magic-context/install-instance-id.ts`,
key `install_instance_id` in the existing `schema_migrations_meta` KV table in
`context.db`. **No TS migration** — that table is part of the baseline schema in
`storage-db.ts`. (`migrations.ts` was not touched; it is fenced to another slice.)

Why persisted rather than derived, per §7A A6:

- A file-derived id (store uuid, database path) is the **same** for two processes
  opening one file, so two hosts serving one project would both present it.
- A process-random id is **different** for the same install after a restart.

Neither can identify a claimant. `ensureInstallInstanceId(db)` mints
`crypto.randomUUID()` once, persists it with `INSERT OR IGNORE`, and re-reads — a
caller that loses the race returns the id that actually landed.
`readInstallInstanceId(db)` never mints, for diagnostics that must not create state.

The id is not a credential. What authorises a report is the attempt-scoped token the
module mints at claim time, so an id that leaks grants nothing. A2 reads it and passes
it as `claimant_instance_id`.

---

## 7. What A2 must implement

1. **The pull loop.** Poll `historian.pending` (no `session_id` for a host serving
   several sessions), `historian.claim` the head, run the completion through the
   host's own hidden executor on `prompt.system` / `prompt.user` walking
   `model_chain`, `historian.heartbeat` every `heartbeat_interval_ms` while it runs,
   and `historian.complete` with `output` or `error`.
2. **Claimant identity.** `ensureInstallInstanceId(db)` from
   `packages/plugin/src/features/magic-context` — do not derive one.
3. **Treat refusals as routine.** `already_claimed` / `not_pending` mean another
   claimant or a state change won; take the next run. `superseded_token` means this
   claim is over: stop the run, do not retry the report.
4. **Deadline propagation.** `deadline_ms` bounds the whole run;
   `claim_deadline_ms` bounds this claim. A completion that will obviously miss
   `deadline_ms` is not worth starting — the module has already stopped waiting.
5. **Restart behaviour.** A `Reclaiming` run is released on module restart, and a
   queued run is only waited on by the in-process firing task that queued it
   (`no_waiter` after a module restart). The release now **parks** the queue row
   rather than orphaning it: the row keeps its chunk fingerprint and prompt bytes,
   `pending` stops offering it, and `expire_historian_claims` deletes it once the
   run's own deadline passes. A2 re-publishing parked runs on boot has everything it
   needs in that row; doing nothing is also safe, because the sweep collects it.
6. **The report is not a publish.** `{"ok": true, "accepted": true}` means the module
   took the text, not that a fold landed. Validation or the publish CAS can still
   refuse it. Fold arrival is observed on a later pass, as it is today.
7. **Kill switch and the default flip** stay A2/A3 (§7A A9): A2 ships with the default
   still `broca`.
8. **Emergency accounting** (§7A A8) is not in this slice: the host lane's
   serve-then-fold cost accounting belongs with the pull loop that makes it the
   standing behaviour.

---

## 8. Equivalence evidence

- **What "identical" covers, measured.** With the default runner the historian
  request digest and the served `ck_messages` array are byte-identical to the base
  `991046ca` (271,085 served bytes, same digest on both trees). The **durable**
  `ModuleMeta` blob is not: 22,027 → 22,048 bytes, exactly the 21 bytes of
  `,"producer_attempt":0`, because the field is `#[serde(default)]` with no
  `skip_serializing_if` and therefore rides every meta blob. Both streams are pinned
  as constants in `crates/mc-module/src/tests/gate_a1_b0_baseline_probe.rs`, so a
  later change to either fails rather than drifts. The claim to quote is "every
  **served** byte", not "every module output".
- **Publish equivalence** (§2.5 / §6A A5):
  `historian::tests::both_runners_publish_the_same_compartments_for_the_same_output`
  feeds one recorded completion down **both** runners into two independent stores and
  compares the published `StoredCompartment` rows. Identical, two rows each (the
  seeded prior plus the fold). Proved non-vacuous: mutating the host path to publish
  altered text reddened exactly that test and left
  `a_queued_run_nobody_claims_is_released_rather_than_left_in_flight` and
  `the_host_runner_refuses_an_empty_model_chain_like_the_in_module_one` green.
- **Differential goldens** (`crates/mc-module/src/differential_goldens.rs`): 4/4 pass,
  including the one-byte vacuity guard across all 9 families. Nothing on the transform
  path was touched; the seam is entirely below the completion call.
- **Rust suite**: `cargo test -p mc-module -p mc-store --no-fail-fast` — 1,222 lib
  tests plus every integration binary pass. One **pre-existing** failure,
  `cold_flip_adversarial::subagent_flip_records_action_and_stable_tagged_replay`,
  reproduced byte-identically on the base tree at `991046ca` (same
  `bytes=459744/459849/459849`, same `first_divergence`) from a read-only
  `git archive` extraction under `$TMPDIR/magic-context/rust-a1-baseline/`.
- **Lint**: `cargo clippy --all-targets -- -D warnings` clean.
  `cargo build --locked --release -p mc-module` clean, `Cargo.lock` unchanged.
- **TS**: `bun run typecheck`, `bun run lint`, and the plugin suite (5,148 pass,
  2 pre-existing skips, 0 fail).
- **Hermetic real-daemon e2e**: `scripts/run-rust-hermetic-e2e.sh` cannot run at this
  base commit — its manifest-selection step fails before any test:

  ```
  mode manifest validation failed: Error: missing manifest entries:
  tests/opencode2/commands-s2-flush.test.ts, …, tests/opencode2/tool-definition-telemetry.test.ts
  ```

  Reproduced identically on the base tree at `991046ca`, so the committed mode
  manifest is stale with respect to the `tests/opencode2/` tree. **Pre-existing; not
  this slice's to fix, and worth naming as a release-gate blocker.**

  The rust-mode files were therefore run with the script's *exact* per-file
  invocation (`MC_E2E_MODE=rust NODE_ENV="" bun test --timeout 600000
  --max-concurrency=1 <file>`), skipping only the manifest selection. Each spawns its
  own hermetic `ckdev-mc-e2e` from the current tree under an e2e-owned target
  directory:

  | File | Result |
  | --- | --- |
  | `rust-smoke` | pass |
  | `rust-historian-producer` | pass (3/3 — deterministic tiered output, oversize tool arc, loud failure path when Broca dies mid-run) |
  | `rust-steady-state-byte-identity` | pass |
  | `rust-compaction-marker-byte-identity` | pass (control, post-restart-1 and post-restart-2 all `sha256=e4cc1773…b23d09`) |
  | `rust-fold-under-pressure` | pass |
  | `rust-timeout-epoch-recovery` | **fail — pre-existing** |

  `rust-timeout-epoch-recovery` fails deterministically (the `transform_timeout`
  drive fault does not trip; the pass is served `applied: true, servedFrom:
  "transform"` where the test expects `applied: false, servedFrom: "raw"`), and fails
  **identically on the base tree** at `991046ca`, down to the same
  `transportBytes: 16347`. Not caused by this slice.

  The byte-identity and historian-producer arms passing under the default runner are
  the acceptance evidence: the broca lane's requests and the served wire bytes are
  unchanged with a real daemon in the loop.

Production isolation held throughout: the test preload pins
`MAGIC_CONTEXT_TEST_DATA_DIR` and `XDG_DATA_HOME` to throwaway temp roots, the e2e
spawns a hermetic ck-subc, no binary was placed, and no database under
`~/.local/share/cortexkit/` was opened.

---

## 9. Deviations from the brief, and why

1. **Migration 57 is a table, not columns on an existing one.** The brief says
   "migration 57 for the phase/attempt columns". The historian phase and attempt live
   inside `mc_cache_state.meta` as JSON, not in SQL columns, so adding SQL columns for
   them would create a second source of truth for the same facts. 57 instead creates
   `mc_historian_pending_run`, which **does** carry `phase` and `attempt` columns — as
   the claim's own copy, written in the same transaction as the session state — plus
   the run addressing and request bytes a claimant needs. The phase/attempt additions
   to the durable state ride serde defaults and need no migration.

2. **`historian.complete` delivers to the waiting firing task rather than
   re-assembling the publish context.** Validation and publish need the validation
   chunk, transcript, raw messages, boundary dates, prior compartments and validate
   options — state the firing task holds and the queue row has no reason to carry. The
   host firing waits for its report exactly as the in-module path waits on its
   subscribe stream, then calls the **same** `publish_output_from_awaiting`. That is
   what makes "validated exactly as today's producer output is" literally true rather
   than approximately true. The cost is that a report arriving after a module restart
   gets `no_waiter`; see §7 item 5.

3. **Refusals are `ok: false` responses, not error frames.** Stated in §2 above.
   A claim race is not a failed request.

4. **No `BrocaRunner` / `HostRunner` structs.** The seam is a selector
   (`HistorianRunnerKind`) plus two firing functions. Wrapping today's path in a
   trait object would have moved the broca call site, and the acceptance bar for this
   slice is that its requests are byte-identical. The broca path is reached by exactly
   the code it was reached by before: `factory.connect(&project_root)` then
   `run_historian_firing_with_model_cache`. The host arm returns before that line and
   never opens a route.
