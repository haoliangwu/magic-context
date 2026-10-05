# Rust Channel-1 defer append analysis (2026-09-22)

## Evidence isolation

The live `~/.local/share/cortexkit/magic-context/store.db` was never opened for writing. It was copied through a read-only SQLite URI before inspection:

```sh
d="$(mktemp -d /tmp/mc-store-copy.XXXXXX)"
sqlite3 "file:$HOME/.local/share/cortexkit/magic-context/store.db?mode=ro" \
  "VACUUM INTO '$d/store.db'"
```

The independently captured `specimens/aft-ch1-defer-append/store-copy.db` reported the same rows.

## A → B attribution

For session `ses_313660571ffeZTsf4koSJwk50Q`:

- Request A was captured at `2026-09-22T06:48:24.903Z`. Its message 304 (zero-based; message 305 in the one-based incident description) was the `board` tool result. Its text was 698 bytes, SHA-256 `e7ccd4a2d8fbb7bccd44e5ef432fee3def3b83f05ec1ba0033a550d2c0d23b10`, with no Channel-1 span.
- The module pass immediately before A completed at `2026-09-22 06:48:22Z`. `mc_pass_trace.scheduler_history` classifies it as `Defer / defer / scheduler_defer`. The target was tagged on that pass as `msg_0c7df4cd1001jRacMV7jxjvkYq#2`, tag 16288, with 251 tokens. No `mc_channel1_appends` row was created.
- Request B was captured at `2026-09-22T06:56:43.647Z`. The same bare 698-byte prefix is unchanged, but a 287-byte reminder suffix was appended. The resulting tool-result text is 985 bytes, SHA-256 `ad5c7f8fe85d2ca8e3173da4ff11987ef324ba21b9b9f2b9a5d8d5b1d62a32ab`.
- The pass that produced B completed at `2026-09-22 06:56:41.226Z`. Both `scheduler_history` and `scheduler_interesting_history` classify it as `Defer / defer / scheduler_defer`; there were no eligible or applied supersessions. `last_divergence` attributes `content_changed` to the already-served block `msg_0c7df4cd1001jRacMV7jxjvkYq#2` at that exact timestamp.
- The same pass inserted `mc_channel1_appends(msg_0c7df4cd1001jRacMV7jxjvkYq#2, …)` with the 274-byte reminder payload. Its copy is the full, non-sticky gentle form and records approximately 26k reclaimable tokens. The persisted Channel-1 state retained `last_nudge_level = gentle` and `last_nudge_undropped = 25,746`.
- The only newly tagged eligible content on that pass was assistant text `msg_0c7df68b4001G9hx7xwxqUedKg#1` (tag 16289, 340 tokens). The next tool result was not observed until the later `06:56:44.134Z` pass (tag 16290). Thus B had no fresh tool result on which the reminder could first-serve.

The firing predicate was a band crossing, not the five-real-user-turn cadence gate. `decide_channel1` emits full `Housekeeping:` copy when `current_rank > previous_rank`; the ordinal gate is consulted only for a same-band sticky refire. The added assistant text changed the effective tail measurement (and advanced the protection window), moving the previously quiet state into gentle. The request-A pass did not fire because that crossing had not yet occurred while the newest result was first observed/protected.

## Former code path

On the B pass, `apply_once` classified `PassPlan::Defer`, making `is_bust_pass = false`, but still called `maybe_append_channel1_nudge` after the defer-time hygiene refresh. `decide_channel1` returned a firing gentle crossing. `newest_tool_result_for_channel1` selected the old board result without consulting `served_output_fingerprint`. The returned row was inserted into `tag_overlay.channel1_by_block_id`; `build_output_with_tags` reached `apply_tag_overlay_to_message` → `append_channel1_to_block` → `append_channel1_to_output`, rewriting the result. `commit_transform` then persisted the append row and the changed served fingerprint.

## Corrected contract

Channel-1 now freezes each newly minted reminder in `mc_cache_state.core_state.frozen_units`:

- the unit key encodes `(tool_call_id, owner_mid)`;
- `reset_rule` stores the target tool-result block id;
- `frozen_payload` stores the exact reminder bytes.

A firing decision is consumed only when the newest eligible result is absent from the prior served fingerprint (first serve), or the current pass is already priced. A defer-time crossing aimed at an already-served result remains pending. Frozen payload bytes are projected into the overlay verbatim on later passes and the unit is retained across hard rebuilds until its target is reduced, covered, or no longer live.

The regression `channel1_waits_for_first_serve_or_priced_pass_then_replays_frozen_bytes` covers the original A → B hold, a fresh-result positive control, a priced-pass append, SHA-256-stable replay across four defers, and retirement after target reduction.

## Pi twin

Pi does not have this failure class. `packages/pi-plugin/src/index.ts` invokes `maybeChannel1ReminderForToolResult` only from `pi.on("tool_result")`. The handler returns the original just-finished result content plus the reminder block before Pi records that result. Pi then persists the replaced content to session JSONL on `message_end`, so all later context passes replay the exact persisted bytes. There is no defer-time history overlay capable of first-applying a reminder to an older result; no Pi change was needed.
