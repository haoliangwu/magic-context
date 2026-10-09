# Historian drop selection and writer hold

## Findings

The supplied mode-444 backup is 6,155,116,544 bytes. It was APFS-cloned into a
throwaway root before SQLite opened it; the backup was never opened by SQLite.
For `ses_114f158ccffet7znXAgI7lc3Kp`, the copy contains **66,536 tags**:
615 active, 2,719 compacted, and 63,202 dropped. Its last compartment ends at
ordinal **53,496**, earlier than the reported 54,427–54,524 publication.
There is no OpenCode raw-message database in the supplied backups (the other
file, `store.db`, is the ck-mc module store).

At the task's base, OpenCode already collects raw message/file/tool keys **before**
`beginSqliteWriterAsync`. Pi does the same before `BEGIN IMMEDIATE`, although Pi
collects keys from the beginning of the conversation rather than the incremental
chunk. Neither path awaits OpenCode/Pi raw-message reads inside publication.
However, `queueDropsForCompartmentalizedMessages` still loads **all active tags
for the session** inside the writer, then filters them in JavaScript to queue
only five drops. This makes writer duration depend on session size and page
residency, not on the number of drops.

The active-tag query is already indexed. No index or migration was added:

```sql
EXPLAIN QUERY PLAN
SELECT id, message_id, type, status, drop_mode, tool_name, input_byte_size,
       byte_size, reasoning_byte_size, session_id, tag_number, caveman_depth,
       tool_owner_message_id, token_count
FROM tags
WHERE session_id = ? AND status = 'active'
ORDER BY tag_number ASC, id ASC;
-- SEARCH tags USING INDEX idx_tags_active_session_tag_number (session_id=?)
```

On Bun 1.4.2 / SQLite 3.54.0, the initial diagnostic active-tag scan took
**71.62 ms**. The old queue, immediately following that diagnostic scan (so with
already-warmed pages), took **11.78 ms**, then **0.50–0.94 ms** on subsequent runs.
The five inserts themselves are not evidence of a five-second bottleneck.
The **5,029 ms live hold was not reproduced** on this older snapshot and runtime.
Without the matching OpenCode raw-store snapshot/deployed artifact, these data
cannot distinguish the original live stall's disk/page-cache behavior from a
different deployed implementation. The fix removes the remaining session-wide
selection from the writer regardless of that uncertainty.

## Change and measurements

OpenCode and Pi now prepare matching tag candidates before acquiring the writer.
Publication still atomically commits compartments, failure/boundary state, and
drop rows. Within the writer, each candidate uses one guarded `INSERT … SELECT`:

```sql
EXPLAIN QUERY PLAN
INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness)
SELECT session_id, tag_number, 'drop', ?, ? FROM tags
WHERE id = ? AND session_id = ? AND tag_number = ? AND message_id = ?
  AND type = ? AND tool_owner_message_id IS ? AND status = 'active';
-- SEARCH tags USING INTEGER PRIMARY KEY (rowid=?)
```

The fresh write-locked snapshot checks the row's primary key, session, public
tag number, source identifier, type, tool owner (including NULL), and active
status. A deleted/reinserted, retargeted, renumbered, consumed, or owner-adopted
candidate is skipped. Size-only updates remain eligible. New tags created while
waiting are not selected by this publication. Composite tool identity and the
legacy NULL-owner fallback remain unchanged; order and duplicate queue behavior
are preserved.

On a fresh clone, preparation took **23.96 ms** initially, then **0.39–0.75 ms**;
the candidate-only transaction took **2.48 ms** initially (including first
write/page setup), then **0.086–0.158 ms**. Legacy queue measurements in that same
probe are warm-cache controls, since preparation runs first.

The probe also executes the **real OpenCode historian publisher** with a synthetic
918-message provider, five existing active tag identities, one stored compartment,
and one stored event. A second provisional compartment supplies lookahead and is
discarded, ensuring the first compartment's event is actually publishable. It
appends range **53,497–53,594** on the copied store, disables fact
promotion, and stubs host marker injection and the producer transport. The actual
publication writer hold, from successful `BEGIN IMMEDIATE` through `COMMIT`, was
**35.32 ms**, below the 100 ms target. This is a controlled publication on the
supplied store, not a replay of the missing live raw transcript or a cold-cache
p90 guarantee. Transaction capture identifies the publication by its compartment
insert, separately from the runner's other metadata transactions, and asserts
one new compartment, exactly five added drops, and one added event.

The probe asserts `lsof -p <its pid>` isolation before and after publication. In
the final run (pid 15707), all `.db`, `-wal`, and `-shm` entries referred to the
same copy below
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/historian-publish-lock/event-probe/`.
No live store or user config was opened. Unit-test processes additionally used
the repository's storage-isolation preloads and a task-local `TMPDIR`.

### Repeat the probe

Use a **new** root for each publication run; the full-publisher portion commits
fixture rows to its copy. On macOS, `cp -c` clones the large backup without a long
physical copy. On other platforms, use a normal copy with a sufficient timeout.
From the repository root:

```sh
timeout 120s bash -c '
  set -e
  root="$TMPDIR/magic-context/historian-publish-probe-$$"
  mkdir -p "$root"/{data,config,state,runtime}
  root=$(cd "$root" && pwd -P)
  cp -c "$TMPDIR/magic-context/ckmc-perf/backups/context.db" "$root/context.db"
  chmod 600 "$root/context.db"
  export MAGIC_CONTEXT_STORAGE_DIR="$root"
  export XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config"
  export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime"
  export OPENCODE_DB="$root/opencode.db"
  bun packages/plugin/scripts/benchmark-compartment-drop-publish.ts "$root/context.db"
'
```

## Pi and ck-mc audit

Pi had the same in-writer active-tag selection and now uses the same prepared,
guarded queue path. Its raw-message selection remains outside publication;
changing Pi's prefix range/owner-pairing semantics is not required for this fix.
Explicit OpenCode recomp already queues drops post-publication, so its convenience
API remains available.

The Rust path is different and needed no edit:

- `crates/mc-module/src/historian.rs::publish_validated_chunk` constructs the
  compartment/fact/event payload before calling `publish_historian_chunk`.
- `mc-module`'s wrapup/reattach publication fences check an in-memory snapshot
  generation, not OpenCode storage, around that call.
- `crates/mc-store/src/lib.rs::publish_historian_chunk` reads the compartment
  generation/ranges and compresses transcripts before its store.db writer.
  Within the writer, it revalidates only selected messages using
  `(session_id, mid)` point reads of `mc_block_identities`.
- `context_writes.rs::apply_fold_tx` publishes compartments/facts/events and
  candidates in context.db. There is **no TS-style tag scan/drop queue** there.
  Its compartment upsert reads only sequences at/after the first incoming one.

## Regression evidence

The frozen-clock parity test compares serialized complete pending rows (including
ids, timestamps, harness, existing rows, and duplicates) to the previous queue,
and independently asserts the expected tag order. Concurrent-change coverage
checks all identity/status exclusions and rollback. End-to-end runner tests for
both hosts assert that tag selection and raw reads execute without a write
transaction, while queue inserts execute inside publication.

Mutation controls were staged before mutation and restored from the index:

| Control | Expected failing test | Other results |
| --- | --- | --- |
| Move OpenCode selection back inside publication | `OpenCode publish selects drop candidates and reads raw messages before taking the writer` | 15 passed, only this test failed |
| Move Pi selection back inside publication | `Pi publish selects drop candidates and reads raw messages before taking the writer` | 48 passed, only this test failed |
| Remove active-status revalidation | `revalidates candidate status and source identity after concurrent changes` | 5 passed, only this test failed; stale tags 1 and 2 appeared alongside 8 |

For every control, `git diff --stat` was non-empty while mutated and empty after
restore. No mutation was committed.
