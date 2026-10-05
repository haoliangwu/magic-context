# TypeScript per-pass latency: measured fixes and remaining uncertainty

## Evidence and isolation

Only the two supplied Magic Context log files were read. No live database,
session file, Pi directory, or user configuration was opened, copied, migrated,
or modified. Reproductions use synthetic in-memory databases and source archives
under `$TMPDIR/magic-context/ts-pass-latency-bg36/`. The baseline source is
`f0fc1e21b4a4e6dd7a706d888355d652f474188a`; dependencies are symlinked from this
worktree, not from the operator's checkout. No dependency versions changed.

The logs grew during the investigation. The read-only sample contained 30 SUBC
passes after 15:30Z and 88 ANTAUTH passes after 15:00Z. Median / p90 / maximum,
milliseconds:

| Session / stage | Median | p90 | Maximum |
|---|---:|---:|---:|
| SUBC entry projection | 525.95 | 719.2 | 837.6 |
| SUBC compartment phase | 0 | 992.1 | 1390.4 |
| SUBC whole pass | 814.3 | 1696.7 | 2427.3 |
| ANTAUTH pipeline | 242.9 | 584.5 | 2108.0 |
| ANTAUTH tag snapshot | 107.7 | 155.5 | 195.1 |
| ANTAUTH fallback identity/adoption | 45.35 | 98.8 | 1787.3 |
| ANTAUTH post-transform | 34.85 | 70.9 | 4197.5 |
| ANTAUTH whole pass | 439.55 | 967.1 | 6526.1 |

These are overlapping stages, not additive totals.

## OpenCode projection

The earlier optimization is `a07326e1d9` (`createLkgEntryProjector`), documented in
`per-pass-entry-mural-costs-2026-10-01.md`. It retains exact tokens, but its reuse
stops at the **first** changed entry. It also discards **all** retention when the
session exceeds 64 MiB. Either condition makes every following entry pay SHA-256
again. A head trim also fails its position-aligned prefix comparison.

The live stage input is **5,176–5,210 messages**, not the roughly 460 messages
eventually served. For example, 15:54:06.786Z reports `messages=5176`, followed
by 493.6 ms of projection. The projection runs before history trimming. Thus a
restored, large pre-trim graph is relevant even when the served request is small.

The projector now retains individually bounded, session-local entries keyed by
message ID, and verifies every exact typed field before borrowing that entry's
digest. IDs alone never authorize reuse. Changing or moving the first message
does not invalidate independent digests for unchanged successors. Oversized
sessions retain the entries that fit instead of losing the entire cache. The
64 MiB total and 16-session eviction limits remain; digest/entry overhead is also
charged. Cyclic/unprojectable entries retain the full-hash/null fallback.

**The logs do not identify SUBC's actual first differing field, retained size,
or eviction event.** Neither a backup-restoration bug nor a specific changing
watermark is established by this evidence. The changes repair all three concrete
reuse failures above, but are not proof of which one SUBC exercised. The live
stage now logs `reused`, `retained`, and `retainedBytes`. A subsequent deployed
sample is needed to confirm the live improvement and diagnose remaining eviction
or oversized-entry misses. This report does not claim an observed live speedup.

## OpenCode compartment spikes

At 16:01:30.679Z the phase starts a historian after a commit-cluster trigger;
the phase takes 949.7 ms before the child-session log at 16:01:31.946Z. Later,
16:02:50, 16:03:01, and 16:05:13–33 starts end with
`historian skip: internal drain budget spent (192000/192000 tokens; resets in …)`.
Those phases cost 992.1, 1005.4, 894.8, 984.2, and 1390.4 ms. They are synchronous
historian startup/no-op work, not a one-second wait for historian completion on
every defer pass. Passes that do not start a run stay at approximately zero.

The runner validates stored compartments and the raw boundary, builds/fits the
fixed prompt, and only then reserves the drain budget. Moving quota admission
ahead of validation would suppress existing errors/notices and change durable
state ordering, so that was not done. The deterministic fixed-prompt token count
is now cached by **exact prompt text and active tokenizer identity**, bounded to
64 entries / 8 MiB. The fit, seeds, memory ordering, calibration, admission,
validation, and quota gates still execute normally. Tokenizer fallback cannot
borrow a count from the former tokenizer. This removes repeated fixed-prompt BPE
work on quota-skipped attempts without changing those decisions.

The logs do not subdivide that startup second. The prompt-fit reproduction below
proves an avoidable component, not that it accounts for or eliminates the whole
live spike. Raw boundary validation, stored-gap inspection, SQLite/lease work,
and contention remain possible contributors; their live shares are unmeasured.

## Pi costs

### Tag snapshot / pipeline

The old reader caches only while its connection-local revision and SQLite
`data_version` remain unchanged. Live `all=` increases on append passes
(45,737 → 45,739 at 15:25–26Z), so tagging invalidates it before the snapshot
read. The earlier ~3 ms result concerned unchanged repeated passes; it did not
defend the ordinary append path. Every append reloaded and converted all ~45,000
rows, even with only ~2,400 active tags.

TEMP triggers now journal changed tag numbers for the reader's at most 100
watched sessions. Local writes reload only those numbers and merge them in the
original `(tag_number, id)` order, including legacy duplicate numbers. Both sides
of renumbers/session moves, deletes, and direct SQL updates are observed. Reads
inside transactions bypass publication/consumption of the journal, preserving
rollback semantics. External commits still force the authoritative full reload;
`data_version` was not weakened or ignored. Cached records still return detached
shallow copies. Connection reuse replaces the older revision-only TEMP trigger
bodies; duplicate journal keys cannot conflict with an outer `UPDATE OR ABORT`.
No durable schema or tag write policy changed.

The pipeline contains this snapshot stage, fallback adoption, tagging, persisted
replay, injection, and accounting. Reducing the first two does not make the whole
pipeline constant-time, nor establish the latency of the live disk-backed store.

### Fallback identity/adoption

Any old `pi-msg-*` row keeps the fallback preflight positive, even if no currently
visible entry can match it. The previous path then probed each visible real
fingerprint individually; a successful preflight could repeat those reads in the
writer transaction. With ~869 visible entries this is hundreds of SQLite calls
per pass, not merely adoption of the new tail.

Existence probing is now batched at 900 fingerprints. After writer admission a
fresh batch read identifies which fingerprints can match; only those take the
existing sequential candidate lookup/migration path. Uniqueness, collision
folding, alias rebinding, pending-op retargeting, stale-negative re-probing, and
the compare-and-swap migration checks are unchanged. Fingerprint construction
still happens when required. The 1.787 s live maximum is not independently
attributed to hashing versus SQL/lock/GC time by the deployed stage lines.

### Post-transform

The 15:25:51.801Z 4197.5 ms phase contains **4175.4 ms of auto-search**, ending
with its existing timeout/skip decision. Ordinary post-transform cost is mostly
Channel-1/2 accounting: its median in the sampled log is 28.7 ms, versus 34.85 ms
for the phase. Neither moving search after serving nor changing accounting gates
would preserve the requested behavior. Those paths were not edited. Synchronous
SQL can still starve the search timer beyond its nominal 3000 ms deadline; the
existing elapsed-result guards remain unchanged. No arbitrary timeout, search
result, fold, or mutation-permission change is included.

## Reproduction and timings

`packages/e2e-tests/scripts/ts-pass-latency.ts` accepts a source root and output
directory, or two capture directories to compare. It reads no session fixture or
database seed. Capture runs six passes through each real host transform, with
fresh cloned graphs. OpenCode has a 5,176-message graph and a synthetic stored
compartment covering the first 4,716 messages: served arrays contain 456–461
messages. Pi starts with 45,737 tag rows (2,410 active), an orphan fallback, and
869–879 visible inputs. Pi failure-open returns are rejected by the runner.
Search/historian network calls are disabled; time is fixed for deterministic
synthetic wire fields, while durations use `performance.now()`.

Example, after extracting the baseline source and linking the worktree's existing
dependencies into that throwaway source tree:

```sh
ROOT="$TMPDIR/magic-context/ts-pass-latency-bg36"
bun packages/e2e-tests/scripts/ts-pass-latency.ts capture \
  "$ROOT/before-source" "$ROOT/verified-before"
bun packages/e2e-tests/scripts/ts-pass-latency.ts capture \
  "$PWD" "$ROOT/final-hardened-after"
bun packages/e2e-tests/scripts/ts-pass-latency.ts compare \
  "$ROOT/verified-before" "$ROOT/final-hardened-after"
```

Recorded baseline and final captures, warm medians over passes 2–6, milliseconds. Fixture construction and
cloning are outside the isolated projection timers:

| Synthetic operation | Before | After |
|---|---:|---:|
| Projection with one leading metadata edit per pass | 842.632 | 34.896 |
| Projection with two leading entries trimmed per pass | 832.913 | 33.344 |
| Projection with strings exceeding the retention budget | 138.862 | 29.271 |
| Identical fixed historian prompt fit (318 memory lines) | 13.564 | 1.077 |
| 45k-tag snapshot after each local append, isolated | 27.253 | 1.183 |
| 869-fingerprint orphan adoption, isolated | 11.981 | 0.449 |
| Pi real-handler snapshot stage | 24.219 | 2.578 |
| Pi real-handler fallback stage | 9.308 | 0.957 |
| Pi real-handler pipeline | 67.037 | 17.803 |
| Pi real-handler post-transform (unchanged code) | 17.460 | 7.335 |
| Pi real-handler total | 91.769 | 26.601 |

These are synthetic captures, not a statistical fleet-speedup claim. The final
arm was taken later, after TEMP-trigger hardening. Shared-machine load moved an
earlier leading-edit pair from 686.554/34.112 ms to 842.632/75.000 ms; the final
after arm returned to 34.896 ms. The unchanged post-transform stage also moved
substantially, so the apparent end-to-end improvement cannot all be assigned to
the edits. Cold work remains expensive. On the final warm
leading-edit pass, 5,175 of 5,176 digests were reused, retaining 51,324,408 estimated
bytes. The oversized case retained 3,937 entries (67,101,720 bytes, below 64 MiB),
reusing 3,936 after a leading edit; the uncached remainder still hashes normally.

## Byte identity and non-vacuity

All **12/12 exact `JSON.stringify` served arrays** matched between baseline and
final source. This equivalent differential compares the actual transform returns
as byte buffers, with no canonicalization or shared expected-value algorithm.
It is a deterministic host-hook proof, not a remote-provider/search or live-store
replay. Full existing host suites also retain their byte-stability assertions.

A staged `NON-VACUITY BREAK` changed the final text of the first synthetic
OpenCode request by one ASCII byte in **production `transform.ts`**, not in the
comparator or fixture. The comparator failed at `opencode served bytes pass 0`
(932,138 versus 932,139 bytes). The other five OpenCode and six Pi arrays remained
identical. Restoring from the index left an empty working diff; the 12-array
comparison passed again. Separate staged controls reddened the leading-edit,
head-trim, over-budget-retention, append-snapshot, fixed-prompt-token, and
positive-adoption cost regressions. Exact names and mutation evidence accompany
the delivery record. No mutation is present in the committed tree.

The final full plugin suite passed 6,735 tests (four skips). The first full Pi
suite passed 1,496 tests (three skips). After adding the TEMP-trigger regression,
the full Pi run passed 1,496 tests with three skips and one unrelated failure:
`a production-timeout busy turn ignores different-model usage and replays` had
its lock-holder subprocess exit 1 before obtaining the lock. The entire untouched
writer/subprocess suite then passed all eight tests in isolation, including that
case. No test contract was rewritten. All task-specific regressions passed.

Workspace typecheck/lint/build, final Pi typecheck/lint/build, and a strict
standalone typecheck/lint of the new replay script passed. Existing unrelated
lint warnings were left untouched. The test scripts' frozen-lockfile installs
made no changes.

## Follow-up required to establish the live SUBC root

Deploy the added projection counters and inspect SUBC's next stage lines: retained
count/size distinguish capacity rejection; reused count distinguishes successful
reuse from continuing input drift or eviction. The permitted log evidence here
does not expose the pristine input needed to name a changing field or prove that
the 2026-10-01 restoration caused it. Likewise, subdivided historian-startup timing
is needed before attributing the residual one-second quota-skipped startup.
