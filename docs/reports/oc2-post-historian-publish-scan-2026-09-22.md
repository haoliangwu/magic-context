# OpenCode 2 post-historian publish scan

## Culprit

The terminating 11 minute 50 second b-tree walk was the drop-key preparation in
`runCompartmentAgent`, not historian parsing or the compartment transaction. After
validation, the incremental runner called:

```text
getRawSessionTagKeysThrough(sessionId, lastCompartmentEnd, { db })
```

`getRawSessionTagKeysThrough` initialized its page cursor at ordinal 0. On the
reported pass that meant reading and decoding ordinals 1-135089 even though the 13
new compartments covered only 134716-135089. Its 32-row pages called the OpenCode 2
provider's `readPage` once per page. The provider opened a fresh `V2StoreReader` for
each call, so the pass issued about 4,222 page queries and decoded the entire
135K-message prefix before the first transaction log (`stored 4 compartment
event(s)`). The eventual `queued 79 drops for messages 0-135089` line exposed the
same erroneous prefix.

The fix passes the incremental `offset` as `fromMessageIndex`, so drop-key
preparation reads only the newly compartmentalized range. The queue log now reports
the actual range. Boundary validation also uses an id-existence query instead of
computing each endpoint's absolute ordinal, avoiding a prefix `COUNT` for every
new compartment.

## Query and plan

The bounded provider executes `V2_MESSAGE_PAGE_SQL`. On a generated 10,000-row
OpenCode 2 fixture with the host's indexes, `EXPLAIN QUERY PLAN` reported:

```text
SEARCH session_message USING INDEX session_message_session_seq_idx (session_id=?)
SEARCH session_message USING INDEX session_message_session_seq_idx (session_id=?)
SEARCH session_message USING INDEX session_message_session_seq_idx (session_id=?)
```

The remaining plan steps were the constant-row `bounds` coroutine and `SCAN bounds`;
there was no `SCAN session_message`. The direct boundary query is:

```sql
SELECT 1 FROM session_message
WHERE id = ? AND session_id = ? AND type IN (?, ?, ?, ?, ?, ?)
LIMIT 1
```

It is keyed by the `id` primary key. All other OpenCode 2 publish-provider reads are
page/count operations keyed by `(session_id, seq)` or `(session_id, type, seq)`, or
single-id reads.

## Generated-fixture measurements

The red-first 10,000-row fixture used a newly published range of 9901-10000 and the
production 32-row drop-key page size.

| implementation | page calls | JSON rows decoded | wall time |
| --- | ---: | ---: | ---: |
| prefix cursor restored (`afterOrdinal = 0`) | 313 | 10,000 | 550.33 ms |
| bounded cursor (`fromMessageIndex = 9901`) | 4 | 100 | 12.531 ms |

Wall time is diagnostic rather than an assertion; the regression tests assert page
calls and decoded rows. The full runner test publishes 9901-9950 in a 10,000-row
fixture and asserts at most 110 decoded rows, no `history` operation, direct-id
boundary checks, and a final open-reader count of zero.

## Reader-handle audit

- Every method created by `createV2RawMessageReader` closes its reader in `finally`.
- `context.ts` direct readers for usage, host compaction, and context folding close
  in `finally`.
- `hidden-completion.ts` centralizes polling reads in `withReader`, whose `finally`
  closes on success, early return, and throw.
- Constructor generation-check failures close before propagating.
- The defect was a per-page opener inside a whole-prefix loop, not a missing source
  `finally`. Bounding the loop removes thousands of rapid reader lifecycles.
- Debug counters now track opened, closed, current, and maximum readers. A complete
  v2 historian publication over the generated fixture asserts `openReaders === 0`,
  `readersOpened === readersClosed`, and `maxOpenReaders === 1`.

The OpenCode 2 context provider now implements a mandatory bounded contract. It has
no full-history method. The only exported full read is
`readAllV2RawMessagesForConversion`, used for coordinate conversion. FTS
reconciliation receives the bounded page/count source and cannot fall through to
`V2StoreReader.history()`.

## Publish-path observability

The runner emits start and completion lines with elapsed milliseconds for:

- `parse`
- `validate`
- `dangling-boundary-check`
- `post-publish-drops` (including bounded raw-key preparation)
- `publish-txn`
- `embeddings`

A stage start is logged before work begins, so a stall identifies the active stage.
Discarded validated output logs an explicit reason for no progress, missing/lost
lease, or a dangling raw boundary. Successful publication ends with a range and
compartment count.

## Isolation

All reproduction and plan work used generated rows under throwaway roots beneath
`$TMPDIR/magic-context/`. The OpenCode 2 harness independently checks the spawned
host with `lsof` at startup and shutdown and rejects any database path outside its
throwaway root. No live OpenCode, CortexKit, or configuration store was opened.

## Gates

- `packages/plugin: bun run typecheck` — passed.
- `packages/plugin: bun run lint` — passed.
- `packages/plugin: bun run test` — passed (5,313 passed, 1 skipped, 0 failed).
- Focused OpenCode 2 source lane (`store-reader`, adapter contracts, v2 prompt/model seams,
  bounded reconciliation, and full post-historian runner publication) — passed.
- OpenCode 1 TypeScript pure replay, base `bbdf4c56943006d23ac7e2607754e1593f47f021`
  versus the implementation — `RESULT IDENTICAL defer_passes=4`.
- Full real-host OpenCode 2 lane was attempted under the harness's throwaway roots. Its
  source-level tests passed, but host cases could not activate because this isolated
  worktree intentionally had no `dist/index.js`; creating it would require the forbidden
  distribution build. The lane reported 31 passed and 34 failures, dominated by plugin
  activation timeouts and an explicit missing-distribution prerequisite.
