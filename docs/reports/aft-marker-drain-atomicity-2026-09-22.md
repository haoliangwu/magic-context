# AFT compaction-marker drain incident — 2026-09-22

## Scope and live-store safety

This diagnosis used read-only queries against `context.db`, `store.db`, and `opencode.db`, plus the Magic Context log and provider dumps. No live store was modified.

Session: `ses_313660571ffeZTsf4koSJwk50Q` (OpenCode, Rust transform lane).

## Timeline

| UTC | Observation |
| --- | --- |
| 11:54:36.709 | Rust transform began the priced pass; the module received a two-message tail delta. |
| 11:54:37.140 | The host drain deleted the marker at ordinal 123404. |
| 11:54:37.273 | The independent injection transaction failed with `database is locked`, only 133 ms after deletion. This was not a five-second busy wait. |
| 11:54:37.372 | Pass completed `SOFT coverage_fold`, input 513, output 97, durable boundary 123814. The pending target was retained. |
| 11:55:00.553 | With no host marker, OpenCode supplied 12,746 messages. The module still served a defer (`SOFT+`) and retained the same provider-prefix bytes as the preceding pass. |
| 11:55:13.792–11:55:23.973 | The next 12,747-message pass materialized `HARD epoch_change`; its provider request was written at 11:55:29.581. The 4–16 second transform-to-request delay explains why a narrow/request-direction join reported `no_mc_pass_row`. |
| after 11:55 | The pending JSON remained `{ordinal:123814,endMessageId:msg_0c8826be3001m6ISRtRtN2LmcT}` while the persisted host-state pointer remained at ordinal 123404. Subsequent non-materializing passes did not call the old retry path. |

## Root cause

The old implementation split one logical host-store replacement across two SQLite transactions:

1. `applyDeferredCompactionMarker` and `updateCompactionMarkerAfterPublication` called `removeCompactionMarker`.
2. They then called `injectCompactionMarker`, which opened its own transaction.

A writer entering between those transactions could leave no marker. The 133 ms specimen interval is consistent with SQLite's WAL read-to-write upgrade `SQLITE_BUSY`, which can bypass the configured busy handler. The writable connection already installs `PRAGMA busy_timeout=5000` before WAL mode (`compaction-marker.ts`, `getWritableOpenCodeDb`); timeout configuration was not the missing protection. The missing protection was acquiring the write lock before the first deletion.

`replaceCompactionMarker` now wraps old-row deletion and deterministic new-row insertion in one `db.transaction(...).immediate()` (`packages/plugin/src/features/magic-context/compaction-marker.ts`). Both manager paths call it (`packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts`). A busy store therefore fails before deletion; any insertion/schema failure rolls the deletion back. Tests hold `BEGIN IMMEDIATE` on a second connection and inject an insertion trigger failure, proving the old rows remain in both deferred/Rust and direct/TypeScript paths.

## Retry and health behavior

`runRustModePostprocess` now attempts any retained pending target on every pass, with or without a new `materializedBoundary`. Frozen-LKG replay also performs the out-of-band host-store repair even though it deliberately skips message postprocessing (`rust-mode-transform.ts`). Target validation and CAS replacement/clear prevent an older drain from clearing a newer publication.

The pending JSON is backward-compatible and now optionally persists:

- `injectAttempts`
- `lastInjectError`
- `firstInjectFailedAt`

After three failures or five minutes from the first failure, status reports `MC-C11 compaction_marker_missing`, including attempt count and last error. The block is exposed in the OpenCode RPC status, the shared status view used by OpenCode 1/2 and Pi, and Pi's status detail. Success clears the pending blob, so health returns to null/zero on the next read.

The fixture performs four markerless defers and asserts one serialized output. A second fixture starts with the old persisted summary, fails once, then successfully injects the successor; provider serialization before and after repair is byte-identical. Marker repair changes future OpenCode input filtering, not the module's served provider bytes for an unchanged durable boundary.

## Why `epoch_change`

The raw input count is not part of Rust render identity. `render_identity_base` uses render config, provider, model, and (when not represented by prompt-surface identity) system-prompt hash. `m0_content_epoch_for_pass` folds workspace, upgrade, memory/compartment/profile/tagger/prompt-surface epochs, and `fold_mural_content_identity` adds the frozen mural content hash (`crates/mc-module/src/transform.rs`). No count, marker-presence bit, or raw-array-shape value is included.

The specimen confirms this directly: the first markerless 12,746-message pass was `SOFT+`, and its three provider-prefix blocks were byte-identical to the 513-message coverage-fold output. The later HARD changed the render identity's mural component: it replaced the stale frozen image with the durable project mural whose store `content_hash` is `2968692fda8986d691c132d0efe0bbcfa7ab51d5badefe5844eb658414056330`; the committed cache identity carries `mur:64:296869…`. It also recomposed m0 against the current compartment set. Therefore the raw-array expansion exposed the cost but did not itself enter identity, and no Rust identity change is required.

Operationally, an unexplained generic `epoch_change` adjacent to a 24.8× `oc_input` jump must still wake: the analyzer now reads Rust pass-log input counts, joins pre-send rows over the existing `request - 30 s`/`request + 5 s` window, and classifies an `epoch_change` with no restart/deploy/config epoch plus a ≥4× recent input step as unaccounted `self_inflicted_epoch`. The AFT fixture uses 513→12,747 and pass/request delays of 4 and 16 seconds.

## Recovery verdict

The historical live state still retains the ordinal-123814 target, which proves the retry intent survived. Under the old binary it only retries when a response supplies another materialized boundary; thus the expected restart HARD would retry it. Under this change it heals earlier: the first ordinary pass after deployment retries the target, atomically recreates the marker, clears pending state, and returns health to normal. A concurrent lock leaves the prior marker state intact and increments typed retry health rather than creating another markerless window.
