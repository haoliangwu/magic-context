# Temporal markers: legacy handoff, indexed state and lifecycle

## Review integration

The task branch merged master at `a8bc4b3b` and the requested unshipped v95
foundation at `6528bb96`. No new migration number was added. The immutable
review at `docs/reports/temporal-markers-review.md` remains unchanged.

The review's old-to-new fixture was ported into `temporal-upgrade.test.ts`
and the shared OpenCode temporal tests. The original ports executed the actual
pre-ledger handlers and reproduced Pi's wire loss before the adoption fix.
OpenCode 1/2 kept their text through incidental source replay, as the review
reported; their added persisted-choice assertions initially failed. This is
not evidence of an old-code handoff wire failure in OpenCode.

For shallow-checkout CI, the tests now restore the committed historical session
state and compare against `testdata/temporal-upgrade-projections.json`. That file
captures all three old handlers' complete context-hook output arrays and their
exact serialized bytes, not an expectation calculated by the current renderer.
It also contains the old persisted tags, source contents, cache pair and LKG
needed to resume without first rebuilding under the new code. Only the cache
clock is advanced. Each test checks that temporal decisions start empty, closes
and reopens its database, then compares the complete output bytes and adopted
choices on a warm defer. Pi also verifies that cached m0/m1 stayed unchanged.

No test imports a historical build, archives Git objects or runs the v94 host
probe. The three historical cases and both existing cut/restart cases pass when
`GIT_DIR` points to an absent repository, after a check confirms the old object
cannot be accessed. The earlier per-test archive budgets are no longer needed.

To regenerate the fixture manually in a full-history checkout with prepared
dependencies:

```sh
timeout 180s bun packages/pi-plugin/scripts/capture-temporal-upgrade-fixture.ts
```

The script loads production code from the pinned `114e9ff6` commit, fixes its
clock, and uses an empty logical project directory so the capture contains no
checkout-specific paths or project documents. It creates only synthetic state
under `$TMPDIR/magic-context/temporal-fixture-capture/` and never reads a live
store. Binary SQLite values are encoded as base64 in the committed fixture.
The history-dependent loader is confined to `packages/pi-plugin/scripts/`.

The manual real-host `--handoff` probe still needs that old commit/build because
its purpose is to launch the actual old handler and v94 storage code. It is not
an automatically collected test or a CI gate. The ordinary drain probe does not
load the old build. No other newly added test needs Git history or either probe.

CI fixture follow-up verification: Bun 1.4.2 passed all five tests in the two
changed regression files with `GIT_DIR` set to an absent repository; a preceding
`git cat-file -e 114e9ff6` probe exited 128, confirming that history was inaccessible.
The historical capture generated three cases, both package typechecks and the
focused script typecheck passed with TypeScript 5.9.3, and the root build passed
including all four v2 loader tests. Targeted Biome 2.5.1 checks passed.
Neutralizing historical adoption still reddened exactly
`Pi upgrade preserves every previously served marker on the first defer`
against the committed complete JSON bytes, while both existing OpenCode
cut/restart tests stayed green. That mutation also ran without Git history and
was restored with an empty working diff.

## Adoption without a new wire edit

Before tagging, an absent decision is classified using the existing session's
persisted tag identities. A historical identity adopts its already served
marker even on SOFT+. A new identity records a pending row instead; its freshly
minted tag cannot cause it to be mistaken for old-code history on the next pass.

For historical identities, the exact previous LKG projection takes precedence
over the current neighbour walk. OpenCode snapshots carry native message ids.
Pi snapshots use their output-entry ownership vector; pre-ownership snapshots
can still resolve `§N§` through the session's persisted tag owner. This protects
an upgrade coinciding with a cut: a prior `+5m` does not become empty merely
because the predecessor has disappeared. The LKG is consulted lazily only when
an unknown historical decision needs adoption, not on routine frozen replay.
The diagnostic served-array ledger is not needed or opened.

If no LKG projection can identify the message, adoption reads the first durable
user-text source through the persisted tag owner; a missing first source cannot
be replaced by a later text part's no-marker evidence. If neither authority
identifies served bytes, the legacy choice remains undecided and its display
temporarily follows the old current-array computation without freezing it.
If the LKG proves that a historical message had no marker but the current walk
now discovers one, the new marker remains pending until a rebuild. Already
frozen empty decisions remain authoritative.

The re-review's source-backed cut-seam regression and exact-LKG control are now
in the Pi package suite. Without evidence, a historical choice stays absent
and pending until a rebuilding pass, rather than being written as a final
empty or current-neighbour marker. NULL rows still identify newly observed
unmarked messages; this distinction prevents a new tag from turning a pending
new message into legacy history on its next defer. The transient legacy display
is carried through final rendering in both TypeScript harness paths, but is
never an authoritative persisted choice.

Item-one verification passed 12 shared temporal tests and 10 Pi upgrade/drain/
content-replay tests with Bun 1.4.2; both package typechecks passed with TypeScript
5.9.3. Disabling durable-source fallback reddened only the reviewer's no-LKG
cut-seam test, while the ordinary upgrade and exact-LKG control stayed green.
Persisting an unsupported neighbour guess reddened only the unproven-legacy
pending test, while the persisted-LKG control stayed green. Both mutations were
staged, observed as two added lines, restored and touched with empty working diffs.

## Indexed storage in v95

`temporal_decisions(session_id, message_id, marker)` has primary key
`(session_id, message_id)` and is a WITHOUT ROWID table. `marker = ''` is a
final no-marker choice. `marker IS NULL` is a pending unmarked observation,
not an adopted timestamp decision; only a rebuilding pass can fill it.
Non-null choices are first-writer-wins, including empty ones.

The same existing v95 installer supplies the fresh schema and the migration.
When installing the table, it extracts prerelease `temporal-message-v1:` records
from the old miscellaneous blob and removes only those entries. That conversion
runs once, not on every open. Runtime reads use the table's primary key and only
the candidate ids on the current pass; they do not load or rewrite all historical
decisions. Legacy tag-owner probes use the existing composite tag index.

The re-review's malformed and non-array outer-blob cases now skip optional
temporal conversion instead of aborting v95: the original blob is unchanged,
one session-scoped diagnostic records the skip without echoing the blob, and
the remaining migration still reaches version 95. A steady-state reopen does
not log it again. Both cases and the odd-individual-entry control are ported
into the package suite; all 14 v95 tests and the package typecheck passed.

The shared session-owned table list includes temporal state after session-meta
deletion, preserving another harness's surviving metadata row if applicable.
Clone and fork filter and remap the row's message identity and preserve literal
markers, empty choices and pending NULL rows. The v2 fork regression exercises
the actual fork wrapper and excludes post-boundary state without deleting it
from the parent.

Permanent `message.removed` cleanup deletes exactly that message's temporal row
inside the existing immediate cleanup transaction. A cut, compression or branch
revert does not prune temporal state; off-wire choices remain available on revert.

`temporal_decisions` is not a ck-mc domain-write table, so it is not included in
the domain/privileged-bracket fingerprints. Their constants did not change.
The full context.db schema fixture was nevertheless regenerated with the named
`scripts/dump-context-db-schema.ts` generator to include the new table. The Rust
domain-fingerprint test passed against that regenerated schema.

## Shared runtime fixture

Mode switches are rebuilding passes; each engine keeps its own first-writer-wins temporal choices after that rebuild.

The re-review's forced state-sync seed and predecessor-edit cases are ported
as documentation of that contract, not as a new TS/Rust transfer protocol.
The strip transport control still passes; the temporal seed test explicitly
records that temporal choices are not transferred. TS retains its prior `+5m`
on a priced return and then stays stable across three defers. A cold native
store beside a synthetic context.db containing that TS choice may select
`+10m` on its HARD switching pass, then must retain it across three SOFT+
passes even after the predecessor changes again. The native test compares
against its own literal switching result, not against the other engine.

`testdata/temporal-mode-switch.json` is the actual TS CK encoder's raw request
after the predecessor edit; the TS test verifies the encoding directly, and
the native test consumes it without an environment-provided fixture, ignored
gate or repository-history dependency. Regenerate it with
`bun packages/plugin/scripts/capture-temporal-mode-fixture.ts`.
The 28 state-sync/mode-switch TS tests and the native switching test passed;
native lsof output listed only the synthetic context.db/store.db and their
WAL/SHM files under the test-owned temporal-mode-switch root.

`testdata/temporal-session-parity.json` supplies one timestamped session and
literal model-visible user bytes. Pi and both OpenCode production transforms
compare their outputs directly to each other and to those literals. The actual
Rust transform/store pipeline consumes the same JSON fixture and checks the
same literals on both its initial render and replay. This is not an extracted
formatter or a comparison of a renderer to its own previous output alone.

Pi retains the inherited annotation policy for transport-only user messages;
the common fixture contains authored users. The previous blanket claim of
universal Pi/OpenCode temporal eligibility has been qualified rather than
silently changing legacy transport bytes in this cache repair.

## Real Pi checks

Both probe modes run Pi's actual 0.87.1 RPC CLI, the production context handler
and a local Responses provider. Every HOME/XDG/store/agent root is throwaway.
`lsof -p` captures assert that every database handle is below that root.

- `bun packages/e2e-tests/scripts/pi-temporal-drain-probe.ts --handoff` starts
  with the actual old handler and storage code, verifies schema v94 and the
  absence of the temporal table,
  terminates that host, then resumes the same journal/database in a new Pi
  process with the current handler and verifies migration to v95. The warm handoff preserves cached m0/m1
  and all 69 existing input objects, 39,336 bytes.
- The ordinary probe still executes a physical drain followed by a deferred
  pass and compares every existing provider input object without normalizing
  content or fields: 19 objects, 13,492 bytes.

Before mutation testing, the successful renderer handoff against a prepared
v95 store was
`$TMPDIR/magic-context/pi-temporal-drain/host-SmCXbC/` (old/new PIDs 98,941 and
6,185), hash `7ec3edae2beabc8a8afcb87cac09727b448da7fe1603d0bdcb58f17ab3ea7ff2`.
The drain root was `host-Zh1JFg/` (PID 7,220), hash
`64d5a8bad81c60116fa5f51e3af26d54be81d2c5162f67ed0acd19439bb852ae`.
Both lsof captures list only their throwaway context.db, WAL and SHM.

The final, stronger v94-to-v95 restart proof passed after all mutations were
restored at `host-xZeUxl/` (old/new PIDs 83,425 and 95,674), with 69 matching
objects and 39,336 bytes; hash
`d69427ecbe9a20fb405e4c4f92966fb5db9584d3d53e329d71ad8b56cf1a57eb`.
The final physical-drain replay passed at `host-cps5eS/` (PID 96,943), with
19 matching objects and 13,492 bytes; hash
`49b56043f00ec93d6202590932245ff57ae47a92fc86fe7ad4780b17269ccef3`.
Both final runs again captured only throwaway database handles. Within-run
hashes are compared, not the hashes of unrelated sessions with new timestamps.

The first handoff attempt failed during fixture loading because Pi's extension
loader relocated import metadata. The probe now explicitly supplies its worktree
repository root to the immutable-source fixture loader; the rerun above passed.
That unsuccessful attempt also used isolated host roots.

## Mutation evidence

Every control was staged before mutation, run with an observable non-empty
working diff, restored from the index and touched. Every restore left an empty
working diff; no mutant is delivered. Each target run below had exactly one
named failed test/check, not an unrelated timeout or compile failure.

| Neutralized control | Exact red test/check | Named control that stayed green |
| --- | --- | --- |
| Historical adoption | `Pi upgrade preserves every previously served marker on the first defer` | `new deferred messages stay pending across repeated passes until a rebuilding decision` |
| Historical adoption under OC1 dependencies | `OpenCode 1 upgrade preserves every previously served marker on the first defer` | `new deferred messages stay pending across repeated passes until a rebuilding decision` |
| Historical adoption under OC2 dependencies | `OpenCode 2 upgrade preserves every previously served marker on the first defer` | `new deferred messages stay pending across repeated passes until a rebuilding decision` |
| Historical adoption in the actual v94-to-v95 host restart | `Old/new handoff wire prefix changed` | `new deferred messages stay pending across repeated passes until a rebuilding decision` |
| New-message pending row | `new deferred messages stay pending across repeated passes until a rebuilding decision` | `Pi upgrade preserves every previously served marker on the first defer` |
| Served LKG projection | `Pi adopts a persisted pre-ownership LKG marker at a changed cut seam` | `temporal choices freeze absence as well as marker bytes and preserve other replay entries` |
| v95/fresh table installation | `migration 95 > v95 installs indexed temporal decisions and extracts only prerelease temporal entries` | all ten `formatGap` tests, including `returns null below threshold` |
| Clone/fork temporal copying | `seedV2ForkFromParent > forks indexed temporal choices by mapped identity, retaining pending and empty rows` | `buildForkIdMap > pairs each copied row with the parent row of the same seq, type and creation time` |
| Permanent-message deletion | `message.removed prunes the removed temporal identity but preserves surviving choices` (removed row remained) | `temporal choices freeze absence as well as marker bytes and preserve other replay entries` |
| Session-scoped deletion | `message.removed prunes the removed temporal identity but preserves surviving choices` (session clear left a row) | `temporal choices freeze absence as well as marker bytes and preserve other replay entries` |

The Pi adoption mutant lost both historical `+5m` and `+10m` bytes with the
synthetic history unchanged. The OpenCode mutants instead failed the newly
required persisted-adoption assertion; their incidental source replay still
preserved text, which is why their wire results are not mislabeled as Pi's bug.
The real host mutation rejected the changed old/new input prefix. Omitting v95
table creation failed against the real migrated database, not a schema proxy.

## Final verification

- Bun 1.4.2 root build passed, including all four v2 loader tests.
- TypeScript 5.9.3 package typechecks and focused probe typecheck passed.
- Shared OpenCode transform/event/schema/clone/fork selection: 479 tests passed.
- Pi context/LKG/degraded/replay/clone selection: 215 tests passed; the new
  handoff test initially exceeded Bun's bare 5-second test/cleanup budget under
  filesystem pressure. It passed with the repository's 30-second hook timeout
  and an explicit bounded archive-test budget. The four OpenCode temporal tests
  also passed after using that archive budget.
- Biome 2.5.1 targeted checks passed (16 shared files and four Pi files).
- Cargo 1.99.0: all 16 temporal tests passed, including the actual Rust transform
  on the common session fixture. The domain-fingerprint snapshot test passed.
  `cargo fmt -p mc-module -- --check` passed with rustfmt 1.10.0.
- Both final real Pi host probes passed with the isolation evidence above.

No package manifests or lockfiles changed. Cargo's generated lockfile drift
from prepared sibling path dependencies was reverted. Native commands remained
serialized, package-scoped and limited to two jobs under outer timeouts. The
workspace-wide native suite was not rerun for this follow-up: its production
Rust renderer is unchanged, and the changed native test/snapshot targets were
checked directly. The earlier full-module run is historical evidence, not
relabeled as a post-merge full-suite pass.
