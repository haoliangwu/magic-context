# Adversarial re-review: frozen temporal markers after rework

Reviewed **03bda40a1b440e41111c8e6b78b686585b322f6c**, including v95, 7af13f08,
cccceda7 and the history-independent regression follow-up. The task initially
started at a different base; the parent explicitly authorized moving this clean
task branch to the review tip. Only review tests, their runner/config and this
report are added. Production code and the first review remain unchanged.

**Verdict: do not merge as-is.** The ordinary legacy handoff is fixed, but a Pi
upgrade with an unavailable LKG and an already cut predecessor still loses a
previously served marker on a warm deferred pass. Two additional should-fixes
are malformed-ledger migration tolerance and cross-mode frozen-choice handoff.

## Blocker: the no-LKG fallback is not evidence of previously served bytes

The fallback at
`packages/plugin/src/features/magic-context/temporal-decisions.ts:90–105`
adopts `previous ?? candidate` immediately for an identity with an existing tag.
That candidate describes the **current** neighbours, not the old wire.
`packages/pi-plugin/src/temporal-awareness-pi.ts:94–108` produces `''` when the
first surviving user's predecessor has disappeared.

The exact LKG correctly wins when available:
`packages/plugin/src/hooks/magic-context/temporal-served-projection.ts:13–20,43–57`
reads it, resolves older Pi tag ownership and extracts the served marker.
However, absent/unreadable snapshots return an empty map. The adopter then
permanently freezes the current empty candidate and Pi replays it immediately
(`packages/pi-plugin/src/context-handler.ts:5527–5541`). No rebuilding permission
is needed for that adoption.

The new failing test is:

> `Pi cut-seam upgrade without LKG preserves the source-backed previously served marker`

It restores the committed old-code fixture, removes only its optional LKG rows,
closes/reopens the synthetic database and resumes with `prior` already absent.
Old tags, source contents and cached m0/m1 are retained. The old source contains
`<!-- +5m -->\nquestion`
(`testdata/temporal-upgrade-projections.json:307–312`), and the independent old
wire literal is `§2§ <!-- +5m -->\nquestion` (`:104–107`). The actual production
Pi handler instead emits **`§2§ question`**; `later` still retains its `+10m`.
The cached m0/m1 comparison passes before the tail assertion fails. This is not
a proposed change to marker semantics after a priced rebuild.

The paired test, `control: Pi cut-seam upgrade prefers the exact LKG over the
empty neighbour candidate`, passes with the *same* cut and intact LKG. The
existing upgrade tests also pass. Thus the rework fixes the first review's normal
case, but its fallback does not uphold the stronger “adoption never changes
served bytes on SOFT+” guarantee. This is a synthetic context-handler proof, not
a physical Pi drain or a provider RPC measurement.

**Required:** use durable served evidence when it exists (the fixture still has
source bytes), and do not turn absence of such evidence into an irrevocable
timestamp-derived historical choice on a defer. In particular, an empty
neighbour candidate is not proof that a historical cut-seam user was unmarked.

## Should-fix: odd outer blobs can abort v95 migration

`packages/plugin/src/features/magic-context/migration-v95-perf-indexes.ts:98–119`
selects any miscellaneous blob containing `temporal-message-v1:`, then calls
`JSON.parse` without a catch and throws on a non-array outer value. Both of these
review tests fail in the actual `runMigrations` v95 transaction:

- `v95 tolerates malformed JSON in the miscellaneous legacy blob`: the truncated
  JSON value `["temporal-message-v1:` produces
  `Migration v95 failed: JSON Parse error: Unterminated string. Database may need manual repair.`
- `v95 tolerates non-array JSON in the miscellaneous legacy blob`: the unrelated
  object `{"unrelated":"temporal-message-v1:"}` produces
  `Migration v95 failed: Invalid temporal migration ledger. Database may need manual repair.`

Both inputs are literal synthetic database values, not modified production code.
The fixtures reconstruct
a v94 migration ledger and absent temporal table on an initialized test DB; other
v95 indexes may already exist. They execute the real migration runner/body, not
a parser reimplementation. Migration failure is propagated to the opener
(`packages/plugin/src/features/magic-context/migrations.ts:3391–3397,3423–3430`).

Individual malformed entries **are** tolerated: the passing control includes
null, a number, an object, an invalid prefixed string and an empty message id,
alongside a valid marker. The decoder's shape checks and catch work at the entry
level (`temporal-decisions.ts:10–25`), and unrelated values are preserved.

This is **not evidence of deployed prerelease rows**. The blob producer and its
replacement are in the same unshipped candidate lineage; the captured pre-ledger
old handler has no such decisions. No live-store survey was performed or would
be appropriate for this review. Manual prerelease users could nevertheless
exist. Conversion is defensive compatibility, not a reason to make optional
legacy metadata fatal. Skip/preserve unparseable or non-array outer blobs (with
an appropriate diagnostic) rather than aborting the schema upgrade. Ordinary
valid v94 migration and indexed conversion controls pass.

## Should-fix: ordinary fixture parity does not guarantee mode-switch parity

The common session fixture passes against Pi, OpenCode 1/2 and the **actual Rust
transform/store pipeline**, including replay. That is a real improvement over a
formatter-only comparison. It does not establish a shared decision authority.

- TS reads/writes `temporal_decisions` by message id
  (`packages/plugin/src/features/magic-context/temporal-decisions.ts:30–59,113–129`).
- Rust reads only `mc_temporal_marks` by block id
  (`crates/mc-store/src/lib.rs:9929–9952`) and derives missing choices from current
  timestamps (`crates/mc-module/src/transform.rs:10085–10123`). Its existing rows
  are first-writer-wins (`:10622–10639`).
- The TS→Rust state-sync schema has strip/hint/nudge seeds but no temporal seed
  (`packages/plugin/src/hooks/magic-context/module-state-sync.ts:137–167`). The
  failing `Rust mode-switch state-sync transports TS frozen temporal choices`
  test builds the real forced seed. An unrelated frozen strip for the same
  session is transported, while the frozen temporal marker is absent. The strip
  transport control stays green; no particular new protocol field is assumed.

The additional native test
`cold_rust_mode_preserves_the_ts_frozen_marker_after_predecessor_edit` demonstrates
the consequence. Its preceding TS control serves the shared fixture literally,
then changes only the existing predecessor's completion time from 300000 to 0.
TS still serves the frozen `+5m`. The TS production CK encoder serializes the
updated **raw** request. Rust opens a fresh synthetic store.db beside the **same
TS-created context.db**, whose `temporal_decisions` row is explicitly checked to
remain `<!-- +5m -->\n`. Rust's real transform emits:

```text
actual:   §2§ <!-- +10m -->\nquestion
expected: §2§ <!-- +5m -->\nquestion
```

`later` and `near` match the fixture. The native assertion fails on this marker,
not on missing metadata, isolation or startup. Both the TS and Rust process's
database handles are captured with lsof. The synthetic context's single-store
state is marked migrated before opening the empty native store: there are no
legacy domain rows to import.

This is a paired renderer/store boundary proof plus a real state-sync omission
test, **not** an OpenCode/subc-daemon mode-switch UI or provider-wire test. The
cold Rust pass is allowed to rebuild; do not mislabel its initial difference as
a demonstrated SOFT+ bust. It proves that the two stores **can disagree**, despite
ordinary fixture parity. An already populated TS table also remains authoritative
when returning from Rust: exact served-LKG adoption only runs for *missing* rows.
That return-direction risk is source-level, not an additional end-to-end claim.
The TS/Rust split predates this repair; it is a should-fix for the requested
cross-mode guarantee, not a new fleet-wide blocker inferred from Pi's failure.

**Required for that guarantee:** transfer identity-mapped frozen markers,
including empty choices, across mode changes (and define pending-row semantics),
or explicitly fence and document a different mode-transition contract. Running
the unchanged initial session independently in each engine is insufficient.

## Note: pending rows and the served-none rule behave as intended with evidence

The pending row is distinguishable from both an absent row and frozen `''`.
`observeTemporalDecisions` includes NULL rows in its known-id set but excludes
them from replay (`temporal-decisions.ts:72–80,103–109`). Fresh tagging cannot
make that new message look like legacy history on the next deferred pass.
`freezeTemporalDecisions` updates only NULL choices (`:121–127`).

Existing controls pass for repeated defer → rebuild → frozen replay and for
exact served-none + newly discoverable gap → pending → rebuild. An exact LKG
empty projection holds a newly discovered nonempty marker pending, rather than
adding it on SOFT+ (`:94–101`). Final empty choices remain frozen by identity.
This is sound **when the projection actually identifies the served message**;
the unsupported fallback is the blocker above.

A NULL row can remain NULL indefinitely if every pass continues to defer, the
message is never eligible again, or temporal awareness is disabled. That is not
a cache-safe reason to force its own bust. A visible eligible message is decided
on the next independently authorized rebuild in both TypeScript harness paths
(`packages/pi-plugin/src/context-handler.ts:5845–5860`;
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:2091–2110`).
A marker can therefore first appear at that rebuild after earlier unmarked
serves; the task explicitly allows this. No pending-row liveness defect was
found within that permission model.

## Note: indexed storage and permanent-message lifecycle are fixed

The unbounded miscellaneous-blob rewrite is gone. The WITHOUT ROWID composite
primary key (`migration-v95-perf-indexes.ts:7–12`) supports runtime reads for only
candidate/replay ids in chunks of 400 (`temporal-decisions.ts:35–46`). Retained
choices can still grow with reversible session history; that is a storage-row
lifetime, not the former whole-ledger parse/rewrite on every pass. Do not cap
away choices needed for revert.

Permanent removal now deletes the temporal row inside the existing cleanup
transaction (`packages/plugin/src/hooks/magic-context/event-handler.ts:210`).
The permanent-message/session-clear control passes. Clone/fork preserves and
remaps literal, empty and NULL rows
(`packages/plugin/src/features/magic-context/storage-clone.ts:666–679`); the
actual v2 fork wrapper control passes. Session-scoped deletion includes the
table (`storage-session-tables.ts:23–25`). No new lifecycle gap was found here.

## Reproduction, isolation and verification

From this worktree with its installed dependencies:

```sh
timeout 120 bash docs/reports/temporal-markers-re-review.sh --review
timeout 180 bash docs/reports/temporal-markers-re-review.sh --controls
timeout 180 bash docs/reports/temporal-markers-re-review.sh --typecheck
timeout 900 bash docs/reports/temporal-markers-re-review.sh --rust-controls
timeout 900 bash docs/reports/temporal-markers-re-review.sh --mode-proof
```

The review and mode-proof commands intentionally return nonzero on the retained
failing claims. The native review test is ignored unless explicitly requested by
the isolated runner; the TS review file is outside the packages' ordinary test
globs. No existing test was changed to bless a new contract.

Live-store isolation, verbatim: never open/read/write/migrate the live stores
(`~/.local/share/opencode/*.db`,
`~/.local/share/cortexkit/magic-context/{context,store}.db`,
`~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a
throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under
`$TMPDIR/magic-context/<task>/`), proven by `lsof -p <host pid>` listing only
throwaway `.db` paths; a single live-store write is a rejected delivery.

No external Pi/OpenCode host or live daemon was launched. HOME, all listed roots,
Pi's agent root and TMPDIR are redirected by the runner. The context-hook test
process and the native transform test capture `lsof -p` while their synthetic
databases are open and assert **nonempty** handle lists confined to their root.
The final TS review run used root `temporal-markers-re-review-MWOxNl`, PID 4565;
the same-database native proof used `temporal-markers-re-review-oe1SsC`, TS PID
35215 and Rust PID 47053. Only throwaway context.db/store.db, WAL and SHM handles
appeared. No live store or user configuration was opened, copied or inspected.

- **Bun 1.4.2:** final review **4 pass / 4 expected fail**, 8 tests, 64 assertions.
  The four red names are the no-LKG Pi test, the two outer-blob tests and the
  temporal state-sync test above. All four independent controls pass.
- **History-independent CI controls:** **35/35 pass**, 6 files, 191 assertions,
  with GIT_DIR set to an absent repository and a preceding old-object `cat-file`
  probe rejected. This includes all three historical upgrade cases, both cut/
  restart cases, shared Pi/OC1/OC2 literal parity, temporal lifecycle, v95 and fork
  controls. No old build or Git archive is loaded. The manual capture/real-host
  probe scripts remain history-dependent by design and are not CI tests.
- **Cargo 1.99.0 / rustc 1.99.0:** package-scoped `cargo test -j 2 -p mc-module
  --lib temporal_ -- --test-threads=2`: **16/16 pass**, including the actual shared
  session fixture and replay. Builds were serialized under outer timeouts.
- **Native handoff review:** the TS fixture-producing test passes; the one named
  Rust review test fails solely with `+10m` versus `+5m`. No other native test is
  selected. This is separate from the passing 16-test native baseline.
- **TypeScript 5.9.3:** both package typecheck scripts pass. The initial focused
  review check needed package-local type roots and the required
  `clearReasoningAge` test dependency; after fixing the review harness,
  `packages/plugin/node_modules/.bin/tsc --noEmit -p
  docs/reports/temporal-markers-re-review.tsconfig.json` passes.
- **rustfmt 1.10.0:** `rustfmt --check
  crates/mc-module/tests/temporal_mode_re_review.rs` passes. **Bash 3.2.57:** runner
  syntax check passes. `git diff --cached --check` passes for the review additions.
- **Isolation negative control:** the files were staged before mutating only the
  review assertion's accepted root to include `NON-VACUITY BREAK`. The working
  diff was one file, one insertion/one deletion. Exactly `control: v95 skips odd
  individual entries and preserves unrelated blob values` failed at the actual
  lsof path assertion; seven other tests were filtered, with no other failure.
  Restoring from the index and touching the file left an empty working diff.
  That same control passes in the final unmutated review run. No production
  mutation and no live-path probe was used.

AFT inspection could not initialize the TypeScript SDK; it is not claimed as a
clean diagnostic result. The explicit installed-package tsc checks above are the
authoritative verification. No manifests or lockfiles are delivered. Cargo
updated five prepared sibling path-dependency versions during verification;
that generated Cargo.lock drift was inspected and reverted. No install was
needed. Full workspace builds/lint and external real-host probes were not rerun
for this review-only change; the narrow production pipelines, package typechecks
and committed adversarial claims were exercised instead.
