# Adversarial review: frozen temporal markers

Review target: `fdd3ea155648a6be76075285335b6b91406e5c0f`, compared with
`114e9ff6`. The review worktree starts at `52dc2620a9`, which does **not** contain
the candidate. Tests extract both immutable trees into ignored scratch directories;
no candidate production changes are applied to the delivery branch.

The protected cache-stability section of `ARCHITECTURE.md` was read first. In
particular, lines 79–83 require a SOFT+ continuation to replay already served bytes.

## Blocker: Pi's first deferred pass after upgrade removes historical markers

`packages/pi-plugin/src/context-handler.ts:5513–5533` collects candidates but
replays only `getTemporalDecisions`; adoption is gated at `5837–5843`. An existing
session has no `temporal-message-v1:` entries. Fresh host arrays therefore receive
no historical markers, even when the predecessor is still present. Reopening the
same on-disk database does not fix this.

The committed regression `Pi upgrade preserves every previously served marker on
the first defer` actually serves the session with the base handler, closes its DB,
then continues with the candidate handler. It checks that the base really served
`+5m` and `+10m`, and that the candidate pass did not opportunistically freeze any
decisions. It fails with `§2§ <!-- +5m -->\nquestion` → `§2§ question` and
`§3§ <!-- +10m -->\nfollow up` → `§3§ follow up`. No fold or history cut is needed.
The synthetic m[0]/m[1] bytes match. This is a deploy-time cached-prefix loss for
affected Pi/OMP sessions, not merely a future-tail policy difference.

The same old→new, close/reopen test **passes for OpenCode 1 and 2** in this fixture:
their existing source-body replay incidentally preserves the old markers despite
an empty temporal ledger. Do not describe this evidence as a fleet-wide failure
in all hosts. Rust already had persisted temporal rows; its upgrade behavior is
reviewed separately below.

Required before merge: preserve the previously served projection while adopting
legacy sessions, without silently dropping historical markers on SOFT+. A test
that starts by rebuilding under the new code does not cover that boundary.

## Reproduction and isolation

From this worktree, with its prepared dependencies:

```sh
timeout 90s bash docs/reports/temporal-markers-review.sh
```

The runner sets HOME, every XDG root, OPENCODE_DB, MAGIC_CONTEXT_STORAGE_DIR and
PI_CODING_AGENT_DIR beneath a new `$TMPDIR/magic-context/temporal-markers-review-*`
root. It only creates synthetic databases and never copies a live store.
`lsof -p <test PID>` is captured while each reopened database is open; assertions
require all `.db` handles to belong to that throwaway root. No live host has been
launched. The passing isolation check and failing wire assertion are independent.

## Should-fix: unbounded shared ledger, including permanently removed messages

`packages/plugin/src/features/magic-context/temporal-decisions.ts:30–49,62–79`
parses the whole `session_meta.merged_reasoning_stripped_ids` JSON blob, creates a
map, and appends a string record for **every** newly adopted user, including empty
choices. There is no limit, watermark-based retirement, or temporal-pruning API.
Both TypeScript and Pi read this ledger several times per transform, and a freeze
rewrites the entire blob. Storage and per-pass read/parse work grow with all adopted
users, not the current wire tail. This is not a process-global map; restarting
reloads the same unbounded session-owned ledger.

The two-fold regression confirms that all four user identities remain after
compaction, although only two raw users remain on the wire. That retention can be
correct for reversible branch history; blindly pruning every off-wire decision
would reintroduce the cache bug on revert. The independently failing regression
`message.removed prunes the removed temporal identity but preserves surviving
choices` demonstrates a more definite gap: the production event deletes
`removed:p0` and keeps `kept:p0`, but the temporal map still contains `removed`.

Evidence: `packages/plugin/src/hooks/magic-context/event-handler.ts:201–280`
prunes placeholder, note and auto-search state on permanent message removal, but
does not prune temporal entries. The first-writer rule at
`temporal-decisions.ts:69–72` also means a reused/edited identity cannot supersede
the retained decision. Add explicit lifecycle/retention handling for actually
deleted identities, and consider indexed storage rather than repeatedly parsing
an ever-growing miscellaneous JSON ledger. Do **not** evict live choices to meet
an arbitrary cap.

Two lifecycle checks passed:

- **Fork/clone:** `storage-clone.ts:160–169` decodes, filters by source message id,
  remaps that id, and copies the exact marker, including empty choices. The review
  test exercises retained nonempty/empty choices and an excluded post-fork id.
  Pi's actual clone filter is branch-id-based
  (`packages/pi-plugin/src/clone-inheritance.ts:82–110`); it is not an array-index
  remapping.
- **Session deletion:** `storage-session-tables.ts:16–28,105–128` deletes the owning
  `session_meta` row. The review test confirms both source and fork temporal maps
  become empty. Rust stores separate rows in `mc_temporal_marks`
  (`crates/mc-store/src/lib.rs:980–987`), copies those rows during descent
  (`12280–12285`), and deletes all session-owned store tables during deletion
  (`8445–8504`). The Rust lifecycle observations here are source review, not a new
  runtime proof.

## Note: the seam-removal assertion protected replay, not marker semantics

The base handler explains the old contract at
`packages/pi-plugin/src/context-handler.ts:6924–6926` (base revision): late
injection could remove the predecessor, whereas the next pass trimmed before
temporal injection. Removing the seam marker made those two orders agree. It was
a workaround for a positional walk, not a requirement that a historical idle gap
must never be visible next to a synthetic history message.

Once the decision belongs to a surviving message id, retaining that marker is
coherent: it describes the historical gap before that request, even when its raw
predecessor has been summarized. The new regression covers **two successive
folds**: seam A keeps `+10m` while seam B, which is not first yet, keeps `+5m`;
the second fold removes A, promotes B, and leaves **exactly one** `+5m`. After a
DB reopen, feeding only B and its tail produces byte-identical output to the
second fold. No doubled marker, ghost A text, or marker copied to another request
was observed.

Candidate evidence: `packages/pi-plugin/src/context-handler.ts:5518–5524`
preserves old seam-removal choices as empty candidates; `6956–6968` replays legacy
removals; `7193–7198` replays message-id choices after downstream transforms.
Existing candidate controls for caveman/seam retention and an old seam decision
after head promotion also pass. The new two-fold test uses production handlers
and on-disk MC state with synthetic branch contexts; it is **not** an additional
real Pi RPC/provider-wire proof or a physical JSONL-drain proof.

## Note: ordinary formatting agrees; transport-message parity is not universal

For complete timestamps, the same effective previous-end/current-created history
produces matching literal bytes in TS and Pi for nine boundary/unit fixtures:
0, 299999 ms, `+5m`, `+12m`, `+2h 15m`, `+1d`, `+3d 4h`, `+1w`, `+2w 3d`.
The test also compiles and executes the **exact** candidate Rust
`temporal_gap_prefix` function and its threshold constant, extracted without
reimplementation (`crates/mc-module/src/transform.rs:124,10046–10080`). Its output
is compared to the same literal goldens, not an expectation generated by TS.
This verifies formatting, **not** the Rust transform/store pipeline.

There is an inherited eligibility divergence. The failing test
`TS and Pi agree that a transport-only reminder user has no temporal marker`
feeds the same reminder-only user after a ten-minute gap. TS leaves the text
unchanged; Pi emits `<!-- +10m -->\n` before it. TS uses
`hasMeaningfulUserText` (`temporal-awareness.ts:161–166` and
`read-session-formatting.ts:35–49`); Pi collects every user, regardless of content
(`temporal-awareness-pi.ts:93–105`). The old eager Pi path did the same
(`temporal-awareness-pi.ts:156–179` at the base), so this is **not a new regression**
or a separate merge blocker. The broad “identical agent-visible behavior” claim
at candidate `temporal-awareness-pi.ts:5–9` needs that qualification. Rust's
timestamp walk also checks authored users (`transform.rs:10095–10118`), with an
existing reminder-shaped transport regression at `34091–34130`.

Rust rows were already persisted before this patch. Candidate
`transform.rs:10150–10159,10622–10639` leaves every existing row authoritative,
including empty rows, and `5190–5197` drops new candidates on SOFT+. This supports
upgrade safety for **already decided** Rust messages; it does not transfer Pi's
empty-ledger upgrade failure to Rust. Missing historical Rust decisions can still
request a parity transition (`3812–3828`); the golden test now seeds temporal
awareness disabled and expects a HARD backfill (`33918–33934`). That is an
activation/backfill fixture, not a legacy-enabled-session upgrade test.

Full Rust transform tests were not rerun: these isolated Git snapshots do not
contain the required sibling `commons`/`subconscious` path workspaces
(`Cargo.toml:15–26`). No Cargo command, live daemon, or copied live Rust store was
used. All Rust state/transition conclusions above are explicitly source-level.

## Note: restart/revert/edit behavior follows identity, not new timestamps

The on-disk reopen regression reintroduces a temporarily reverted message and
edits its body/time under the same id. TS and Pi replay its original `+5m` once,
even when it is no longer first and the visible predecessor suggests a different
gap. Repeated replay does not duplicate the prefix. This is the intended frozen
identity policy (`temporal-decisions.ts:69–72`), not recomputation on edit. A new
host identity is a new candidate; permanent deletion has the pruning gap above.
The restart test exercises actual persisted decisions; branch revert/edit walking
is a renderer-level check, not a full host revert UI test.

Pi unresolved messages deliberately cannot mint a positional marker. The test
confirms undefined entry ids produce no candidates and cannot inherit another
entry's choice. Candidate `context-handler.ts:1625–1659` uses references or a
unique immutable fingerprint to align host arrays with entry ids, refusing to
guess among duplicates; `5515–5517` supplies those resolved ids to the collector.
Thus a truly id-less/unresolvable message may have **no temporal annotation** even
on a rebuild, unlike the old eager walker. This is a defensible identity-safety
tradeoff, but not universal temporal parity. No claim is made that unresolved
entries preserve old eager markers across deployment.

## Verification and verdict

- Bun **1.4.2**: review suite **7 pass / 3 expected red**, 10 tests. Red names are
  the Pi upgrade, permanent-message cleanup, and inherited reminder-parity tests
  listed above. They are intentionally retained as failing claims, outside the
  package test globs, not rewritten to bless the observed behavior.
- `timeout 90s bash docs/reports/temporal-markers-review.sh --candidate-controls`:
  **8/8 shared TS controls** in three files and **17/17 Pi controls** in three
  files pass (Bun 1.4.2). This includes the candidate's renamed seam assertions;
  their green status does not cover the newly exposed upgrade case.
- TypeScript **5.9.3**: focused no-emit typecheck for the committed review test;
  shell syntax check and `git diff --check`. No production API/package/lockfile
  changes; no build or install is needed for this documentation/test-only review.
- Rust **1.99.0**: exact extracted formatter compiled and ran nine goldens. No
  workspace build, transform/store test, or live host run is claimed.
- AFT diagnostics could not initialize the workspace TypeScript SDK; the explicit
  installed-package `tsc` check is used instead. The unavailability is not treated
  as a clean diagnostics result.

**Verdict: do not merge as-is.** The Pi/OMP legacy-session SOFT+ upgrade case is a
demonstrated cache-stability blocker. Fix that adoption boundary and rerun the
old→new test before relying on the otherwise successful frozen-seam replay proof.
