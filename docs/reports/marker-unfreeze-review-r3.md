# Compaction-marker unfreeze: final round-three adversarial review

## Scope and verdict

Review candidate **7d7b23ea506c2957835bb6e75aaf09247a8d0a70**, including
round-three commits **c32bceb002**, **0a31af0ecb**, and **7d7b23ea50**.
The review branch starts at **7068e09570f9b29f4db50563134b177a8bae33e8**.
All candidate source line references below describe the temporary candidate
overlay, not the review branch's production files. Only this report is delivered.
Read both earlier reviews and the protected `ARCHITECTURE.md:48–108` first.

No live database, configuration, or backup store is accessed. Unit fixtures and
host runs are confined to `$TMPDIR/magic-context/marker-unfreeze-review-r3-bg_c62afe4/`.
Shell commands have outer timeouts; native builds are serialized with `-j 2`.
Candidate source/test overlays and all throwaway proof tests were restored before
delivery; no production fix, package/config workaround, or test weakening is
included. The report was committed at its evidence checkpoints.

**Do not sign off round three yet.** All three round-two reproductions now pass
for their intended reasons, and the ordinary real OpenCode 1 byte-identity suite
passes. But the new fence recovery sends a malformed `session.flush` request:
the transport's `method` argument is not the wire dispatch field. An armed fence
therefore permanently refuses subsequent real turns, including after restart,
before a rebuilding transform can even run. The passing fault-recovery mocks
do not exercise this wire contract.

## The three round-two blockers

Independently executed the **exact three** `r2 proof:` tests in the manager,
Rust adapter, and V2 boundary suites: **3 pass, 0 fail, 10 assertions**
(Bun 1.4.2). None was skipped or replaced with a simpler setup.

1. **Retained assistant target / earlier user:** the manager still creates the
   initial real marker at target 8, verifies that its retained user is 7, then
   vetoes target 20. `compaction-marker-manager.ts:227–265` enumerates all
   uncovered ends and excludes only ends canonically *before the retained user*,
   not ends at/below the summary target. Test: `r2 proof: a retained partial at
   the prior target ordinal still vetoes the next cut`.
2. **Rejected HARD:** the adapter validates the native head at
   `rust-mode-transform.ts:3892–3897`, before postprocess/host mutation at
   `:4063–4074`. The deliberately invalid response still replays byte-identical
   LKG, freezes the representation, and leaves both mirror state and real host
   marker rows absent; no fence is armed. Test: `r2 proof: a rejected HARD output
   cannot move the host marker before LKG replay`.
3. **Absent endpoint / visible real gap:** `v2/fold/boundary.ts:181–243`
   verifies each visible prefix coordinate against summary ranges, rather than
   only looking for a visible endpoint. The real ordinal-3 gap remains in the
   array and zero messages are removed. Test: `r2 proof: an absent partial
   endpoint cannot hide visible real content in its successor gap`.

Paths above without a package prefix live below
`packages/plugin/src/hooks/magic-context/`, except `v2/fold/boundary.ts` under
`packages/plugin/src/`.

The initial proof invocation used an absolute throwaway `OPENCODE_DB`. Two tests
correctly failed because their helpers create separate per-test XDG databases.
Rerunning with `OPENCODE_DB=opencode.db` resolves under each throwaway fixture's
XDG root and gives the passing result above. This was a setup correction, not a
production or assertion change.

## Blocker — fence recovery never reaches a real rebuilding transform

**Evidence:**
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3616–3632`
passes `method: "session.flush"` to the client but serializes only
`body: {v:1, session_id:sessionId}`.
`packages/plugin/src/hooks/magic-context/module-transport.ts:592–603,606–610`
encodes `args.body` plus `accept_reply_pages`; it does **not** copy `args.method`
into that JSON. `crates/mc-module/src/lib.rs:14135–14141,14178` dispatches on
the JSON `method`, not on the client's local bookkeeping argument. Other real
flush callers correctly put the method in the body
(`packages/plugin/src/plugin/rpc-handlers.ts:1735–1736`,
`packages/plugin/src/hooks/magic-context/command-handler.ts:664–668`).

The fence check disables parking and forces full transport
(`rust-mode-transform.ts:2405–2417`), but the malformed flush fails *before*
`sendTransformSeriesWithSingleRestart(body)`. The catch refuses while preserving
the flag (`:4404–4422`). The only durable clear is after successful final
admission (`:4396–4402`); no successful transform can reach it on this path.
An ordinary retry, a natural HARD opportunity, and a process restart all take
the same broken flush first. This is a liveness blocker, not an unsafe raw serve.

### Failing unit proof and green controls

Throwaway test, inserted beside the candidate's `markerFaultFixture` tests:
`r3 proof: marker recovery serializes the session.flush wire method`.
Add a `requests` array to that existing helper, recording `{method, body}` at
the top of its mocked client `call`, and expose it in the returned fixture. Then:

```ts
it("r3 proof: marker recovery serializes the session.flush wire method", async () => {
    const fixture = markerFaultFixture("capture");
    try {
        await fixture.serve();
        await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
        fixture.stopFault();
        await fixture.serve();
        expect(fixture.requests.find(r => r.method === "session.flush")?.body)
            .toMatchObject({method:"session.flush", v:1, session_id:fixture.sid});
    } finally { fixture.dispose(); }
});
```

**Sole failed test in a 12-test selection:** expected body method
`"session.flush"`; received `{v:1,session_id:"marker-admission-capture-…"}`
with no method. **11 pass, 1 fail, 119 assertions.** Green controls include
all three post-cut after-marker/capture/bookkeeping tests, persistent capture
refusal, committed-SOFT+ refusal, adapter restart, and five new crash/contention
probes below. Their mock branches on `call.method` and returns `{ok:true}` for
every non-transform call, so they are useful admission controls but **not**
evidence that the real flush was dispatched. No production guard was mutated.

### Independently failing real-host proof

`r3 review real module: a durable refusal fence is cleared by an explicit SOFT
rebuild before and after restart` warms an isolated real Rust-mode session, then
atomically stores the exact version-2 fence and removes its durable slot/chunks
in that fixture's context.db. It tries a new turn, restarts OpenCode on the same
fixture, and tries another. The test collects both observations before asserting
that at least one rebuilding transform was applied and the fence cleared.

Result: **0 pass, 1 fail, 10 assertions, 25.52s**; the applied-transform-count
assertion fails (**expected >0, received 0**). Both real turns report
`decision=error reason=marker_admission_failed served_from=refused`, with
`transport_pages=0`; both leave **fence=1, durable_slots=0**. This test recreates
the durable crash state, not a fault-enabled Rust producer or an actual process
kill; the candidate's real-SQLite adapter fault tests independently establish
that a failed cut admission writes precisely that state.

The same real module route was sent the exact recovery wire object, including
the transport's `accept_reply_pages:true`. It responds:

```text
no `method` or `kind` field matched a known request;
got top-level keys: [accept_reply_pages, session_id, v]
```

A direct control with the otherwise-identical body plus
`method:"session.flush"` returns **`{"armed":true,"ok":true}`**. This pins the
failure on dispatch rather than an unavailable module, invalid JSON, missing
summary coverage, or a non-busting transform decision. All lsof assertions pass.

**Required:** serialize the management dispatch field, and add a real transport
or real-host fence-recovery regression. Do not weaken the genuine rebuilding
decision requirement or clear the flag just to make a retry proceed. A mocked
client accepting the incomplete request is not an adequate regression.

## Durable-fence attack results

### Crash windows across context.db and the host store

The fence and strict deletion of the old durable LKG share one context.db
`BEGIN IMMEDIATE` (`rust-mode-transform.ts:2072–2089`). The nested clear is a
savepoint, not an independent commit (`lkg-persist.ts:301–307`,
`shared/sqlite.ts:290–308`). Hence there is no durable state with the LKG deletion
committed but the fence absent. The context transaction **commits before** the
separate OpenCode replacement transaction (`compaction-marker-manager.ts:361–390`,
`features/magic-context/compaction-marker.ts:625–646`). There is deliberately no
distributed rollback.

| Failure/crash point | Durable state | Next pass / restart on this candidate |
| --- | --- | --- |
| Fence transaction fails or process dies before its commit | Host cut unchanged; fence/deletion roll back; old durable LKG survives | Current adapter conservatively refuses a failed attempt; a fresh adapter can hydrate old LKG. Independent actual SQLite-lock control passes. |
| Fence and LKG deletion committed, host cut not attempted/committed | Fence armed; old host boundary; old durable LKG absent | Attempts full recompose, but malformed flush **refuses indefinitely**, including restart. Mocked correctly acknowledged flush can recover and durably clear. |
| Host cut committed, context marker mirror/bookkeeping not committed | Fence armed; new host marker; mirror may still be old/NULL | Same fail-closed recovery, with the same real flush blocker. No old-LKG hydration. |
| New priced LKG persisted, later bookkeeping or final clear fails | New slot may exist, but fence remains armed and hides it | Refuses; a new adapter also cannot hydrate it until rebuilding admission finishes. |
| All admission and strict clear succeed | New priced LKG durable; fence absent | Normal serve/replay resumes. Independent mock-SOFT recovery followed by a **second** connection/adapter restart proves the clear itself is durable. |

Five independent throwaway adapter tests passed **53 assertions**:

- `r3 review crash window: before-host stays fenced across restart and a SOFT
  rebuild durably clears it`: strategy stops immediately after the committed
  fence, before the actual host write; **0 host markers / NULL mirror**.
- `r3 review crash window: mirror-capture stays fenced across restart and a SOFT
  rebuild durably clears it`: fail the real marker-mirror SQL and later capture;
  **1 host marker / NULL mirror**.
- `r3 review crash window: clear stays fenced across restart and a SOFT rebuild
  durably clears it`: fail the last replay-document UPDATE *after* capture;
  **1 host marker / persisted mirror**.
- `r3 review contention: a real fence-lock failure never reaches the host and
  preserves durable old LKG`: another SQLite handle holds context.db's writer
  at the fence acquisition; **no strategy invocation / no host marker**, the
  old durable LKG remains readable and hydrates after restart.
- `r3 review reverse order: a busy host cut followed by capture failure loses
  still-safe old LKG`: a separate process holds opencode.db's writer for seven
  seconds, yielding a real `retryable-failure` and **no host marker**; fail later
  priced capture. The fence is durable, the safe old LKG is gone, and a new
  adapter cannot hydrate it. Mocked SOFT recovery clears it once faults stop.

These are exception-window/file-connection-restart proofs, not OS kill-window
or host-provider-wire fault certification. The real-host failure above demonstrates
why their green mocked recovery cannot establish deployed recovery.

### Should-fix — preserve availability when the host is proven not to have cut

The reverse ordering is **not** symmetric. A failed fence prevents a cut, but
a successful fence followed by a failed host BEGIN has already destroyed the
old LKG. The executed reverse-order test observes a 202-character old snapshot,
`retryable-failure`, no host rows, NULL mirror, and absent durable replay.
Source: `transform-postprocess-phase.ts:855–862` fences **before** the strategy
knows whether it will even cut; `compaction-marker-manager.ts:372–378,399–414`
uses the same retryable outcome for failure before host commit and failure after
host commit in the mirror.

In general it is correct to refuse an **uncertain** commit; the approved
fail-closed design must not guess that every caught failure means no cut.
Nevertheless a provably failed host transaction has the unchanged old prefix,
and losing its only safe replay worsens storage-busy availability unnecessarily.
Consider retaining a quarantined old snapshot plus a typed definitely-no-cut
outcome/verified rollback, rather than destructively discarding it for no-op,
stale-skip, or never-acquired-host-lock attempts. Do not revive it on an ambiguous
post-commit failure. This is a should-fix availability distinction, not a second
content-safety blocker; the missing flush currently magnifies it into permanent
refusal even after the lock and capture fault are gone.

### Locks, contention, and permanently fenced sessions

The new fence is a foreground write-lock acquisition, not a read-only hot-path
flag. It runs only on eligible pending/boundary application, not ordinary SOFT+.
The pending-target transaction, fence transaction, host transaction, and mirror
transaction are sequential; the fence does **not** hold context.db's writer
while acquiring opencode.db's writer. SQL transaction routing takes IMMEDIATE
before reads, uses the bounded foreground acquisition lease, and restores
`busy_timeout` (`shared/sqlite.ts:237–255,751–778`). I found no new reversed
two-database lock nesting in this path.

On real fence contention, the flag/deletion transaction rolls back, no host cut
is attempted, and the current pass refuses: no unmanaged pass. Old durable LKG
survives for restart. If optional target recording fails earlier, the adapter
can instead complete a validated module serve without any cut
(`transform-postprocess-phase.ts:829–839`). On host contention after fencing,
a fully admitted new capture can clear the fence and serve; if later admission
also fails, it refuses with old replay unavailable as above. This respects
"busy never passes unmanaged"; it is not a promise that every busy pass will
replay old LKG.

The intended clear requires a genuine HARD/SOFT/MIGRATE_HARD/EXECUTE decision,
final fit, synchronous durable LKG, bookkeeping, and a strict replay-document
write (`rust-mode-transform.ts:3822–3836,4110–4118,4200–4206,4396–4402`).
Persistent capture/storage faults remain refusing, not parked/raw; a metadata-only
SOFT+ cannot clear. When flush is actually dispatched, Rust arms a soft refresh
(`crates/mc-module/src/lib.rs:7826–7843`), and its existing
`session_flush_consumes_once_as_soft_without_forcing_hard` regression at
`:33733–33751` describes the intended SOFT opportunity. The deployed candidate
never gets there after fencing. Manual deletion of the flag is **not** a safe
operational workaround for an uncertain committed cut.

## Host parity and cache safety

**OpenCode 2 shares this fence, and thus the blocker.** Its Rust lane calls the
shared adapter (`hooks/magic-context/transform.ts:667–674,973–990`), supplying a
strategy that records the retained user boundary in context.db instead of
mutating host marker rows (`v2/fold/boundary.ts:56–125`). Its next-pass trim at
`v2/hooks/context.ts:1642–1648` checks visible coverage. The envelope/LKG fence
and full-array/flush recovery are shared; there is no independent V2 clear.
This review does not claim a V2 real-provider fault run.

**Pi does not enter this Rust adapter/fence path.** It has its own entry-list
`appendCompaction` strategy and stricter uncovered-indexed-end veto
(`packages/pi-plugin/src/compaction-marker-manager-pi.ts:60–68,110–119`), plus
its own `pi-lkg.ts` coordinator. The shared durable loader now observes the Rust
fence (`lkg-persist.ts:309–310`), but Pi does not arm or clear it for Pi-native
cuts. Pi's separate marker suite stays green. This is parity of the shared
coverage rule, not a claim that Pi gained the two-database Rust admission fence.

**Ordinary path:** ran the actual candidate OpenCode 1 byte-identity suite once,
with its rebuilt distribution and rebuilt module. **3 pass, 0 fail, 140
assertions, 85.34s**; OpenCode **1.18.30**. Dense fixture: **25 indexed
compartments / 24 distinct marker ordinals**, input **12,956 → 44**, first cut
transport **all 44**, next ordinary delta **3**. Actual intercepted provider
system/messages equality passes; all three comparable serializations have
SHA-256 **`86ef9e6b2bd2988f3b4f1fd60e28ff79398d5c76ea2786e7d07df1f1270ca508`**,
exactly the round-two review's recorded hash. Comparable passes are applied
SOFT+ transforms, not LKG or refusal. The seven-gap fixture advances **50 → 140**
with synthetic-only gaps; a real row at **85** keeps marker **50** and sends no
new provider request. The real metadata-only committed execute remains SOFT+
and preserves pending work/history bytes. None of these ordinary probes arms a
failed-admission fence, so none contradicts the recovery blocker.

## Verification, isolation, and limits

Tools: **Bun 1.4.2 (744846f84)**, **TypeScript 5.9.3**, **cargo 1.99.0
(5f94df478 2026-08-27)**, **SQLite 3.54.0**, real **OpenCode 1.18.30**.
Rebuilt the worktree's module; used the explicitly selected existing hermetic
daemon **ck-subc 0.20.55**, not a newly rebuilt daemon. Candidate and review-base
Rust sources/manifests/lock compare equal. The lock does not match three available
sibling versions, so `cargo build --release -p mc-module -j 2 --locked` fails
before compiling. A single foreground offline build succeeds in **5m35s**, with
temporary sibling lock resolutions `subc-core 0.20.55→0.20.56`, `subc-daemon
0.31.1→0.32.0`, and `subc-os 0.1.5→0.1.6`; the lock was staged first, then
restored/touched and its diff verified empty. No lock or manifest is delivered.

All shell commands have outer timeouts. Builds and host runs use foreground
waits, native compilation uses **`-j 2`**, and **only one OpenCode host runs at
a time**. The prepared frozen Bun install is used; no package install or manifest
edit was required. Full native/V2 lanes and unrelated baseline failures from the
round-two review were not rerun: this is the deliberately narrow fence review.

For all review tests, set these under the throwaway root (the harness further
creates a separate `opencode-e2e-*` fixture for each host):

```sh
root="$TMPDIR/magic-context/marker-unfreeze-review-r3-bg_c62afe4"
export TMPDIR="$root/tmp" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config"
export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime"
export MAGIC_CONTEXT_STORAGE_DIR="$root/storage" OPENCODE_DB=opencode.db
```

`OPENCODE_DB` is deliberately relative so the helpers' separate per-test XDG
fixtures own their respective databases; none resolves against HOME's live store.
Every real-host sample used `timeout 20s lsof -p <host,daemon,module[,producer]>
-Fn` and checked **every** `.db`, `.db-wal`, and `.db-shm` path against that host's
throwaway data directory. The host byte-suite's first sample: PIDs
**84831,84603,84674,84769**, holding only
`…/tmp/opencode-e2e-N2gbam/data/opencode/opencode.db` and
`…/data/cortexkit/magic-context/{context,store}.db`. The final failing fence proof:
host **61684**, restarted host **76418**, daemon **61195**, module **61435**;
every database is under `…/tmp/opencode-e2e-3kIpG4/data/`. The file inventories
are printed verbatim in the retained logs. No live database/config or backup is
opened, read, written, copied, or migrated; the host's legacy-config migration
messages refer only to these isolated fixture configs.

| Command / check | Independent result |
| --- | --- |
| From `packages/plugin`: `timeout 180s bun test src/hooks/magic-context/compaction-marker-manager.test.ts src/hooks/magic-context/rust-mode-transform.test.ts src/v2/fold/boundary.test.ts -t 'r2 proof:' --timeout 30000` | **3 pass / 0 fail / 10 assertions**; exact previous blockers, not filtered away. |
| `timeout 180s bun run --cwd packages/plugin build` | Candidate rebuilt successfully, including **4 V2 loader tests / 19 assertions**. |
| `timeout 120s bun run --cwd packages/plugin typecheck` | All **three tsc invocations pass**, silent-on-success, TypeScript 5.9.3. |
| `timeout 900s cargo build --release -p mc-module -j 2 --offline` | **One package build target passes**, no Rust tests; temporary lock resolution restored as above. |
| From `packages/e2e-tests`: `timeout 1200s bun test tests/rust-compaction-marker-byte-identity.test.ts --timeout 900000` | **3 pass / 0 fail / 140 assertions**, 85.34s; lsof guards pass. Explicit paths: `MC_E2E_CK_MC_PREBUILT_BIN=$PWD/../../target/release/ck-mc`, `MC_E2E_CK_SUBC_BIN=$PWD/../../target/pipe-only-subc/debug/ck-subc`, `MC_E2E_PLUGIN_ENTRY=$PWD/../plugin/dist/index.js`. |
| Temporary adapter tests: `timeout 180s bun test src/hooks/magic-context/rust-mode-transform.test.ts -t 'r3 review' --timeout 30000` | **5 pass / 0 fail / 53 assertions**, 8.13s; before-host, mirror, final-clear, actual fence lock, and reverse-order actual host lock. |
| Temporary unit blocker proof plus controls: `timeout 90s bun test src/hooks/magic-context/rust-mode-transform.test.ts -t 'r3 proof:\|post-cut.*refus\|r3 review' --timeout 30000` | **11 pass / 1 expected-safe failure / 119 assertions**; only the exact wire-method test fails. |
| Temporary real-host blocker proof: `timeout 240s bun test tests/rust-marker-fence-review-r3.test.ts --timeout 120000` | **0 pass / 1 expected-safe failure / 10 assertions**, 25.52s; both pre/post-restart refuses collected, real dispatch/control replies and lsof guards verified. |
| Original candidate seven-suite run after proof tests restored: `timeout 240s bun test src/features/magic-context/compartment-storage-v6.test.ts src/hooks/magic-context/compaction-marker-manager.test.ts src/hooks/magic-context/transform-postprocess-phase.test.ts src/hooks/magic-context/rust-mode-transform.test.ts src/hooks/magic-context/rust-mode-marker-lock-contention.test.ts src/hooks/magic-context/lkg-persist.test.ts src/v2/fold/boundary.test.ts --timeout 30000` | **459 pass / 0 fail / 4,578 assertions**, 70.01s. All existing fence, outer-wrapper, queued-capture, and LKG hydration controls stay green. |
| From `packages/pi-plugin`: `timeout 90s bun test src/compaction-marker-manager-pi.test.ts --timeout 30000` | **11 pass / 0 fail / 18 assertions**, separate Pi process. |
| `timeout 20s git diff --check` and final changed-file inventory | Pass; final review changes only this Markdown report. |

The preliminary extra-host probe had two setup limitations, corrected without
changing production: `h.contextDb()` is read-only, so the test's fence control
uses an explicit writable **throwaway** connection; and diagnostic writes are
queued, so the proof awaits `waitForRustPasses` instead of assuming log completion
immediately after the SDK prompt. The final expected-safe failure is the real
wire-dispatch blocker, not either setup error.

Retained text evidence and temporary proof source under the throwaway root:
`oc1-host.log`, `review-windows.log`, `flush-unit-proof.log`,
`oc1-flush-wire-proof.log`, `candidate-units.log`, `pi-markers.log`,
`adapter-review-proofs.ts`, and `real-fence-proof.ts`. Only the report is committed;
no fixture database, source overlay, or generated bundle is delivered. No
production-guard mutation proof is claimed: the blocker proofs assert literal
safe wire/recovery outcomes and fail loudly against the unchanged candidate.
