# B2 migration lost TypeScript-written history (SUBC session)

2026-09-30. Session `ses_12a4fa38dffe81Fz7Y2AsWb5Cg` (project `git:18e126e49bd12139fdf9c8b832e081e832ab0d9f`, subconscious) lost its compartments from sequence 707 on (July 26 to September 30) in the single-store migration. This report covers the rule that did it, the fix, the repair tool for stores that were already migrated, a rehearsal of both on APFS clones of the live stores and the real backup, and an audit of the "gaps" found in fleet sessions.

Nothing here was run against the live stores or the backup. Every run used `cp -c` clones under `$TMPDIR/magic-context/b2-repair/`. `lsof` on each clone directory showed no holders, and the host probe checked its own open files against the live roots (`forbidden: []`).

## 1. The rule that picked store.db

In `crates/mc-module/src/single_store_migrate.rs` at the base commit `282445ee`:

- The loop at lines 3040-3057 calls `copy_session` for every session that has rows in `store.db`'s `mc_compartments`, `mc_compartment_events` or `mc_user_memory_candidates`. It skips a session only when its project was skipped as foreign. It never looks at the per-project decision that `classify_projects` makes for memories and notes.
- `copy_session` (doc at 1849-1853: "The store wins") deletes every `context.db` compartment above the store's last sequence (line 1932, `DELETE FROM ctx.compartments WHERE session_id = ?1 AND sequence > ?2`). It then rewrites every other compartment to the store's values in place. Context events and candidates that point at the trimmed or rewritten sequences are deleted as "superseded".

So any session present in `store.db` was treated as module-authoritative, whatever mode its project was in and whichever copy was newer. The SUBC project has no `mc_authority` rows and no `authority_managed` row, so for memories it was already classified TypeScript-owned. The session history ignored that.

What the backup shows for the session:

| | rows | sequences | last message | newest `created_at` |
|---|---|---|---|---|
| backup `context.db` `compartments` | 1,255 | 0-1254 | 82,880 | 2026-09-30 12:16 |
| backup `store.db` `mc_compartments` | 707 | 0-706 | 24,296 | 2026-07-22 20:32 |

The two copies agree on sequences 0-648. From 649 on they differ. TypeScript re-summarised 649-706 from 2026-07-22 21:45 on, which is after the store's last write, and those rows reach message 28,742 where the store's stop at 24,296. The migration kept the store's 649-706 and deleted 707-1254.

## 2. The fix: keep the copy that was being written

`decide_history` in `single_store_migrate.rs` compares the two copies per session. A row "matches" when the same sequence holds the same content fields; message coordinates are left out because the host and the module spell the same boundary differently.

1. **Identical:** nothing to decide. The session is not reported.
2. **One copy holds every row of the other, unchanged, plus more (a superset):** that copy is kept, whatever the project's mode. Keeping it loses nothing. This covers ALF's stalled mirror (store ahead) and a project that went back to TypeScript before TypeScript rewrote anything (context ahead).
3. **Both copies have rows the other lacks:** the copy whose differing rows are newer (`created_at`) wins, if the project's owner at migration time agrees. With no known owner (a session no host attributes), it wins only if it also reaches at least as far (highest end ordinal). Equal timestamps (the mirror copied them) fall back to the owner. That is the pre-existing fixture shape, where a module-owned store rewrote a row.
4. **Anything else is refused** with `single_store_history_diverged`, naming the session, both copies' counts, newest change and reach, and the flags `--prefer-history <session>=store|context`.

When `context.db` wins, `keep_context_history` changes and deletes no context row. It adds store events and candidates only where they describe compartments both copies hold unchanged. It copies heading dates only for those compartments. Store rows it leaves behind are counted under a new `superseded` column. Verification checks that a kept context history is byte-for-byte unchanged, and the render check skips those sessions (the store copy it would compare against is the one left behind). Owner resolution now goes through one `Authority` reader shared with `classify_projects`, so memories and history read the same authority rows.

Tests (`single_store_migrate_tests.rs`):

- TS ahead: `a_typescript_session_that_rewrote_and_extended_history_keeps_its_context_copy` (the SUBC shape) and `a_session_whose_context_copy_is_a_superset_keeps_it_whatever_the_owner`
- module ahead: `a_session_whose_store_copy_is_ahead_takes_it` (ALF)
- identical: `identical_history_is_left_as_it_is_and_not_reported`
- diverged: `diverged_history_refuses_until_a_copy_is_preferred`
- owner fallback: `equal_timestamps_fall_back_to_the_project_owner`

With the early return for a context win disabled, the three context-kept tests went red by name and the other 34 migration tests stayed green.

**Rehearsal on the real backup.** `ck-mc single-store-migrate --dry-run --skip-foreign` on a clone of the pre-migration pair: 110 sessions differed between the copies. 109 kept the store copy as a superset; one (SUBC) kept the context copy as `wrote_last` (store 707 rows to message 24,296, context 1,255 rows to message 82,880). ALF `ses_227ce5788ffeRPA9THoPLOQreO` kept the store copy as a superset (store 1,771 rows to message 121,942, context 1,469 to 102,057). There were no refusals, and the render check sampled 362 sessions with 362 passed.

## 3. Why SUBC still renders complete history, and what would end that

The TypeScript host replays the cached m[0] bytes unless `mustMaterialize` (`packages/plugin/src/hooks/magic-context/inject-compartments.ts:1719-1919`) says to rebuild. On the clone of the live store, SUBC's `session_meta` has `cached_m0_max_compartment_seq = 1252`, `cached_m0_materialized_at` = 2026-09-30 01:17Z (before the migration), and `cached_m0_max_mutation_id = 0`. The session has no `m0_mutation_log` rows.

Nothing the migration or the re-summarising historian did is an m[0] trigger:

- New compartments are never a trigger (lines 1897-1901): they are m[1] deltas, read as `sequence > cachedM0Seq`. The truncated table stops at 729, below 1252, so m[1] carries nothing from it.
- The degraded mode in the log comes from `prepareCompartmentInjection` (lines 646-720): the frozen baseline boundary is not in the visible window. It re-anchors or asks for a fresh materialization only on a cache-busting pass after two degraded passes (`REANCHOR_MIN_DEGRADED_PASSES = 2`, line 161; condition at 672). Degraded mode by itself never re-materializes.

These **would** re-materialize m[0] from the truncated table on SUBC's next pass (the list in `mustMaterialize`, in order):

- no cached m[0] or m[1]
- memory switched off while the cache holds a memory block
- a change in the compartment-render epoch (a plugin update that changes rendering)
- a change in the recorded mural setting, the render-budget identity, or a shrink in the rendered budgets (a config edit)
- a model change
- a system-prompt hash change
- idle past the cache TTL, followed by a response
- a native host compaction
- a project identity change
- a workspace-fingerprint change, or a project-memory epoch bump (external memory edits)
- a new `m0_mutation_log` id for the session (a compartment delete, merge or recomp, including from the compressor)
- an upgrade-state change

On timing: `session_meta.cache_ttl` reads `never` for this session. m[0] has not been rebuilt since 01:17Z despite a day of activity, which suggests the TTL trigger is not firing for it. That is an inference, not a source proof. The live risk is therefore any config or plugin change, a model switch, a system-prompt change, or a compressor merge.

What such a HARD does was measured. The host probe (below) on an unrepaired clone hit a HARD because the probe's config differs in the mural setting (`render_config:mural(true→false)`). The re-rendered `<session-history>` ended at `## 25316-25341`, sequence 729: the model would lose July 26 to September 30. The same pass logged `compartment injection entering degraded mode: boundary msg_f8c1c9c25001… not in visible messages`. That boundary is the end of live sequence 711, a compartment written after the migration.

## 4. The repair tool

`ck-mc single-store-repair-history --context-db <path> --store-db <path> --from-backup <dir> [--session <id>]... [--apply --backup-dir <dir>]`

The CLI form is `magic-context doctor single-store repair-history --from-backup <dir> [--session <id>]... [--apply [--live]] [--ck-mc <path>] [--backup-root <dir>]`.

**Preview** (the default) writes nothing and needs no holder check. It offers a session when all three hold:

- the migration moved it: the backup `store.db` has compartments for it;
- the backup `context.db` reached further than the backup `store.db`, so the old rule deleted the difference;
- the live file still lacks at least one of the backup's compartment ids.

A session deleted from the live file since is not offered, and neither is one already repaired. For each session it prints the backup, live and after extents; the kept, restored and removed rows; removed rows that straddle the backup's end; live rows past the backup's end; and the event, embedding and candidate changes.

**Apply:**

- It checks that the live `context.db` is migrated, that the backup `context.db` is not, that both have the same `store_uuid`, and that the backup's columns exist live.
- The CLI refuses while `lsof` or the holder inspection finds OpenCode, Pi or ck-mc on the stores. The exception is `--live`, which needs `--session`.
- It takes a fresh `VACUUM INTO` backup of both live files (`repair-history-<timestamp>` under the backups directory), with `quick_check`, sha256 and a manifest.
- It then repairs each session in its own `BEGIN IMMEDIATE` transaction on `context.db`. It re-plans inside the transaction, and refuses (`repair_session_busy`) while a compartment lease is held, `compartment_in_progress` is set, or a recomp is staged.
- Live compartments equal to the backup's are kept. The migration's filled-in block indexes are accepted where the backup left them unset.
- Every other live compartment that starts inside the backup's range is removed, with its chunk embeddings, its events, and the candidates drawn from that range. That covers the rows the migration rewrote and the rows re-summarised since.
- The backup's compartments go back with their original ids (ids are `AUTOINCREMENT`, so they are free), boundaries normalized as the migration normalizes them. Their chunk embeddings, events and candidates go back with them.
- Live compartments that start after the backup's last message are kept and renumbered to follow it.
- One `compartment_delete` row is added to `m0_mutation_log`. The columns the host's own `clearCachedM0M1` clears are cleared, plus `pending_compaction_marker_state`: the clone had a queued marker move to ordinal 25,341, which points at a compartment the repair removes. The host's `compaction_marker_state` is not touched; it already points at the pre-migration boundary (ordinal 82,769).
- Before COMMIT it re-reads every restored row, the count, the unique and contiguous sequences, the embedding owners, and the number of dangling events (never more than before).
- After COMMIT it drops the session's `mc_compartment_dates` rows from the first restored sequence, and marks its `mc_cache_state` for one HARD.
- The connection does not checkpoint. With autocheckpoint on, the COMMIT held `context.db` for 7.2 s, above the plugin's 5 s busy timeout. Without it the whole write transaction took 0.65 s.

Unit tests are in `single_store_repair_tests.rs` (preview writes nothing; apply restores ids, events, embeddings, candidates, session_meta and store caches; tail renumbering; not-needed sessions; busy refusal; unmigrated and mismatched-backup refusals). CLI tests are in `doctor-single-store-repair.test.ts` (the preview skips the holder probe; apply refuses on a holder; `--live` proceeds with named sessions; engine refusals pass through).

### On a clone of the live stores against the real backup

Preview for all sessions: exactly one session, SUBC.

```
backup: 1255 compartments, last sequence 1254, last message 82880
live:   730 compartments, last sequence 729, last message 25341
after:  1255 compartments, last sequence 1254, last message 82880
kept 649 / restored 606 / removed 81 (sequences 649-729) / straddling 0 / kept past the backup 0
events: restored 196 / removed 4
chunk embeddings: restored 744 / removed 108
user-memory candidates: restored 0 / removed 4
```

After apply, the session had 1,255 rows, sequences 0-1254, ending at 82,880. All 1,255 matched the backup by id, content and ordinals. Events numbered 264 (backup 264) and chunk embeddings 1,469 (backup 1,469). `quick_check` returned ok. There were no genuinely new rows past the original end.

### A real OpenCode host pass on the repaired clone

`scripts/b2-drill/repair-history-host-probe.ts` ran OpenCode 1.18.30 with this branch's plugin build:

- stores: clones of the repaired pair;
- OpenCode database: a clone of the live `opencode.db`;
- project: clones of the project's `.git` and `.cortexkit`;
- provider: the e2e mock, answering as `anthropic/claude-opus-5-5` so the model key matched the cache.

It sent one prompt into the existing session and captured the outgoing request:

- `m[0] HARD fold decision: reason=first_render executed=true`; no `degraded` line for the session.
- The rendered `<session-history>` ends at `## 82770-82880` (sequence 1254). It starts at `## 76762-76764`: the history budget renders the newest compartments, as the pre-migration m[0] did, whose render started at 76,527.
- Afterwards `cached_m0_max_compartment_seq = 1254`, the baseline boundary is sequence 1254's end message, and the pending marker move is null.

The unrepaired contrast on the same inputs is in section 3 (history ending at 25,341).

### Running it on the live store

The installed `ck-mc` does not have the subcommand yet. Pass a build of this branch:

```sh
# preview, read-only
bun packages/cli/src/index.ts doctor single-store repair-history \
  --from-backup ~/.local/share/cortexkit/magic-context/backups/single-store-2026-09-30T17-39-24.412Z \
  --session ses_12a4fa38dffe81Fz7Y2AsWb5Cg --ck-mc "$PWD/target/release/ck-mc"
# apply while hosts run
bun packages/cli/src/index.ts doctor single-store repair-history \
  --from-backup ~/.local/share/cortexkit/magic-context/backups/single-store-2026-09-30T17-39-24.412Z \
  --session ses_12a4fa38dffe81Fz7Y2AsWb5Cg --apply --live --ck-mc "$PWD/target/release/ck-mc"
```

The backup step needs about 8.5 GB free next to the stores and took 60-120 s on the clone. The live row counts will have moved on since the clone was taken; the preview shows the current plan, and apply re-plans inside its transaction.

**Host in-memory state: no restart needed.** The reasons, from source:

- The session's in-memory injection entry is the degraded one, with a null boundary. On every pass that entry is rebuilt from the database (`inject-compartments.ts:428-432`).
- With cached m[0]/m[1] cleared, the next pass's `mustMaterialize` returns `first_render` and folds from the restored rows, one prompt-cache write.
- The TypeScript path keeps no other copy of the m[0] bytes in memory.
- The historian takes its next start from the database.

If a historian run is in flight, apply refuses with `repair_session_busy`; run it again when the run finishes. This running-host reasoning is from source. The probe itself was a fresh process.

## 5. The one-sided gaps in fleet sessions

The gaps were checked on the clone of the live `context.db` and the clone of `opencode.db`, with ordinals rebuilt the way `read-session-raw.ts` numbers them (by `(time_created, id)`, skipping completed summary messages):

- AFT `ses_313660571ffeZTsf4koSJwk50Q`: 7 gaps
- `ses_0ad83017cffexe0g5N8UG0y3LZ`: 12 gaps
- `ses_08df2045bffeBcWcqw60elghER`: 7 gaps

All 26 have the same shape. The end id of the compartment before the gap resolves exactly to its end ordinal, and the start id after it resolves exactly to its start ordinal. The `#n` block index is the anchor of each endpoint message's last content block (the Rust historian anchors messages that way), not a partial range. The uncovered ordinals, one per gap and two in one case, are always a **user message made of a single synthetic part**: `<system-reminder>[BACKGROUND BASH COMPLETED] - task bash-… (exit 0) …`, 100-2,570 characters.

In the AFT example, 1675 ends at ordinal 114,366 (`msg_0a26f3536…#1`, the whole message). Ordinal 114,367 is such a background-bash notice (618 characters). 1676 starts at 114,368. In the live row 1676 has an empty `start_message_id` and a NULL `start_block_index`, not 3; it is the empty-start seed shape from `docs/reports/b2-first-pass-seed-cost.md`. So no message is partly covered. Blocks 2+ of a message are not in question: the uncovered item is a whole notification message.

These are dropped on purpose. The historian's chunk reader skips user messages that are pure system notifications with no tool results (`read-session-chunk.ts:1193-1202`, "zero signal for compartment summaries"). The Rust historian that wrote these rows skips them too. When the notice falls exactly between two compartments, neither range claims its ordinal.

- **Render:** the notice text itself is in no summary, so e.g. "T157_DONE failure / failed job 106592361986" is in the rendered history only if the assistant's next turn, which is summarised, carried it. That is the designed noise filter, not a migration loss.
- **ctx_expand:** recovery is by ordinal range and message-granular. Expanding compartment N or N+1's own range does not include the notice; a range that spans the gap does, since the message is still in the host store.
- **Backfill:** I would not add one. Filling the gaps would mean either widening the next compartment's `start_message` over the notice, which claims coverage no summary provides, or re-running the historian on noise it is built to discard. If contiguous ranges are wanted for tooling, absorbing filtered noise into the next block's range at write time is the place, not a repair of old rows.

## 6. Gates

- `cargo test --locked -j 2 -p mc-store -p mc-module --no-fail-fast`: 1,645 passed and 1 failed. The failure is `real_daemon::mc_pipe_only_supervision_through_real_daemon` ("supervised HELLO did not register"). It fails the same way with the new `main.rs` dispatch reverted to the base version; it depends on the sibling subconscious daemon, not on these changes.
- `cargo clippy --locked -p mc-module -p mc-store --all-targets -- -D warnings` and `cargo fmt --check` for both crates: clean.
- CLI: `bun test src/commands/doctor-single-store` passes 21 tests; `tsc --noEmit` passes; `biome check` has no errors. The one warning (`doctor-single-store.ts` `undo`) and one info (`migrate.test.ts`) were already there before this change.
