# Open issue triage against v0.44.0

Date: 2026-09-28. Scope: the 41 open issues in cortexkit/magic-context listed below, checked against tag `v0.44.0` (bump commit `013312c7`), with `v0.43.2`, `v0.43.1` and `v0.43.0` checked for fixes that shipped earlier. Nothing has been posted, labelled or closed on GitHub. The notes below are drafts.

How evidence was gathered: every issue and all of its comments were read. Fix commits were found with `git log --grep` (most commit subjects say "issue N" rather than "#N") and with the commit named in our own replies. Containment was checked with `git merge-base --is-ancestor <sha> <tag>`. "in v0.44.0" means the commit is an ancestor of `v0.44.0` and not of `v0.43.2`. "in v0.43.2" means it is an ancestor of `v0.43.2`, and so also of `v0.44.0`. "master only" means it is on master but not an ancestor of `v0.44.0`.

Classes: SHIPPED (everything asked for or agreed is in a released version), PARTIAL (some of it shipped), MASTER-ONLY (fixed only after the tag), OPEN-DESIGN (feature request, design discussion, or blocked upstream, with no shipped resolution), NEEDS-INFO (we asked the reporter something and have no answer).

## Summary

| Issue | Title (short) | Class | Version / commit evidence (tag containment) | Action |
|---|---|---|---|---|
| #552 | Pi loads unrelated OpenCode history into its heap | MASTER-ONLY | `7eff024b38` master only (not in v0.44.0) | keep |
| #551 | OC2: unset `historian.maxTokens` sends no output cap; reasoning-only truncation | PARTIAL | diagnostic: merge `4ce766b` in v0.44.0; live reload of `historian.maxTokens` / `dreamer.maxTokens`: `7e00707c55` master only | keep |
| #550 | Hidden step-cap abort reported as HiddenProviderError | PARTIAL | attribution (`step_limit`, MC-D10): merge `a954db640e` in v0.44.0; step-cap policy and `verify manifest missing closing root tag`: no commit | keep |
| #548 | OC2 hidden provider failure can poison a child | SHIPPED 0.44.0 | PR #549 merge `bc62841908` and review fix `8e6fb20b76`, both in v0.44.0 | close |
| #547 | `ctx_reduce` returns success even though it failed (Pi) | SHIPPED 0.44.0 | merge `0b0e79a480` in v0.44.0 | close |
| #546 | OC2: every turn refused in silence ("context storage is not durable") | SHIPPED 0.44.0 | `e14feb01a5`, `aec755f82d`, merge `f93907bfa5`, all in v0.44.0 | close |
| #545 | Marked items didn't drop after long pause | SHIPPED 0.44.0 | `f195250849`, merge `7aae18efa0`, in v0.44.0 | close |
| #543 | Auto-embed compartment history when memory is disabled | SHIPPED 0.44.0 | `6b77e8705b`, merge `88ece73ffd`, in v0.44.0 | close |
| #542 | Dashboard shows "No projects yet" on OpenCode 2 | SHIPPED 0.44.0 + Dashboard 0.18.0 | plugin/doctor merge `379655f83c` in v0.44.0; dashboard fixes in tag `dashboard-v0.18.0` (`e0c06d9933`, after v0.44.0) | close |
| #541 | Rust historian: prompts size-checked only with `context_limit_tokens`, never for fallbacks | PARTIAL | `cd1b13f7a2`, merge `e286d94bb1` in v0.44.0; `historian.context_limit_tokens` on the host-runner path: not fixed (see note) | keep |
| #540 | Older `ck-mc` on a v53+ store fails note writes; is rollback supported? | SHIPPED 0.44.0 | merge `1df5ecc004` in v0.44.0 (npm and `ck-mc`) | close |
| #539 | Image reading broken on OpenCode 2 | SHIPPED 0.44.0 | `910598faee`, merge `9e281c951b`, in v0.44.0 | close |
| #538 | Compaction boundary absent from message list; pressure escalation | SHIPPED 0.44.0 | `881e973`, `67f44f5`, `e4966b8`, `dd57c43943`, `d9787a5a21`, merge `2e9293d257`, all in v0.44.0 | close |
| #537 | Fragmented memories: links, composites, taxonomy-as-data | PARTIAL | parser defect: `bfcc555ec4`, merge `1f893735ff` in v0.44.0; the three proposals: memory redesign, no commit | keep |
| #536 | OC2 first-request history reconciliation blocks for 154 s | SHIPPED 0.44.0 | `52651f635d`, merge `68946fd573`, in v0.44.0 | close |
| #535 | Rust mode: conditional `ctx_note` writes always refused | SHIPPED 0.44.0 | merge `60a3ca01d0` in v0.44.0 (npm and `ck-mc`) | close |
| #534 | Context window briefly jumped to over 200% | SHIPPED 0.44.0 | merge `c227145d69`, `d9c0fc1e36`, merge `7d17a154f1`, in v0.44.0 | close |
| #533 | Rust mode: deferred read-then-write transaction fails `SQLITE_BUSY` | SHIPPED 0.44.0 | `4d190f9ff1` in v0.44.0 | close |
| #529 | Rust mode: `/ctx-wrapup` after restart says "Retry in a moment (MC-C09)" | SHIPPED 0.43.2 | `29e3595ea5` in v0.43.2 | close |
| #527 | Rust mode: session served raw after running under TS | SHIPPED 0.43.2 | `4cf127a004`, `35ee61c614` in v0.43.2 | close |
| #526 | OMP: accept role aliases (`@role`) in historian/dreamer model config | OPEN-DESIGN | no commit; no maintainer reply in thread (see possible 0.44.0 interaction below) | keep |
| #525 | [Pi] typebox should be a peer dependency | NEEDS-INFO | decision "stays bundled" and guard test: merge `3f15e86084` in v0.44.0; our question of 09-25 unanswered | keep |
| #522 | Rust mode: historian reattach waits 600 s instead of `historian_timeout_ms` | SHIPPED 0.43.2 | `b5c0f303d1` in v0.43.2 | close |
| #521 | Rust mode: long-lived module state has no retention bound | PARTIAL | session maps: `612fc69e8e` in v0.43.2; `mc_changefeed` pruning: no commit on master | keep |
| #520 | Rust mode: module-served classify records 0 tokens and no model | SHIPPED 0.43.2 | `7b7acfcb91` in v0.43.2 (npm and `ck-mc`) | close |
| #519 | `ctx_reduce` availability ignores agent/session permissions | SHIPPED 0.43.2 | `271f302832`, `7e14c8f197`, merge `38903a2834` in v0.43.2 (OpenCode 1 only, as agreed) | close |
| #513 | Dropped placeholder copied into tool arguments | SHIPPED 0.44.0 | refusal wording: merge `e183d45f9d` in v0.43.0; real-or-absent arguments: `8b9cee1ecd`, `98b55ed17a`, `d07a457bdc` in v0.44.0 | close |
| #505 | Rust mode: module's on-disk model-chain fallback is always empty | SHIPPED 0.43.2 | `cf8448028d` in v0.43.2 | close |
| #502 | Rust mode: module manifest omits `broca` from `consumes` | SHIPPED 0.43.2 | `consumes`: `5493aba63` in v0.43.0; `self_signals`: `9a5eb1fa3a` in v0.43.2 | close |
| #498 | Conflicting worktree schedules postpone Dreamer tasks | SHIPPED 0.44.0 | PR #532 merge `5a89028570` in v0.44.0 | close |
| #495 | History compression could not finish this turn (MC-H01) | SHIPPED 0.43.0 | historian reports the provider's saved error (#491 item in v0.43.0 release notes); cause is OpenCode Zen's free-tier gate (see note) | close |
| #494 | "Infinite loop" during conversation after update | NEEDS-INFO | no commit; our questions of 09-21 unanswered | keep |
| #474 | Optional decision-provider for memory importance | SHIPPED 0.43.0 | tie-break and `/ctx-status` histogram: `b7819a677b`, merge `87a243c224` in v0.43.0; memory docs `ba9dde700e` in v0.43.0; #496 dreamer fix in v0.43.0; hosted provider declined | close |
| #449 | Task-scoped memory prefetch by ID for subagents | OPEN-DESIGN | no commit; we said 09-16 we'd post the shape when settled | keep |
| #447 | [pi] Stable dashboard token | OPEN-DESIGN | no commit; `serve/mod.rs` still calls `generate_token()` on every launch; no maintainer reply | keep |
| #405 | `embedding.dimensions` for Matryoshka models | OPEN-DESIGN | no commit; no `dimensions` in the config schema; PR #406 conflicting; no maintainer reply | keep |
| #360 | Add little-coder support | OPEN-DESIGN | no commit; launcher-aware setup planned, not landed | keep |
| #358 | Dreamer policy hardcoded to software development | OPEN-DESIGN | no commit; policy packs planned after engine consolidation | keep |
| #335 | Memory promotion is single-episode | OPEN-DESIGN | no commit for the corroboration/decay direction (the separate wrapup regression was fixed in `f79dca51`) | keep |
| #332 | Win11: first keystroke crashes Bun | OPEN-DESIGN (upstream-blocked) | no commit; crash is in Bun's FFI path, waiting on OpenCode shipping a newer Bun | keep |
| #310 | Embeddings through host agent models / OpenCode provider | OPEN-DESIGN (SDK-blocked) | no commit; no host embedding API | keep |

Counts: SHIPPED 24 (0.44.0: 15, 0.43.2: 7 counting #502, 0.43.0: 2), PARTIAL 5, MASTER-ONLY 1, NEEDS-INFO 2, OPEN-DESIGN 9.

## SHIPPED issues

In 0.44.0: #548, #547, #546, #545, #543, #542 (with Dashboard 0.18.0), #540, #539, #538, #536, #535, #534, #533, #513, #498.

In 0.43.2 (never announced or closed): #529, #527, #522, #520, #519, #505. #502 also counts here: one half in 0.43.0, the other in 0.43.2.

In 0.43.0 (never closed): #495, #474.

## Things I was unsure about

- **#526 and a possible 0.44.0 regression on OMP.** The reporter says a primary historian model written as a role alias (`"model": "@historian"`) works today by accident. 0.44.0 added `validatePiDreamerModels` (`packages/pi-plugin/src/dreamer/index.ts:131`). It keeps a model only if the name has a `/` and Pi's `modelRegistry.find(provider, id)` knows it. `resolveHistorianFromConfig` (`packages/pi-plugin/src/index.ts:927`) runs the historian chain through it whenever a registry is passed. An `@role` entry has no `/`, so on 0.44.0 it is probably dropped with a warning. If no model is left, the historian doesn't run. I did not test this on OMP, and I don't know whether OMP passes `ctx.modelRegistry`. It should be checked before anyone replies to #526.
- **#495 as SHIPPED.** What we agreed to fix (show the provider's refusal instead of "no assistant output") shipped in 0.43.0. The reporter's symptom has an upstream cause: OpenCode Zen's free tier refuses a request whose tool list has no `bash`. It stays until the reporter uses a non-free historian model. If you'd rather keep issues open until the user-visible symptom is gone, this becomes OPEN-DESIGN (upstream).
- **#541 as PARTIAL.** Everything the reporter asked about the module path shipped in 0.44.0. The part still open is one we raised ourselves: on the host-runner path, the default for OpenCode in Rust mode from 0.44.0, `historian.context_limit_tokens` is not applied (`historian-host-runner.ts` uses only `resolveKnownHistorianContextLimit` and the SDK window). We said we would close that gap separately, so I counted it as agreed work.
- **#519 as SHIPPED.** The fix covers OpenCode 1 only. We told the reporter that OpenCode 2 has no client to read agent permissions with, and that Pi has no per-agent permissions. I treated those as out of scope, not as unfinished work.
- **#540 scope.** Only `ck-mc` from 0.44.0 onward refuses a newer store. Older binaries still warn and continue. The ship note says this.
- **#542 and Dashboard 0.18.0.** Tag `dashboard-v0.18.0` exists at `e0c06d9933`, and its release notes cover #542. I could not check from the repo that the GitHub release and updater manifest are published.
- **#546.** The reporter never answered our questions, so the cause on their host (an older OpenCode 1 build blocking the migration) is still unconfirmed. The shipped fix covers that cause and reports any other cause by name. The ship note asks them to post the refusal text if turns are still refused.
- **#538.** Everything we said we'd fix is in 0.44.0, and we dropped the fold trigger in the thread (comment of 09-27 18:53). The jump to 262K at 04:22:24 was left unexplained by agreement. SHIPPED is a judgement call.
- **#494 and #525 (NEEDS-INFO).** Our last comments are questions from 7 and 3 days ago. The task says to draft a status comment only when there's no recent status from us. For #525 I wrote "no comment needed". For #494 I drafted an optional nudge, because the reporter's model (DeepSeek v4.1 Flash) is the one in the Pi report on #513, and the #513 fix in 0.44.0 may be what they were seeing.
- **#332 and #310** are blocked upstream (Bun / OpenCode's plugin SDK) rather than being design questions. I put them under OPEN-DESIGN because none of the five classes fits better.
- **#498.** We said a `/ctx-status` warning naming both conflicting schedules would be "welcome if it costs no state". It wasn't added. I read that as optional and left it out of the ship note.

## Draft notes

### #552: Pi loads unrelated OpenCode history into its heap (MASTER-ONLY)

No comment needed. Our comment of 2026-09-28 11:52 already says the fix merged after 0.44.0 was tagged, gives the primer-refresh workaround, and says end-to-end measurements on a 10,000+ message session are in progress. The next update should be those numbers, or the ship note when the next release is out.

### #551: OC2 unset `historian.maxTokens` (PARTIAL)

> Update: `historian.maxTokens` and `dreamer.maxTokens` now apply from the next historian or dreamer run, without a restart, on OpenCode 1, OpenCode 2, Pi and Rust mode. That's on master (7e00707c55) and ships in the next release. The clearer error for a reasoning-only reply that ran out of output budget is already out in 0.44.0. Until the next release, a change to either setting still needs a host restart.

### #550: Hidden step-cap abort reported as HiddenProviderError (PARTIAL)

> Status: the attribution fix is in 0.44.0. On OpenCode 2, a dreamer task whose hidden agent reaches its step limit is now recorded with failure class `step_limit` and reported as `MC-D10`. It isn't retried on another model, and the child session is retired. A hidden run that fails without a provider error is no longer reported as one. We haven't yet decided whether to make the step cap configurable or to bound each run's work, and `verify manifest missing closing root tag` isn't addressed yet. Keeping this open for those.

### #548: OC2 hidden provider failure can poison a child (SHIPPED)

> This is in 0.44.0, built on your PR #549. Thanks. On OpenCode 2, a hidden historian or dreamer child that ended with a provider error was kept and reused for the next run. It is now stopped and retired, and the next run, including a fallback model's retry of the same run, gets a new child. When OpenCode itself retried a retryable provider error (a 500, for example) on a reused child, Magic Context refused the retried step with `hidden_prompt_unrecognized`. A later step of a run now starts at that run's own marker, so the host's retry goes through.
>
> To update on OpenCode 2, open `/plugins`, select Magic Context and press ctrl+u, or run `opencode plugin update`. 0.44.0 migrates `context.db`, so restart every OpenCode and Pi host that shares it on the new version at the same time. If you still see `Failed to drain Session` or stalled event delivery on 0.44.0, please post the log lines around it.

### #547: `ctx_reduce` returns success even though it failed (SHIPPED)

> This is in 0.44.0. Magic Context's Pi tools returned a failure as a result marked `isError`, and Pi's agent loop ignores that mark, so a failed call was recorded as a success. The tools now throw the same text as an error, so Pi records the call as failed. The text the model sees is unchanged. Update the Pi package and restart Pi. 0.44.0 migrates `context.db`, so any other hosts that share it need to be restarted on 0.44.0 at the same time.

### #546: OC2 every turn refused in silence (SHIPPED)

> This is in 0.44.0. When OpenCode 2 couldn't open `context.db`, every turn was refused with nothing on screen, and the log said only "context storage is not durable". Now:
> - the refusal names its cause: the process that blocks the migration (its kind and PID), or a database newer than this build, with both schema versions and what to do;
> - a connected Magic Context TUI shows it as a toast on every refused turn, and once per session and cause a `[Magic Context storage notice]` is stored in the conversation. It is never sent to the model;
> - the open is retried at most once every five seconds, so once the blocker is gone a later turn migrates the database and goes through without a restart. Magic Context's tools still need an OpenCode restart after that, and a notice says so;
> - `doctor` reads the schema version built into every cached Magic Context copy on both OpenCode 1 and OpenCode 2. If a copy is behind the database, the check fails and names the directory and how to refresh it.
>
> For your setup: update both hosts. On OpenCode 2 use `/plugins` (ctrl+u on Magic Context) or `opencode plugin update`, and refresh OpenCode 1's cached plugin as well. Stop any OpenCode 1 server still running an older build, restart both hosts on 0.44.0, and run `npx @cortexkit/magic-context@latest doctor --fix`. We never confirmed the cause on your host, so if turns are still refused on 0.44.0, the refusal now says why. Please paste it here.

### #545: Marked items didn't drop after long pause (SHIPPED)

> This is in 0.44.0. Magic Context decides whether the provider cache has expired from the time since the last provider response. On Pi, that time was also reset by your own new prompt, which Pi records just before the context pass, and by tool results and failed requests. So the first turn after your pause saw an idle of a few milliseconds, deferred, and left the 52 queued drops pending. Now only a response that reports provider usage resets it, on Pi and OpenCode 1. On OpenCode 2, a stored reply with no usage no longer resets it either. After an idle longer than `cache_ttl`, the next pass applies the queued drops. Update the Pi package and restart. 0.44.0 migrates `context.db`, so restart every host that shares it on the new version at the same time.

### #543: Auto-embed compartment history when memory is disabled (SHIPPED)

> This is in 0.44.0. History embedding now runs whenever `embedding.provider` is not `off`, whatever `memory.enabled` says, and so do semantic `ctx_search` and auto-search over history. This applies on OpenCode, Pi and `/ctx-embed`. There is no new setting, and the automatic path posts nothing to the timeline. `memory.enabled: false` still turns off memories, promotion, the dreamer's memory tasks and memory injection, and memories aren't embedded while it's off. One thing to know when upgrading: with `memory.enabled: false` and the default `local` provider, history is now embedded. Set `embedding.provider: "off"` if you don't want that.

### #542: Dashboard shows "No projects yet" on OpenCode 2 (SHIPPED)

> Both parts are out: the plugin and doctor fixes in Magic Context 0.44.0, and the dashboard fixes in Dashboard 0.18.0.
> - The Projects page and the Sessions list read OpenCode 2's `session_v2` table, so OpenCode 2 sessions are listed.
> - The plugin records which project each OpenCode 2 session belongs to. It looks up the session's directory once per session through the host, and existing OpenCode 2 sessions are filled in shortly after startup.
> - The Dashboard's Logs page and `doctor --issue` read the OpenCode 2 plugin log (`opencode2/magic-context/magic-context.log` in the temp directory).
> - `doctor` warns when a historian, dreamer or fallback model's provider or model isn't in the OpenCode catalog, and shows `n/a` with the reason instead of `0` when a row count can't be read.
>
> To pick this up: update Magic Context on OpenCode 2 (`/plugins`, ctrl+u, or `opencode plugin update`), update the Dashboard to 0.18.0, and restart every host that shares `context.db` on 0.44.0 at the same time, since it migrates the database.

### #541: Rust historian prompt size checks (PARTIAL)

> Status: the module-side fix is in 0.44.0 (npm package and `ck-mc`). The host sends each chain model's context window and output limit, and the prompt is checked against the model that will receive it, fallbacks included, in the module and in the host runner. The gap I mentioned is still open: when the historian runs through the host runner, which is the default for OpenCode in Rust mode from 0.44.0, `historian.context_limit_tokens` isn't applied. Only the per-model windows are. Until that's fixed, a model's `limit.context` in your OpenCode config caps it on every path. Keeping this open for that part.

### #540: Older `ck-mc` on a newer store (SHIPPED)

> This is in 0.44.0 (npm package and `ck-mc`). Rolling back only the binary across a store migration is not supported. From this release, a `ck-mc` that finds a `store.db` newer than itself refuses to open it before reading or writing anything:
> - `ck health magic-context` reports `failing` with `storage_state: open_refused_store_ahead` and both versions;
> - turns are refused with `MC-C13`, and `ctx_memory` and `ctx_note` reply with the same message.
>
> The supported rollback is the earlier `ck-mc` together with `context.db` and `store.db` restored from the same backup. One limit: only `ck-mc` from 0.44.0 onward has this check. A binary older than 0.44.0 still warns and continues on a newer store, so keep rollback binaries from 0.44.0 or later. Update the module and the npm package together, and restart every host on 0.44.0 at the same time.

### #539: Image reading broken on OpenCode 2 (SHIPPED)

> This is in 0.44.0. OpenCode 2's `read` tool returns an image as a file entry next to the text of the result. Magic Context rewrote that result as JSON text, so the model got the base64 data as text instead of an image, and it filled the context. The file entries are now kept, so the provider receives the same image blocks OpenCode 2 sends without Magic Context, and their size counts toward context usage. A dropped result loses its images along with its output. To update, open `/plugins`, select Magic Context and press ctrl+u, or run `opencode plugin update`. Then restart every host that shares `context.db` on 0.44.0 at the same time, since it migrates the database. If a model still can't see an image on 0.44.0, please post the Magic Context log lines around the `read`.

### #538: Compaction boundary absent from message list (SHIPPED)

> 0.44.0 is out with the fixes from this thread:
> - A boundary before the first remaining message is logged once as `boundary-precedes-window` and treated as nothing to cut, not as a refusal on every pass. The line now says the rows in between were cut with the summarized history or removed by reduction.
> - `prepared prompt exceeds engine max_context N` and `prompt exceeds ... max_context N` are recognised as context overflows on OpenCode, Pi and Rust mode, and N is recorded as the model's limit. A rejection like yours now starts emergency recovery on the next pass.
> - The context limit is kept per model. A late usage reading from an older step no longer overwrites a newer one. On OpenCode 1.18.31 and later, a reading over the limit is recorded before the model-catalog refresh, so the next pass sees it.
> - The `message.updated` log line ends with `message.id=` and `session.id=`.
> - The logger keeps lines when a write to the log file fails, up to 1 MB.
> - A dropped tool result no longer sends its attachments, such as the PDF that became a `document` block.
> - On OpenCode 1, Magic Context turns off OpenCode's automatic compaction for its own instance whenever it manages compaction. This didn't affect you, since your config already had `auto: false`. A native `/compact` on 1.18 now costs one cache rebuild instead of two.
>
> The jump at 04:22:24 stays unexplained, as we agreed. If a rejection happens again on 0.44.0, the `emergency`, `overflow` and `transform stage` lines around it will show whether recovery ran. 0.44.0 migrates `context.db`, so restart every host that shares it on the new version at the same time, and run `npx @cortexkit/magic-context@latest doctor --fix`.

### #537: Fragmented memories (PARTIAL)

> Status: the parser fix is in 0.44.0. Facts the historian tags with a category it doesn't recognise are still not stored, but the log now names the category and how many facts it held, in TypeScript and Rust mode. The category list comes from one shared constant, with a test that fails if the copies disagree. The three proposals stay open as input to the memory redesign. I'll link the design issue here once it exists.

### #536: OC2 first-request reconciliation blocks for 154 s (SHIPPED)

> This is in 0.44.0. The first OpenCode 2 request of a session last served by OpenCode 1 still re-derives Magic Context's saved message positions, but:
> - the per-message tag lookups, which were about 90% of the time and couldn't use an index, are keyed instead of scanned;
> - history is read once instead of twice, and statements are reused;
> - the work yields to the event loop between bounded chunks, and still commits as one transaction;
> - the search-index rebuild that follows runs in 2,000-row transactions and resumes if interrupted.
>
> On a 42,534-message session of your shape it went from one 123-second block to 4.8 to 8.0 seconds in total, with no single block over 4.6 seconds. To update on OpenCode 2, use `/plugins` (ctrl+u on Magic Context) or `opencode plugin update`. Restart every host that shares `context.db` on 0.44.0 at the same time, since it migrates the database.

### #535: Rust mode conditional `ctx_note` writes refused (SHIPPED)

> This is in 0.44.0 (npm package and `ck-mc`). The host now tells the module that note conditions can be evaluated, so `ctx_note write` with a `surface_condition` works in Rust mode again. It is still refused with MC-C08 when there really is no evaluator. `ctx_note update` that adds a condition to a session note is now refused in Rust mode, TypeScript mode and Pi, with a message to write a new note with the condition. Changing the condition of an existing smart note still works. Session notes already stuck as `pending` are restored when the store opens. Update both the npm package and `ck-mc`, and restart every host on 0.44.0 at the same time.

### #534: Context window briefly jumped to over 200% (SHIPPED)

> This is in 0.44.0. After a failed request, Pi removes the failed attempt and then reports a character-count estimate of the whole unreduced branch as context usage until the provider reports again. That estimate was the 425K. Magic Context now recognises it with Pi's own rule (a context edit or compaction newer than the last provider usage) and keeps the previous reading. As you pointed out, usage the provider reports still counts in full on every host, even above the configured window. It counts as pressure over 100%, but it doesn't raise the session's learned limit. Pi's own status bar is Pi's and may still show its estimate after a retry. Update the Pi package and restart. 0.44.0 migrates `context.db`, so restart every host that shares it at the same time.

### #533: Deferred read-then-write transaction fails `SQLITE_BUSY` (SHIPPED)

> This is in 0.44.0. Every writing transaction in the OpenCode and Pi plugins now takes its write lock when it begins, so it waits up to `busy_timeout` instead of failing at once. In Rust mode, recording the compaction-marker target after a module pass no longer fails a pass the module already produced. If the lock outlasts the timeout, that pass logs one line and skips the recording, and the next pass records it. A test fails on any new writing transaction that doesn't take its lock at the start. The case of a priced pass whose last-known-good snapshot write waits longer than `busy_timeout` is the separate one in #362. Restart every host on 0.44.0 at the same time, since it migrates `context.db`.

### #529: `/ctx-wrapup` after restart says "Retry in a moment (MC-C09)" (SHIPPED)

> This shipped in 0.43.2 and is in 0.44.0. After a rebind, the module reports the missing transform snapshot as `transform_not_observed`, separate from the in-flight case. The host shows MC-C12: "History compression has not seen this session since Magic Context reconnected. Send a message in this session first", instead of MC-C09. Update both the npm package and `ck-mc`.

### #527: Session served raw after running under TS (SHIPPED)

> This shipped in 0.43.2 and is in 0.44.0. When a session comes back to Rust mode, a state-sync seed whose coverage ends after the module's own boundary is now adopted. It replaces the boundary and coverage, clears `pending_rewrite`, and the next transform folds once. A seed at or behind the module's boundary is still ignored. `session.status` and health report `raw_passthrough` when a session is being served raw because of an armed `pending_rewrite`. Update `ck-mc` along with the npm package.

### #526: OMP role aliases (OPEN-DESIGN)

No draft (OPEN-DESIGN). The thread has no reply from us. Before anyone replies, check the possible 0.44.0 interaction described under "Things I was unsure about": the new Pi model-registry check may drop an `@role` primary that used to work.

### #525: typebox as a peer dependency (NEEDS-INFO)

No comment needed. Our comment of 2026-09-25 explains why TypeBox stays bundled (OMP's loader replaces a bare `typebox` import with a shim whose schemas fail registration). It also asks what concrete problem the bundled copy causes. The 0.44.0 release notes repeat the decision. We're waiting on the reporter.

### #522: Historian reattach waits 600 s (SHIPPED)

> This shipped in 0.43.2 and is in 0.44.0. A historian run picked up again after a module restart now waits the configured `historian_timeout_ms`, clamped the same way as a fresh run, instead of the producer's 600-second default. Update `ck-mc` to 0.43.2 or later.

### #521: Long-lived module state has no retention bound (PARTIAL)

> Status: parts 1 and 2 shipped in 0.43.2. The `transform_session_roots` and `guidance_dates` entries are removed when a session's last route closes, and on `session.delete`, and rebuilt from the store if the session comes back. Part 3, pruning `mc_changefeed`, isn't done yet. It still needs a consumer watermark so the host mirror can't miss rows. Keeping this open for that.

### #520: Module-served classify records 0 tokens and no model (SHIPPED)

> This shipped in 0.43.2 and is in 0.44.0 (npm package and `ck-mc`). When the module runs `classify-memories`, it now reports the runner's token usage, and the host records it together with the model. With an older module, the host still records the model. Update both the npm package and `ck-mc`.

### #519: `ctx_reduce` ignores agent/session permissions (SHIPPED)

> This shipped in 0.43.2 and is in 0.44.0. On OpenCode 1, Magic Context reads the agent's and the session's permissions once, at the start of a session, before the `ctx_reduce` verdict is fixed. If either denies `ctx_reduce`, the session gets no §N§ tags, no reduce guidance and no reduce reminders. Heuristic and emergency drops don't depend on this verdict, and tests fail if either starts reading it. A permission changed mid-session doesn't change the current session. As noted before, this covers OpenCode 1 in TypeScript and Rust mode. OpenCode 2 gives the plugin no client to read agent permissions with, and Pi has no per-agent permissions.

### #513: Dropped placeholder copied into tool arguments (SHIPPED)

> 0.44.0 is out with the change from my last comment. A dropped tool call inside the newest 20 messages no longer gets a placeholder in its arguments:
> - if its text arguments come to 1 KB or less, it keeps its real arguments, and its output is replaced by `[dropped §N§]`;
> - if they're larger, the call is removed together with its output;
> - the call whose result ends the request, and calls next to the model's reasoning, keep their real arguments whatever their size.
>
> This applies on OpenCode, Pi and Rust mode. There's nothing in argument position for a model to copy, and Pi's validation error has no marker to echo. Placeholders already sent in a session keep their exact bytes until the next pass that rebuilds the cache anyway, and are replaced with real arguments then. A session already stuck in the loop clears at its next fold, and a new session clears it at once. 0.44.0 migrates `context.db`, so restart every host that shares it at the same time. If a model still copies a placeholder on 0.44.0, please post the refusal lines and the model.

### #505: Module's on-disk model-chain fallback always empty (SHIPPED)

> This shipped in 0.43.2 (cf8448028d) and is in 0.44.0, npm package and `ck-mc`. The on-disk fallback is removed, and the host is now the only source of the model chain. A historian run without a chain is skipped with `model_chain_missing` and a warning. `/ctx-wrapup` uses the chain from the session's last pass. A dreamer task without a chain fails with `model_chain_missing`. The host always sends the chain for classification, even when it's empty.

### #502: Module manifest omits `broca` from `consumes` (SHIPPED)

> Both halves have shipped. `consumes` follows the resolved runner target from 0.43.0 (5493aba63). The two self-signal declarations, historian firing and the classify task, are in 0.43.2 (9a5eb1fa3a). Both come from the same resolved routes, so they drop out together on a host-runner configuration. Update `ck-mc` to 0.43.2 or later.

### #498: Conflicting worktree schedules postpone Dreamer tasks (SHIPPED)

> This is in 0.44.0, through PR #532 (thanks @Oscar-Williams), with the amended rule from my last comment:
> - a schedule change keeps the earlier of the new schedule's next slot and the slot already held, and never schedules in the past;
> - the retry count is kept when the held slot is kept;
> - a worktree with the task disabled no longer changes the shared schedule;
> - reconciliation runs in one write transaction, so two processes can't interleave;
> - during a daylight-saving fall-back hour, a task that already ran at the first occurrence of the repeated time isn't scheduled again for the second.
>
> The trade-off stands: moving a task to a less frequent schedule runs it once more at the old time. No config change is needed. 0.44.0 migrates `context.db`, so restart every host that shares it at the same time.

### #495: MC-H01 "History compression could not finish this turn" (SHIPPED)

> 0.43.0 made the historian report the error the provider sent instead of "Historian returned no assistant output", so this case now shows Zen's refusal text. The refusal comes from OpenCode Zen's free tier, which rejects the historian's request because its read-only tool list has no `bash`. That's on the provider side, so the fix is still a historian model outside Zen's free tier, or the `permission: { bash: "ask" }` workaround from my last comment. If you still see MC-H01 with a non-free historian model on 0.44.0, please reopen with the output of `npx @cortexkit/magic-context@latest doctor --issue`.

### #494: "Infinite loop" after update (NEEDS-INFO)

Optional nudge. Our questions of 2026-09-21 are still unanswered, so it's fair to leave it.

> One thing that may be related: 0.44.0 changes how dropped tool calls are shown to the model (#513). Before, a dropped call's arguments were replaced with a `{"dropped": ...}` placeholder, and some models, including DeepSeek v4.1 Flash, copied it into new tool calls over and over. That loop is gone in 0.44.0. If you still see the loop after updating, the details asked for above (what repeats, and the `doctor --issue 494` bundle) would let us trace it.

### #474: Optional decision-provider for memory importance (SHIPPED)

> Everything this issue tracked has shipped, all in 0.43.0:
> - equal-importance memories tie-break on verification and last-seen recency on OpenCode, Pi and the Rust module, not on creation order;
> - `/ctx-status` shows a per-band importance histogram with an unclassified count;
> - the dreamer runs on Pi and OMP again (#496), so unclassified memories get classified;
> - the memory docs say that an edit is re-embedded right away and re-scored at the next classify run.
>
> The hosted decision provider stays declined, as discussed. Pluggable classification belongs to the policy-pack work in #358.

### #449: Task-scoped memory prefetch (OPEN-DESIGN)

No draft (OPEN-DESIGN). On 2026-09-16 we said we'd post the shape here once it's settled. Nothing has landed.

### #447: Stable dashboard token (OPEN-DESIGN)

No draft (OPEN-DESIGN). The thread has no reply from us. Dashboard serve mode still generates a new token on every launch (`packages/dashboard/src-tauri/src/serve/mod.rs`, `generate_token()`).

### #405: `embedding.dimensions` (OPEN-DESIGN)

No draft (OPEN-DESIGN). The thread has no reply from us, only a contributor audit. There's no `dimensions` setting on master, and PR #406 has conflicts.

### #360: little-coder support (OPEN-DESIGN)

No draft (OPEN-DESIGN). Launcher-aware setup is planned but hasn't landed. `--with-pi-extensions` or `LITTLE_CODER_PI_EXTENSIONS=1` remains the workaround.

### #358: Configurable dreamer policy (OPEN-DESIGN)

No draft (OPEN-DESIGN). Policy packs are committed but planned after the engine consolidation. #537's proposals feed into the same redesign.

### #335: Memory promotion is single-episode (OPEN-DESIGN)

No draft (OPEN-DESIGN). The corroboration and decay direction is still a design thread. The `/ctx-wrapup` promotion regression reported in the same thread is a separate defect, already fixed (`f79dca51`).

### #332: Win11 first-keystroke Bun crash (OPEN-DESIGN, upstream-blocked)

No draft. The crash is in Bun's FFI trampoline, and Magic Context doesn't use `bun:ffi`. Our 2026-08-20 comment says to keep it open until OpenCode ships a Bun with the upstream fix and it's retested.

### #310: Embeddings through host agent models (OPEN-DESIGN, SDK-blocked)

No draft. OpenCode's plugin SDK has no API for embedding calls or for borrowing the host's credentials, and PR #342 closed unmerged.
