# Incomplete OpenCode user arrival: guard and host measurements

## Delivered behavior

The OpenCode outer message-transform wrapper now refuses an input ending in a persisted user row with zero parts. The exception carries the user-facing message:

> Your message hadn't finished arriving. Send it again.

The check precedes tail repair, storage admission, the inner transform and last-known-good replay. It cannot be converted into passthrough by compaction-off mode or the ordinary transform error boundary. The host's existing prompt error path records it on the assistant row. No provider request is sent. Non-empty rows, tool-only rows, ID-less synthetic heads and host summary rows are unchanged.

Pi was not changed. Its adapter receives complete `AgentMessage` objects, with user `content` stored on the message itself (`packages/pi-plugin/src/transcript-pi.ts:111-115`). The installed Pi 0.83.0 host builds text plus images before handing the message to `agent.prompt` (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:864-875`, `744-747`). Tool results have their own `toolResult` role and the adapter's synthetic user normalization contains those results (`transcript-pi.ts:23-34`). There is no equivalent separate persisted-row/part-write arrival window in that path. An extension could explicitly construct an empty content array; that is not evidence of this host race.

## Real-host method and isolation

Command:

```
bun packages/e2e-tests/src/repro/incomplete-user-real-host.ts --out /tmp/magic-context/<new-root>
```

The probe requires OpenCode **1.18.30**, starts separate `serve` hosts with private HOME, XDG directories, TMPDIR, OpenCode database and Magic Context storage directories, and uses a loopback mock Anthropic SSE provider. It retains `lsof.txt` for each host and rejects any open database outside its throwaway root. No live stores were opened. Each host is terminated, with a bounded SIGKILL fallback for the probe's own PID.

The no-plugin host has an empty plugin list. The Magic Context host wraps the locally built plugin's `server` export. The wrapper buffers input-tail traces and event timing measurements. SQLite triggers in the throwaway OpenCode database record actual message and part insertion times, rather than using delayed event delivery as a proxy. Trigger clock resolution is approximately one millisecond. Instrumentation and triggers have overhead; these are diagnostic samples, not a statistical latency guarantee.

For each session, the first prompt contains text and a valid PNG file part. The second text-plus-image prompt is scheduled after the mock emits `message_stop`, sweeping 0, 1, 2, 5, 10, 20 and 50 ms. The offset is relative to provider stop emission, not a claim that the host's terminal check has already run.

Artifacts retained outside git:

- `/tmp/magic-context/arrival-20261002-mason-6`: larger sweep, 10 repetitions per offset, 140 user messages per mode.
- `/tmp/magic-context/arrival-20261002-mason-9`: final probe including statement timings, deterministic refusal control and pure-replay control, 3 repetitions per offset.

Each root includes host logs, raw mock-provider requests, API responses, trace records, summaries and lsof proof. Earlier trial roots are not comparison evidence: one used an invalid PNG, another failed to invoke the union plugin export, and some were interrupted during teardown. The final probe explicitly requires the Magic Context transform to have executed so an unloaded plugin cannot count as a successful comparison.

## Measurements

Larger sweep (140 user-row-to-first-part gaps per mode, milliseconds):

| Mode | Median | P95 | Maximum |
| --- | ---: | ---: | ---: |
| No plugin | 1.006 | 3.983 | 502.995 |
| Magic Context | 1.006 | 4.023 | 12.030 |

The half-second no-plugin maximum belongs to the initial cold prompt, not evidence of plugin overhead. The median is identical; the P95 difference is below the clock's resolution. This did **not** reproduce a Magic Context-induced 1.5-second window. No event-path change is justified by this sample. The conditional historical comparison was not run: master's typical gap was not measurably larger than the no-plugin gap. `scripts/restart-window.sh` history contains earlier candidate commits (for example `f79fd92d12`, October 1 at 14:22 +02:00), should a follow-up reproduce widening.

The outer plugin event wrapper awaits the auto-update hook before invoking Magic Context (`packages/plugin/src/plugin/event.ts:19-21`). Its immediate synchronous prefix is therefore **not** the duration of the inner handler. Async elapsed time is recorded only as an upper bound: it can include unrelated microtasks or waits, and must not be called main-thread CPU time.

The final probe instruments actual SQLite statement execution separately. Statements overlapping a row-to-first-part window by the millisecond wall clock were:

| Table | Calls | Sum execution ms | Maximum execution ms |
| --- | ---: | ---: | ---: |
| schema_migrations_meta | 1 | 0.143 | 0.143 |
| session_meta | 3 | 0.067 | 0.050 |

These timings exclude statement preparation and instrumentation overhead. Boundary attribution has one-millisecond uncertainty. No tag or project-table statement was observed inside those windows.

Relevant source paths:

- User `message.updated` calls `observeSessionActivity`, then returns before the assistant usage path (`hooks/magic-context/event-handler.ts:465-490`). The activity write is `session-activity.ts:39-45`; subsequent events are coalesced for 15 seconds (`49-78`). It writes `schema_migrations_meta`, not all session metadata on every user event.
- `message.part.updated` has no heavy branch in this handler; common entry performs expiry bookkeeping and turn-event observation (`event-handler.ts:287-291`).
- Project binding on `session.created` is `event-handler.ts:316-334`; transform project binding is `transform.ts:1849`. Neither is a user-row part-update handler.
- Auto-search/embedding admission is in transform postprocessing (`transform-postprocess-phase.ts:3242`), not the user event branch.
- LKG entry/replay is in `plugin/messages-transform.ts`, after the new arrival guard, not the event hook.

This is measured statement-level attribution plus source inspection, **not** a full CPU profile of all handler work. It cannot exclude a workload-specific stall absent from these small mock turns.

## Refusal and pure-replay controls

The unmodified send-delay sweeps did **not** hit `user:none`. Consequently there is no claimed natural-race reproduction here. This remains an open requirement for a larger-history or workload-specific follow-up.

A separate deterministic split-arrival control submits a persisted user row with `parts: []` after an old question has been answered. This deliberately supplies the incomplete input shape; it is not presented as a naturally occurring text/image race. On the real host the transform receives:

```
user:text, assistant:step-start+text+step-finish, user:none
```

It throws `IncompleteUserMessageError`. The next assistant row has `finish: error` and `UnknownError.data.message` containing the retry instruction. The API history displays the instruction and the provider request count does not increase. The final probe asserts all these properties.

For normal requests a separate fixture freezes the input history before the transform, then submits it three times. The two defer passes must be **byte-identical raw provider request strings**, not reconstructed hashes of selected fields. In the final run these were 49,419 characters, SHA-256 `f0fe71fcc161f1be9e73c73eba17229a68c7566cde270d2b0be571f7fa9b3573`.

Unit tests also assert that legitimate input shapes are unchanged, that the refusing path never calls the inner transform, and that refusal is enforced with compaction both on and off.

## Verification limitations

The package typecheck, targeted transform tests and plugin build passed. The full e2e TypeScript project has unrelated existing errors in host scripts and OpenCode 2 tests; a narrowed configuration covering the new probe and its imports passed. Repository Biome configuration discovery fails with nested root configurations, so no repository lint pass is claimed. Automated comment review passed after expanding the unexplained abbreviation for Magic Context.
