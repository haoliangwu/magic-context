# Issue 587: dreamer sessions in OpenCode clients

## Outcome

Tested **OpenCode 1.18.33** (`opencode-ai`, npm) and **OpenCode 2.0.20** (`@opencode/cli`, npm) on macOS arm64, using only a loopback OpenAI-compatible mock. No reporter credentials or live stores were used.

- **OpenCode 1:** Dreamer children now require a real parent session. The executor prefers its supplied parent, otherwise selects an ordinary root, excluding previous Magic Context sessions and other subagents. If none exists, the spawn gate declines to create a session and logs the deferral. An unsuccessful lookup is not cached permanently: a later run can discover the first ordinary session. The real host excluded the parented child from `session.list(roots=true)`.
- **OpenCode 1:** Desktop's error-notification handler already ignores sessions with `parentID`. Parenting prevents the background error notification without suppressing host failure events or Magic Context's own failure logs.
- **Both lanes:** Genuine empty-output validation errors now include the host/provider finish reason and whether reasoning was present. OpenCode 1's asynchronous transport no longer mistakes an accepted user row with no settled assistant for a completed empty reply. Its existing plugin event hook forwards `session.error` into active child waits, preserving errors that precede assistant creation. Structured assistant errors also retain status and message instead of becoming `[object Object]`.
- **OpenCode 2:** The exposed session-creation API cannot set `parentID` or a hidden-session flag. Its existing metadata does not hide the carrier. No database manipulation, fake parent, relocation, or dreamer disablement was added. This remains an upstream limitation, as agreed with the task owner. See the draft request below.

The task owner supplied a likely root cause: DeepSeek now accepts `deepseek-flash` and `deepseek-v4-pro`, not the reporter's `deepseek-v4-flash`. The mock reproduced that exact HTTP 400 message through a real v1 dreamer mapping task, with provider status/message persisted in invocation telemetry and written to the dreamer log. It also reproduced a pre-assistant unknown-model dispatch error. This is not a live DeepSeek-account trial: the reporter's underlying host error payload was unavailable, so whether their host rejected the name locally or reached DeepSeek remains unconfirmed.

## Reproduction and isolation

Committed reproducer: `packages/e2e-tests/scripts/probes/issue-587.ts`. It exercises the actual v1 child-spawn helper and asynchronous wait helper against the installed host, and exercises v2 creation, listing, prompting, waiting, context retrieval, interruption, and events through the installed client. It runs the actual v1 `mapMemories` task with a throwaway in-memory context database. Its SSE bridge calls the same error-recording function as the plugin event hook; a separate integration test invokes the actual hook. It does not boot the entire Magic Context plugin or a graphical Desktop process; Desktop notification conclusions below are from the exact host source.

```sh
ROOT="${TMPDIR:-/tmp}/magic-context/issue-587"
mkdir -p "$ROOT/install-v1" "$ROOT/install-v2"
npm install --prefix "$ROOT/install-v1" opencode-ai@1.18.33 --no-audit --no-fund
npm install --prefix "$ROOT/install-v2" @opencode/cli@2.0.20 --no-audit --no-fund
bun install --frozen-lockfile
bun packages/e2e-tests/scripts/probes/issue-587.ts
```

Before importing plugin helpers, the probe process also resets its own HOME/XDG/TMPDIR beneath `$ROOT/probe-home` and later records its own lsof snapshot. The runner creates new `v1-*` and `v2-*` roots beneath `$ROOT` and overrides HOME, XDG config/data/cache/state/runtime, TMPDIR, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, and `MAGIC_CONTEXT_LOG_PATH`. Host environment is not copied wholesale; provider credentials are the literal `mock-only`. Default plugins and model-catalog fetching are disabled. The mock binds to `127.0.0.1`; generation requests use only its endpoint. Host ports are independently allocated from a temporary socket reservation, and requests are made only after the spawned process announces that exact port. A failed bind cannot cause the runner to talk to an unrelated server. The v2 host uses `serve` without `--service`; 2.0.20 no longer accepts the earlier harness's `serve --standalone` flag. The temporary server password is not committed.

The script asserts root-list membership, parenting behavior, database descriptor isolation, and the presence of the expected host error event. It records raw events, replies, message histories, and **`lsof -p <host-pid>`** in `$ROOT/evidence.json`, with host logs and a summary alongside it. In the final run:

```text
Final v1 store: .../magic-context/issue-587/v1-ju2xWP/data/opencode/opencode.db
Final v2 store: .../magic-context/issue-587/v2-n4uOQ4/data/opencode/opencode2.db
```

The final descriptor capture had v1 descriptors `7u`, `8u`, `9u` (database/WAL/SHM; duplicated database connections are also present) and v2 descriptors `8u`, `9u`, `10u` under their respective throwaway roots. The script verifies **every `.db`, `.db-wal`, and `.db-shm` descriptor** is beneath that host's root. No descriptors point at `~/.local/share/opencode/*.db` or live CortexKit storage. Magic Context helpers log under `$ROOT/probe-mc`; unit-test databases are in-memory or test fixtures. No live config/store was opened to establish the isolation proof.

## OpenCode 1 session visibility and errors

Dreamer stages create titled sessions such as `magic-context-dream-map-memories`, `magic-context-dream-verify`, and `magic-context-dream-classify`. The agent is chosen on the prompt: mapper, verifier, classifier, retrospective, docs, or base dreamer, depending on the stage. Before this change, a missing parent lookup permitted `session.create` without `parentID`, producing an ordinary root. A hidden agent does **not** imply a hidden session.

Historian creation uses the same fenced helper but supplies the conversational parent. Its v1 executor uses synchronous prompts, whereas dreamer children use `prompt_async` and idle/message polling when available. OpenCode's built-in subagent visibility likewise depends on the child relationship, not the title or the agent-picker setting: [`v1.18.33/tool/task.ts:158–161`](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/tool/task.ts#L158-L161) creates its child with `parentID: ctx.sessionID`, a descriptive subagent title, and the selected agent.

Exact-version sources:

- [`v1.18.33/session/session.ts`](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/session.ts): create input at lines 416–424; parent carried into the session at 499–537; root-list filters at 555–563 and 985–987 exclude rows with `parent_id`.
- [`v1.18.33/app/context/notification.tsx`](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/app/src/context/notification.tsx#L366-L395): `session.error` looks up the session and returns for a child with `parentID` before notifying.

Real-host result: child `ses_f0cd9317cffeTV3gVSFpaf8r8D` had parent `ses_f0cd9318cffex8CZJmzzGzWDb6`; the root list contained only the parent. Raw, unfiltered session APIs can still enumerate children, as they do for OpenCode's own subagents. Existing leaked roots are not retroactively reparented; the existing age-gated cleanup still owns them.

The v1 controls emitted these `session.error` events (the final run additionally contains the exact DeepSeek-shaped model 400 from the mapping task):

1. `APIError`, HTTP 400, `mock provider failure`.
2. `UnknownError`, `Model not found: missing-provider/missing-model.`
3. A second host error with the corresponding `ProviderModelNotFoundError` stack.

Reasoning-only and genuinely empty successful replies emitted **no** `session.error`. Calling the abort endpoint during a delayed provider request persisted `MessageAbortedError: Aborted` on the assistant row but emitted **no additional `session.error`** in this version. Thus the reproduced user-facing notification comes from the host's provider/dispatch error, not our validator's `no output` exception; timeout cancellation alone did not generate that notification in the tested build. Historian has no exemption from provider-error generation, but its existing parent relationship suppresses Desktop notifications in the same handler.

## The 30-second failure and DeepSeek-shaped output

The v1 transport's `DEFAULT_START_GRACE_MS` is **30,000 ms**. Previously, if `prompt_async` accepted a user row but the host failed before producing an assistant, the transport returned success at that grace boundary merely because a fresh message existed. The task then fetched messages, found no assistant text, and threw `<task> returned no output`. Since validation never succeeded, teardown also reported `prompt unsettled` and left the child to the age-gated sweep. This matches the reported timing and log sequence without needing a 30-second provider timeout.

The mock tests distinguish these cases:

| Mock/host case | OpenCode 1.18.33 | OpenCode 2.0.20 |
| --- | --- | --- |
| Text content | Text part, `finish=stop` | Text content, `finish=stop`, `rawFinish=stop` |
| Only `reasoning_content`, empty content | Reasoning part only, `finish=stop` | Reasoning content only, `finish=stop`, `rawFinish=stop` |
| Empty content, `finish_reason=stop` | No text/reasoning, settled assistant | Empty content array, settled assistant |
| Tool-call turn followed by an empty final turn | Intermediate `finish=tool-calls`, tool part; final `finish=stop`, no text | Same two-turn shape |
| Provider HTTP 400 | Persisted APIError and `session.error` | Persisted `provider.invalid-request` and `session.execution.failed` |
| Abort during provider delay | Persisted MessageAbortedError; no error event | Persisted `aborted`, interrupted run; no additional failed event |
| Missing model before assistant creation | User-only row and host errors; before adding the event bridge, the wait rejected at **30,946 ms** with `observed_busy=false`. Final code captures `Model not found` in **1,014 ms**. | Not used as the v2 timing explanation |

In the final run, successful reasoning-only replies settled in 28 ms (v1) and 17 ms (v2), and empty replies in 24 ms and 26 ms respectively. An earlier cold v1 text control took 76 seconds on the shared machine; later text controls took approximately one second. The reproducer needs room for cold startup and now waits for host termination, escalating only its own spawned process if graceful shutdown stalls. Earlier unbounded shutdown trials completed their assertions but kept the command alive; the bounded-cleanup trial exited successfully. They did **not** reproduce the 30-second wait. The unknown-model async case did. Without a delivered host error, the fixed helper reports `prompt_async did not start a run with a settled assistant ... within 30000ms`, rather than passing that user-only history to output validation as a successful completion. With the plugin event bridge, it instead surfaces the first matching host error at the next poll, even when no assistant exists. Tracking is restricted to active waits and removed on settlement/rejection/abort; ordinary session errors are not retained or changed.

Reasoning-only content is not a manifest: accepting private reasoning as final mapping, verification, or classification would permit incomplete plans to mutate memories. Extraction therefore remains text-only for these tasks. The historian has a separate reasoning fallback guarded by its compartment validation. Tool results are likewise not final manifest text. Curate already accepts tool-only work when actual `ctx_memory` operations completed; its regression test remains green. The mock's tool control uses an unavailable tool (no filesystem mutation) and then an empty final turn; it is not a claim that an unavailable tool successfully performed maintenance.

True empty reply errors now include diagnostics such as `map-memories returned no output (finish=stop, reasoning=false, tools=0)`; v2 reads the carrier's `tokenLog.finish_reason`. Missing finish metadata is explicitly `unknown`, not a guessed provider reason. Persisted provider errors continue through their existing error path.

## DeepSeek invalid-model 400 and doctor validation

The mock advertises `mock/deepseek-v4-flash` to the host so the request reaches the API rather than being refused locally. It **asserts the actual outgoing API model is `deepseek-v4-flash`**, then returns:

```json
{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-flash","type":"invalid_request_error"}}
```

The real v1 `mapMemories` task, which asks the dreamer model to associate stored memories with project files, failed in **1,029 ms**. This exercises the same background mapping path that reported `returned no output` in issue 587. Its persisted `subagent_invocations` row had `task=map-memories`, `status=failed`, `modelId=deepseek-v4-flash`, and:

```text
DreamerProviderOutputFailureError message="Host recorded session error: APIError: The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-flash (status=400)"
```

The same message/status was asserted in the **newly appended** dreamer log, not an older probe's log; no invocation error contained `returned no output`. The task created another parented child, and the post-task root list still contained only the ordinary parent. This demonstrates task logging and persisted telemetry, not merely reading a proxy for the provider response. A structured assistant-row control separately verifies status/message survive through the retry wrapper when the event has already settled.

The installed v1 host also rejected an attempt to use `deepseek/deepseek-v4-flash` before generation with `Model not found ... Did you mean: deepseek-flash, deepseek-v4-pro?`. That path previously needed the 30-second grace to escape; active error forwarding now retains its precise message too. This is why the mock uses an explicitly advertised mock-provider model for the HTTP-400 control.

Doctor already checks configured historian/dreamer/fallback names against the matching host catalog in `packages/cli/src/commands/doctor-opencode.ts` (`checkConfiguredVariantCatalog`, called by `doctorOpencode`). The new focused regression uses a catalog containing only `deepseek-flash` and `deepseek-v4-pro`, with the reporter's dreamer name and their working historian name. It warns only for dreamer:

```text
dreamer model deepseek/deepseek-v4-flash is not offered by provider 'deepseek' on this OpenCode host. The dreamer cannot run on it; choose a model listed by opencode models --verbose.
```

A stale host catalog that still advertises `deepseek-v4-flash` produces no warning, demonstrated by a second control in the same test. Doctor does not issue live provider completions and cannot establish whether an advertised ID has been withdrawn remotely. No doctor production behavior was changed: corrected catalog validation already exists, and actual run errors now retain the provider's message when that catalog is stale.

## OpenCode 2 limitation and notifications

Exact version source was inspected at tag `v2.0.20`, commit `84c9be93a56304a108f1a22df0c5d62c26d5b6ca`, in a throwaway clone under `$ROOT/source-v2`.

- [`protocol/src/groups/session.ts`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/protocol/src/groups/session.ts#L220-L230) exposes create fields `id`, `title`, `agent`, `model`, `location`, `metadata`, `permissions`, **not** `parentID` or `hidden`. The server forwards those fields. Internal [`core/src/session.ts`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session.ts#L82-L91) has a separate parented-create alternative, and validates the parent exists at lines 250–258; this is not the injected plugin/client API.
- [`core/src/session/store.ts:99–138`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session/store.ts#L99-L138) lists by parent/project/location and other ordinary list fields, not metadata or permissions. [`core/src/session/info.ts:47–55`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session/info.ts#L47-L55) carries metadata/permissions into returned records without hiding them.
- Web Home requests `parentID: null` and excludes child/archived sessions: [`app/src/home/sessions/index.ts:30–57`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/app/src/home/sessions/index.ts#L30-L57). Location restricts a selected-directory view, not all-session visibility; see `records.ts:17–28` in the same directory.
- [`tui/src/component/dialog-session-list.tsx:58–100`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/tui/src/component/dialog-session-list.tsx#L58-L100) requests roots on the remote path and scopes location/project. Its local path only explicitly excludes children during a search. Neither path treats `metadata.magic_context`, hidden agents, or permissions as a hidden-session flag.
- `agent.hidden` affects agent selection (`core/src/agent.ts:92–103`), not session listing. Changing location could conceal work from one scoped view but would not conceal it from all-projects clients and would change project/tool semantics; that is not a safe fix.
- [`app/src/shell/notifications/notification.tsx:253–291`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/app/src/shell/notifications/notification.tsx#L253-L291) handles **`session.execution.failed`**, skips actual children, records an error, and calls the platform notifier if error notifications are enabled. The browser notifier requires permission and skips visible/focused pages (`app/src/runtime/platform/web.ts:21–40`). The shared app path applies to the injected Desktop platform too; a native OS popup was not exercised here.
- [`tui/src/feature-plugins/system/notifications.ts:4–18,61–72`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/tui/src/feature-plugins/system/notifications.ts#L4-L18) handles execution failure, requests an error notification and toast, and suppresses notifications for actual child sessions (sound is separately requested).

The v2 real host created `ses_f0cd91fe4ffeBd24o1N5rEVuBv` with `metadata={magic_context:"hidden-run", role:"dreamer"}` and the supplied work location. Attempting to pass an extra `parentID` through the public client did not parent it: the returned record had no parent and **the root list included it**. The captured HTTP-400 failure emitted `session.execution.failed` with `provider.invalid-request`. Therefore these current carriers are eligible for user-facing failure notifications; neither metadata nor agent hiding supplies an exemption. The existing v2 hidden carrier still enforces internal prompt/tool isolation and retirement, but those are not client invisibility controls.

### Draft upstream request (not filed)

> Please expose a plugin-facing way to create a parented or internal session. OpenCode 2's internal Session.create already accepts a parentID, but public and injected plugin session.create do not. Background historian/dreamer plugins need either a parentID-bearing creation API or an explicit internal/hidden attribute honoured consistently by root/session pickers and completion/error notifications. It should work before a user conversation exists, preserve provider errors for the plugin/event stream, and avoid exposing background sessions or their notifications as ordinary user work. Metadata and agent.hidden currently do not provide this contract. We can reproduce on @opencode/cli 2.0.20 with a loopback mock: metadata magic_context=hidden-run still appears in root lists and an HTTP-400 turn emits session.execution.failed to notification handlers.

## Verification

- `bun install --frozen-lockfile`: restored worktree package links; no manifest or lockfile changes.
- Plugin `bun run typecheck`: passed.
- Plugin `bun run lint`: passed (1,091 files).
- Final affected dreamer/v2/shared/event suites: **801 passed, 1 failed** across 87 files. The unrelated, unchanged `createV2StorageGate > restores the native write busy window after a non-blocking boot open` timed out at 30 seconds while real-host probes were active; retry at 60 seconds alongside another probe also timed out and yielded an undefined database (6 other storage tests passed). After the probes stopped, the entire storage-gate file passed **7/7** without code changes, including the busy-window test in 11.6 seconds. No storage-gate/schema changes were made. Narrow changed-path suites passed: 107 tests for shared transport/retry and the actual event hook; 33 verifier tests also passed separately. An earlier full run had only the primer fixture's old parentless mock failure, which was corrected and its impacted heap test passed.
- Early 5-second runs and one 180-second mixed-suite command hit timeout limits. The completed 802-test run used the package's 30-second per-test setting and a larger command cap; the concurrent storage-open timeout is recorded rather than treating that mixed run as a green gate. Its failed file was subsequently verified serially.
- CLI doctor typecheck, lint (121 files), and focused doctor suite: passed, 42 tests.
- Plugin `bun run build`: passed, including both v1/v2 bundles and 4 v2 server-loader tests; generated TUI output caused no tracked changes.
- Comment review: no unclear comments flagged. The first AFT inspect checkpoint was interrupted after six phases. Its later fresh scoped result still had no authoritative diagnostics: the TypeScript producer could not locate an SDK and Biome published no diagnostics within the budget. Actual TypeScript and Biome command-line gates above passed.
- Real-host probe: passed assertions on both requested installed versions, including root-list filtering, event presence, and lsof store isolation.
- Spawn-guard mutation: disabling only the parentless guard made `defers parentless dreamer work without creating a visible root` fail; the other four fence tests remained green. Staged implementation was restored and the working diff was empty afterward.
- Finish-diagnostic mutation: disabling only settlement annotation made `empty v1 and v2 replies report the provider finish reason` fail; the other 30 retry tests remained green. Restored tests passed (36 across both files).
- Host-event forwarding mutation: omitting the active-child handoff made only `forwards an early dreamer model error into its active asynchronous wait` fail; the other 59 event-hook tests passed. Restored hook suite passed 60/60, with an empty working diff after restoration.

The test-fixture changes supply a real conversational parent instead of allowing parentless mock creation. This intentionally changes the startup/session-visibility contract; it does not reverse output validation, memory safety, provider-error, or tool-only-curate claims.
