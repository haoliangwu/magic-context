# Issue 610: Rust idle refresh, aborted resend and late system identity

This follows the Rust verification gap in
[the TypeScript report](issue-610-idle-abort-system-hash.md). The module fix is
implemented in `ee3e59bd9f0d40f6b49eaa857bc1c1ce0debfc0c`; subsequent changes
repair the restart fixture and record verification. No database migration or
render epoch bump is required.

## Where the three rules live

1. **Served-response clock.** The OpenCode event handler already persists only
   served provider responses, including successful completions without usage,
   with failure precedence and a monotonic timestamp. `rust-mode-transform.ts`
   forwards that value as `prev_response_completed_at_ms`. Previously the module
   ignored it for scheduling and called `record_response_observation(now_ms())`
   after every local transform. That recorded request preparation, not a provider
   answer. `lib.rs` now constructs `ProducerContext.observed_last_response_at_ms`
   from the forwarded completion evidence and removes the local observation map
   and prepare-time write. Preparing or aborting a request cannot spend expiry.
2. **One head fold, independent cold-cache permission.** The scheduler retains
   its strict `elapsed > TTL` test. Both the full and additive-only transform
   paths request an idle HARD only when the served-response clock is newer than
   `ModuleMeta.expiry_cutoff_ms`, the existing last-HARD materialization clock.
   A still-expired retry retains independent reduction ride permission even
   though it needs no second head fold. A reductions-only retry can use SOFT
   without a history coverage anchor; reconcile and subagent fences remain.
   `mc-core::classify` remains the pure ordered classifier: the module supplies
   the consumed-fold HARD input and the narrowly scoped retry promotion.
3. **Adopt the external system identity, not a second fold.** The shared system
   hook adopts a late identity on the expired request in its durable cached
   marker. The Rust adapter now forwards the actual system hash, even after an
   omitted bootstrap hash, and separately forwards `adopted_system_prompt_hash`.
   When the hook follows messages, this durable acknowledgement reaches the
   module on its next invocation; it acknowledges the identity already served
   on the expired request, without rebuilding its head on that warm invocation.
   The module also adopts an early system-only change directly while expired.
   `can_adopt_system_identity` recomputes the comparison identity using only the
   previous system hash and requires exact equality with the frozen identity.
   Model, serializer, workspace, prompt-surface and renderer changes cannot be
   waived. Both `last_system_prompt_hash` and `last_render_config` are adopted;
   an acknowledged identity is not another cold-cache reduction permission.

An expired replay reports `ttl_idle` even with action `SOFT+`. The adapter maps
that request to `execute`, `materialized=0`, and binds its own assistant's row.
The action still accurately describes byte replay; scheduler attribution does
not pretend another materialization happened. Warm non-date content changes
without acknowledgement retain their existing HARD behavior.

The optional request field is backwards-compatible wire evidence, not a new
stored field. The four pinned constants remain **memory=3, compartment=2,
OpenCode profile=2, tagger=4**. Claude Code profile=3 and Pi profile=1 also remain
unchanged. No stores are migrated by this change.

## Exact request-byte scope

Relative to the old Rust path, the only byte-changing opportunities are:

* The **first genuinely expired request** may release the date and materialize
  its head. That request was already rebuilding the provider cache; its existing
  idle fold stays on that request.
* Its **still-expired resend after an abort** may release the date if the real
  observer did not run on the attempt, and apply work queued after the prepared
  fold. The provider has still not answered, so this resend is already a full
  provider-cache rebuild. The existing head is replayed, not folded twice. In
  the measured before/after drive, both resend payloads already contained Oct 03;
  the new reduction application moves to this cold request.
* The **next warm tool step loses the old delayed epoch HARD** and its reductions.
  It now appends to the resend prefix. This removes a paid warm rewrite; it does
  not introduce new warm mutations. Subsequent steps and the next user turn
  append the ordinary conversation tail.

Hash adoption and attribution are metadata changes. No ordinary warm-midnight
date release is added, and pressure-only execute is not proof of a cold cache.

## Real OpenCode 1.18.30 observations

Host **OpenCode 1.18.30**, **Bun 1.4.2**; an isolated Anthropic-compatible mock
reports 240,000 input tokens against a 1M window. Three substantial replies seed
history, followed by an idle attempt that is held and aborted, a revert, one
new queued drop, a resend with two actual bash calls, and a final reply.

The old module's process-local clock cannot be aged through the host database.
The abort scenario therefore uses an explicit **15s TTL and a real 16s idle
wait**, in addition to aging durable response/materialization clocks together
past UTC midnight. Ordinary expiry and midnight controls keep the 1h TTL. The
wrapper seeds the old identity before messages on both paths, skips the real
observer on the aborted attempt, and observes Oct 03 after resend messages.
Provider payloads, not reconstructed proxies, are compared. Only advancing
`cache_control` breakpoints are excluded from prefix equality; raw captures keep
those fields.

| Drive | Resend row | Step 2 fold | Message prefix retained, step 1 to step 2 |
| --- | --- | --- | --- |
| Rust before, continuous | defer, no reason | HARD / epoch_change | 131 / 2,456,297 bytes |
| Rust fixed, continuous | execute / ttl_idle, materialized=0 | none | 1,842,382 / 1,842,382 bytes |
| Rust fixed, restarted host and module | execute / ttl_idle, materialized=0 | none | 1,842,467 / 1,842,467 bytes |
| TS parity, continuous and restart | execute / ttl_idle, materialized=0 | none | 1,842,328 / 1,842,328 bytes |

Before, the two compared message-prefix SHA-256 values are
`b53e2b051d264328c3cfbf2401cdfaa5653710586395eec33d87fc4233da0652` and
`0492cb5a54674b48c4ef0616794aecb9aba88bd871d66b7562ef88f6ec22f841`.
The fixed continuous capture has
`ec78c90e09dc7aeed6c5c44dd7cebb31b5ced38a0e8d66126c5ef3618a15ec9e`
on both steps. Steps 2 to 3 and 3 to the next user turn also replay their whole
prior prefix, system and tool definitions. These independent captures measure
prefix preservation within each drive, not identical fixture sizes across runs
or real Anthropic billing/cache accounting.

The fixed module's `expiry_cutoff_ms` stays unchanged from the aborted prepared
fold through the final warm turn. Its frozen system hash adopts the actual late
Oct 03 identity, matching the host's persisted hash. All three returning Rust
steps have captured decision rows: `execute/ttl_idle`, then two ordinary defers.

The **normal warm-midnight control passes on both TS and Rust**: the host offers
Sat Oct 03, but the request still sends Fri Oct 02 with the full 412-byte previous
message prefix, system text and tools identical. The baseline Rust warm control
also passes. The genuinely expired midnight controls release Oct 03 on the
first rebuild and replay it on the next warm request.

The Rust host suite initially exposed a fixture defect: restart provisioning
discarded `existingEnv` and allocated new databases, losing the session. The
runner now starts the new daemon/module pair in the existing isolated root, and
the scenario asserts that root is unchanged. Both affected restart cases pass.
No pre-fix restarted-prefix result is claimed.

## Binary provenance and isolation

The before module reports
`ck-mc 0.1.0 (9304b7abf534dc5bd997c0f9b5cf5c2e7b4543c5)`.
The implementation module reports
`ck-mc 0.1.0 (ee3e59bd9f0d40f6b49eaa857bc1c1ce0debfc0c)`.
Both were built from this worktree with
`MC_BUILD_SHA=$(git rev-parse HEAD) cargo build --release -p mc-module` and
copied into the throwaway root before running the existing prebuilt-pair seam.

No daemon was built for the successful reproduction. With the parent's approval,
the daemon was copied from
`~/.local/share/cortexkit/staging/ck-subc.40918e8f` to
`$TMPDIR/magic-context/issue-610-rust/bin/ckdev-subc-issue610`.
Its actual `--version` is **ck-subc 0.20.51** (also the installed binary's version),
not the anticipated 0.20.53+. The copied binary's SHA-256 is
`6c1c995b42d6ce5fb50650eb383214043feff5f07e99e203d9d693b91375d94a`.
The real isolated route successfully serves this module. No live daemon or live
connection file was contacted.

Every host invocation exports throwaway `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
`XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB` and
`MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/issue-610-rust/`.
The OpenCode runner additionally isolates HOME. Captured `lsof -p <pid> -Fn`
inventories for host, module and daemon are checked by `assertOpenPaths`.
Every observed `.db`, WAL and SHM path is under its throwaway fixture root;
the host may also open an isolated ONNX runtime telemetry database there.
**No live store or live configuration was opened, read, written or migrated.**

Requests, clock evidence, module metadata, decisions, plugin logs and raw lsof
inventories are retained under the following absolute root on this machine:

`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-610-rust/`

Its `evidence-before`, `evidence-after`, `evidence-ts` and
`evidence-replay-mutation` directories contain the drives above. The `bin`
directory contains the isolated binary copies. No operator database is an input.

## Verification and non-vacuity

* `cargo test -p mc-module --lib`: **1,546 passed, 19 existing ignored, 0 failed**,
  cargo 1.99.0 / rustc 1.99.0. Includes the three new issue 610 tests, scheduler
  and TS/Rust differential goldens, additive-only replay, warm-content and
  unrelated-identity controls, and existing subagent/reconcile fences.
* Four impacted OpenCode unit files: **269 passed** with Bun 1.4.2. The adapter
  test verifies forwarded completion and both first and expired system identities;
  the telemetry test distinguishes expired replay from an ordinary warm defer.
* Plugin typecheck script: passed with TypeScript **5.9.3**. Compiler-API scope
  checks all three changed e2e files with **zero scoped diagnostics**; the e2e
  project still has **25 unrelated diagnostics**, not repaired here.
* Real OpenCode TS matrix: **7 passed**. Rust matrix: **5 passed initially**, then
  **both restart cases passed** after the fixture correction; the exact continuous
  abort/resend case passed again after restoring the replay mutation.
* Runner and mode-manifest units: **11 passed**. Manifest now includes the shared
  regression in the Rust lane (57 Rust files).
* `bun run build`: passed for the three distributions, including four v2 loader
  tests. `cargo fmt --check`: passed, rustfmt 1.10.0-stable. Stamped release module
  build: passed in 12m04s, without bypassing shared compile slots.

Two staged-live-state challenges used a nonempty mutation diff, the exact
`NON-VACUITY BREAK` marker, checkout/touch restoration and an empty final diff:

1. Ignoring the durable late acknowledgement reddened only
   `issue_610_expired_retry_replays_one_fold_and_adopts_only_the_late_system_identity`
   (`HARD` instead of `SOFT+`). The clock and queued-drop issue 610 tests stayed
   green. All three pass after restoration.
2. Mutating the actual next warm provider prefix in the host wrapper reddened
   only `an aborted idle attempt and late system change do not rewrite the next step without a host restart`,
   specifically at `assertReplay` (`identicalMessages=false`). The same real-host
   test passes after restoration. No mutation marker remains in implementation.

Earlier cold hermetic builds timed out at 1,800s before producing a pair. The
parent authorized the hydrated task target and then the staged daemon copy;
successful module builds used the shared compile slots normally. An optional
standalone `mc-core` test build also exhausted a combined command's timeout;
it was not retried. The final full module suite and release build both passed.

The existing three warm/threshold fixtures now supply explicit served-completion
evidence rather than depending on the deleted preparation clock. Their original
defer assertions are preserved. The TTL-observation fixture places its completion
after the previous materialization; its old in-process-only name was corrected
to describe the host-served-response contract.

## Reproduce

Build ck-mc once from the intended commit, stamp it, verify its version, and copy
the approved daemon binary to the task's throwaway `bin` directory. Then export
all isolation variables above and use the existing prebuilt-pair seam:

```sh
MC_E2E_MODE=rust \
MC_E2E_CK_MC_PREBUILT_BIN="$ROOT/bin/ckdev-mc-after" \
MC_E2E_CK_SUBC_BIN="$ROOT/bin/ckdev-subc-issue610" \
IDLE_TTL_EVIDENCE="$ROOT/evidence-after" \
timeout 420s bun test packages/e2e-tests/tests/idle-ttl-restart.test.ts
```

Here ROOT and TMPDIR are the throwaway task root, never a live CortexKit root.
`MC_E2E_MODE=ts` runs the paired TS controls. The four additional large-history
no-abort loops remain opt-in with `IDLE_TTL_LONG=1`; they were not needed for the
abort/resend and midnight proof. This delivery verifies the requested OpenCode 1
Rust lane, not new Rust real-host coverage for Pi, OMP or OpenCode 2.
