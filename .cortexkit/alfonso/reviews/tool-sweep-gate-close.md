# Scoped tool sweep + atomic marker drain — gate close

## Status

The BLOCK findings of `tool-sweep-scoped-gate.md` are closed with product changes and executed
pins. The gate's own red tests were cherry-picked first (`3645fd18a`, `798a1df77`) and are green
on this branch; the sequence 11b red is converted into a bound-pinning test per the ruling.

Base: `0671ffac0b` (contains master `955f54750c`, marker atomicity `41e112a0`). Dists are not
rebuilt here.

| Finding | Was | Now |
|---|---|---|
| 10 — pre-fix priced marker-seam upgrade loses the reasoning-only assistant | provider divergence 50, target 51 → -1 | divergence **-1**, target 51 → 51 → 51 |
| 7 — clone drops the adoption marker | inherited=false for an adopted source | inherited=true; pre-adoption clone still legacy |
| 3 — raw served array not preserved across restart | hook divergence 4 (empty shell) | MC-owned row shape divergence **-1** |
| 11b — pre-fix drain upgrade window | red test | ruled, bounded, pinned (see D) |
| 2 — HARD fold adoption | not executed | executed arm `published-history` |
| 8 — two-process adoption race | not executed | executed, both interleavings |

## A. Pre-adoption defer picks the sweep by the last served array

`tool-sweep-policy.ts` now exposes `createPreAdoptionToolSweepResolver`. A pass that has no
adoption marker and may not change bytes no longer takes a default:

- `ToolMutationBatch` computes BOTH candidate arrays at finalize (legacy sweep = every row left
  without a meaningful part is removed; scoped sweep = only this pass's tool-drop owners) and asks
  the resolver which to apply. The answer is memoized per batch, so one pass has one policy.
- The resolver compares both candidates against the array the session was last served, row by row,
  over what the provider actually receives: a row whose parts were all removed, or that was
  reduced to an empty text shell, is dropped before the request is built and is skipped on both
  sides. Reasoning-only rows are compared — they are sent, and they are exactly what the two
  sweeps disagree about. A candidate matches only if it replays the whole recorded row sequence
  as its prefix.
- Deliberate outcomes, all logged under the stable key `tool_sweep_lkg_mismatch` with
  `session=<id> condition=<...> last_served_rows=<n> legacy_divergence=<i> scoped_divergence=<i>`
  (`sessionLog` already prefixes the session id; the explicit `session=` keeps the line
  self-contained for a counter). Conditions:
  - `lkg_absent` — no durable snapshot: nothing is known to have been served, adopt scoped now.
  - `matched_old` — the legacy array reproduces the snapshot: serve legacy, do not adopt. Also
    reported when BOTH candidates reproduce it, because indistinguishable candidates are no
    evidence for changing what a session is being served.
  - `matched_scoped` — only the scoped array reproduces the snapshot: serve it and write the
    marker on that pass. This is reproduction of served bytes, not a first application.
  - `matched_neither` — history moved since (e.g. a new drop landed this pass): serve legacy, the
    status quo the session was already paying under; the next priced pass adopts.
- Priced passes adopt unconditionally, exactly as before.

### Durable representation actually used

The TS lane does not write a "served array" store of its own. It captures an LKG slot at the end
of every pass that finalizes without degradations (`passOutcome.captureEligible`, priced or defer)
through `captureLkgSlot({ input, output: messages })`, and persists it to `lkg_slots` (migration
v81) via `saveLkgSlotToDb`. `slot.jsonPrefix` is the serialized served prefix through the pass's
anchor, which is the durable last-served representation that exists on this lane — no new store
was invented. The snapshot handle is read once, at policy selection; only the parse is deferred to
the point where both candidates exist, so a second process pricing the same session mid-pass
cannot change this pass's input halfway through (see E, two-process).

### Executed evidence

Seam arm, exactly as the report's command (pre-fix checkout `4f9a3d1a` — the revision *before*
scoped sweeping existed; `e27fc7f0` already adopts and cannot produce a pre-adoption ledger):

```sh
MC_PROBE_UPGRADE_FROM=/tmp/gate-close-prefixed-scoped/packages/plugin/src/index.ts \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

`(pass) scoped gate upgrade preserves pre-fix priced marker-seam prefix`, 17 assertions:

```
aSha256=73735ac4ba9b3cd1ea30ee2297443ad0426f19bc3b0bcc6e8d3dbea6591cae72
bPrefixSha256=73735ac4ba9b3cd1ea30ee2297443ad0426f19bc3b0bcc6e8d3dbea6591cae72
firstDivergence=-1 targetA=51 targetB=51 targetC=51
hookFirstDivergence=4 hookShapeFirstDivergence=4 preUpgradeLkgRows=0
[magic-context][ses_...] tool_sweep_lkg_mismatch session=ses_... condition=lkg_absent
    last_served_rows=0 legacy_divergence=-1 scoped_divergence=-1
```

**Honest reading of this arm.** It resolves through `lkg_absent`, not through a match: the pre-fix
build left NO `lkg_slots` row for this session (`marker-drops-pre-upgrade-lkg.json` = `[]`,
dumped before the old host is killed — new probe output, and now an assertion). Its priced
marker-seam pass declines capture and, being a busting pass, drops the durable row. So for the
seam population the ruled `lkg_absent` arm is the operative one, and the test pins that premise:
if a future change makes the seam pass capture, this arm reddens and the decision is re-examined.
(Executed: no row at kill time, after 29 passes. The mechanism — the priced seam pass declines
capture and, being a busting pass, clears the durable row through the existing
`bustedThisPass && !captured` drop — is consistent with that and with the capture code being
identical in both builds, but was not separately instrumented.)

The matching arms are executed elsewhere, on the same code path:

- Unit discrimination (`tool-sweep-policy.test.ts`): all four conditions, and `matched_old` vs
  `matched_scoped` asserted to differ in both condition and served variant.
- Transform-level discrimination (`transform.test.ts > pre-adoption defer serves the sweep variant
  each session was last served`): two sessions replay the same history on a defer pass; the one
  whose snapshot holds the reasoning-only row gets it back and records adoption
  (`e8d95b0f9cec2fcc...`), the one whose snapshot does not keeps the legacy array and does not
  adopt (`6d7fbad168f1b983...`).
- Durable cross-process read (E, two-process): a fresh process read the snapshot a previous
  process wrote and returned `matched_old`.
- The non-seam replay arm is unchanged: `legacy-1/2/3` still hash
  `04006c59b8c824f3eef0bc3cf0de256c708fa9e0e988069efbe8c087fff3677d` with divergence -1, and the
  marker is still false before the priced pass — i.e. ordinary pre-adoption defers DO find a
  snapshot and decline to adopt. A cross-version non-seam arm (old binary prices, new binary
  defers) is not executable with this harness: its upgrade lane is seam-only. Residual risk is
  stated below.

## B. Clone keeps reserved ledger control entries

`RESERVED_LEDGER_CONTROL_ENTRIES` is exported next to `TOOL_SWEEP_SCOPED_MARKER`, and
`clonePiContentDecisions` (`storage-clone.ts`) copies any entry on that allowlist verbatim instead
of discarding it as an undecodable id. A pre-adoption clone still does not inherit adoption.

`tool-sweep-clone-gate.test.ts` — the expected-red todo is now an ordinary test:

```
SCOPED_GATE clone source_adopted=false inherited=false   (pass) scoped gate pre-adoption clone remains legacy
SCOPED_GATE clone source_adopted=true  inherited=true    (pass) scoped gate adopted clone retains priced sweep policy
```

## C. The sweep prunes the array that is served

On a pass that trims a compaction prefix, tagging runs over the pre-trim copy so persisted drops
still find their rows. The sweep spliced only that copy, so a fully dropped tool owner survived in
the live array as an empty shell and the NEXT pass — which sweeps the served array directly —
removed it: two passes over the same history served different arrays. `ToolMutationBatch` now
takes the served array and removes exactly the rows the sweep removed from both
(`pruneServedRows`); `tagMessages` passes it through (`servedMessages`).

Restart arm (`MC_PROBE_EXPECT_ADOPTED=1`, same build on both sides):

```
firstDivergence=-1 targetA=51 targetB=51 targetC=51
hookFirstDivergence=29 hookShapeFirstDivergence=-1
```

`hookShapeFirstDivergence` is the array as Magic Context owns it (id, role, parts) — the pinned
value flips from 4 to **-1**. The remaining raw-JSON difference at index 29 is OpenCode re-adding
its own empty `info.summary` to a message it rebuilt after its restart; no transform writes it and
it never reaches the provider. Asserting raw JSON equality there would assert the host's metadata
is stable across its own restart, which is not a Magic Context claim; every row the host sends is
compared byte for byte.

For the cross-version upgrade arm the same comparison is made over the rows the host actually
sends: the pre-fix build's unsendable shell (index 4) is not something the fixed build is asked to
reproduce, and the test asserts the fixed build emits no unsendable rows at all.

## D. Sequence 11b — ruled, not fixed

RULING: a session that was mid-drain when it upgraded from a build without the atomic
drain/trim rule pays for that build's last drain exactly once. That build committed the marker
while still serving the rows below it; afterwards the host builds every request from the committed
boundary, so those rows are simply not in this transform's input. Serving them would be forwarding
history the host did not provide — the class we refuse. The loss is bounded: only rows below the
committed boundary disappear, the reasoning target survives (shifted), and the next pass repeats
the new prefix. The ruling is stated in a comment at the drain refusal site
(`transform-postprocess-phase.ts`, the `!trimWasProven` branch).

The gate's red test is now the bound:

```sh
MC_GATE_BOUNDARY=1 MC_PROBE_EXPECT_ADOPTED=1 \
MC_PROBE_UPGRADE_FROM=/tmp/gate-close-prefixed-marker/packages/plugin/src/index.ts \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

`(pass) marker boundary upgrade loses exactly the rows below the pre-fix committed boundary, once`,
20 assertions: `firstDivergence=1 targetA=53 targetB=49 targetC=49`. It asserts every row present
in A and missing from B is a host row strictly below the committed boundary, that no row at or
above the boundary is lost, that B reproduces the surviving rows in order, that the target survives
(shifted), and that the pass after B repeats B's prefix (provider and raw) — paid once, not per
pass.

## E. Gate gaps closed

**Sequence 2 — HARD fold.** `transform.test.ts` adoption arms are now
`soft-execute | explicit-flush | force-band | published-history`. The new arm publishes a
compartment and leaves the deferred-history signal pending, so the pass rebuilds the injected
history head while the scheduler still defers; the covered opening is replaced by the rendered
`<session-history>`, the marker flips, the reasoning-only assistant is restored, and three
following defers replay it byte-identically
(`3140c5853f5a7423a949cb247a5986081a28869948bf9ed7e8806a075123b9dd`, divergence -1 each).

**Sequence 8 — two processes, one SQLite session.** New
`packages/e2e-tests/scripts/tool-sweep-concurrency-gate.test.ts` plus
`tool-sweep-concurrency-pass.ts`. Each pass is a real second Bun process running the real
`createTransform` against the same context DB; the barrier is a file handshake inside the tag walk,
after the pass has read its sweep policy and before the sweep is finalized.

```
SCOPED_GATE concurrency legacy=a82ee514de76acdb… during=a82ee514de76acdb…
                        after=f7e10e298f3fbc40… adopted=f7e10e298f3fbc40…
```

- Interleaving 1 — the priced process commits the marker while the defer process is parked
  mid-pass: the defer serves pre-adoption bytes for its whole pass.
- Interleaving 2 — a whole defer pass runs inside a parked priced process's pass, after that
  process committed the marker: the defer serves post-adoption bytes for its whole pass.
- The two coherent outcomes are asserted to differ, so neither equality is a tautology, and each
  arm is byte-identical to exactly one of them — never a mixture.
- The pre-adoption process's log is asserted to carry the `tool_sweep_lkg_mismatch` line.

## Gates

| Gate | Result |
|---|---|
| `bun run typecheck` (plugin, pi-plugin, cli, retina-local-fs) | pass |
| `bun run lint` | plugin/cli/retina clean; pi-plugin fails only on pre-existing `src/overwall-wire-shapes.test.ts` and `src/overwall-upgrade-replay.test.ts` (untouched by this branch). The pinned `transcript-pi.test.ts` formatting was fixed. |
| `bun run --cwd packages/plugin test` | 5171 pass, 3 skip, 0 fail |
| `bun run --cwd packages/pi-plugin test` | 1218 pass, 3 skip, 0 fail (storage-clone is shared) |
| `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only 955f5475 HEAD` | `RESULT IDENTICAL defer_passes=4` |
| upgrade gate, seam arm | pass (above) |
| upgrade gate, adopted restart arm | pass (above) |
| upgrade gate, boundary arm | pass (above) |
| concurrency gate | pass |
| `tsc --noEmit` in packages/e2e-tests | new/changed gate scripts clean; the documented baseline errors remain (rust-harness.ts, opencode2 tests, command-handler.ts, condition-compiler.ts) |

## Mutation ledger

Every control staged the live tree first (`git diff --stat` empty), captured a non-empty stat while
mutated, and restored with `git checkout -- <path> && touch <path>` to an empty stat. No mutant is
retained.

| Control | Path / stat | Exact red | Other failures |
|---|---|---|---|
| Constant condition (`matched_scoped` always) | `tool-sweep-policy.ts` +2/-1 | `pre-adoption sweep variant follows the array this session was last served` (`Expected: "matched_old" / Received: "matched_scoped"`) | by design this control changes every pre-adoption pass: also the four adoption arms and `pre-adoption defer serves the sweep variant each session was last served` (6 fail / 5165 pass), and the e2e concurrency gate. Re-run on the final tree with the same six reds. |
| Drop the reserved-entry allowlist | `storage-clone.ts` -4 | `scoped gate adopted clone retains priced sweep policy` (`Expected: true / Received: false`) | none (5170 pass, 1 fail) |
| Prune the tagged copy only (`pruneServedRows` disabled) | `tool-drop-target.ts` +1/-1 | `scoped gate restart preserves adopted priced marker-seam prefix` (`hookShapeFirstDivergence Expected: -1 / Received: 4`) | plugin suite 5171 pass / 0 fail — the unit suite does not cover this seam; the host arm is the control |

## Residual risk and what is NOT closed

1. **`lkg_absent` is load-bearing for the seam population.** Executed: the pre-fix build leaves no
   durable snapshot after its priced seam pass. A pre-fix session whose LAST priced pass was
   non-seam and whose snapshot is likewise missing would adopt scoped on its first fixed defer and
   change its prefix once. Ordinary passes do leave a snapshot (executed at unit level and across
   processes), so this is the narrow case; it is countable in production as
   `condition=lkg_absent`, which is why the key exists.
2. **Cross-version non-seam arm not executed.** The probe's upgrade lane always drives the marker
   seam. The non-seam claim rests on same-build unit execution plus the durable cross-process read.
3. **Raw-array comparisons use MC-owned row shape** (id, role, parts) across a host restart, for
   the reason given in C. Within one process, raw JSON equality is asserted unchanged.
4. **Sequence 6 (pre-fix reader tolerance)** still has no mutation control, and 11b's ruling is a
   ruling, not a repair.
5. Dists are not rebuilt by this change; both cache-path changes still gate the same rebuild.
