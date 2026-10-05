# Repeated ALF full syncs: projection admission

## Cause and where the diagnostics went

The hypothesis is confirmed by the **module-owned fleet log**, not inferred
from the plugin's NEED_FULL_SYNC reason. The read-only log is:

```
~/.local/share/cortexkit/magic-context/logs/magic-context.2026-10-04.log
```

At 06:55:35.521Z it records ALF's rejected projection charge as **217,902,912
bytes (207.81 MiB)**, against a **201,326,592-byte (192 MiB)** entry ceiling.
At 06:55:50.522Z the charge is **217,911,888 bytes**. Both have
`previous_entry_kept=false`. The intervening misses say `reason=missing`, not
`revert_epoch`. Another session's projection occupied **76,636,051 bytes
(73.09 MiB)**. This explains the plugin's two full-sync retries quoted in the
incident: the successful transform never admitted its delta base.

`crates/mc-module/src/main.rs` installs `cortexkit_log::init_from_env()`. Its
normal sink is `<module data dir>/logs/<module>.<UTC date>.log`; the default
module data directory on this host is the path above. Tracing does **not** go
to the daemon's `subc.<date>.log`, or to its child-stderr capture, except for
logger fallback/write errors and independent stderr output. The old
`run/logs/magic-context.stderr.log` is therefore not the tracing destination.
The plugin's temporary `opencode/magic-context/magic-context.log` is a separate
log. The supplied Darwin temp path resolves to
`/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/` on this host.

The fleet logger defaults to **info**, controlled by **CK_LOG**, not RUST_LOG.
The live file contains these INFO events: they were not filtered. To see them,
read the module-owned daily segment. If a module is launched with a stricter
filter, give it `CK_LOG=magic-context=info` at spawn (preserving other fleet
directives as needed); changing a shell environment after launch does not
change the running subscriber. No live logging configuration was modified.

## Accounting and reproduction

`FlatProjection::retained_bytes` charges the retained flat blocks, typed wire
blocks and their original block JSON, identities, message metadata, boundary
states, vector capacities and allocation/node overhead. It does **not** charge
the complete request, message-level original JSON, or native sidecar trees.
The per-message charge memo contributes its vector storage, **not the sum of
the memo's numeric values**, to projection admission. That sum is separately
used to account request snapshots.

There really are multiple retained payload allocations. A deserialized block
has typed content and independent original JSON for lossless serialization;
the projector also retains canonical block bytes. Tool calls additionally
retain a cloned input. Removing original JSON without a lossless replacement
would risk changing provider/unknown fields. Boundary states in the current
projector are separately allocated for each message, not repeatedly charged
references to a single shared state. No accounting reduction is justified by
the inspected ownership model.

`alf_scale_projection_is_retained_and_next_pass_accepts_tail_delta` constructs
**9,268 messages / 30,000 canonical text blocks**, serializes and deserializes
the request through the production wire types, and measures:

```
request_wire_bytes=118842881
projection_byte_charge=211177800  # 201.39 MiB
```

The fixture is close to the live request's ~116 MB wire size; unlike the
frame-admission fixture, its bulk is canonical content, not native-only
padding. It verifies that the three payload buffers are distinct allocations
and that the charge includes their sum with bounded structural overhead. The
existing original-tool-input/frontier accounting and independent-cache charge
tests also pass. This is a synthetic reproduction, not a replay of ALF's tool
payloads or a claim to measure its exact allocator footprint.

Failing first on the 192 MiB ceiling: the test failed with **"ALF-size
projection must survive admission"**. Raising only the entry ceiling to
224 MiB then failed the added co-residency assertion: **"the measured
large-session working set must coexist rather than alternate evictions"**.
The final test admits a ~72 MiB neighbor and the large projection together,
with no full-request fallback snapshot. It then exercises the production
handler's tail-delta expansion, including native-prefix reattachment, and
proves incremental projection shares the retained prefix wire allocation.
It does not run a large tokenizer/transform over the transport; the ordinary
wire/transform path is covered by the real-module replay below.

## Bounded policy and memory projection

Use a **224 MiB entry ceiling / 320 MiB total projection budget**. The live
working set is ~**280.90 MiB**, so this admits ALF and the already resident
neighbor, with ~39 MiB total-budget headroom. A 224/256 policy would fix
admission but make these two sessions evict each other on alternating passes.
A compact lossless retained form is a larger serialization change; a measured,
bounded budget increase is the smaller urgent fix.

Native attachment and serialized-output budgets remain **256 MiB each**;
the explicit combined target becomes **832 MiB**, up from 768 MiB. The native
cache's existing oversized-delta-core exception and in-flight projection Arc
clones are unchanged; this is not a whole-process memory cap. The LRU still
evicts other sessions to meet its total budget. More/larger simultaneous
sessions can still cause cache churn.

The brief's earlier physical footprint was **1.3 GiB**. During this
investigation, `ck module status magic-context` reported PID **10900** at
**1.7 GiB physical footprint**, healthy, with no restarts. The new policy's
maximum ordinary cache target increases only **64 MiB**. At the actual
observed occupancy (73 MiB cached, ALF rejected), retaining ALF adds about
**208 MiB of stable projection allocations**. A simple additive estimate is
therefore **~1.9 GiB** against the 1.7 GiB observation (~1.5 GiB against the
earlier 1.3 GiB observation), before allocator reuse or avoided cold-request
peaks. This is a planning estimate, **not a post-deployment measurement**:
the old full-sync path already allocated that projection temporarily, and
warm deltas avoid repeatedly receiving/parsing the ~116 MB full request.
No production binary was placed or restarted by this change.

## Uncacheable sessions and fallback

Admission rejection now emits a **WARN once per session's bound lifetime**,
including session ID, charge, both budgets, whether an old entry survives,
and the explicit consequence/fallback. The warning survives LRU removal and
revert invalidation; the final route teardown clears its suppression record.
No message/tool contents are logged.

Above the ceiling, memory is still refused rather than admitted without a
bound. A matching ready full-request snapshot may recover the delta prefix;
otherwise the existing protocol returns NEED_FULL_SYNC and the adapter sends
a full request. If the full request also cannot be retained, subsequent passes
repeat that expensive fallback. The warning makes this state actionable
without changing successful output bytes or pretending a delta base exists.
It does not disable cache use for a session that later shrinks enough to fit.

The warn-only fleet-logger regression checks two sessions, repeated stores,
and suppression across a miss/revert lookup. A safe **NON-VACUITY BREAK**
downgrading only this event to INFO made
`projection_admission_rejection_warns_once_per_session_at_warn_level` fail
(0 warnings instead of 2); the four other selected projection tests stayed
green. The mutation was restored before verification/commit.

## Ordinary byte replay and verification

Before editing, the worktree's baseline `ck-mc --version` reported
`3e21492cc27bb9564376efdc23877291471ea4cf`. The existing
`rust-full-sync-frame-cap.test.ts` seeded **52 messages**, then served a full
request and **four distinct acknowledged tail deltas** through a real ck-mc
and hermetic ck-subc. After a locked release build of the candidate, the same
test and daemon repeated that replay. All five baseline and candidate hashes
of the complete serialized **CK + reassembled native output** were:

```
352ec3d5c89c0c35bfd41e44461bf36d2da5f81855aea4afbd9f1a31e20dfea3
```

Both runs: Bun 1.4.2, **1 passed, 0 failed, 38 assertions**. Distinct request
fingerprints prevent completed-page-response replay from answering the later
passes. This covers ordinary unchanged defers on that seeded OpenCode fixture,
not live ALF, arbitrary provider system/tools, or every compaction transition.
The prebuilt daemon was the same worktree-owned ck-subc 0.20.47 in both runs;
no deployed module or live store was used for execution.

Rust gates use Cargo/rustc 1.99.0 and clippy 0.1.99, with the checked-in
lockfile unchanged. Final gates:

- `cargo fmt --all --check`: passed (rustfmt 1.10.0).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed,
  all four workspace packages and their targets.
- `cargo test -p mc-module --locked -- --test-threads=1`: passed,
  **1,553 library tests + 24 binary/integration tests**, **22 ignored** in
  total; no failures. The existing opt-in/private-fixture tests remain ignored.
- `cargo build --release -p mc-module --bin ck-mc --locked`: passed, followed
  by the candidate real-module ordinary replay above.
- `git diff --check`: passed. Rust diagnostics for the changed source also
  reported no errors or warnings; Markdown has no diagnostic producer.

No migrations, store backups, live-store writes, or reads
under `~/.config` were needed. Architecture and structure documents are unchanged.
