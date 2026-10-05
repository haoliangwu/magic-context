# A1 + B0 gate fixes — findings 1–7 and the two wording pins

**Tree**: `gate/rust-a1-b0` (`b5ef0e21`) with `master` merged in, then the seven findings
from `.cortexkit/alfonso/reviews/rust-a1-b0-gate.md` fixed.
**Under repair**: A1 (host-runner claim lane) and B0 (single-store marker), as merged.

Every finding's gate test was written by the gate to assert the defect, so it goes red
the moment the defect is gone. Each one below was flipped to assert the guarantee and
renamed to say so; a test whose name still described the defect would be a lie the next
reader would trust.

---

## 0. Master first

The gate's two named pre-existing failures (`cold_flip_adversarial::subagent_flip_records_action_and_stable_tagged_replay`
and the `rust-timeout-epoch-recovery` e2e) are fixed on master, and the stale mode
manifest that stopped `scripts/run-rust-hermetic-e2e.sh` from selecting files
(the gate's finding 8) is repaired there too.

Master was brought in as a **merge**, not a rebase. The brief asked for a rebase and for
a push that `gate/rust-a1-b0` can be fast-forwarded to; those two are not both
satisfiable, because a rebase rewrites `b5ef0e21` out of the branch's ancestry and no
fast-forward can then reach it. The merge keeps `b5ef0e21` as an ancestor, so the
fast-forward works, and it carries exactly the same master fixes. Master touched no
Rust crate this branch touches (`crates/mc-module/src/transform.rs` and the e2e
harness only) and `Cargo.lock` did not move, so no lockfile reconciliation commit was
needed.

---

## 1. BLOCK — the merged tree failed its own mc-store suite

`RESERVED_UNSHIPPED_MIGRATION_VERSION` is gone. Nothing is reserved once 57 ships.

- `the_migration_chain_has_exactly_one_reserved_gap` → **`the_migration_chain_is_contiguous_and_claims_each_version_once`**:
  `missing` must be empty, and no two migrations may claim one version. This restores the
  property B0's "collateral change" section said it was giving up — a migration declared
  but never reaching a store is caught again, and a hole is now a failure rather than the
  assertion.
- `the_marker_migration_lands_unset_on_a_populated_store` steps through to
  `SINGLE_STORE_MARKER_MIGRATION_VERSION - 1` (57), and the "reserved" message is gone.
- `shipped_migration_versions()` keeps its two call sites; with a contiguous chain either
  form is sound, and comparing against the shipped chain still catches a declared-but-unapplied
  migration.

`mc-store --lib`: 181 pass, 0 fail.

**B1 is untouched.** `gate/rust-b1` carries its own `RESERVED_UNMERGED_MIGRATION_VERSIONS = {57, 58}`
with a self-retiring assertion; when B1 merges after this, that constant retires with it.
Nothing here reaches into that branch.

---

## 2. A2 blocker — the claim lane had no channel scope

`historian.pending` / `claim` / `heartbeat` / `complete` now resolve the channel's binding
like every neighbouring management op, and the store filters on `project_path`.

- **Unbound channel** → `route_unbound` error frame, the same code `management_binding`
  uses (`crates/mc-module/src/lib.rs`, `historian_lane_binding`).
- **Bound channel** → the project key is resolved through
  `authority_project_for_route(route_root, "memories")` with the route root as the
  fallback — *exactly* the resolution the transform applied when it queued the run, so a
  workspace member and its authority project are one key rather than two spellings.
- **Store side**: `list_pending_historian_runs`, `claim_historian_run`,
  `heartbeat_historian_run` and `authorize_historian_report` all take `project_path` as a
  required argument. A run in another project is answered **`unknown_run`** — the same
  answer as a run that does not exist. A caller must not learn that another project on
  this machine has a fold outstanding, let alone read its transcript.

A claimant still discovers runs by polling without naming a session. What it can no longer
do is poll outside its own project.

Gate test flipped: `gate_pending_hands_an_unbound_caller_another_projects_run_and_prompt`
→ **`gate_pending_refuses_an_unbound_caller_and_hides_another_projects_run`**. It drives all
four ops on the unbound channel 9 (all `route_unbound`), then on the bound channel 7 asserts
the listing contains only the bound project's run, the other project's run claims
`unknown_run`, and — as the control — the caller's own run claims fine and hands back its
prompt.

---

## 3. `v` is read now

All four ops require `v == 1` and answer `bad_request` otherwise, the same as
`management_binding` beside them. The fixture
(`crates/mc-module/testdata/historian-claim-wire-golden.json`) is unchanged: it already
pinned `v: 1`, and nothing read it.

Gate test flipped: `gate_the_claim_lane_serves_requests_whose_version_it_never_read`
→ **`gate_the_claim_lane_refuses_a_request_whose_version_it_cannot_serve`**, covering all
four ops × {absent, `99`, `"not-a-number"`}, with the `v: 1` control still served.

---

## 4. A heartbeat past the run's own deadline is refused

`heartbeat_historian_run` refuses with a new named refusal, **`run_expired`**, once
`now_ms >= deadline_ms`. A new code rather than reusing `not_pending`: the claimant's
correct response is to stop, and a code that also means "someone else has it" would be
read as "try the next run".

At that point `pending` no longer offers the run and `claim` refuses it, so the heartbeat
was the single op in the lane still telling a claimant to keep paying a provider for a
completion nothing can accept.

Gate test flipped: `gate_a_heartbeat_after_the_runs_own_deadline_is_answered_ok`
→ **`gate_a_heartbeat_after_the_runs_own_deadline_is_refused_run_expired`**. The store-level
twin, `a_heartbeat_past_the_runs_own_deadline_is_refused_rather_than_extended`, keeps the
one-millisecond-before control so the refusal is about the deadline and not about the token.

---

## 5. A restart-released run parks its queue row

Decided with A2's needs in mind, since A2 may re-publish parked runs on boot:

- `handle_restart_load` marks the row **`phase='parked'`** (`park_historian_pending_run`),
  keeping `chunk_fingerprint`, the prompts and the model chain — everything a
  re-publication would otherwise pay to re-assemble. The park happens **before** the
  session is released, so a crash between the two leaves a row the next boot parks again
  rather than one still advertised to claimants whose session no longer owns it.
- `pending` and `claim` skip parked rows (`is_claimable` already refused any phase that is
  not `pending`/`claimed`; parked joins that set explicitly, with `claim` answering
  `not_pending`).
- `expire_historian_claims` deletes parked rows past `deadline_ms` in the same sweep, and
  now returns `HistorianSweepOutcome { reclaimed, dropped }` so a caller can log what it
  dropped rather than discovering silence.

Migration 57 is unshipped, so its documentation was amended in place: `phase` names its
three values and the row lifecycle now states that a parked row is deleted by the sweep.
No DDL change was needed — `phase` is `TEXT NOT NULL` with no value constraint, so the new
value required no schema edit and no new migration number.

Gate test flipped: `gate_restart_releases_a_parked_run_but_leaves_its_queue_row_behind`
→ **`gate_restart_releases_a_parked_run_and_parks_its_queue_row`**: the row reads `parked`
with `fp-ses` intact, `pending` returns `[]`, a claimant that names it anyway is refused
`not_pending`, the sweep inside the deadline leaves it (that is the window a boot-time
re-publication has), and the sweep at the deadline drops it.

---

## 6. The poll left the write transaction

`list_pending_historian_runs` moved from `with_conn_fenced` (an `IMMEDIATE` write
transaction that may also create the fence table) to `with_conn`. It is a pure read; at one
poll per second per host, every poll was taking the store's exclusive write lock and
competing with transform commits for a query that writes nothing.

New test: **`gate_a_pending_poll_does_not_block_a_concurrent_transform_commit`**. A second
connection opens `BEGIN IMMEDIATE`, writes a session row and holds it; the poll must return
its answer promptly, and the writer must then commit normally. Under the mutation back to
`with_conn_fenced` the poll fails with `database is locked` (M-C below).

---

## 7. `store_meta` checks its row count

`store_meta` now returns `rusqlite::Error::StatementChangedRows(affected)` unless exactly
one row moved. Every caller today reads and writes inside one transaction, so this cannot
fire; the point is the first caller added outside one, which would otherwise get a silent
no-op that reads exactly like a successful write and a new row version for a row that was
never updated.

New test: **`store_meta_refuses_a_write_that_touched_no_row`**, with the successful write at
the live row version as its control.

---

## 8. The two wording pins in the A1 report

`.cortexkit/alfonso/reviews/rust-standalone-a1.md`:

- The acceptance sentence now says **every served byte** and every historian request is
  byte-identical to the base `991046ca`, and states the exception the gate measured: the
  durable `ModuleMeta` blob grows by exactly 21 bytes, the length of
  `,"producer_attempt":0`. §8 carries the numbers (271,085 served bytes unchanged;
  22,027 → 22,048 durable).
- §2's refusal convention now pins the edge the gate found and neither delivery document
  described: **a lapsed lease is not lost until someone else takes it.** A heartbeat that
  arrives after the lease expired but before a replacement's claim revives the claim and
  the replacement is refused `already_claimed`; in the other order the replacement wins and
  the late beat is refused `superseded_token`. Both orders leave exactly one live claim.
  That is deliberate — a beat inside the two-missed-beats window is a live claimant proving
  liveness — and A2 must code against it: a claimant that missed a beat should send one
  rather than assume it has lost the run. Named by
  `historian_claim::tests::a_heartbeat_revives_a_lapsed_lease_and_the_replacement_is_then_refused`.

§2 was also brought back in line with the lane as it now behaves (binding requirement, `v`,
`run_expired`, parked rows), because §2 is what A2 codes against and a stale contract there
is worse than none.

**One tracking note.** `.cortexkit/alfonso/*` is gitignored. The A1+B0 gate force-added its
own report, so `rust-a1-b0-gate.md` is tracked; `rust-standalone-a1.md` was not. Both this
report and the edited A1 report are force-added here, because an edit to an untracked file
would live only in this worktree and never reach the branch. If the A1 report is meant to
stay untracked, `git rm --cached` it — that is one command, whereas silently losing the
correction is not recoverable.

---

## Mutation evidence

Each mutation was applied to the live tree with the working state staged, run, then
restored (`git checkout --` from the index); `git diff --stat` was non-empty during and
empty after every one.

| # | Mutation | Red | Also red |
| --- | --- | --- | --- |
| M-A | poll's `WHERE project_path = ?1` made always-true | `historian_claim::tests::a_run_is_only_reachable_from_the_project_that_queued_it`, `tests::gate_a1_b0::gate_pending_refuses_an_unbound_caller_and_hides_another_projects_run` | nothing |
| M-B | the `now_ms >= deadline_ms` heartbeat refusal deleted | `historian_claim::tests::a_heartbeat_past_the_runs_own_deadline_is_refused_rather_than_extended`, `tests::gate_a1_b0::gate_a_heartbeat_after_the_runs_own_deadline_is_refused_run_expired` | nothing |
| M-C | the poll put back inside `with_conn_fenced` | `tests::gate_a1_b0::gate_a_pending_poll_does_not_block_a_concurrent_transform_commit` (`database is locked`) | nothing |
| M-D | the restart park call removed | `tests::gate_a1_b0::gate_restart_releases_a_parked_run_and_parks_its_queue_row` (row read `pending`) | nothing |
| M-E | `store_meta`'s row-count check removed | `historian_claim::tests::store_meta_refuses_a_write_that_touched_no_row` | nothing |
| M-F | the `v == 1` check removed from the claim lane | `tests::gate_a1_b0::gate_the_claim_lane_refuses_a_request_whose_version_it_cannot_serve` | nothing — and notably **not** `the_historian_claim_lane_answers_the_wire_a2_codes_against`, which pins `v: 1` in the fixture and still never reads it. That is finding 3 in one line. |

---

## Gates

| Gate | Result |
| --- | --- |
| `cargo build --locked --release -p mc-module` | pass, `Cargo.lock` unchanged |
| `cargo test --locked -p mc-store -p mc-module --all-targets --no-fail-fast` | pass — mc-store lib **181**, mc-module lib **1,237** (8 ignored), every integration binary green, **including** `cold_flip_adversarial` (5/5; it was the gate's pre-existing red and is fixed on master) |
| `cargo clippy --locked --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `scripts/run-rust-hermetic-e2e.sh` | **`status=pass`, 45/45 files**, whole script, no retries (see below) |

### The hermetic e2e group

The script selects files again (master's manifest repair closed the gate's finding 8), and
the rust mode now selects **45** files rather than the six the gate could drive by hand.
Two prerequisites had to be satisfied in a fresh worktree before it could run — neither is
a code change and neither is committed:

1. `bun install` — `packages/e2e-tests/node_modules/@opencode/client` was not materialised,
   so every file that imports `src/opencode2-harness.ts` died at import with
   `Cannot find module '@opencode/client'`. `bun install --frozen-lockfile` reports
   `Checked 990 installs across 1238 packages (no changes)`: no manifest or lockfile moved.
2. `cd packages/pi-plugin && bun run build` — `packages/pi-plugin/dist/index.js` is a
   gitignored build artifact the pi harness requires
   (`ensurePluginAvailable`, `packages/e2e-tests/src/pi-runner/spawn.ts`). Without it
   `tests/pi-rust-degradation-arc-1` and `-4` fail before reaching any assertion; with it
   both pass 3/3.

With both satisfied, the whole script runs green: `[e2e:rust:hermetic:end] status=pass`,
45 files passing, no `RETRY` line anywhere in the log. `rust-timeout-epoch-recovery` — the
gate's second pre-existing red — **passes** here, as expected from master.

## Production isolation

Every store opened here is a `tempfile::tempdir()` under the ambient temp root; the e2e
script spawns its own hermetic `ckdev-mc-e2e` with `XDG_DATA_HOME` pinned to a throwaway
directory. No database under `~/.local/share/cortexkit/` was opened and no binary was
placed.
