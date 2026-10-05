# Session cleanup slicing: proposed reversible retirement protocol

Status: design only, not implemented or enabled by this release. Session cleanup and orphan sweeping retain their whole-transaction behavior. Short admission attempts do not make an admitted whole-session deletion short.

## Why row limits alone are unsafe

Deleting 25 tag rows, committing, and later cancelling a marker when the host session returns leaves a permanently partial request history. Checking the host before BEGIN also races restoration while writer admission waits. A harness-scoped completion must not consume another harness's Rust acknowledgement. Finally, an unmapped legacy FTS row remains owned text even when no ordinary locator remains. The durable queue alone provides neither reader isolation nor reversibility.

## Ownership and state machine

A separate schema/API change introduces an authoritative context-store manifest keyed by `(harness, session_id, generation)`, with an ownership token, revision, lifecycle state and optional deletion ID. Physical rows and cached requests must be associated with this ownership generation; shared session-ID-only rows need explicit owner references rather than an assumed single harness. The states are:

`active -> retiring -> retired`, with `retiring -> restoring -> active` for cancellation, and a separately authorized `retired -> purged` transition for irreversible disposal.

A short transaction publishes `retiring` and a durable deletion job together. Discovery may nominate a candidate but cannot authorize destruction. After writer admission, re-read the owning host's liveness and compare the manifest revision/token before publishing or moving rows. Missing host authority defers work. A changed revision cancels admission. This closes the deterministic admission-boundary race, but an external SQLite read is not a cross-database transaction: the generation/reader protocol, not the extra probe, supplies the safety boundary.

Host restore/open events and every request entry point call a single `ensureSessionGeneration` coordinator. They cannot reuse a retiring generation by bypassing the manifest. A live host while retirement is in progress requests restoration, fences further retire slices with a new revision, and leaves the session unavailable until restoration completes. A host restore after irreversible purge starts a new empty Magic Context generation rebuilt from authoritative host history; old drop/tag decisions are never mixed into it. This reset is an explicit API contract requiring review, not an assumption an orphan sweep may invent.

## Reader and writer contract

Every request-state reader, index/FTS search, LKG replay, historian, memory join, Rust module and cache must check the ownership generation. A retiring or retired generation is logically fully gone even while its physical rows remain. A restoring generation is unavailable, not partially readable: interactive turns must replay an independently valid request or refuse, never pass an inconsistent history. Cached fingerprints, prepared read results and last-good requests are fenced by manifest revision. No cache-only fast path may bypass retirement.

For multi-statement readers, use a read snapshot and capture the generation once. Before publishing a request derived from that snapshot, validate that its manifest revision is still active. Writes carry their expected generation/revision and fail or retry if it changed. Batch completion uses the same fence. SQL view filtering alone is insufficient when code accesses physical tables directly; inventory and migrate every TS/Rust reader before enabling slicing.

## Reversible slices and restoration

Do not destroy request state during cancellable retirement. Each slice atomically moves its bounded rows into a generation/deletion-ID-scoped quarantine and records their exact restoration representation. Preserve every column, primary key, ownership relation, binary value and dependency, not just tag counts. FTS text and its map are one owned unit; quarantine must retain the original source text and enough row identity to rebuild the paired locator safely. Bound both row count and copied bytes, including vector blobs, then yield. The deletion journal and manifest are never included in their own deletion table list.

If liveness returns after one slice, transition to restoring before another retire slice can commit. Restore quarantined rows in dependency-safe bounded batches, fenced by the new revision, while readers continue to see the whole generation unavailable. Resolve duplicate writes using the generation fence rather than overwriting newer active rows. Atomically expose active only after all moved rows are restored and validated; consume only this deletion job. Cancellation restores every original tag, including tags already moved by a committed slice, rather than merely forgetting that a subset is missing. A crash resumes either direction from the manifest and journal, never from absence of a pending marker.

Quarantine has a privacy/retention cost. Irreversible purge needs explicit owning-harness authorization or a separately approved grace/undo contract, and a final ownership/liveness validation. It cannot be justified by a single absence read. After authorization, bounded physical purge is safe because readers already see the entire retired generation as gone. Keep a compact generation tombstone long enough to reject late writers and stale Rust acknowledgements.

## Cross-harness and Rust completion

Deletion jobs and acknowledgements are keyed by owning harness, session, generation and deletion ID. Acknowledgement must match all four; an OpenCode slice cannot consume `pi:rust`. Retire only the exact job/marker that authorized the cleanup. Keep other owners' project coordinates and module-owned state until their own acknowledgements. Shared counters/data survive until the last owning generation retires. Rust workers must understand the manifest fence before TS batching ships; a late acknowledgement from generation N cannot unlock deletion of restored generation N+1.

## Legacy FTS and backfill

Completion proves that no owned physical text remains, not merely that mapped rows are gone. Either quarantine bounded legacy rowid ranges directly with verified ownership, or defer completion until the session's legacy range has been mapped and then retire those pairs. The backfill must consult retirement manifests so a yield cannot recreate a locator for tombstoned text after completion. Persist resumable progress for the legacy range. Missing provenance is a deferred/manual-repair state, not permission to delete another harness's data. Validate the actual FTS table, map, source and quarantine in the completion transaction.

## Acceptance criteria

Preserve the four cleanup fixtures archived in commit `8fb428d6fe86af1326a120751aeddd1ab1263985` in the separate implementation. Retrieve their source with `git show 8fb428d6fe86af1326a120751aeddd1ab1263985:packages/plugin/src/features/magic-context/issue-601-cleanup-review-r2.test.ts`. They are intentionally not added to this release branch. The following exact tests must become green without weakening their claims:

1. `restoring a live orphan after one slice must not leave a partially deleted tag history` — seed 60 tags, retire a 25-tag slice, and restore host liveness; after restoration, all 60 tags survive, not just the 35 never moved.
2. `resumed orphan cleanup must recheck host liveness after writer admission` — a restore inserted at the BEGIN boundary retains live state; no retire slice proceeds on the stale absence observation.
3. `OpenCode scoped cleanup must preserve Pi Rust acknowledgement and retry coordinates` — the Pi marker, project retry coordinates and module data remain until the matching Pi acknowledgement.
4. `cleanup must not declare completion while legacy unmapped FTS rows survive` — no orphan text or later resurrected map survives completion, including an upgrade with an unfinished locator backfill.

The fifth review test, `startup FTS map backfill must not synchronously wait for the production five-second timeout`, is implemented independently in the current release; it is not a cleanup-generation acceptance test.

Add tests that read via real TS/Rust/cache entry points between slices and during restoration; crash/reopen at each state transition; race writers and generation changes at admission; reject late acknowledgements; interleave legacy backfill; and prove exact byte/ownership restoration. Negative tests must neutralize manifest reader fencing and journal restoration independently. Measure each populated late-table/FTS/blob slice on a copied large store, alongside the contention harness (`packages/e2e-tests/scripts/issue-554-contention.ts`), which runs eleven real OpenCode hosts against one throwaway context database and probes admission, provider completion and health. The feature stays disabled until reader coverage and the irreversible restoration contract are reviewed.
