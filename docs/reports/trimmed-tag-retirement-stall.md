# Trimmed-message tag retirement stall

## Reproduction and timings

The October 3 log confirms SUBC's `pp.placeholderNeutralize` stalled immediately
after placeholder persistence: 280,199.4 ms at 13:40:19Z and 319,327.1 ms at
18:44:30Z, with foreground writer holds of 280,130 and 319,324 ms respectively.
The latter pass began with 4,625 host messages and consumed deferred history.
The log was only read, never modified.

All database measurements used disposable, read-only-source SQLite backups under
`$TMPDIR/magic-context/trim-stall/`; no live connection was migrated or modified.
There was 271 GiB free before the 7.56 GB context backup. The first snapshot had
99,629 SUBC tags: 491 active, 91,409 dropped, 7,729 compacted.

The stored native marker's ordinal was 82,769; the cached baseline end was
`msg_101b473d0001wo4jRnxS8SQR9l`, ordinal 86,964. Reconstructing the source window
from `message_history_source` gives **4,196 source ids** through that boundary.
The stored compartment has no `end_block_index`, so the initial prepare includes
the boundary message. This is a reconstruction, not an instrumented count of the
historical host array: any host-only synthetic marker ids are not represented in
the context source ledger. Attempts to back up the host `opencode.db` and
`opencode2.db` yielded empty copies, so they could not refine that distinction.

The initial exploratory legacy run mistakenly excluded the whole-message end:
**4,195 ids took 587,345.5 ms and changed 146 rows** on the context copy. Applying
the omitted final id with the same legacy SQL then took 5,022.5 ms and changed
two more rows. The separate last-id run was cold; these are not claimed as one
contiguous 4,196-id transaction timing. Even the 4,195-id run alone reproduces
the multi-minute stall and already bounds its scale.

On a fresh context backup, the final implementation processed all **4,196 ids in
97.4 ms**, changed **148 rows**, and used three transactions with a measured
maximum writer hold of **12.6 ms** (including commit). Immediate idempotent replay
took **74.0 ms**, changed zero rows, and acquired no writer transaction.
Warm exploratory timings were 74–84 ms with SQLite candidate filtering. Cold
exploratory reads also reached 2.3–3.1 seconds; after the final build/full suite,
one replay read took **26.7 seconds**, still with zero writer transactions.
Disk/cache state can still dominate a synchronous read, but that read holds
**no writer lock**. The sub-100-ms result
is a measured result, not a guarantee against cold storage or arbitrary triggers.

Tools: Bun 1.4.2; sqlite3 3.54.0. The checked-in
`packages/plugin/scripts/benchmark-trim-tags.ts` rejects paths outside the
disposable backup directory. Run it with a copy path and optionally `--legacy`,
`--boundary-only`, or `TRIM_PLAN=1`. It deliberately does not initialize/migrate
the copy. All measurement copies were deleted after verification.

## Mechanism and change

The old UPDATE's plan was `SEARCH tags USING INDEX idx_tags_session_message_id
(session_id=?)`: neither the message-id equality nor the owner equality bounded
the search because they were ORed with default case-insensitive LIKE. Deduplicating
the input ids did not prevent about 4,200 scans of almost 100,000 rows.

The new read materializes the input ids once with `json_each`, builds SQLite IN
sets, and traverses the session once using the existing session/tag-number index.
Its plan has one `SEARCH tags ... (session_id=?)`, one `MATERIALIZE ids`, and four
list subqueries over that materialization, not correlated per-id tag scans.
Ordinary unmatched rows never cross into JavaScript. The general matcher retains
ASCII-only LIKE folding, escaped literal `%`, `_`, and backslash, arbitrary `:p%`
and `:file%` suffixes, nested delimiters, NULLs, and NUL terminators. It does not
add Pi's `:mc-text-v1:` form to retirement. Exact ids and owners stay case-sensitive.

Matching rows are updated by INTEGER PRIMARY KEY outside the discovery read,
at most 128 rows or eight milliseconds of work per transaction. Identity and
status are rechecked under the lock, and RETURNING counts only top-level rows,
not trigger writes. Interruption between batches leaves only valid compacted
states; retry safely finishes the remainder. No schema/index migration is needed.

### Why only some passes

`transform.ts` captures `messagesBeforeInitialPrepare` only when both
`isCacheBusting` and `deferredHistoryWasPendingAtPassStart` hold. It passes the
trimmed slice only on those history-consumption passes. Compaction-off skips the
operation, and ordinary defer/cache replay passes pass no trimmed ids at all.
The caller already drains the one-shot history refresh. A newer deferred
publication can replay the same covered ids; permanently memoizing those ids
would incorrectly miss later re-tagged/re-keyed source rows. The implementation
therefore avoids all writes for previously compacted rows rather than keeping an
unsafe id-only cache. Zero matches now mean a read and no BEGIN IMMEDIATE.

## Tests and byte identity

`retires 100k tags with 4000 trimmed ids within two seconds` was run **before**
changing production code. It reached the exact expected count (5,333) and full
100,000-row state comparison, then failed its timing assertion at 32,438.6 ms.
With the fix it took 35–75 ms in focused runs. The expected full-state vector is
the one verified on that identical fixture with the old implementation, not a
value generated using the new matcher. A separate semantic fixture compares
the new function directly with the frozen legacy SQL, including nonstandard ids.

`sends byte-identical postprocess output with linear and legacy trimmed-tag
retirement` runs a priced postprocess pass on two independently seeded stores.
One runs the real new function; the other substitutes and observes the old SQL
function. Both demonstrably retire the two trimmed tags and retain the served
tail tag. Their complete final message-array UTF-8 bytes are identical; visible
answer bytes remain, and archived bytes are absent. This is a focused transform
proof of identical adapter input, not a captured network request.

Separate mutation checks disabled the identity fence and raised the batch cap;
only the respectively named retarget and interrupted-batch tests failed. The
mutants were restored before the final gates. The delivery declaration records
the exact failures and staged-state restore evidence.

## Twins and other call sites

Plans below were obtained on the copied schema. No other per-id OR/LIKE tag loop
on a foreground path accepting a bulk list was found.

| Site | Plan / upper id count per invocation | Disposition |
| --- | --- | --- |
| `markTagsCompactedByMessageIds` | Former session-only message index, arbitrary iterable (4,196 reconstructed here; regression 4,000) | Fixed: one discovery scan, bounded primary-key writes. |
| `deleteTagsByMessageId` SELECT | Session/tag-number index `(session_id=?)`; exact / `:p%` / `:file%` / `:mc-text-v1:%` OR | One id, only production caller is `cleanupRemovedMessageState` for one `message.removed` event. No bulk loop. |
| `deleteTagsByMessageId` DELETE | Covering session/message index `(session_id=?)` | Same one-id event. Retains existing atomic cleanup/rollback contract. |
| Deletion's owner SELECT / DELETE | `idx_tags_pi_fallback_tool_owner (session_id=? AND tool_owner_message_id=?)`; SELECT sorts in a temp B-tree | One indexed owner id, not a session scan per trimmed id. |
| `markWhitespaceAssistantTagInert` NOT LIKE guard | Unique session/tag-number index `(session_id=? AND tag_number=?)` | One indexed tag per call, even if the caller visits thousands. |
| `hasPiFallbackMessageTags` / `hasPiFallbackToolOwnerTags` / `findPiFallbackToolOwnerTags` | Session-only scan with a fixed `pi-msg-%` pattern | One gate/collection read per invocation, not one scan per message. |
| `findAdoptableFallbackTags` | `idx_tags_pi_adopt (session_id=? AND entry_fingerprint=?)`, residual LIKE | May probe thousands of visible entries, but indexed by fingerprint, not a whole-session scan. Adoption writes are indexed by tag number. |
| `foldShrunkMessagePartTags` | One `readPartTagRowsByMessage` session scan; then tag-number keyed writes | Already avoids per-message LIKE scans. |
| `deriveTaggerFloor` | Session/message range `(session_id=? AND message_id>? AND message_id<?)` | At most 64 probes, no OR/LIKE scan. |

Pi shares this storage implementation but does not call trimmed-id retirement:
`trimPiMessagesToCachedBoundary` and the injection trim splice message arrays and
update boundary metadata, not tags per trimmed id. Its fallback adoption queries
are listed above. No Pi edit is needed for this mechanism.

Rust uses `mc_tags`, coverage ordinals, and in-memory red-unit survivor/prune
operations (`surviving_red_units`, `prune_covered_red_units`), not the TypeScript
`tags` OR/LIKE per-id update. Searches of `crates/` found no corresponding
trimmed-message SQL scan. No Rust edit or native rebuild is needed.
