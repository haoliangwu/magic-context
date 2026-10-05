# A2 on the fixed claim lane — integration and executed adversarial gate

**Tree**: `gate/rust-a2` (`a11472d3`) with `gate/rust-a1-b0` (`efc19002`) merged in, then the
findings below fixed and gated.
**Under review**: A2 (host-runner pull loop, durable terminal report, serve-then-fold) standing
on the A1+B0 gate fixes (project-scoped claim lane, `v` enforcement, `run_expired`, parked
queue rows, `HistorianSweepOutcome`).

Merge, not rebase, on the same reasoning the A1+B0 fixes gave: a rebase rewrites `a11472d3` out
of the branch's ancestry and no fast-forward can then reach it.

**Verdict: SHIP-WITH-PINS.** Three BLOCKs were found and fixed in this branch with their tests
flipped to guarantees; five pins are recorded below for whoever owns A3.

---

## 1. What the merge had to reconcile

### 1.1 The migration chain

57 (claim queue, A1 — amended in place by the fixes to name the parked phase), 58 (single-store
marker, B0) and 60 (terminal report columns, A2) now ship contiguously except 59, which is
reserved for a change on its own branch.

Migration 57's documentation gained the fourth phase value A2 writes
(`crates/mc-store/src/lib.rs:2947`): it named three, and `reported` is a fourth.

**The assertion that was dropped, by name.** The fixes' finding 1 flipped
`the_migration_chain_has_exactly_one_reserved_gap` into
`the_migration_chain_is_contiguous_and_claims_each_version_once`, whose first assertion is
`missing == []` over `1..=LATEST`. A chain reserving 59 cannot satisfy it. It is replaced by
`the_migration_chain_has_no_hole_except_the_one_reserved_version`
(`crates/mc-store/src/lib.rs:24090`), which:

- excludes exactly one version **by name**, through a `RESERVED_UNMERGED_MIGRATION_VERSION`
  constant, so a hole anywhere else is still a failure — the property the fixes restored is
  kept for every version except the reserved one;
- **retires itself**: its first assertion fails the moment the reserved version joins the
  chain, so whoever merges it deletes the constant rather than leaving a permanent hole in the
  check.

The uniqueness half of the dropped assertion survives twice: here, and in A2's
`the_bundled_migration_chain_never_reuses_or_rewinds_a_version`, which the brief asked to keep.

`shipped_migration_versions` (the fixes') and `bundled_migration_versions` (A2's) were the same
function under two names. One is kept.

### 1.2 A store that applied 58 without 57 now refuses to open

Migration 60 extends `mc_historian_pending_run`, the table 57 creates. A store that recorded 58
while 57 was not in its chain never gets 57, so 60 has nothing to extend and the open fails
naming the missing table. Before 60 existed the same skew opened quietly and failed at the
first queued run.

`gate_a_store_that_applied_58_first_never_gets_57`
(`crates/mc-store/src/tests/gate_a1_b0.rs:184`) now drives an era-accurate chain (everything up
to 58, minus 57) and asserts the louder consequence, then proves the skip is still permanent.
No released build ever carried 58 without 57 — the fixes state they ship in one build — so this
is a property of the skew, not a migration hazard introduced here.

`gate_a_store_at_58_is_served_by_a_binary_whose_chain_stops_at_56` became
`gate_a_store_at_the_current_ceiling_is_…`, and
`the_marker_migration_lands_unset_on_a_populated_store` stopped asserting the marker migration
is the newest one: it is not, now that 60 follows it. Both still cross the marker migration
through the real open path and still prove the marker lands unset.

### 1.3 `run_expired` everywhere the run's own deadline is the reason

A2's `record_historian_report` refused a report for a run past its own deadline with
`unknown_run`. It now answers `run_expired`
(`crates/mc-store/src/historian_claim.rs:766`), the same code the fixes gave the heartbeat,
because it means the same thing and asks the claimant for the same response: the run is over,
stop rather than take the next one. `a_report_for_a_run_whose_deadline_passed_is_not_stored`
asserts the new code and says why the distinction matters.

### 1.4 The re-publication tests stopped writing `parked` by hand

A2's store tests forced `phase = 'parked'` with raw SQL, which was correct when nothing wrote
it. They now park through `park_historian_pending_run`, the call the restart path itself makes.

---

## 2. Findings

### F1 — BLOCK (fixed): the parked-row re-publication could not fire in production

`republish_parked_historian_run` refuses a row that is already claimable or claimed, so it only
acts on a row in `phase='parked'`. Two independent reasons made that unreachable:

1. The only writer of `parked` is `handle_restart_load`
   (`crates/mc-module/src/historian.rs:947`), which releases the session in the same
   transaction. Release calls `abandon_with_detail`, which resets to
   `HistorianDurableState::default()` except for five named fields
   (`crates/mc-module/src/historian.rs:611`), clearing `producer_run_id` — and
   `producer_run_id` is the only link `load_parked_historian_run` follows to find the row
   (`crates/mc-store/src/historian_claim.rs:880`). The row is orphaned by the same write that
   parks it.
2. Even given a parked row the session still named, `maybe_spawn_reattach` short-circuited the
   "still out, no report, inside its deadline" case and returned before ever calling
   `adopt_historian_run_on_host` (`crates/mc-module/src/lib.rs:5524`) — which is where the
   re-publication lived.

A2's §8 states the contract is "pinned before the fix lands" by
`a_run_taken_out_of_the_queue_by_a_restart_goes_back_on_offer_unchanged`. That test wrote the
phase itself, so it pinned the store call and not the path to it.

**Fix.** `reoffer_parked_historian_run` (`crates/mc-module/src/historian.rs:2389`) parks the row
and puts it straight back, and is called from **both** the short-circuit and the adoption path.
The park is a new narrowed writer, `park_unclaimed_historian_run`
(`crates/mc-store/src/historian_claim.rs:958`), which skips a row a claimant is still holding:
that claimant is heartbeating against the row and paying a provider for the completion right
now, so clearing its token would throw away a fold in flight. Everything the run owns — run id,
chunk fingerprint, firing sequence — survives both steps.

Guarantee: `gate_a_parked_row_goes_back_on_offer_on_the_next_boot_with_the_same_run_and_chunk`
(`crates/mc-module/src/tests/gate_a2.rs:437`). Mutation M-1.

### F2 — BLOCK (fixed): the claim sweep had no production caller

The fixes gave `expire_historian_claims` a return value so a caller could log what it dropped,
and left it with no caller outside tests. Restart recovery now runs it
(`crates/mc-module/src/lib.rs:5485`) and logs both halves by name.

The sweep is the only thing that walks the **queue** rather than one session's link into it, so
it is the only thing that can reach the row F1 describes: parked, past its deadline, and named
by nobody. Without it such a row stays for the lifetime of the store.

Guarantee: `gate_restart_recovery_sweeps_a_parked_row_nothing_else_can_reach`
(`crates/mc-module/src/tests/gate_a2.rs:537`). Mutation M-2.

**Recorded against this gate, not against A2.** The first version of that test parked a row past
its deadline and watched it disappear; removing the sweep's caller left it green, because the
adoption path was already releasing that row through the session's own link. The test was
measuring the adoption path and calling it the sweep. It was rewritten around a row nothing
else can reach, and only then did the mutation redden it.

### F3 — BLOCK (fixed): the lane's last write was not scoped to the caller's project

The fixes made `list`, `claim`, `heartbeat` and `authorize` take `project_path` as their first
argument. A2 added a fifth store call reachable from the lane —
`record_historian_report`, the durable half of `historian.complete` — and it took none. It is
protected today only because `authorize_historian_report` runs in front of it on the one path
that reaches it; the next caller added beside it would write across projects.

**Fix.** `record_historian_report` takes the caller's project and filters on it
(`crates/mc-store/src/historian_claim.rs:728`), answering `unknown_run` for another project's
run exactly as its four neighbours do.

Guarantee: the store-level arm of `gate_a_host_bound_to_one_project_cannot_walk_another_projects_run`
(`crates/mc-module/src/tests/gate_a2.rs:683`), which offers a report straight to the store under
the wrong project with the **right token** and is refused. Mutation M-3.

### F4 — PIN: the two token checks in `authorize_historian_report` shadow each other

`authorize_historian_report` compares the presented token against the queue row's
(`crates/mc-store/src/historian_claim.rs:663`) and then against the session meta's
(`crates/mc-store/src/historian_claim.rs:676`). Deleting the first reddens **nothing** across
mc-module (1,248 tests) and mc-store (189) — recorded as mutation M-5a, an `undefended` result.
Deleting both reddens the gate.

This is defence in depth and the redundancy is worth having: the row and the meta are written
together, so a disagreement between them is itself a signal. The pin is that no test
distinguishes them, so a reader tidying one can delete it believing the other is the guard, and
the tree gives no warning that the second deletion is the one that opens the lane. A3 should
either give each check its own test or fold them into one comparison with one name.

### F5 — PIN (fixed here, but it changes a delivery claim): a refused poll was logged every pass

A2's §8 claims a refused poll is "surfaced and logged once instead of being read as no work",
pinned by *says once when the module refuses this host's poll outright*. The dedupe only covered
a refusal delivered as a body (`{ok: false, refusal}`). The module answers the faults this
sentence is about — `route_unbound`, `bad_request` — with an **error frame**
(`historian_lane_binding`, `crates/mc-module/src/lib.rs:7466`), which reaches the loop as a thrown error and was logged on
every transform pass. Those are exactly the faults that do not clear on their own, so it was a
line per pass forever.

Both paths now dedupe on the same key, in `HistorianHostRunner.poll`
(`packages/plugin/src/hooks/magic-context/historian-host-runner.ts:293`). Guarantee: *says once
when the module refuses this host's poll outright, however the refusal arrives*. Mutation M-8.

### F6 — PIN: `historian.runner: "host"` is accepted on Pi and does nothing

Pi shares the plugin's config schema, so `historian.runner` parses there. Nothing in Pi reads
it: Pi has no Rust transform mode, no module client and no claim-lane caller, so a Pi session
cannot queue a run at all and therefore cannot leave one queued unanswered — which is the
failure the brief asked to rule out, and it is ruled out structurally rather than by a check.

What is NOT true is that the user is told. A Pi user who sets `historian.runner: "host"` gets no
warning and no behaviour change; the historian runs in the Pi session as before. A3's
harness-derived default fixes the behaviour question; the diagnostic question stays open.

Pinned by `packages/pi-plugin/src/historian-host-lane-pi.test.ts`: one test scans every non-test
Pi source for a claim-lane op or a Rust-mode caller and requires none, and one loads the config
and asserts Pi resolves its own subagent historian regardless. The first would fail the moment
Pi gains a queueing path without a claimant.

Minor, same file: `PiHistorianOptions.runner` is the Pi **subagent** runner, an unrelated object
that happens to share the name with the lane selector. Recorded so a reader of either does not
assume they are connected.

### F7 — PIN: one claim per session is guarded once, for two properties

Removing `if (this.active.has(run.sessionId)) continue;` reddens both the head-of-line gate and
A2's own *refuses a second claim for a session it is already running* (mutation M-9). One line
carries both "do not buy a completion whose report cannot be admitted" and "do not let one
session's queue depth starve another". That is fine as behaviour and worth knowing when it is
next edited.

### F8 — the A8 accounting, measured on a fixture that has tool arcs

A2 measured serve-then-fold on `big_messages()`, which is plain text: the emergency reduction
has no tool-output tier there, so its dropped-tag count was reported as 0 without the
permanent-content-loss half being exercised at all. A2 said so plainly and listed a tool-bearing
fixture as A3 work. This gate runs it.

`gate_the_a8_emergency_accounting_on_a_fixture_that_has_tool_arcs`
(`crates/mc-module/src/tests/gate_a2.rs:763`) drives 81 messages, 27 of them tool arcs with
large outputs, down both runners at 48,000/50,000 usage:

```
broca dropped_tags=15 served_messages=46 served_bytes=35796  second_rewrite_bytes=0
host  dropped_tags=20 served_messages=69 emergency_served_bytes=65060
      second_rewrite_dropped_tags=15 second_rewrite_messages=46 second_rewrite_bytes=35796
```

What those numbers say, and what they do not:

- **The emergency pass costs +29,264 bytes, +81.8%** under the host runner (65,060 against
  35,796), because it serves 69 raw messages where the inline join served 46. That is a bigger
  relative gap than the +33.3% A2 measured on the tool-less fixture, because tool outputs are
  the bulk of what the fold removes.
- **The host lane drops five more tool outputs on that pass** — 20 against Broca's 15. This is
  the half A2 could not measure, and it is not zero. The extra drops are the reduction paying
  for the larger serve.
- **The second rewrite is byte-identical to what Broca served inline**: 35,796 bytes over 46
  messages with 15 dropped tags, the same three numbers. So the fold that eventually lands is
  the same fold, one pass later, and the steady state after it is the same.
- **What this does NOT establish** is whether those five extra drops are permanent. The second
  rewrite serves 46 messages where the emergency served 69, so the arcs that would carry the
  difference are inside the folded prefix and are not in the comparison. Measuring permanence
  needs a pass that serves the same window under both runners; it is not what this fixture
  does. A3 should not read `20 vs 15` as "five tool outputs lost forever" — only as "the
  emergency pass under the host runner drops more".

Non-vacuity: the measurement is guarded by an assertion that the served wire carries tool arcs
at all, and mutation M-7 strips the arcs out of the fixture and reddens it.

---

## 3. The sequences this gate executes

Each one drives the real dispatcher, the real store, the real restart path, or the real loop.

| Claim | Where | Mutation |
| --- | --- | --- |
| Two hosts on one project; A claims, is killed mid-completion; B steals after the lease lapses; exactly one publish and it is B's; A's late `complete` replayed by hand with the stale token is refused `superseded_token` | `gate_a_killed_host_loses_the_run_to_the_next_one_and_its_late_report_is_refused` + host-side `hands a killed host's run to the next one…` | M-5b, M-9 |
| Module restart between claim and `complete`: the report is stored on the queue row, the next pass publishes it, a second report after the publish is refused | `gate_a_report_that_crosses_a_module_restart_is_stored_and_then_published` | M-4 |
| A restart that parked a row: boot re-publishes it and a claimant adopts it with the SAME run id and fingerprint | `gate_a_parked_row_goes_back_on_offer_on_the_next_boot_with_the_same_run_and_chunk` | M-1 |
| Head-of-line: a slow claim on session A never delays session B; one claim per session per host in flight | `never lets a slow fold on one session delay a claim on another` | M-9 |
| Kill switch: no claims, one log line, runs stay pending and another host claims them | `claims nothing while the kill switch is off and says so once…` | M-6 |
| Serve-then-fold at ≥95% on a fixture WITH tool arcs, both runners, numbers recorded | `gate_the_a8_emergency_accounting_on_a_fixture_that_has_tool_arcs` | M-7 |
| Cross-project isolation through the loop's whole op sequence | `gate_a_host_bound_to_one_project_cannot_walk_another_projects_run` + `never sees or claims a run belonging to another project` + the seam test | M-3, M-10 |
| Pi: `runner=host` cannot leave a Pi run queued unanswered | `packages/pi-plugin/src/historian-host-lane-pi.test.ts` | structural (scan) |

Two details worth naming.

**The restart is a real one.** It is two tokio runtimes over one store directory, not two
handlers: the firing task the first pass spawns holds an `Arc<McStore>`, and only dropping the
runtime it lives on takes it away. The store's single-writer lease refuses the second module
until that has actually happened, so the test cannot accidentally carry the first process's
in-memory ledger across. That is what makes "no task in this process is waiting" true rather
than asserted.

**The two hosts produce different documents.** Both run the same prompt, but the gate gives them
distinguishable answers and asserts the surviving claimant's is the one in the compartment —
so "exactly one publish" cannot pass by publishing the wrong one.

---

## 4. Mutation evidence

Every mutation was applied to the live tree with the working state staged, run, then restored
with `git checkout --` from the index. `git diff --stat` was non-empty during and empty after
each one. Suites: `cargo test --locked -p mc-module -p mc-store --lib --no-fail-fast` for the
Rust rows; the three host-runner test files for the TypeScript rows.

| # | Mutation | Red | Also red |
| --- | --- | --- | --- |
| M-1 | `reoffer_parked_historian_run` returns early without parking or re-publishing | `gate_a2::gate_a_parked_row_goes_back_on_offer_on_the_next_boot_with_the_same_run_and_chunk` | nothing |
| M-2 | the sweep call removed from restart recovery | `gate_a2::gate_restart_recovery_sweeps_a_parked_row_nothing_else_can_reach` | nothing |
| M-3 | `record_historian_report`'s `project_path` filter made always-true | `gate_a2::gate_a_host_bound_to_one_project_cannot_walk_another_projects_run` | nothing |
| M-4 | restart recovery stops looking for a queue row behind an `AwaitingProducer` session | `gate_a2::gate_a_report_that_crosses_a_module_restart_is_stored_and_then_published` | nothing |
| M-5a | `authorize_historian_report`'s queue-row token comparison deleted | **nothing** — 1,248 + 189 green | — (finding F4) |
| M-5b | both of `authorize_historian_report`'s token comparisons defeated | `gate_a2::gate_a_killed_host_loses_the_run_to_the_next_one_and_its_late_report_is_refused` | `gate_a1_b0::gate_complete_refuses_a_superseded_an_unknown_and_an_unclaimed_run` — the A1+B0 gate's own cover for the same guarantee |
| M-6 | the kill switch's log latch never re-arms | `host runner gate > claims nothing while the kill switch is off and says so once…` | nothing |
| M-7 | the A8 fixture's tool arcs replaced with plain messages | `gate_a2::gate_the_a8_emergency_accounting_on_a_fixture_that_has_tool_arcs` | nothing |
| M-8 | the poll-failure log stops deduplicating | `host runner gate > says once when the module refuses this host's poll outright…` | nothing |
| M-9 | the one-claim-per-session guard defeated | `host runner gate > never lets a slow fold on one session delay a claim on another` | `historian host runner > refuses a second claim for a session it is already running` — A2's own cover for the same line |
| M-10 | the loop's ops sent on a route bound to another project root | `host runner project binding at the transform seam > sends every claim-lane op on the transform's own project route` | nothing |

M-5a is reported as **undefended** rather than quietly dropped: it is finding F4 in one row.

---

## 5. Gates

| Gate | Result |
| --- | --- |
| `cargo build --locked --release -p mc-module` | pass, `Cargo.lock` unchanged |
| `cargo test --locked -p mc-store -p mc-module --all-targets` | pass — mc-module lib **1,248**, mc-store lib **189**, every integration binary green |
| `cargo clippy --locked --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `bun run typecheck` | clean |
| `bun run lint` | 0 errors (40 pre-existing warnings, none in files this branch touches) |
| `scripts/run-rust-hermetic-e2e.sh` | **`status=pass`**, whole script, exit 0 in 1,242 s, no `RETRY` line |
| `packages/pi-plugin` suite | **1,219 pass, 3 skip, 0 fail** |
| `packages/plugin` suite | 5,187 pass, 2 skip, **1 fail** — a load flake, §6 |
| v1 pure-replay differential, `master` → HEAD | **`RESULT IDENTICAL defer_passes=4`** |

---

## 6. Suites, e2e and the differential

### The hermetic e2e

`scripts/run-rust-hermetic-e2e.sh` runs end to end and reports
`[e2e:rust:hermetic:end] status=pass`, exit 0, with no `RETRY` line. The same two fresh-worktree
prerequisites the A1+B0 fixes recorded had to be satisfied first, and neither is a code change
or is committed:

1. `bun install --frozen-lockfile` — `Checked 990 installs across 1238 packages (no changes)`;
   no manifest or lockfile moved.
2. `cd packages/pi-plugin && bun run build` — `packages/pi-plugin/dist/index.js` is a gitignored
   build artifact the Pi harness requires.

These run under the **default** runner, which is this slice's acceptance evidence: with a real
daemon in the loop, the Broca lane's requests and served bytes are unchanged.

### The pure-replay differential

`bun packages/e2e-tests/scripts/pure-replay-differential.ts master HEAD` —
**`RESULT IDENTICAL defer_passes=4`**, every defer pass byte- and sha256-equal between master
(`923f027d`) and this branch:

```
DEFER PASS 3 IDENTICAL left_bytes=594 left_sha256=d649359b66… right_bytes=594 right_sha256=d649359b66…
DEFER PASS 4 IDENTICAL left_bytes=760 left_sha256=9e81ff6905… right_bytes=760 right_sha256=9e81ff6905…
```

That, plus the wire golden `crates/mc-module/testdata/historian-claim-wire-golden.json` passing
unchanged and `the default runner never reaches the claim lane` still green, is the
byte-identity claim for `historian.runner: "broca"`.

### The one plugin-suite failure

`explicit shared storage resolution > opens a fresh absolute override and applies private
storage permissions` timed out against its 5 s cap — after taking **63.7 s**. It passes in
isolation in 752 ms, and `git diff master..HEAD` over both
`packages/plugin/src/features/magic-context/storage-db.ts` and its test file is **empty**: this
branch does not touch either. A 5 s cap blown by a factor of twelve on a machine running a
parallel Rust build is machine contention, and it is the same storage-db family A2 recorded
flaking under load. Recorded rather than waved away, but it is not this branch's.

---

## 7. Production isolation

Every store opened here is a `tempfile::tempdir()` under the ambient temp root; the hermetic e2e
spawns its own `ckdev-mc-e2e` with `XDG_DATA_HOME` pinned to a throwaway directory, and the
TypeScript preload pins `MAGIC_CONTEXT_TEST_DATA_DIR` and `XDG_DATA_HOME` to temp roots. No
database under `~/.local/share/cortexkit/{magic-context,store}` was opened and no binary was
placed.
