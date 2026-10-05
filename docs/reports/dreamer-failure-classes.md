# Dreamer failure classes on the maintainer's machine (2026-09-28)

Scope: the six failure classes in `.cortexkit/alfonso/reviews/dreamer-failures-2026-09-28.md`, which summarises the last 14 days of `subagent_invocations` in the live `context.db` (OpenCode 1, Pi and Rust mode). This is a read-only investigation, with no code changes. Every claim names the code that produces the text. Anything that depends on live-store data is listed under "Queries to run" (§9). I did not open a live store.

Sources read: this repository at `67f44f51fa`, the OpenCode log (`$TMPDIR/opencode/magic-context/magic-context.log*`, which only covers 2026-09-27 13:54Z to 2026-09-28 01:08Z because the temp dir was cleared at the 09-27 reboot), the Pi log (`$TMPDIR/pi/magic-context/magic-context.log`, 09-27 only, boot lines only), and the installed OpenCode binary (`~/.opencode/bin/opencode`, 1.18.30), searched as bytes. Installed Magic Context is v0.43.2, per the Pi boot line `loaded v0.43.2`.

Neither log window contains a single dreamer task run. The runs are scheduled 02:00–04:00 local (Pi boot line: `map-memories 0 2 * * *, verify 10 3 * * *, classify-memories 15 3 * * *, …`), and the retained window has no night. The log evidence below is therefore about code paths and about adjacent failures that are in the window. The per-row facts have to come from the §9 queries.

## 0. How to read the ledger counts

Three things inflate or shape the counts in the evidence table:

- **Rows are batches or attempts, not task runs.** OpenCode map/verify/classify write one `subagent_invocations` row per batch or chunk (`recordInvocation` in `map-memories.ts:352/421/438`, `verify.ts:292/363/374`, `classify.ts:479/490/507`). Pi writes one row **per model attempt** (`packages/pi-plugin/src/subagent-runner.ts:1089-1125`, `runOnce` → `recordChildInvocation`). The Pi facade's `session.list` returns `[]` (`packages/pi-plugin/src/dreamer/index.ts:437`), so the shared executor writes no second row. On Pi, a primary that fails followed by a fallback that succeeds shows up as one failed row and one completed row.
- **Hot retries repeat the same failure.** A transient task failure keeps `next_due_at` and retries on each 15-minute tick, up to `MAX_TASK_RETRIES = 3` (`task-scheduler.ts:32`, `recordTransientFailure` 290-336). A deterministic failure, such as a verify slice too short to finish, therefore writes up to four rows per project per night.
- **Failed OpenCode rows carry no tokens or model.** The failure branches call `recordInvocation(args, startedAt, { status, error })` without messages, so `input_tokens`/`output_tokens` are 0 and `provider_id`/`model_id` are NULL on every failed OpenCode dreamer row. Pi rows do carry the attempt's model and usage. The only per-row signal left for OpenCode failures is duration (`ended_at - started_at`), so the §9 queries lean on it.

Status mapping (`subagent-token-capture.ts:89-98`): `timed_out` matches only `timed out after Nms|prompt timed out`. `empty` matches `length-capped|no output|empty text`. Everything else is `failed`. That is why the host `TimeoutError` rows are `failed`, not `timed_out`.

---

## 1. `TimeoutError "The operation timed out." code=23` and `prompt timed out after 120–300 s`

These are **two different timers**.

### 1a. `prompt timed out after N ms` is ours

**Code path.** `promptWithTimeout` (`packages/plugin/src/shared/model-suggestion-retry.ts:207-273`) arms `setTimeout(controller.abort, timeoutMs)`. When our own controller fires it calls `abortChildRun` (POST `/session/{id}/abort`) and throws `prompt timed out after ${timeoutMs}ms` (line 254/270). `isNonRetryable` (314-328) stops the fallback chain on that exact message.

**Budget.** The per-batch budget is `sliceMs`, carved from the task deadline `startedAt + timeoutMinutes·60 000` (`task-executor.ts:403`), where `timeoutMinutes` defaults to **20** (`task-config.ts:37`).

| Task | Batch | Slice formula | Floor |
|---|---|---|---|
| map-memories | 80 memories (`map-memories.ts:68`) | `max(240 s, remaining / batchesLeft)` (`computeMapBatchSliceMs`, 138-143) | 240 s; batches are not started below it (253-259) |
| verify / verify-broad | 50 memories (`verify.ts:75`) | `remaining / batchesLeft` (`verify.ts:196-202`) | **none** |
| classify (TypeScript path) | 100 memories (`classify.ts:77`) | `remaining / chunksLeft` (`classify.ts:320-325`) | none |

**Does the budget fit?** For verify it does not once the pool grows. A 20-minute run with 200 memories in scope gives 4 batches of 300 s. With 500 in scope it gives 10 batches of 120 s. Those are the observed 120–300 s values, and they are exactly what `20 min / ceil(inScope/50)` produces. The map-memories harness note records about 41 agent turns for 100 memories (`map-memories.ts:59-60`). Verify reads deeper than map (`verify.ts:63-65`), so a 50-memory verify batch is a multi-minute tool loop, and 120 s cannot hold it.

**What happens when it fires.** Verify re-throws any non-parse prompt failure (`verify.ts:375-382`), so **the first timed-out batch ends the whole verify run**. Batches already applied stay applied (per-memory `verified_at`, `applyParsedVerifyManifest`). The run then fails as transient, hot-retries in 15 minutes with the same slice arithmetic, and fails the same way. Map-memories swallows per-batch failures (`map-memories.ts:432-450`) and trips a circuit breaker after two consecutive timeouts (`CONSECUTIVE_TIMEOUT_LIMIT`, 82, 291-300).

**Work lost.** The whole batch. The manifest only arrives at the end of the loop, so every file read and token spent in the batch is discarded. The child session is archived and later swept (`child-session-teardown.ts:54-65`).

Cause: **ours** (budget design). Confidence: **high** for the verify arithmetic; the §9 Q2 query confirms the in-scope sizes.

### 1b. `TimeoutError message="The operation timed out." code=23` is the host's

**What it is.** `describeError(error).brief` (`shared/error-message.ts:86-95`) of a real `DOMException` named `TimeoutError` (legacy code 23 is `TIMEOUT_ERR`). That is the reason object of an `AbortSignal.timeout(...)`. Nothing in our dreamer path creates one:

- our own timer aborts with a plain `AbortController`, which produces the `prompt timed out …` text above;
- the Rust module transport throws `SocketTimeoutError` (`hooks/magic-context/module-transport.ts:115-123`);
- the Pi facade reports `pi subagent aborted by caller`.

The exception therefore comes from **inside the host call `client.session.prompt`**. The installed OpenCode 1.18.30 binary wraps every provider request in `AbortSignal.timeout(options.timeout)` and passes `timeout:false` to Bun's fetch. Byte excerpt from the binary:

```
r.fetch=async(i,s)=>{let d={...s??{}},f=[d.signal,…,r.timeout!==void 0&&r.timeout!==null&&r.timeout!==!1?AbortSignal.timeout(r.timeout):void 0]…;let y=await(typeof o==="function"?o:fetch)(i,{...d,timeout:!1});
```

OpenCode's documented provider `timeout` default is 300 000 ms. Separately, the repo itself records that Bun's `fetch()` has a hard-coded ~5-minute cap that longer `AbortSignal.timeout` values do not lift (`packages/e2e-tests/src/opencode-runner/spawn.ts:478-485`, bun#16682). That cap applies if the plugin SDK's `session.prompt` goes over a real socket. So there are two candidates, and both are a **~300 s wall on a single blocking request**:

1. OpenCode's provider-request timeout on one model step, surfacing as a thrown error out of `session.prompt`;
2. Bun's fetch cap on the plugin's own synchronous `POST /session/{id}/message`, which stays open for the **whole** agent loop.

The byte search could not locate how 1.18.30 builds the plugin client (the app bundle is not plain text). Query Q1 tells the two apart: under (2), durations cluster at about 300 s regardless of task. Under (1) they vary, because they are the loop time plus 300 s for the last step.

**Why it fits the tasks it hits.** Map-memories hands a single batch up to `max(240 s, remaining)`, which is often the full 20 minutes for a one-batch backlog. Verify with 1–3 batches gets 400–1200 s. Both are longer than 300 s, so the host wall fires before our timer, which explains 63 map and 66 verify `TimeoutError` rows against few map `prompt timed out` rows. Classify is single-shot, but a 100-memory chunk on a slow reasoning model can exceed five minutes in one request, which explains its 32 rows.

**How our code then mishandles it (ours, independent of the origin):**

- `isNonRetryable` does not recognise `TimeoutError` (`model-suggestion-retry.ts:314-328`), and `classifyPromptFailure` files it as `provider_error` (347-367). The chain therefore **retries the same prompt in the same child session with each fallback model** (`copyPromptArgs(baseArgs…)` keeps `path.id`), and each retry can hit the same wall.
- `promptWithTimeout` only calls `abortChildRun` when *our* signal aborted (238-255). After a host `TimeoutError` the server-side loop is **not** aborted. Under candidate (2) that loop keeps running and billing (the #154 shape), and the fallback's prompt lands in a session that is still busy.
- Map-memories' `isTimeoutClassError` only matches our text (`map-memories.ts:145-149`), so these rows count as `other`. The two-timeout circuit breaker never trips, and the run keeps starting 5-minute-doomed batches until the deadline.

**Work lost.** The whole batch, as in 1a.

Cause: **host wall (OpenCode/Bun), mishandled by us**. Confidence that it is a ~300 s host timer: **high**. Confidence about which of the two host timers: **medium**; Q1 settles it.

**Fix (M).**

1. Do not hold one synchronous request open for an agent loop. For the OpenCode 1 map/verify/classify transports, send with `session.promptAsync` and wait for the child session to go idle (poll `session.status` or `session.messages`) under our own `sliceMs`. Our timer then stays the only authority and still calls `abortChildRun`. This works under either candidate for a single long request. If candidate (1) is confirmed, also set the dreamer child's provider request timeout above the slice, or document `provider.<id>.options.timeout: false` for dreamer models.
2. Treat `error.name === "TimeoutError"` exactly like our timeout: non-retryable in `isNonRetryable`, `provider_timeout` in `classifyPromptFailure`, timeout-class in map's breaker, and call `abortChildRun` on it.

Item 2 is S and should ship first.

---

## 2. `Rust classify module failed: session.send did not return [an active run_id]` (55)

**Code path.** TypeScript: `runClassifyThroughModule` (`classify.ts:537-704`) calls `dreamer.run_task` with `timeoutMs: CLASSIFY_MODULE_RUN_TIMEOUT_MS = 660 000` (81, 588). Any failure is wrapped as `ClassifyModuleFailureError("module", …)`, whose message is `Rust classify module failed: …` (113-121, 501).

Module: `handle_dreamer_run_task` walks the model chain (`crates/mc-module/src/lib.rs:12472-12605`). Each attempt calls `HistorianProducer::start_with_generation` (`crates/mc-module/src/historian_producer.rs:786-855`), which sends `session.send` to Broca and then waits `CLASSIFY_AWAIT_TIMEOUT = 600 s` plus `CLASSIFY_RECOVERY_TIMEOUT = 60 s` of redrain (`crates/mc-module/src/classify.rs:18-19`).

**What it waits on and why it "never returns".** It is not a hang. `session.send` did return, but in a shape the old decoder read as malformed. Broca runs one run at a time per provider session. A send into a session that still has an active run is **queued** and answered with `{state:"pending", submission_id}`, not `{state:"active", run_id}`. Before `76acc1b3fa` (2026-09-19) the classifier used **one provider session for the whole fallback chain**:

- `child_session_id(&authority_project, command_id)`, keyed by command, not by attempt;
- the decoder only read `run_id`.

So whenever attempt 1 ended while its run was still alive (a parked or paused run, or one abandoned at the await deadline), attempt 2's send was queued, decoded as `MissingRunId`, and that message **overwrote attempt 1's real cause** (`last_error = …`). The exact old message was `Rust classify module failed: session.send did not return an active run_id`, with no model prefix. Every row with this text is therefore pre-fix behaviour. The fix, `76acc1b3fa` ("stop reading a queued classify send as a missing run id"), does four things:

- decodes `pending` as `SendQueued` (`historian_producer.rs:1262-1278`, 842-852);
- gives each attempt its own session via `next_attempt_nonce` (`lib.rs:12514-12520`);
- reports every attempt's error, prefixed by model (`lib.rs:12475`, 12531, 12588);
- logs each attempt as `mc-module: classify attempt=… outcome=…`.

The fix is an ancestor of `v0.43.2` (the installed version).

**Remaining issue (ours, S).** The TypeScript transport budget (660 s) equals **one** module attempt (600 + 60 s). If attempt 1 reaches the await deadline, the host abandons the request while the module goes on to attempt 2 and later records a result nobody reads. `command_id` embeds the run's `startedAt`, so the next scheduled retry cannot replay it. Either send `timeoutMs = chain_len × 660 s + slack`, or pass the remaining slice to the module and have it stop the chain when the slice runs out.

**Work lost.** The whole chunk. Nothing is written until `memory.set_classification`.

Cause: **ours** (module decoder and session reuse), already fixed. Confidence: **high** that the 55 rows predate the fix; Q3 confirms with dates. If rows with this exact text appear after the install date of v0.43.x, some host there is still running an older `ck-mc`, and that should be checked first.

---

## 3. Pi: `pi exited (code=…) without emitting agent_end. stderr: … Model "ollama-c…"` (46 + 10 + 8)

**Code path.** `packages/pi-plugin/src/subagent-runner.ts:1796-1808`: the child `pi` process exits non-zero before `agent_end`, and stderr carries Pi's own `Model "<provider/model>" not found`. The Pi dreamer facade (`dreamer/index.ts:438-490`) runs **one model per call**, `body.model`, with `fallbackModels: undefined`. The shared executor owns fallback iteration (`promptSyncWithValidatedOutputRetry`), and this error is retryable (`provider_error`), so **the chain does fall back**. What the ledger shows is the per-attempt row of the failed primary (§0). The next row in the same `session_id` and task is the fallback attempt. Q4 checks this pairing directly.

**Which model.** From the prefix, an `ollama-cloud/…` entry, which is OpenCode's provider id for Ollama Cloud. Pi resolves models from **its own** registry, so an id that works under OpenCode fails under Pi. Model selection per harness is `resolveDreamerTaskModel` (`shared/model-resolution.ts:143-206`): task model → `dreamer.pi.model`. **Exception:** compress-cues falls back to the harness-independent `mural.model` string when the task block sets no model (175-181). A shared `mural.model: "ollama-cloud/…"` would therefore reach Pi unchanged, which explains the "+10, +8 others" if those are compress-cues rows. I cannot read `~/.config/cortexkit/*`. The exact id and its source are in Q4, and the user can check with `pi --list-models | grep -i ollama`.

**Why it still hurts even though the chain falls back:**

- every Pi batch spends a process spawn on a model that can never resolve;
- if the ollama entry is the **only** entry for a task (a task-level `model` with no `fallback_models` inherits an empty chain, 182-185), the task fails outright;
- when all attempts fail with retryable errors, `throwWithPromptFailure` throws the **first** attempt's error (`model-suggestion-retry.ts:764-772`), so the task-level error names the ollama model even when a later fallback failed for a different reason.

Cause: **config (user)**, plus **ours** for not validating the Pi chain. Confidence: **high** on the mechanism, **medium** on which config key. Fixes:

- (S, config) replace or remove the `ollama-cloud/…` entry in the Pi block, or `mural.model`;
- (S) at Pi registration, resolve every chain entry against Pi's model list once and drop unknown entries with a one-time warning;
- (S) make the all-exhausted error name the last attempt's cause and list every model tried.

---

## 4. Output that stops early

| Text | Where | What it proves |
|---|---|---|
| `mappings manifest missing complete root element` (map, 27) | `manifest-parser.ts:17` via `map-memories-prompt.ts` | The final assistant text has **no** `<mappings>` open tag at all |
| `verify manifest missing closing root tag` (verify, 13) | `manifest-parser.ts:15` | `<verify>` opened, never closed |
| `… returned no output` (verify 45, map 25, classify 12) | `verify.ts:348`, `map-memories.ts:411`, `classify.ts:430` | The last assistant message has **no text part** and **no recorded error** |
| `pi assistant produced empty text` (map 27+9) | `subagent-runner.ts:1723-1742` | Pi saw `agent_end`, but the final text was empty (a provider error is appended when Pi recorded one) |

Separating the three shapes:

- **A truncated completion from the output limit is not in these rows.** Validation checks `hasLengthCappedOutput` first (`finish ∈ {length, max_tokens, max_output_tokens}`, `assistant-message-extractor.ts:106-129`) and reports `… returned length-capped output` instead. A `missing closing root tag` therefore means the stream ended mid-manifest **without** a length finish reason. That is a provider cut (stream reset, gateway timeout, or a proxy such as Antigravity that ends with `stop` or `other`), or a model that stopped by itself.
- **The step-cap shape is `missing complete root element` on map.** The mapper agent has `maxSteps: 60` (`agents/hidden-agent-registrations.ts:212`) for an 80-memory batch, against a harness history of about 41 turns per 100 memories (`map-memories.ts:59-66`). When OpenCode 1 reaches `steps`, it forces a final tool-less turn. The model then usually writes a progress summary, with no manifest, so no root. This is the OpenCode 1 cousin of #550. Verify shares the same 60-step agent but reads deeper per memory. Q5 checks the prediction that these rows have long durations (the full loop).
- **An empty provider reply is `returned no output` with a short duration, and on Pi `pi assistant produced empty text`.** When the provider ends a turn with only reasoning, or with nothing (Antigravity empty responses; the table already tags some of the Pi rows), there is no text part. Our `extractLatestAssistantFailure` only fires when the host recorded an error on the message. Classify (`maxSteps: 4`, no tools) can only fail this way, so its 12 rows are provider-empty or reasoning-only replies.
- **The model did not follow the format.** This shows as `missing complete root element` with a *short* duration (a single turn that answered in prose). It overlaps the step-cap row text and is only separable by duration or step count.

**Work lost.** The whole batch or chunk. The only partial save is map's closed-root subset with omissions (`map-memories.ts:272-289`); a missing root saves nothing.

**Evidence gap (ours).** Failed OpenCode rows record no tokens or model (§0), and the child session is archived and swept. Setting `keep_subagents: true` for one night keeps *settled* children only. Unsettled failed children are swept regardless (`shared/keep-subagents.ts:5-8`). The cheapest evidence fix is to record `messages` on failure rows as well. `recordInvocation` already accepts them, and Pi already does this.

Cause: step cap (**ours**, budget), provider empty or cut stream (**provider**), format drift (**model**). Confidence: **medium**, pending Q5. Fixes:

- (S) record messages, tokens and model on failed rows;
- (S/M) size the map batch to the step cap (for example 40 memories per 60 steps, or raise the mapper to 100–120 steps). A prompt-side "you have K steps left: emit the manifest now" warning needs a per-step hook, so it is M;
- (S) classify `returned no output` whose last assistant message carries only reasoning as `empty_completion` from the provider, so it hot-retries on the next model instead of counting as a parse failure.

---

## 5. `prompt aborted by external signal` (22 classify, 21 map, 18 verify, 9 smart notes)

**Who aborts.** In map, verify and classify the only external signal is the lease heartbeat:

```ts
const heartbeat = startLeaseHeartbeat(db, holderId, leaseKey, () => abortController.abort(), leaseAcquisition);
```

This is at `map-memories.ts:232-239`, `verify.ts:183-190` and `classify.ts:310-317`. The heartbeat's `onLost(reason)` string is **discarded**, so the ledger never says why. Smart notes have their own lease abort (`evaluate-smart-notes.ts:76-96`, 140-143). A user action cannot cause this text: `/ctx-dream` waits for the lease (`task-scheduler.ts:366-378`) and never aborts a running task. A process restart kills the process, and a killed process writes no row. So these rows are **lease loss**.

**Why the lease is lost (ours).** From `dreamer/lease.ts`: `LEASE_DURATION_MS = 120 s`, and the heartbeat renews every 60 s (218). In `startLeaseHeartbeat` (233-320), when a renewal fails because the lease already expired, the code checks `Date.now() - lastConfirmedAt > 120 s` **before** trying to reacquire (282-285). A lease only expires after more than 120 s without a renewal, so that check is essentially always true, and **any expiry is declared lost even when nobody else took the lease**. The reacquire branch (286-297) is effectively unreachable. Three triggers on this box:

1. **The machine sleeping mid-run.** Tasks run 02:00–04:15 on a laptop. A sleep or dark-wake gap of more than 2 minutes loses the lease on the next beat, and the in-flight prompt is aborted. Q6 predicts a duration far longer than the slice, clustered at night.
2. **One failed beat.** A renewal that throws (`SQLITE_BUSY` after the 5 s busy timeout, with several OpenCode processes, Pi and `ck-mc` sharing `context.db`) is silently skipped. The next beat arrives slightly after `t0+120 s`, finds the lease expired, sees a gap over 120 s, and declares loss.
3. **Starting on an already-expired lease.** Every task in a domain group shares one acquisition (`task-scheduler.ts:366`, 421-427), and the heartbeat seeds `lastConfirmedAt` from `acquisition.acquiredAt` (247-248). If more than 120 s pass without a renewal between two tasks of the group (a preceding task without its own heartbeat, or a slow authority check in `resolveDreamerModuleRoute`), the next task's first synchronous beat declares loss at once, before any prompt. Q6 predicts near-zero durations.

**Work lost.** The in-flight batch or chunk. Earlier batches stay committed. The task is recorded as transient and hot-retried.

Cause: **ours** (heartbeat logic), triggered by the host (sleep, SQLite contention). Confidence: **high** that it is lease loss, **medium** on the trigger mix (Q6). Fix (S):

- In `beat()`, when renewal fails, first reacquire if the holder is still us and the generation is unchanged. Only declare loss when another holder or generation is confirmed, which is the property the lease exists to protect.
- Pass the loss reason into `abort(new Error(reason))` and into the ledger text.
- Renew once at the start of each task in a group.

---

## 6. `ModuleMemoryAuthorityError: memory writes for module-managed project` (classify, 12)

**Code path.** `runClassify` takes the module route only when `resolveDreamerModuleRoute` returns a route (`task-executor.ts:422-443`, 745-754; `dreamer/module-apply.ts:40-78`). It returns `undefined`:

- when the host is in explicit TS mode (`transformMode === "ts"`, 55);
- when the host has **no module client** (a Pi host, or OpenCode in TS mode);
- when the module reports a state other than `MODULE`.

The TypeScript path then **runs the whole LLM classification first** and only at apply time calls `setMemoryClassification` → `assertTsMemoryIdWriteAllowed` → `assertTsMemoryWriteAllowed`. That function finds the project in `authority_managed` or `authority_repair_pending` and throws (`memory/storage-memory.ts:596-620`, 1099-1111). Projects share their `git:<sha>` identity across hosts. So when a project is flipped to MODULE by a Rust-mode OpenCode, every **other** host that dreams it (Pi, a TS-mode OpenCode, or a stale process) spends a full classify prompt and then fails at the write.

**Same class, not in the ledger.** The OpenCode log has 81 × `[dreamer] timer-triggered task scheduling failed for git:1e394c247b8d97d63170b90b218b766fc95704aa: context.db note writes are managed by the Rust module` in about 11 hours (every 15-minute tick). This is the `notes_authority_guard_*` trigger (`features/magic-context/migrations.ts:242-262`) firing inside the dream tick's `try` (`plugin/dream-timer.ts:577-621`). The first note writer there is `runCompiledSmartNoteSweep` (673-692), which runs **before** `runDueTasksForProject`. So for that project, **no dreamer task runs at all** from that OpenCode host, and nothing reaches `subagent_invocations`. Confidence: medium, because the log line has no stack.

**Work lost.** The whole LLM spend for each chunk; nothing is written.

Cause: **ours** (route choice happens after the spend). Confidence: **high**. Fix (S): before any prompt, check `authority_managed` for the project. If it is module-managed and this host has no module route, skip the task as `not_owner` (advance the schedule, no error row) or route the apply through the module. Apply the same pre-flight to `runCompiledSmartNoteSweep`, and move it out of the shared `try` so a notes refusal cannot block the memory tasks.

---

## 7. Does a failed run lose all of its work? Save points per task

| Task | Unit of commit | Saved as it goes? | On failure |
|---|---|---|---|
| map-memories | 80-memory batch, host-applied after a validated manifest (`applyParsedBatchMappings`) | Yes, per batch; a closed root with omissions banks the valid subset and re-queues the rest once | The failed batch is lost; the run continues for non-timeout failures, stops after 2 consecutive own-timeouts, and ends on abort |
| verify / verify-broad | 50-memory batch (`applyParsedVerifyManifest`, per-memory `verified_at`) | Yes, per batch | The failed batch is lost; **any timeout or provider failure ends the run** (`verify.ts:375-382`); parse failures continue |
| classify-memories | 100-memory chunk (`applyClassifications`, or `memory.set_classification` on the module route) | Yes, per chunk | The failed chunk is lost; the module route and non-parse prompt failures end the run |
| curate, other ctx_memory agentic tasks | each tool call | Yes, per tool call | Only the remaining calls are lost |

Within a batch nothing is saved. Every tool read happens before the single manifest, so a timeout, step cap, abort or empty reply discards the whole batch's spend. Across runs, progress is durable: map drains unmapped memories, verify drains by per-memory `verified_at`, and classify drains by `classified_at`.

## 8. Scaling with memory count (the #550 concern)

- **verify / verify-broad scale worst.** Batches = `ceil(inScope/50)` with no cap. The slice is `timeout / batches`, with no floor. Past about 200 in-scope memories on the 20-minute default, every slice is under 300 s. Past about 400 it is 150 s or less, and the first batch times out and ends the run. That is a deterministic nightly failure for large projects. verify-broad puts every mapped memory whose `verified_at` predates the broad cycle in scope (`verify-gate.ts:39-42`), so it hits this first.
- **map-memories** only scales with the *unmapped* count (plus ≤80 re-queued rows). The 240 s floor keeps slices sane, but a single large batch still runs into the ~300 s host wall (§1b) and the 60-step cap (§4).
- **classify.** Pools of 10–100 memories re-classify **the whole pool every run** (Stage 2, `classify.ts:271-274`), which is a constant but repeated spend. Above 100 only unclassified memories plus 30 anchors are sent (Stage 3), so cost is bounded by new memories. The module-route budget is fixed at 660 s per chunk regardless of the slice.
- **Per-run setup** (`getMemoriesByProject`, verifications) is O(N) SQLite and not a concern.

## 9. Queries to run (read-only)

Open with `sqlite3 "file:$HOME/.local/share/cortexkit/magic-context/context.db?mode=ro"`. All times are milliseconds since the epoch. `W` = 14 days: `(strftime('%s','now')-14*86400)*1000`.

**Q1: which host timer (1b).**
```sql
SELECT harness, task,
       COUNT(*) n,
       MIN((ended_at-started_at)/1000) min_s,
       CAST(AVG((ended_at-started_at)/1000) AS INT) avg_s,
       MAX((ended_at-started_at)/1000) max_s,
       SUM((ended_at-started_at) BETWEEN 295000 AND 310000) near_300s
FROM subagent_invocations
WHERE subagent='dreamer' AND error LIKE 'TimeoutError%'
  AND started_at > (strftime('%s','now')-14*86400)*1000
GROUP BY harness, task ORDER BY n DESC;
```

**Q2: own-timer slices versus scope (1a).**
```sql
SELECT task,
       CAST(substr(error, instr(error,'after ')+6) AS INTEGER)/1000 AS slice_s,
       COUNT(*) n
FROM subagent_invocations
WHERE subagent='dreamer' AND error LIKE 'prompt timed out after %'
  AND started_at > (strftime('%s','now')-14*86400)*1000
GROUP BY task, slice_s ORDER BY task, slice_s;

SELECT project_path, COUNT(*) active FROM memories WHERE status='active' GROUP BY project_path ORDER BY active DESC;
```

**Q3: the classify module error is pre-fix (2).**
```sql
SELECT date(started_at/1000,'unixepoch','localtime') day, harness, COUNT(*) n
FROM subagent_invocations
WHERE error LIKE '%session.send did not return%'
GROUP BY day, harness ORDER BY day;

SELECT substr(error,1,160) e, COUNT(*) n, date(MAX(started_at)/1000,'unixepoch','localtime') last_day
FROM subagent_invocations
WHERE task='classify-memories' AND error LIKE 'Rust classify module failed%'
GROUP BY e ORDER BY n DESC;
```

**Q4: which Pi model, and did the chain fall back (3).**
```sql
SELECT task, provider_id||'/'||model_id AS model, substr(error, instr(error,'Model "'), 80) AS stderr_model, COUNT(*) n
FROM subagent_invocations
WHERE harness='pi' AND error LIKE '%without emitting agent_end%'
  AND started_at > (strftime('%s','now')-14*86400)*1000
GROUP BY 1,2,3 ORDER BY n DESC;

SELECT a.task, b.provider_id||'/'||b.model_id AS next_model, b.status, COUNT(*) n
FROM subagent_invocations a
LEFT JOIN subagent_invocations b
  ON b.id = (SELECT MIN(c.id) FROM subagent_invocations c
             WHERE c.harness='pi' AND c.session_id=a.session_id AND c.task=a.task AND c.id>a.id
               AND c.started_at <= a.ended_at + 10000)
WHERE a.harness='pi' AND a.error LIKE '%Model "ollama-c%'
GROUP BY 1,2,3 ORDER BY n DESC;
```

**Q5: step cap, empty reply or format drift (4).**
```sql
SELECT task, harness,
       CASE WHEN error LIKE '%missing complete root%' THEN 'no_root'
            WHEN error LIKE '%missing closing root%' THEN 'unclosed'
            WHEN error LIKE '%returned no output%' THEN 'no_text'
            WHEN error LIKE '%empty text%' THEN 'pi_empty' END AS shape,
       CASE WHEN ended_at-started_at < 60000 THEN '<1m'
            WHEN ended_at-started_at < 300000 THEN '1-5m' ELSE '>5m' END AS dur,
       provider_id||'/'||model_id AS model,
       COUNT(*) n, CAST(AVG(output_tokens) AS INT) avg_out
FROM subagent_invocations
WHERE subagent='dreamer' AND started_at > (strftime('%s','now')-14*86400)*1000
  AND (error LIKE '%manifest missing%' OR error LIKE '%returned no output%' OR error LIKE '%empty text%')
GROUP BY 1,2,3,4,5 ORDER BY n DESC;
```

**Q6: lease-loss trigger (5).**
```sql
SELECT task, harness,
       strftime('%H', started_at/1000,'unixepoch','localtime') hour,
       CASE WHEN ended_at-started_at < 5000 THEN 'at_start'
            WHEN ended_at-started_at > 1200000 THEN '>20m (sleep?)' ELSE 'mid_run' END AS when_aborted,
       COUNT(*) n
FROM subagent_invocations
WHERE error LIKE '%aborted by external signal%'
  AND started_at > (strftime('%s','now')-14*86400)*1000
GROUP BY 1,2,3,4 ORDER BY n DESC;
```
Correlate with sleep: `pmset -g log | grep -E "^\S+ \S+ \S+ (Sleep|Wake|DarkWake)"` for the same nights.

**Q7: authority refusals by host and project (6).**
```sql
SELECT s.harness, d.project_path, COUNT(*) n
FROM subagent_invocations s
LEFT JOIN dream_runs d ON d.parent_session_id = s.session_id
WHERE s.error LIKE 'ModuleMemoryAuthorityError%'
GROUP BY 1,2;

SELECT * FROM authority_managed;
SELECT project_path, task, last_status, retry_count, substr(last_error,1,160)
FROM task_schedule_state WHERE last_status='failed' ORDER BY project_path, task;
```

## 10. Ranked fix list

| # | Fix | Classes | Size | Why this rank |
|---|---|---|---|---|
| 1 | Verify: give each batch a floor (for example 240 s), stop starting batches that cannot get it, and treat a batch timeout as "bank and stop cleanly" (complete=false) rather than a thrown failure that hot-retries the same doomed slice | 1a, 8 | S | Largest single bucket (verify 43%). Failure is deterministic and grows with memory count |
| 2 | Treat host `TimeoutError` as a timeout: non-retryable, `provider_timeout`, map breaker counts it, `abortChildRun` on it | 1b | S | Stops burning every fallback against the same wall and stops orphaned server loops |
| 3 | Lease heartbeat: reacquire an expired lease that is still ours before declaring loss; carry the reason into the abort and the ledger; renew at each task start | 5 | S | About 70 aborts. The current logic turns any 2-minute gap, including sleep, into a lost batch |
| 4 | Authority pre-flight before prompting (classify, and the smart-note sweep in the tick); skip as not-owner; move the note sweep out of the tick's shared `try` | 6 | S | Zero-value LLM spend; one project's dreamer is fully blocked on OpenCode |
| 5 | Replace synchronous `session.prompt` with `promptAsync` + idle wait under our slice for OpenCode 1 agentic dreamer tasks (or confirm and raise the provider timeout if Q1 shows candidate 1) | 1b | M | Removes the ~300 s wall for tool loops |
| 6 | Pi: validate the chain against Pi's model list at registration; fix the `ollama-cloud/…` config entry; name the last cause in the all-exhausted error | 3 | S (+config) | Wasted spawn per batch; hard failure when it is the only entry |
| 7 | Size map/verify batches to the 60-step cap (or raise the mapper cap) | 4, 8 | S | Step-cap `no_root` rows (to confirm with Q5) |
| 8 | Record messages, tokens and model on failed OpenCode dreamer rows | 4 (evidence) | S | Without this, §4 stays inferred from durations |
| 9 | Classify module route: send a budget that covers the chain (or pass the slice to the module) | 2 residue | S | The 55 rows are fixed already; this closes the abandoned-attempt waste |
| 10 | Classify Stage 2: stop re-scoring the whole ≤100 pool every run (gate on unclassified or changed, as Stage 3 does) | 8 | S | Repeated spend, not a failure |

## Side notes (outside the six classes)

- The Pi boot log shows `project=dir:6666cd76f969 | dir=/`, which is md5 of `/`, registered for dreaming (`[dreamer] registered project dir:6666cd76f969`). A Pi process started with cwd `/` dreams the filesystem root as a project.
- `[dreamer] project directory no longer exists (git:…); skipping + unregistering` repeats 223× for one identity in the 11-hour window. Registration is re-created and removed on every tick. This is log noise, not a failure.
