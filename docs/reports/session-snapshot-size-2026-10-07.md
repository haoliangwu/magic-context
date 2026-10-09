# Magic Context session snapshot size — 2026-10-07

## Summary

Read-only measurement of the live stores for ALF (`ses_227ce5788ffeRPA9THoPLOQreO`), AFT (`ses_313660571ffeZTsf4koSJwk50Q`), and an ordinary TS-mode session (`ses_331acff95fferWZOYF1pG0cjOn`):

| Session | `context.db` row-value bytes | `store.db` row-value bytes | Combined |
|---|---:|---:|---:|
| ALF | 133,941,111 B (127.74 MiB) | 175,500,470 B (167.37 MiB) | 309,441,581 B (295.11 MiB) |
| AFT | 151,632,790 B (144.61 MiB) | 140,266,448 B (133.77 MiB) | 291,899,238 B (278.38 MiB) |
| Ordinary TS | 209,835,514 B (200.11 MiB) | 0 B (no rows for this session) | 209,835,514 B (200.11 MiB) |

The ALF row-value total is about 37 MiB above the earlier ~258 MiB reference. This is not a controlled before/after comparison: the earlier table/column scope and byte-counting method are not available here, so the difference should not be attributed to the compaction-marker fix alone. The ordinary TS session has substantial `context.db` history but no module-store rows, as expected for this TS-mode sample.

## Method and scope

Both live files were opened with SQLite URI `file:...?...mode=ro` and `PRAGMA query_only=ON` (SQLite 3.54.0, journal mode WAL), then measured in one explicit read transaction per database to keep each database's table counts on one snapshot. No live store was copied, written, checkpointed, or vacuumed. For each table with a `session_id` column, the query counted matching rows and summed `length(CAST(column AS BLOB))` for every column in each row; `notes` was restricted to `type = 'session'`, matching its extra predicate in `SESSION_SCOPED_TABLES`. Values below are bytes per table as `rows / bytes`.

This is a logical row-value measure, not allocated SQLite pages: text/blob bytes are counted as stored; numeric values are counted by their text form. It excludes SQLite record headers, indexes, page slack/freelist, WAL, and FTS shadow/index storage. In particular, it should not be compared to a file-size or `dbstat` total as if they were the same measure. Tables without a session key are not apportioned to these sessions; project-owned rows that merely mention an originating `source_session_id` are not charged to that session.

## `context.db` — session rows by table

`Scope` is exact membership in `SESSION_SCOPED_TABLES` from `packages/plugin/src/features/magic-context/storage-session-tables.ts`. `recalls` and `session_notes` carry session IDs but are outside that list, so they are identified separately rather than called project-scoped.

| Table | Scope | ALF rows / bytes | AFT rows / bytes | TS rows / bytes |
|---|---|---:|---:|---:|
| `compartment_chunk_embeddings` | `SESSION_SCOPED_TABLES` | 1,576 / 26,229,338 | 1,939 / 32,269,572 | 2,595 / 43,189,186 |
| `compartment_events` | `SESSION_SCOPED_TABLES` | 354 / 307,786 | 245 / 218,383 | 329 / 290,759 |
| `compartment_history_versions` | `SESSION_SCOPED_TABLES` | 1 / 67 | 1 / 67 | 1 / 66 |
| `compartment_state_lease` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `compartments` | `SESSION_SCOPED_TABLES` | 2,115 / 11,763,904 | 2,138 / 19,564,222 | 2,205 / 23,029,470 |
| `compression_depth` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `embedding_measurement_corpus` | `SESSION_SCOPED_TABLES` | 2,000 / 2,082,707 | 862 / 897,762 | 1,318 / 1,389,156 |
| `historian_runs` | `SESSION_SCOPED_TABLES` | 1,819 / 239,296 | 1,124 / 146,833 | 1,639 / 240,911 |
| `lkg_slot_chunks` | `SESSION_SCOPED_TABLES` | 63 / 4,114,715 | 25 / 1,579,177 | 42 / 2,693,662 |
| `lkg_slots` | `SESSION_SCOPED_TABLES` | 1 / 34,391 | 1 / 26,561 | 1 / 15,113 |
| `m0_mutation_log` | `SESSION_SCOPED_TABLES` | 1 / 67 | 1 / 67 | 1 / 67 |
| `message_fts_rowid_map` | `SESSION_SCOPED_TABLES` | 32,810 / 1,806,790 | 59,740 / 3,289,165 | 65,630 / 3,614,519 |
| `message_history_fts` | `SESSION_SCOPED_TABLES` | 32,810 / 20,135,074 | 59,763 / 30,843,446 | 65,630 / 36,740,894 |
| `message_history_index` | `SESSION_SCOPED_TABLES` | 1 / 58 | 1 / 58 | 1 / 58 |
| `message_history_source` | `SESSION_SCOPED_TABLES` | 139,980 / 24,990,820 | 57,590 / 10,299,876 | 155,592 / 27,793,240 |
| `notes` (`type='session'`) | `SESSION_SCOPED_TABLES` | 809 / 1,007,669 | 589 / 678,933 | 439 / 529,993 |
| `pending_ops` | `SESSION_SCOPED_TABLES` | 0 / 0 | 204 / 13,872 | 58 / 3,944 |
| `pending_session_cleanup` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `plugin_messages` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `primer_candidates` | `SESSION_SCOPED_TABLES` | 229 / 3,817,418 | 142 / 2,338,443 | 123 / 2,036,062 |
| `recalls` | session-keyed, outside list | 0 / 0 | 0 / 0 | 49 / 22,766 |
| `recomp_compartments` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `recomp_facts` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `session_facts` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `session_meta` | `SESSION_SCOPED_TABLES` | 1 / 966,030 | 1 / 974,309 | 1 / 1,249,860 |
| `session_notes` | session-keyed, outside list | 0 / 0 | 0 / 0 | 0 / 0 |
| `session_projects` | `SESSION_SCOPED_TABLES` | 1 / 95 | 1 / 95 | 1 / 95 |
| `session_replay_decisions` | `SESSION_SCOPED_TABLES` | 64,046 / 4,152,926 | 40,334 / 2,616,281 | 34,976 / 2,269,984 |
| `source_contents` | `SESSION_SCOPED_TABLES` | 33,031 / 15,484,013 | 61,295 / 26,588,812 | 76,772 / 37,587,842 |
| `subagent_invocations` | `SESSION_SCOPED_TABLES` | 1,306 / 179,366 | 1,671 / 227,167 | 1,750 / 237,576 |
| `synapse_batch_ledger` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 0 / 0 |
| `tags` | `SESSION_SCOPED_TABLES` | 121,958 / 16,435,819 | 148,122 / 18,866,718 | 204,861 / 26,449,887 |
| `temporal_decisions` | `SESSION_SCOPED_TABLES` | 0 / 0 | 0 / 0 | 30 / 1,867 |
| `tool_owner_backfill_state` | `SESSION_SCOPED_TABLES` | 1 / 65 | 1 / 65 | 1 / 65 |
| `transform_decisions` | `SESSION_SCOPED_TABLES` | 2,000 / 192,697 | 2,000 / 192,738 | 2,000 / 448,472 |
| `user_memory_candidates` | `SESSION_SCOPED_TABLES` | 0 / 0 | 1 / 168 | 0 / 0 |

Project-scoped examples deliberately not assigned to one session include `memories`, `memory_embeddings`, `memory_mutation_log`, `primers`, `git_commits`, `workspaces`, `workspace_members`, project key files/state, and project-owned smart notes (`notes` rows whose type is not `session`). The table list also contains global metadata, migration, and FTS support tables; those are neither session-scoped nor project-owned session payload.

## `store.db` — session rows by table

The second column classifies transfer behavior for the agent-move question. Rebuildable means a state sync can recreate the cache/projection from the authoritative context/history. “Move” is the prompt-prefix-critical state that must travel with the frozen head. Other operational/durable rows are listed separately rather than assumed to be reconstructible.

| Table | Resync / transfer class | ALF rows / bytes | AFT rows / bytes | TS rows / bytes |
|---|---|---:|---:|---:|
| `mc_block_identities` | Move with frozen head; identities accompany frozen blocks | 37,209 / 14,956,321 | 32,193 / 13,316,485 | 0 / 0 |
| `mc_cache_frozen_chunks` | Move; frozen `core_state.frozen_units` (m[0]/m[1] head) | 763 / 8,684,628 | 700 / 7,997,987 | 0 / 0 |
| `mc_cache_sections` | Rebuildable cache state (boundaries/tail sections) | 2 / 986,386 | 2 / 1,201,478 | 0 / 0 |
| `mc_cache_state` | Rebuildable cache state | 1 / 12,569 | 1 / 13,583 | 0 / 0 |
| `mc_cache_state_digest` | Rebuildable cache digest | 1 / 87 | 1 / 86 | 0 / 0 |
| `mc_channel1_appends` | Durable operational state; preserve | 30 / 8,933 | 92 / 28,798 | 0 / 0 |
| `mc_chunk_transcripts` | Durable transcript history; preserve | 628 / 89,174,427 | 508 / 67,067,026 | 0 / 0 |
| `mc_compartment_dates` | Rebuildable derived projection | 2,115 / 235,506 | 2,138 / 240,861 | 0 / 0 |
| `mc_dream_task_commands` | Durable command ledger; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `mc_historian_pending_run` | Durable in-flight work; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `mc_historian_side_channel_outbox` | Durable delivery state; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `mc_overlay_frontiers` | Rebuildable projection frontier | 1 / 36 | 1 / 36 | 0 / 0 |
| `mc_pass_trace` | Rebuildable pass trace | 1 / 264 | 1 / 262 | 0 / 0 |
| `mc_pass_trace_history` | Rebuildable pass trace | 505 / 166,157 | 543 / 186,719 | 0 / 0 |
| `mc_recomp_commands` | Durable command ledger; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `mc_reduce_command_ledger` | Durable idempotency ledger; preserve | 810 / 91,285 | 573 / 65,848 | 0 / 0 |
| `mc_served_output_fingerprints` | Move; validates the served prompt prefix | 1,254 / 165,471 | 685 / 90,019 | 0 / 0 |
| `mc_single_store_pending_publish` | Durable pending publish; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `mc_state_imports` | Durable import bookkeeping; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `mc_tag_cache_generations` | Rebuildable tag cache | 1 / 45 | 1 / 45 | 0 / 0 |
| `mc_tags` | Rebuildable tags | 42,301 / 60,875,180 | 38,412 / 49,956,490 | 0 / 0 |
| `mc_temporal_marks` | Move; frozen decisions/markers | 736 / 56,013 | 514 / 40,192 | 0 / 0 |
| `mc_transform_session_roots` | Rebuildable session projection root | 1 / 96 | 1 / 89 | 0 / 0 |
| `mc_user_hints` | Durable session hints; preserve | 813 / 73,962 | 571 / 56,988 | 0 / 0 |
| `mc_wrapup_commands` | Durable command ledger; preserve | 0 / 0 | 0 / 0 | 0 / 0 |
| `pending_agent_drops` | Durable pending command state; preserve | 91 / 13,104 | 24 / 3,456 | 0 / 0 |
| `shadow_divergences` | Diagnostics; no rows for these sessions | 0 / 0 | 0 / 0 | 0 / 0 |

`mc_cache_frozen_chunks` is the split storage for the frozen-unit list, not disposable cache. `mc_block_identities`, `mc_temporal_marks`, and `mc_served_output_fingerprints` are also preserved with the frozen head so identity, frozen decisions, and served-prefix validation remain aligned. The append-only `mc_chunk_transcripts` are sizable and are not counted as resync-rebuildable; the authoritative historical text is not inferred to be losslessly available on the destination just because a rendered projection can be rebuilt.

The LKG slot tables are in `context.db`, not `store.db`: ALF has 4,149,106 B (3.96 MiB), AFT 1,605,738 B (1.53 MiB), and TS 2,708,775 B (2.58 MiB), across `lkg_slots` and `lkg_slot_chunks`. They are included in the context totals above. This makes the named rebuildable subset (tags, cache state/digest/sections, pass trace/history, LKG, and derived date/frontier/session-root projection) 66,425,432 B (63.35 MiB) for ALF and 53,205,387 B (50.74 MiB) for AFT. Without the context-host LKG rows, the corresponding store-only subset is 59.39 MiB for ALF and 49.21 MiB for AFT. These are targeted category sums, not the total amount that every kind of resync necessarily writes.

## Per-turn size

**Estimate, not a live WAL sample:** use about 32 KiB of `store.db` WAL (about 53 KiB of live-config writes) for a state-changing new-message pass as a current-scale estimate, based on the split-cache plus pass-trace-ring AFT SQL replay in `docs/reports/ckmc-write-amplification-design.md` §2.3; pass type and whether state changes materially affect it. No live WAL growth was sampled during this read-only inventory.
