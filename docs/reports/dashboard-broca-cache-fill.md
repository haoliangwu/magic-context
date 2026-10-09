# Dashboard Cache tab: Broca fill numbers and live-poll cost

Date: 2026-10-07. Dashboard base `116585df42`. Broca on this machine: 0.3.189.

This covers two problems with the same view:

1. The Cache tab cost a lot of CPU and disk I/O on every live poll, most of all with
   the harness filter set to `broca`.
2. Broca sessions showed the wrong context fill, and some runs were missing steps.

Every measurement below was taken read-only against the live stores (`opencode.db`
40 GB, `run-index.db` 11.6 GB, `context.db` 7.6 GB, Broca WALs), unless the text
says it used a synthetic store.

## 1. Live-poll cost

### How it was measured

`src-tauri/src/bin/bench_cache_poll.rs` runs the same loop as `reconcile` in
`CacheDiagnostics.tsx`, once a second:

- list sessions (limit 50, managed only, subagents hidden);
- keep a window for the 10 most recent sessions: a full load the first time, then an
  incremental `since` fetch whenever a session's listed activity moves.

The bench routes every SQLite file access through a counting VFS registered as the
default. It reports the bytes SQLite actually read (database, WAL, temporary files)
and wrote to temporary files, plus Broca WAL bytes and process CPU. The figures are
the steady-state mean of polls 1..N; poll 0 is a cold start.

### What a poll did before

| Source | Query or work | Pages per call | Calls per poll |
|---|---|---|---|
| opencode.db | candidate list `SELECT … FROM session WHERE time_archived IS NULL … ORDER BY time_updated DESC LIMIT/OFFSET`. Plan: `SCAN session` plus a temp B-tree for the ORDER BY. Rows hold `summary_diffs` before `time_updated`, so every row's overflow chain is walked. | 8,088 | up to 2 (OFFSET paging) |
| opencode.db | subagent parents `SELECT id FROM session WHERE … TRIM(parent_id) != ''` (`SCAN session`) | 8,085 | 1 |
| context.db | subagent map `session_meta WHERE harness IN (…) AND is_subagent != 0` (scan) | 3,997 | 1 per harness |
| context.db | context limits `session_meta WHERE last_usage_context_limit > 0` (scan), per events fetch | 8,554 | 1 per refetched session |
| run-index.db | Broca list: `GROUP BY json_extract(segment_json,'$.session')` over all `export_facts`, `UNION` a scan of `run_index WHERE state='active'`, plus a `ROW_NUMBER()` window | 43,477, plus a 27.8 MB temp spill | 1 |
| run-index.db | Broca run totals `WHERE json_extract(segment_json,'$.session') = ?` (scan) | 60,511 | 1 per refetched Broca session |
| Broca WALs | the list decoded every listed session's WAL, including archived ones, just to read its compatibility note | | 50 sessions on cold start |

The temp-spill row, measured with `sqlite3 .stats`, accounts for the operator's writes.
Each Broca list sorted about 70,000 JSON identities for the GROUP BY. The connection
used the default `temp_store=file`, so the sort spilled 26.5 MB to a temporary file,
wrote it, and read it back, every poll. The live WAL reader itself already tailed each
file from its saved offset; it was not re-reading whole files.

### What changed

- **OpenCode** (`db/opencode_list_cache.rs`, commit `3fa7970d18`):
  - One read-only connection stays open between polls. `PRAGMA data_version`
    unchanged means the previous list is returned with nothing read.
  - When it has changed, only new `session`, `message` and `part` rows are read, by
    rowid range. Sessions touched in the last 2 minutes are re-read by primary key.
  - A full scan runs at most once a minute while the store changes.
  - Subagent parents come from the same index.
  - Context limits are looked up by session id (index seek).
  - The context.db subagent map is kept on a persistent connection and re-read at
    most every 10 s while that store changes.
  - A session already known to hold a cache event is not re-probed.
- **Broca** (`db/broca_run_index.rs`, commit `0bc92c3a02`):
  - Facts past the highest `export_seq` seen and `run_index` rows past the highest
    rowid are read, plus, by rowid, the runs last seen `active` or `paused`.
  - Each session's run ids are kept, so run totals go through the
    `export_facts(run_id)` index.
  - The index rebuilds when the file is replaced, when keys go backwards, and every
    15 minutes.
  - The list's note never decodes a WAL.
  - A live WAL cursor re-reads from the start when the file's (device, inode)
    changes, not only when it shrinks.
  - run-index connections use `temp_store=MEMORY`.
- **Frontend** (`lib/live-poll.ts`): the poll runs every second only while the window
  is visible and focused. It runs every 10 s while the window is visible but
  unfocused, never while hidden, and at once when the window comes back.

### Before and after, per steady-state poll

| Harness filter, store | CPU ms | DB read | Temp written | Notes |
|---|---|---|---|---|
| broca, live | 627 → 4.4 | 454 MB → 0.27 MB | 26.5 MB → 0 | 10 polls each, run back to back |
| all, live | 667 → 30 | 493 MB → 0.9 MB | 26.5 MB → 0 | |
| opencode, live (quiet) | 99.5 → 14 | 122.6 MB → 0.96 MB | 0 | |
| opencode, synthetic 15k sessions / 300k messages / 600k parts, writer appending a turn every 300 ms | 70.7 → 16.7 | 173.7 MB → 2.8 MB | 0 | 20 polls, 2 event refetches per poll |
| pi, live (after) | 5.5 | 0 | 0 | Pi's reader is file-metadata based. No SQLite reads; no change needed. |
| opencode2, live (after) | 3.9 | 0 | 0 | The V2 query is one seek per session. It now runs only when the store changed. |

Cold first poll, broca filter: Broca WAL bytes 38.1 MB → 7–8 MB (the list no longer
decodes every listed session), DB read 3,032 MB → 172 MB.

Same output: the session list (ids, order, flags) and every event window are identical
between the old and new builds for the `opencode` (23 sessions, 4,202 events) and `pi`
(50 sessions, 464 events) filters. For `broca` the same 50 sessions are listed. One
window differed only by a step a live session appended between the two runs.

## 2. Broca fill and cache numbers

### Independent reading of the raw WAL

`walread.py` (in the task's temp directory) parses frames and verifies digests itself.
It shares no code with the dashboard. For each `model_step_finished` it takes `usage`
as Broca writes it: per step, not cumulative, with `run_finished.usage` being the run's
sum. Fill is fresh input + cache reads + cache writes, Broca's `Usage::fill_tokens`
since 0.3.171. The window is `run_started.config.context_limit`, the context window
Broca froze when it admitted the run: the caller's override, otherwise the catalog's
window (`context_limit_for_episode` in broca-module-serve).

| Session (WAL) | Shape | WAL steps | Dashboard before | Dashboard after |
|---|---|---|---|---|
| `alfonso:bg_f025a8d921c2215d` (`38a319fa…`), gpt-6.1-sol | long mason run, daemon-restart pause + resume | 71 | 27 steps shown, 44 missing, banner "features this dashboard doesn't understand (restart-pause/v1)", no run total | 71 of 71 |
| `alfonso:bg_1c2315f75ad4d099` (`69d17f9e…`), gpt-6-luna | short reader | 5 | 5 | 5 |
| `alfonso:bg_d4ea6fa037c05af9` (`b542dbd0…`), claude-opus-5-5 | Anthropic, cache writes on every step | 18 | 18 | 18 (23 at the later run: the session was live) |
| `alfonso:bg_c83ef7955e1d4f0c` (`00063179…`), gpt-6.1-sol | 2 runs, 13 cache warms, a steer | 214 | 214 | 214 |

Per-step tokens (input, cache read, cache write) agreed exactly on every step the
dashboard showed. The fill did not:

| Step | WAL in / read / write | WAL fill / window | Before: prompt / limit | After |
|---|---|---|---|---|
| `bg_f025…` #27 | 423 / 89,344 / 0 | 89,767 / 1,050,000 = 8.5% | 89,767 / 89,767 (estimated) = 100% | 8.5% |
| `bg_f025…` #71 | 1,698 / 140,288 / 0 | 141,986 / 1,050,000 = 13.5% | not shown | 13.5% |
| `bg_1c23…` #5 | 1,230 / 15,872 / 0 | 17,102 / 1,050,000 = 1.6% | 17,102 / 17,102 (est.) = 100% | 1.6% |
| `bg_d4ea…` #18 | 2 / 98,814 / 726 | 99,542 / 1,000,000 = 10.0% | 99,542 / 99,542 (est.) = 100% | 10.0% |
| `bg_c83e…` #87 (run 2) | 1,955 / 358,016 / 0 | 359,971 / 1,050,000 = 34.3% | 359,971 / 359,971 (est.) = 100% | 34.3% |

Hit % (cross-step retention), severity, and the per-turn rows (prompt, cached, new =
summed cache writes) matched the raw data before and after. Example: the short
reader's step 3 really did read 0 cached tokens after 14,848, and both builds show it
as a full bust. Neither build has an aggregation-across-runs, steer or retry problem:

- each `model_step_finished` carries its own step's usage;
- retries only add `model_attempt_finished` records, which have no usage;
- a resumed run keeps its run id and continues its step ids, with no new `run_started`;
- a steer adds a message, not a step.

### The causes

| # | What was wrong | Class | Cause in code |
|---|---|---|---|
| 1 | Every Broca session's largest step read as 100% full. The window shown was the session's own largest prompt. | wrong context window | `broca_wal_step_rows` set `context_limit: None`. Magic Context records no limit for Broca sessions (`context.db session_meta` has no `broca` rows), so `build_db_cache_events` fell back to the session's max prompt and marked it estimated, and the frontend scaled every bar to it. The run's real window is in `run_started.config.context_limit`, which the parser ignored. |
| 2 | Runs Broca paused for a daemon restart stopped at the pause. The banner asked about unknown features; later steps and the run total were missing. | parser drift | The dashboard's `KNOWN_FEATURES` lacked `restart-pause/v1` and `flow-scopes/v1`, which Broca's `framing.rs` lists. The reader therefore stops at the gated `run_paused` frame. With the compatibility note set it also drops the run totals. 15 of the 1,500 most recent WALs carried a restart pause. |

Checked and not a problem:

- **Broca 0.3.171 counting cache writes in fill.** The dashboard already counted
  input + read + write as the prompt, so it matches the new fill.
  Example: `bg_d4ea…` step 1 = 4 + 26,208 + 2,249 = 28,461.
- **Model resolution.** Provider and model come from `run_started.config.model`
  (`provider_module_id` / `model_id`) and are correct.

### What changed (this commit)

- `broca_wal.rs`:
  - `KNOWN_FEATURES` now equals Broca's table: `flow-scopes/v1` and
    `restart-pause/v1` added. Each only adds a field or a record type this reader
    does not use.
  - `WalRun.context_limit` is read from `run_started.config.context_limit`.
- `db.rs`: Broca step rows carry `context_limit: run.context_limit`. It is a recorded
  limit, not an estimate, so the timeline scales to the real window.

Tests, written red first (output saved before the fix):

- `broca_wal::tests::a_run_resumed_after_a_restart_pause_keeps_every_step` uses a
  real-shaped restart-pause/resume WAL with no transcript text.
- `broca_wal::tests::every_feature_broca_writes_is_understood` spells out Broca's
  feature names rather than reusing the reader's own list.
- `db::broca_cache_tests::broca_steps_are_scaled_by_the_runs_frozen_context_window`.

OpenCode and Pi readings are unchanged: every OpenCode (4,202 events, e.g.
`ses_313660571ffe…` last step 2 / 299,207 / 762 against an 872,000 window) and Pi
event is byte-identical between the base build and this one.

Screenshots of `alfonso:bg_f025a8d921c2215d` in the light theme, before and after, are
in the task's temp directory (`before-broca-cache-light.png`,
`after-broca-cache-light.png`):

- Before: 27 steps, a 90k axis, and the unknown-feature banner.
- After: 71 steps and a 1.1M axis.

## Left as is

- **Run totals for runs with no WAL steps.** Their prompts are summed over a whole
  run, so they keep the estimated (max-prompt) scale. Broca's export facts carry no
  window.
- **Cache warms.** `cache_warmed` requests (13 in `bg_c83e…`) are not model steps and
  are not shown in the timeline. Broca bills them as separate export facts.
- **OpenCode in-place changes.** An in-place change to an OpenCode session that is
  not busy (archiving it, say) shows within the one-minute full rescan, not on the
  next poll.
- **New subagents.** A new subagent's `context.db` flag can take up to 10 s to hide
  it. OpenCode children are flagged at once from their parent id.
- **Broca notes in the list.** A Broca session's compatibility note shows in the list
  once its events have been fetched, normally by the next poll.
