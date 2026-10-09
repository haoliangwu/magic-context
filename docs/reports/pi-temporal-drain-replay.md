# Frozen idle-gap replay after a history cut

The initial implementation described here was reviewed at `fdd3ea1556`.
Its legacy-adoption and blob-storage shortcomings are corrected in
[the follow-up](temporal-markers-follow-up.md); that report supersedes the
storage and upgrade-policy descriptions below.

## Observed incident

The Pi cache analyzer was run before source inspection, with session
`019de471-4fdc-762d-9286-624dfad0b5fe` and the requested
`2026-10-05T19:20:00Z`–`19:30:00Z` window. It found the legitimate
19:27:25Z `accounted_hard_marker_drain` (about 255,947 rewritten tokens), then
19:29:01Z `unaccounted_defer_pass` (185,694 rewritten tokens).

Read-only inspection of the session's `602-req.json` and `603-req.json`
confirmed the first raw user text changed from `§46233§ <!-- +5m -->` to
`§46233§`. The Pi log records an execute at 77.3%, twenty gap injections,
and a physical marker drain with first-kept entry `9955e32a` at ordinal
62,637. The next pass is a defer at 55.1%, with fifteen injections and no
new history materialization.

`injectPiTemporalMarkers` walked the **current** array on every pass. Its
timestamp inputs were stable, but its choice of predecessor was not: the
physical drain changed the next pass's source array. The prior workaround
removed a marker at a late injection seam, but could not protect every
earlier trim/physical marker projection. Regex idempotence on an already
mutated array did not protect fresh host arrays.

## Runtime coverage and policy

- **Pi and OMP's shared context handler:** collect candidates before cuts;
  persist the first marker or empty choice under the durable entry id on a
  priced rebuild; replay from that decision before tagging and after
  compression/drops. Unresolved positional fallback ids cannot mint markers.
  Old persisted seam removals and marker-only legacy sources retain their
  prior projections.
- **OpenCode 1 TypeScript and OpenCode 2:** both use `createTransform` and the
  shared TypeScript temporal walker (v2 supplies its host seams). Their old
  eager walker also introduced new markers on deferred passes. Source-content
  replay can incidentally preserve a seam marker in some cases, but is not a
  durable temporal decision. The regressions exercise both host dependency
  configurations, a changed array head, a reopened database/recreated transform/LKG reset, and
  delayed first appearance until an explicit rebuild.
- **Rust module:** existing `mc_temporal_marks` rows already froze many
  observations, but the temporal-parity transition could compare them with
  new neighbours and replace them. Existing decisions are now authoritative;
  parity backfill applies only to missing decisions. Candidates computed
  before planning are discarded on SOFT+ so no new marker appears on a defer.
  The existing first-text block key contains the stable message id, not an
  array position.

TypeScript decisions use a versioned namespace in the existing additive
session replay ledger. Empty choices are explicit; a later predecessor cannot
turn them into markers. Writes precede byte mutation and clone filtering maps
the message ids and preserves the exact choices. No schema migration is needed.

The old Pi test asserting seam removal now asserts retention of the frozen
marker. Its separate legacy-seam test seeds an **existing** removal rather than
expecting a new removal. Rust marker-format/transport/frontier tests retain
their assertions but explicitly supply a rebuilding config transition when
minting; the parity golden starts with temporal awareness disabled, so it tests
missing-decision backfill rather than overwriting already served empty choices.
The scanning reference now retains old rows like the indexed implementation.

## Real Pi host proof

Run `bun packages/e2e-tests/scripts/pi-temporal-drain-probe.ts` under an outer
timeout. The probe uses Pi's actual RPC CLI and production context handler,
a new synthetic journal, a local mock Responses provider, and three turns:
baseline, publication/physical drain, then defer. It does not load unrelated
historian/background-agent services. The companion extension only seeds work;
it does not implement the transform or the replay oracle.

On Pi 0.87.1 the drain and defer matched exactly over all 19 pre-existing
provider input objects (13,492 bytes), including the first-kept user's
`<!-- +10m -->` and the tail. SHA-256:
`82b6de1e14757d90d8e213d6f91278b2b3ad63bbf4286723fdb5023261db4cea`.
No message fields or content are normalized. Responses transport avoids the
expected moving Anthropic `cache_control` tail breakpoint.

The successful root was
`$TMPDIR/magic-context/pi-temporal-drain/host-hzL8zv/`.
`lsof -p 93313` listed only that root's `storage/context.db`, WAL and SHM.
The probe sets HOME, every XDG data/config/state/runtime/cache root,
OPENCODE_DB, MAGIC_CONTEXT_STORAGE_DIR and PI_CODING_AGENT_DIR under its
throwaway root. The raw requests, RPC events, journal and lsof output are
retained there. No live database/config store was opened or modified.

After restoring all mutations, the same host probe passed again at
`$TMPDIR/magic-context/pi-temporal-drain/host-tCMltu/` (host PID 46,335),
again comparing 19 objects and 13,492 bytes. Its within-run prefix hash was
`6987e23a81d1a5dde52bd66bbf16b4fe96b53af84c94032ba7b6b5b16157a8c7`.
The journal's new-turn timestamps can differ between independent probe runs;
the oracle compares the drain and replay inside each run, not two sessions.

The first probe used Anthropic transport and correctly rejected a raw-byte
comparison because the host moved `cache_control` from the former tail to the
new tail; the retained idle-gap content itself matched. That unsuccessful run
was also isolated and is not used as the passing proof.

## Mutation controls

Each mutation was staged against the live implementation before changing it,
marked as temporary non-vacuity breaks, observed with a non-empty working diff, then
restored from the index and touched. The working diff was empty after each
restore. No mutant is committed.

| Neutralized control | Exact red test/check | Controls that stayed green |
| --- | --- | --- |
| Shared TypeScript message-id replay | `OpenCode 1 freezes user gap bytes across a cut and a restart` | all ten `formatGap` tests |
| Shared TypeScript message-id replay, v2 host seams | `OpenCode 2 freezes user gap bytes across a cut and a restart` | all ten `formatGap` tests |
| First-writer persisted/returned snapshot | `temporal choices freeze absence as well as marker bytes and preserve other replay entries` | all ten `formatGap` tests |
| Pi message-id replay | `Pi marker-drain wire stability > lands the marker projection in the same pass as deferred publication` | all ten Pi temporal formatting/normalization tests |
| Pi message-id replay, actual host | `Drain/defer wire prefix changed` | the marker-presence and physical-drain checks were reached and passed |
| Rust transition comparison of already decided marks | `transform::tests::temporal_gap_cut_keeps_the_persisted_message_decision` | `temporal_gap_format_matches_typescript_goldens` |
| Rust defer adoption fence | `transform::tests::temporal_gap_first_appears_on_rebuild_then_replays_after_predecessor_change` | `temporal_gap_cut_keeps_the_persisted_message_decision` |
| Rust stored-row overwrite during backfill | `transform::tests::temporal_gap_cut_keeps_the_persisted_message_decision` | `temporal_gap_format_matches_typescript_goldens` |

The Pi unit mutant lost exactly 15 bytes from the existing prefix (the
`<!-- +10m -->` line), while its unmutated run matched the full array.
The shared TypeScript mutants specifically exposed eager first appearance
on the deferred tail; incidental source-body seam replay did not hide that
failure. The Rust row-overwrite mutant replaced the retained `+5m` with an
empty marker. Each named red run had exactly one failed test/check.

## Final gates

- Bun 1.4.2: root distribution build passed, including all four v2 loader tests.
- TypeScript 5.9.3: both plugin package typecheck scripts and the focused host
  probe tsconfig passed.
- OpenCode/shared transform regression selection: 355 tests passed in six files.
- Pi context/LKG/degraded-pass/replay regression selection: 187 tests passed in
  seven files.
- Cargo 1.99.0: `cargo test -j 2 -p mc-module --lib` passed 1,595 tests, with
  21 pre-existing ignored tests. The post-mutation temporal selection passed
  all 15 tests; package formatting passed with rustfmt 1.10.0.

Native commands were serialized and limited to two jobs under outer timeouts.
The initial 600-second Rust attempt timed out while waiting for shared compile
slots; later package checks completed. Cargo resolved newer versions of the
prepared worktree's sibling path dependencies during these checks; the generated
lockfile drift was reverted, and no manifest or lockfile changes are delivered.
