# Ride-only agent drops: implementation and verification

## Admission

OpenCode, Pi, and the Rust module no longer let scheduler execute, a queued
drop, another drop command, or an active drain latch originate a mutation.
Queued drops use the same independently authorized pass as automatic reclaim.
The originating work is an executed fold/first render, landed published-history
refresh, explicit flush, an available force episode, emergency, or consumed
late publication. Contended prefix preparation does not count as delivery.

The TypeScript force permission now consults the existing persisted emergency
sample, just as Rust consults its existing episode latch. This closes a second
application path: a newly queued batch cannot reopen a consumed force episode.
No new episode state, age promotion, or historian predicate was introduced.
Emergency and a later independent refresh/flush remain available. The Claude
Code Force85 coalescing test is retained and now also queues a late agent drop.

Rust selection no longer promotes the other lanes after selecting agent drops.
The `reductions_pending_now` input to classification remains derived from the
already-authorized selector (or test-only injected decisions); it is not an
independent admission signal. Cached-m1 repair is included in prefix-fold
permission so an actual repair HARD still drains its queued drops.

## Source checks

- Pi `runPipeline` receives `isCacheBusting` from the local
  `historyRefreshSessions.has(sessionId)` value, not from scheduler execute.
  The set is **not exclusively a historian-publish flag**: explicit `/ctx-flush`,
  cache-breaking thinking-level changes, and the index handler can set it too.
  Historian publication uses deferred history/materialization signals. Thus bare
  execute cannot sneak back through this argument; describing every set writer
  as a publication would be inaccurate.
- Pi's local historian map is no longer read by reduction admission. It still
  serves historian lifecycle/shutdown management. Cross-process lease activity
  therefore cannot create or remove reduction permission. No lease or spawning
  behavior was changed.
- Pi and OpenCode share the full and light `ctx_reduce` descriptions. The Rust
  full guidance asset has the same wording; the Rust facade acknowledgement
  states the ride-only contract too. Description changes belong in the same
  release and intentionally change prompt-description bytes once.
- The protected ARCHITECTURE.md region was not edited. The brief's specification
  path was outdated: the real v0.2 document is gitignored under
  `docs/private/specs/transform-machinery.md` in the parent. Per the parent's
  explicit ruling, the mistakenly created tracked stub was removed; the parent
  will add “scheduler execute alone originates nothing” to the private document
  while preserving its in-flight drain clause.
- The module half requires a **ck-mc bounce** to take effect.

## Proofs

Baseline for red-first and differential checks: `a06dadeb2529610d02b3fde33dccc96dc43cea0c`.
The live files were staged before each mutation, baseline runtime implementations
were restored temporarily with a `NON-VACUITY BREAK` marker, nonempty unstaged
stats were captured, and the staged implementations were restored and touched.
The unstaged diff was empty after restoration. No mutant was committed.

1. **Execute at threshold, no originating work:** OpenCode
   `holds execute-only queued drops with historian=false`, Pi
   `holds execute-only queued drops byte-identically with historian=false`, and
   Rust `execute_only_queued_drops_are_held_without_historian` all failed alone
   on baseline and pass with the fix. They compare served bytes and retained
   pending rows. Rust's separate `execute_at_ceiling_cannot_originate_agent_drop`
   selector control also failed alone on baseline.
2. **Historian in flight:** independently named `historian=true`/`with_historian`
   controls failed alone on baseline and pass with the fix. OpenCode registers
   an actual active compartment run and checks that the hold log says
   `no originating cache-bust opportunity` and `historianRunning=true`.
   Rust logs `reason=no_originating_cache_bust` with scheduler and historian state.
3. **Force episode:** both TS `queued agent batches consume only one force
   episode` controls and Rust's
   `force_episode_coalesces_lanes_and_defers_late_candidates` failed alone on
   baseline with the new late-queue assertion. All pass after the fix. First
   application consumes the episode; a later batch holds until flush/refresh.
4. **Fold:** existing OpenCode and Pi
   `drains queued pending ops on a DEFER scheduler pass when m[0] HARD-folds`
   tests pass; OpenCode's explicit historian-overlap fold test passes too.
   Rust `queued_drops_coalesce_with_fold_and_published_refresh_once` checks a
   real HARD, frozen drop state, and identical next-pass replay while a historian
   is active.
5. **Publish:** existing m1 refresh, deferred-publication, and contention tests
   remain green. The Rust coalescing test also checks a changed m1 containing
   `PUBLISHED`, queued drop consumption, and identical replay after one SOFT.
   Pi's incident observer test lands publication and drops together and observes
   no second application.
6. **Demoted thinking:** OpenCode
   `freezes first merged-strip application onto a bust and replays it across
   fresh rebuilds` and Rust
   `post_hard_defer_preserves_demoted_native_thinking_until_priced_pass` pass.
   New first applications remain closed on defer; persisted strips still replay.
7. **Four-pass differential:** identical baseline/branch served bytes **and
   durable drop state** on four pure defer passes from identical pre-state.
   Only runtime admission was swapped; description bytes were pinned, deliberately
   excluding the one-time description update. OpenCode replay digest:
   `0e2eafc1d0c980bba9fab965e8db36e53ea858607fd07878d0509025dc6d6226`.
   Pi replay digest:
   `473dce26e0347f464a82019c66446001571e72bdeeda48156f114ee779208443`.
   The Rust serialized four-pass bytes/frozen-state record was compared directly;
   SHA-256 of its identical `RIDE_REPLAY_RUST` record is
   `f441111ebdff814e7ea8e1c14ffdd026fcdf4d6fdb78c4d76450f8366860c2b8`.
   Hermetic OpenCode A1 and Pi's three quiet mural-enabled passes both pass with
   zero cache busts. Rust integration/differential goldens pass.
8. **Pi 019de471 decision reconstruction:** the mutation-gate observer test
   reproduces the supplied 65% execute, 60% execute with historian active, and
   deferred publication shapes. The rows correspond to **11:28:49Z held**,
   **11:32:37Z held**, **11:33:45Z applied**, then held on the next pass. This is
   a hermetic gate reconstruction from the supplied decision facts, not a replay
   of private session bytes or a rewrite of recorded history. The observer test
   failed on baseline and passes after the fix.

Before the provider-transport interruption, red-first coverage already existed
for both OpenCode execution shapes, Pi plain execute, and Rust at-ceiling
selection. The completed work adds separately reached historian controls,
late-episode controls, and the baseline-versus-branch replay comparison.

## Gates and operational notes

- `bun install --frozen-lockfile`: passed. No manifest or lockfile changes;
  no lock drift reconciled.
- OpenCode plugin full suite: **4882 passed, 0 failed**.
- Pi complete suite: **1174 passed, one timing-only failure, one skipped**.
  The timing file passed in isolation (17 tests); all three affected Pi files
  passed together after correcting the native retry fixture. That fixture now
  signals an explicit flush: a failed native activation cannot treat the same
  already consumed force episode as a new originating opportunity.
- Both package `bun run typecheck` scripts pass; these include real `tsc` checks.
- Both package builds pass.
- `cargo test -p mc-module --locked`: full module and integration suite passed
  (1166 unit tests plus integration suites, 8 ignored). The subsequently added
  fold/publish coalescing test was run separately and passed.
- `cargo clippy -p mc-module --locked --all-targets -- -D warnings`: passed.
- Prompt golden regenerated. Checklist/budget checker and its 10 tests pass.
  Light mutable prose is **1822 tokens**, below the immutable **1825** ceiling;
  full mutable prose is 3734 tokens. Parameter schemas remain unchanged.
- A concurrent earlier Rust timing check exceeded its microsecond limit; the
  isolated rerun and final full gate passed. An earlier Rust invocation lost
  its bin test executable after unit tests passed; the final full run completed
  every integration target successfully.
- AFT inspect twice timed out during tier-2 rescan; actual typechecks are the
  authority. Repository Biome configuration currently rejects the `preset`
  key under the installed binary. An attempted fallback formatter caused
  formatting-only churn; that churn was discarded before final verification.

Existing application fixtures now explicitly supply flush permission rather
than relying on scheduler execute or a pending drop to create a bust. This is
an intentional contract correction, not relaxed byte-identity assertions.
