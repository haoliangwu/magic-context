# How Magic Context uses Broca's llm-runner surface

Magic Context does not link `cortexkit-role-llm-runner`. Its Rust module (ck-mc) talks to Broca's runner with hand-built JSON, only when the user configures the historian (or the dreamer's classify task) to run on a module runner. The default runs them in the host, with no route to Broca. The original census was taken on 2026-10-05; the send identity, route-open class, and cleanup entries below include the follow-up to BROCA's review (fleet-notices #1935). Source references are relative to `crates/mc-module/src/`; original line ranges are navigation hints, not fixed anchors.

The route open (`historian_producer.rs:1002-1059`, `route_targets.rs:14-95`) sends project root, harness and session identity, with no scope and `role_versions: None`.

| Item | MC | Where |
|---|---|---|
| `session.send` | Sends `prompt` (string), `model {provider, model, variant?}` split at the first `/` of `provider/model`, `tools: []`, `generation.max_output_tokens` (historian 32,000), optional `generation.temperature` (classify 0.1), `system` when non-empty | `historian_producer.rs:815-853` |
| `model.variant` | Sent when the host configured a variant for the attempt's model (for example an OpenCode reasoning variant such as `high`), on every send; omitted, never sent empty, when none is configured. MC sends only queued sends (no `delivery`), which must name the variant because a queued send does not inherit the session's. The historian gets per-model variants from the transform's `historian_model_variants` map and the dreamer's classify task from `dreamer.run_task`'s `model_variants` map, both keyed by the chain's model strings, so each fallback attempt sends its own model's variant or none. The `model` object is serialized as `provider`, `model`, `variant`, and a test compares it byte for byte with Broca's `send_request.model_variant_queue.json` and `send_request.model_variant_steer.json` goldens, copied into `crates/mc-module/testdata/broca/` | `session_send_request`, `HistorianProducer::start_with_generation` |
| `send_id` | Sends the attempt-owned producer session id. Stable across a transport resend/reconnect of that attempt; distinct for a new historian firing or dreamer attempt | `HistorianProducer::start_with_generation` |
| `delivery`, `mark`, `plan`, `prompt_blocks` | Not sent; every send is a queued send | `historian_producer.rs:833-853` |
| Other send fields (`tool_choice`, `stop_when`, `budget`, `cache`, `keep_warm`, `on_restart`, `conversation_key`, `work_class`, `context_limit`, `service_tier`, `context_management`, `auth`, `one_shot`, `append_episode`) | Not sent | `historian_producer.rs:833-853` |
| `session.send` reply | Decodes `run_id` (active) or `state: "pending"` plus `submission_id` (queued, then retracts). Does not recognise `paused` as a send outcome | `historian_producer.rs:855-869, 1263-1297` |
| `session.subscribe` | Sends `from: "start"`; decodes control units (`type`/`kind`, `run_id`, `reason`/`detail`, `error`, `finish_reason`), assistant text and usage (`input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_tokens`) | `historian_producer.rs:966-978, 1091-1186, 1339-1391` |
| `run.status` | Sends `run_id`; maps `state` broadly: terminal, interrupted, completed or finished → done; active, paused, pending or running → active; anything else → missing. Doesn't read `pause_reason` | `historian_producer.rs:923-932, 1299-1337` |
| `run.cancel` | Sends `run_id`; ignores the body | `historian_producer.rs:934-943` |
| `session.retract` | Sends `submission_id`, only after a pending send | `historian_producer.rs:872-889` |
| `session.delete` | Not supported by Broca and no longer sent. Cleanup closes existing routes, returns an explicit unsupported-deletion error, and warns once per process about snapshot retention | `HistorianProducer::purge_session` |
| `session.warm`, `session.read`, `session.head`, `run.result`, `session.baseline`, `role.describe`, `compaction.ready`, `session.refresh*`, `session.flush_prefix`, `session.import` | Not used | `historian_producer.rs:801-982` |
| Paused stream unit | Treated as a failed run (`RunPaused`); reads `reason`/`detail` and the error class, not the named reasons | `historian_producer.rs:1127-1137, 1453-1489` |
| Terminal reasons | Not parsed as a taxonomy; `max_steps`, `cancelled` and `transform_unavailable` are not told apart | `historian_producer.rs:1120-1179, 1393-1444` |
| Refusal codes | Decodes `code` and `message` generically. `open_failed` reads `detail.class` (Broca 0.3.171+); message text still labels the reporting stage, but decides durable vs transient refusal only when the class is absent | `ProducerErrorBody::from_value`, `RunnerRefusal::is_durable` |
| Error class | Ordinary errors branch on top-level `class` (`transient`, `permanent`, `auth_required`/`auth`, `context_overflow`) and `retry_after_secs`. Route-open errors use `detail.class`; an explicit class overrides text heuristics, including the shared refusal cache. Unknown present classes do not invoke the legacy text fallback | `HistorianProducerError::classification`, `HistorianRunnerRefusalCache::record_refusal` |

Answers to the diff's closing questions, from MC's side:
1. MC uses `run.status`, `run.cancel` and `session.retract`, but not `session.warm`.
2. MC sends `model.provider` and `model.model`, plus `model.variant` when the host configured one for that model.
3. MC now sends `send_id` from its attempt-owned producer session identity, so lost-reply resends can deduplicate without reusing an id for a new attempt.
4. MC never sends `mark`.
5. MC doesn't handle `paused` as a send outcome; a paused run during streaming counts as a failure.
6. MC branches on the error class and retry hint, not on the named pause or terminal reasons or provider codes.

## Retry identity

The historian calls `fire` before each model attempt, incrementing the durable firing sequence. `historian_producer_session_id` includes project, lineage hash, and firing sequence. The dreamer builds a fresh `child_session_id` using an attempt nonce for each model attempt. Each such session owns one logical send, so its identity is also the `send_id`; neither prompt bytes nor per-connection frame correlations define an attempt.

Classified failures and their `retry_after_secs` hints govern fallback/backoff; those later model attempts are new sends, not transport retransmissions. The producer does not introduce an automatic transport retry loop. If the same attempt is resent after a lost reply, including on a new connection, its id remains stable. Regression tests exercise the lost-reply/reconnect wire requests and distinct ids for new historian and dreamer attempts.

## Dreamer snapshot cleanup and unresolved retention policy

Previously, `purge_session` sent `session.delete`. A Broca `unknown_method` error frame became `HistorianProducerError::Subc` in `unary_json`; the `?` returned before `purge_session` reached `close()`. The `HistorianProducerDriver` adapter then caught that error and called `close()` itself, silently discarding the deletion failure. Dreamer cleanup called that void adapter once on each terminal path: it did not log the error or retry indefinitely, and a successful classify response remained successful despite the failed deletion.

The read-only ck-mc logs in `~/.local/share/cortexkit/magic-context/logs/` (13 files, 2026-09-23 through 2026-10-05) contained no matches for `unknown_method`, `session.delete`, `purge`, or `delete session`. There is no observed log line to quote; the silent adapter explains why absence of a line is not evidence of deletion.

Cleanup now sends no deletion operation and opens no replacement route. It always releases existing command/subscription routes, returns `RunnerSessionDeletionUnsupported` through the driver, and emits a plain warning once per process. Dreamer continues to use its classify output independently of cleanup, as before; returning output does **not** claim the snapshot was deleted.

Broca never deletes a session. Its write-ahead log is append-only; after 7 days an idle session is moved into an archive container byte for byte and kept there, and engram backs up both the live logs and the archives (BROCA, fleet-notices #1939). A memory-pool snapshot sent to the runner therefore stays indefinitely, in the log or archive, in Broca's transcript index and in engram's backups. The old dreamer deletion comment was an expectation, not a supported guarantee. **Ufuk and BROCA must decide whether this retention is acceptable or requires a different classify transport/retention design.** This change exposes the mismatch and fixes route cleanup; it does not settle that design question.
