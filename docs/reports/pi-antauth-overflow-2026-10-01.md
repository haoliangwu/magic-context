# ANTAUTH Pi session at "125.9%" with "Pi model chain empty": 2026-10-01

Session `019de471-4fdc-762d-9286-624dfad0b5fe` (Pi, `~/Work/Projects/CortexKit/anthropic-auth`,
`openai-codex/gpt-6.1-sol`, thinking xhigh, Magic Context v0.44.4).

This is a read-only investigation. No product code changed, no logs or stores were modified, and no
provider calls were made. SQLite was opened with `?mode=ro`. Times are UTC (Z); local time is UTC+2.

## Short answer

1. **No request anywhere near 990K was sent.** At 15:49:26Z Codex returned a transient
   `overloaded` error for a request of about 238K tokens. Pi auto-retried it. To retry, Pi drops
   the failed attempt from context with a `context_edit` entry. Until the next provider response,
   Pi's `getContextUsage()` stops trusting the last provider usage and estimates the session's
   **entire raw, unreduced branch** from characters: 989,562 tokens.
   Magic Context's transform recognized this figure as a raw-branch estimate and ignored it
   (`usage reading 989562 set aside`). Its context pressure stayed at 30.3% of its 786,172-token
   limit. But `/ctx-status` and the
   `mc:` status line don't apply that check. They take `max(persisted, live)`, so they showed
   989.6k. Pi's own footer showed the same estimate against 500k (197.9%).
2. **Nothing in Magic Context fixed it; the next response did.** The retried request succeeded at
   15:50:33.756Z with 239,163 tokens (108 fresh input plus 238,208 cache read). Its usage is newer
   than the `context_edit`, so Pi went back to provider usage, and both displays dropped to about
   30% (MC) and about 49% (Pi). There was no historian run, emergency pass, or drop.
3. **The model chain has been empty since v0.44.0, and not because of the Anthropic extension.**
   The configured Pi historian and dreamer models are `google/antigravity-gemini-3.8-flash` and
   `ollama-cloud/deepseek-v4-flash:0731`, so neither is Anthropic.
   - The first does not exist under that name in Pi's registry. The antigravity-auth extension
     registers provider `google-antigravity`, not `google`.
   - The second is in neither pi-ollama-cloud's static catalog nor its refreshed catalog.

   The registry check added on 2026-09-28 (`c52552526b`, first released in v0.44.0) rejects both on
   every boot. Before that check, the child process ran these same strings successfully. The
   anthropic-auth reload hypothesis is **refuted**.
   The historian did not fail during this incident because pressure never reached its 75% trigger.
   But **no Pi historian has run on any session since 2026-09-26 21:22Z**, and with this config it
   cannot.
4. **MC's 786.2k window comes from a different model.** It is `observed_safe_input_tokens = 786172`
   (the "proven input floor"). That number is the input of a successful request on
   **`google-antigravity/antigravity-gemini-3.8-flash`** (a 1M-window model) in this same session on
   2026-09-21. It survived later switches to muse-spark, gpt-6-sol and gpt-6.1-sol.
   Pi's 500k is the user's override in `~/.pi/agent/models.json`. Pi's catalog says 272k.

## 1. Where Pi's Magic Context log is

- `getMagicContextLogPath(harness)` returns `$MAGIC_CONTEXT_LOG_PATH` if set, else
  `path.join(os.tmpdir(), harness, "magic-context", "magic-context.log")`
  (`packages/plugin/src/shared/data-path.ts:37-39`, `:50-57`).
- The Pi plugin calls `setHarness(PI_HARNESS_KIND)` at load (`packages/pi-plugin/src/index.ts:930`).
  The boot line confirms it: `loaded v0.44.4 | harness=pi (via process-title)`.
- **File:** `$TMPDIR/pi/magic-context/magic-context.log`, which on this machine is
  `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/pi/magic-context/magic-context.log`.
  It is 9.6 MB, 69,897 lines, and its first line is `2026-09-27T10:22:04Z`. There is no `.1`
  rotation file, so anything before 09-27 is gone.
- Matches for the session id: 34,828 in the Pi log; 0 in `$TMPDIR/opencode/magic-context/magic-context.log`
  and 0 in its `.1`. `$TMPDIR/magic-context.log` (128 bytes) holds test residue only.

## 2. Timeline, 2026-10-01 15:00Z to 16:05Z

Sources:
- the Pi log;
- the Pi session JSONL,
  `~/.pi/agent/sessions/--Users-ufukaltinok-Work-Projects-CortexKit-anthropic-auth--/2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl`
  (345 MB; "L" below means a JSONL line number);
- read-only `context.db`.

Before 15:21Z the session had been idle since 2026-09-30 09:xxZ. The Pi log has no session lines
between those two times.

| Time (Z) | Source | Event |
|---|---|---|
| 15:21:34.066 | log | `boot: entering pid=33081 dir=~/Work/Projects/CortexKit/anthropic-auth`. Registers `historian trigger (model=google/antigravity-gemini-3.8-flash, executeThreshold=75% …)` |
| 15:21:41.735 | log | `window-geometry: usable hard limit clamped for openai-codex/gpt-6.1-sol: 372000 → 375000 (overlay/provider inversion)` |
| 15:21:47.859 | log | `[dreamer] unregistered project … stopped dream schedule timer`: the first process goes away |
| 15:22:15.690 | log | Second boot, `pid=48517`, same dir. This is the process the operator used; `/ctx-status` says "Config generation 1, adopted 5:22:15 PM" |
| 15:22:37.208 | log | `[dreamer] WARNING: dropping Pi model not found: google/antigravity-gemini-3.8-flash` and `… ollama-cloud/deepseek-v4-flash:0731` |
| 15:22:37.690 | log | `transform: first pass reset — percentage=29.8% tokens=234301` |
| 15:22:37.795 | log | `pi m[0] HARD fold firing: reason=ttl_idle` (idle since 09-30), then heuristic cleanup, `tool reclaim auto-drop: targets=42`, calibration revision adopted |
| 15:22:42.692 | L68949 | First assistant reply `aborted` (`Operation aborted`), followed by a model re-select and a thinking change to xhigh (L68950-68951) |
| 15:23:19 → 15:49:00 | L68953-68995 | Normal turns. Provider input grows 210,759 → 237,617 tokens. MC transform reports 26.8% → 30.3%, `decision=defer` throughout |
| 15:49:02.761 | log | `transform: usage=30.3% (238085 tokens, limit=786172) decision=defer` for the request that will fail |
| 15:49:26.335 | L69001 | Assistant `stopReason=error`, `errorMessage="Codex error: Our servers are currently overloaded. Please try again later."`, usage all zero |
| 15:49:26.962 | log | `agent_end: returning synchronously` |
| 15:49:27.092 | L69002 | `context_edit {targetId: "ee089e50", replacement: null}`: Pi's retry path omits the failed attempt (`ee089e50` is L69001) |
| 15:49:29.252 | L69003 | Queued user message "Don't use any workers, we want direct audit." |
| 15:49:29.252 | log | `usage reading 989562 set aside (message_end estimate): Pi re-estimated its whole unreduced session branch because a context edit or compaction follows the last recorded usage …` |
| 15:49:29.559 | log | `transform: usage=30.3% (237913 tokens, limit=786172) decision=defer`: the retried request, about 238K |
| ≈15:49:30-15:50:33 | operator | `/ctx-status` shows 989.6k / 786.2k = 125.9%; Pi footer 197.9%/500k; transcript shows the overloaded error. "Dreamer last 25m ago" matches the 15:24:17Z dreamer tick plus 25 minutes |
| 15:50:33.756 | L69004 | Retry succeeds: `input=108 cacheRead=238208 output=847 total=239163` |
| 15:50:35.142 | log | `transform: usage=31.3% (245890 tokens, limit=786172)` |
| 15:50 onward | operator | `mc: 239.2K (30%)` is 239,163 / 786,172 = 30.4%. Pi footer `49.2%/500k` is about 246K / 500K |
| up to 16:05 | L69005-69052 | Normal growth to 299,376 tokens. Highest MC reading in the window: `34.3% (270040 tokens)` at 15:56:48 |

Not in the window, with how each was checked:
- **Historian:** no run started, refused, failed or published. The log has no historian line apart
  from the `historianScheduling` stage timings. In `historian_runs`, the newest Pi row in the whole
  database is 2026-09-26 21:22:30Z.
- **Emergency, force band or overflow:** none. No `emergency`, `overflow`, `force` or 95% line
  except the `emergencyRecoveryBlock` stage timer. `session_meta.needs_emergency_recovery=0` and
  `detected_context_limit=0`.
- **95% refusal:** none was needed or possible. MC's own pressure never went above 34.3% in the
  window, or above 41.7% since the log began on 09-28.
- **Pi compaction:** none. The only JSONL entry types in the window are `message`, `model_change`,
  `thinking_level_change` and one `context_edit`. Pi's own threshold-compaction check uses the same
  estimator once the projection contains a `context_edit` (`agent-session.js:2354-2384`). Inference:
  the overloaded error took the retry branch first (`:1364`). The next check ran after the
  successful 15:50:33 response, when the estimate was usage-based again (about 239K, below
  500K), so it did not compact.
- **No pass brought usage back to about 30%:** MC's transform reading never left about 30%.

## 3. Why the model chain is empty

### Configuration

The user config is `~/.config/cortexkit/magic-context.jsonc`. anthropic-auth has no project
`magic-context.jsonc`: its `.cortexkit/` holds only `alfonso/`.

- Pi historian: `historian.pi.model = "google/antigravity-gemini-3.8-flash"`, with
  `fallback_models = ["ollama-cloud/deepseek-v4-flash:0731"]` (config lines 34-39).
- Pi dreamer: the same model and fallback, plus per-task `curate` and `verify-broad` set to the
  same Google model (lines 146-159).
- No Pi chain contains an Anthropic model. (`historian.module_fallback_models` lists
  `google/antigravity-claude-opus-4-6-thinking`, which goes through the Google provider and is not
  part of the Pi chain.)

### How the chain is checked

- `activeModelRegistry` is set from `ctx.modelRegistry` (`packages/pi-plugin/src/index.ts:1548-1550`,
  `:1689`, `:2106`).
- `validatePiDreamerModels` splits each entry at the first `/` and keeps it only if
  `registry.find(provider, modelId)` returns a model (`packages/pi-plugin/src/dreamer/index.ts:132-177`).
  - `google/antigravity-gemini-3.8-flash` is therefore looked up as provider `google`, model
    `antigravity-gemini-3.8-flash`.
  - Results, including "not found", are cached per registry object (`:130`, `:151-163`). The
    warning prints once per process (`:129`, `:165-168`).
- The `/ctx-status` warning re-runs the same check against `activeModelRegistry`
  (`packages/pi-plugin/src/index.ts:1814-1841`).
  - It lists every dreamer task whose chain is empty, including tasks with `schedule: ""`
    (`map-memories`, `verify`).
  - It appends `historian` when `resolveHistorianFromConfig(config, "pi", registry)` returns nothing.

### Why each model is "not found" (proved)

- **`google/antigravity-gemini-3.8-flash`:**
  - The antigravity-auth Pi extension, loaded from
    `~/Work/Projects/CortexKit/antigravity-auth/packages/pi/dist` (listed in
    `~/.pi/agent/settings.json` under `packages`), registers its provider as `'google-antigravity'`
    (`antigravity-auth/packages/pi/src/index.ts:16`, `pi.registerProvider(ANTIGRAVITY_PROVIDER_ID, …)`).
    The provider has used this id since the extension was created (commit `b0effa4`).
  - The model id is `antigravity-gemini-3.8-flash`
    (`antigravity-auth/packages/core/src/model-registry.ts:103`).
  - So the Pi registry name is `google-antigravity/antigravity-gemini-3.8-flash`. This same session
    ran on exactly that provider and model on 2026-09-20/22 (JSONL L59023 `model_change`, L59900+
    assistant rows).
  - `google/…` is the OpenCode provider naming, used correctly in the `opencode` blocks of the same
    config.
- **`ollama-cloud/deepseek-v4-flash:0731`:**
  - pi-ollama-cloud 0.12.2 registers provider `ollama-cloud` with `GENERATED_MODELS`
    (`~/.pi/agent/npm/node_modules/pi-ollama-cloud/index.ts:53-60`). That list has 17 ids and
    `deepseek-v4-flash:0731` is not among them (`models.generated.ts`, generated
    2026-09-27T00:52Z).
  - The refreshed catalog in `~/.pi/agent/models-store.json` (`ollama-cloud.checkedAt` =
    2026-10-01T15:21:45Z) has the same 17 ids and does not include it either.
  - The model is only present in `limits.generated.ts` and `reasoning.generated.ts`.
  - Before validation existed, `subagent_invocations` recorded 53 `failed` Pi dreamer runs on this
    model between 2026-09-24 and 09-27.

### The anthropic-auth reload hypothesis: refuted

- No configured Pi chain contains an Anthropic model, so Anthropic models leaving the registry
  cannot empty any chain.
- The warning is not transient. The log shows both drops at every Pi boot since the log began:
  2026-09-28T09:22, 09:41, 10:56, 11:29, 12:38, 12:41, 13:32, 14:49, 21:16, 2026-09-29T21:31, and
  2026-10-01T15:22:37.
- No reload in the window: nothing under `anthropic-auth/packages/pi` is newer than 2026-10-01 14:00Z
  (`find -newermt`), and anthropic-auth has no commits on 2026-10-01. There were two Pi processes
  (pids 33081 and 48517, 41 s apart), which is a restart or `/reload`. It does not matter here,
  because the dropped models are not Anthropic.

### Did the historian actually fail?

- **Not in this incident.** The historian is only needed at the 75% execute threshold, and MC
  pressure peaked at 34.3%. Nothing tried to run it. In this incident the warning appeared only in
  `/ctx-status`.
- **But it is effectively disabled for Pi** (proved from the database, mechanism from code):
  - `resolveHistorianFromConfig` returns `undefined` when validation drops every model
    (`packages/pi-plugin/src/index.ts:956-979`).
  - The context options, `/ctx-recomp` and `/ctx-wrapup` all resolve the historian through it with
    `activeModelRegistry` (`:1559-1564`, `:1882-1886`, `:1936-1940`).
  - `subagent_invocations` shows Pi historian runs `completed` with `google/antigravity-gemini-3.8-flash`
    13 times between 2026-09-24 and 2026-09-26 21:21Z, and none since. `historian_runs` for Pi ends
    at 2026-09-26 21:22:30Z. This session's 838 compartments all predate that.
  - Inference: before `c52552526b` the child Pi resolved `google/antigravity-gemini-3.8-flash`
    itself, probably by matching the model id. The new host-side `find()` check is stricter than the
    child, so it rejects a chain that used to work.
  - The boot line `registered historian trigger (model=google/antigravity-gemini-3.8-flash, …)` is
    misleading: it resolves without a registry (`index.ts:1482`), before validation can drop the
    model.
- Side observation: `session_meta.emergency_drain_active = 1790457707897` (2026-09-26T21:21:47.897Z)
  is still set. That latch is meant to keep the historian draining after a spike to 95% or more
  (`packages/plugin/src/features/magic-context/migrations.ts:1681-1687`). Because the historian
  cannot run, nothing has cleared it.

## 4. The window mismatch: 786.2k (MC) vs 500k (Pi) vs 272k (catalog)

| Source | Value | Evidence |
|---|---|---|
| Pi catalog, `openai-codex/gpt-6.1-sol` | 272,000 window, 128,000 maxTokens | `~/.pi/agent/models-store.json`. The same entry prices `tiers: [{inputTokensAbove: 272000, …}]` |
| User override | **500,000** | `~/.pi/agent/models.json` `providers.openai-codex.modelOverrides["gpt-6.1-sol"].contextWindow` |
| Pi footer | 500,000 | `getContextUsage()` uses `_limitsModel().contextWindow` (`pi-coding-agent@0.99.2 dist/core/agent-session.js:3371-3376`), which includes the override |
| MC transform, status, `/ctx-status` | **786,172** | `session_meta.observed_safe_input_tokens = 786172`, `last_usage_context_limit = 786172` |

Where MC's 786,172 comes from (proved):
- The transform passes Pi's window into geometry as `rawContextWindowSource: "catalog"`
  (`packages/pi-plugin/src/context-handler.ts:2856`, `:2914-2926`).
- A catalog-sourced window is not a trusted absolute wall
  (`packages/plugin/src/shared/window-geometry.ts:643-645`), so the persisted floor is not cleared
  (`context-handler.ts:2928-2963`).
- `applyProvenInputFloor` then lifts the usable limit to `observed_safe_input_tokens`
  (`packages/pi-plugin/src/pi-context-limit.ts:124-129`, `context-handler.ts:2964-2971`).
- The boot clamp `372000 → 375000` is the geometry before the floor is applied. Inference: 372,000
  is the 500,000 window minus the 128,000 output allowance; 375,000 is the soft limit.

Where 786,172 was proven (proved): JSONL **L59956, 2026-09-21T09:35:38.825Z**, an assistant row on
`google-antigravity/antigravity-gemini-3.8-flash` with `input 3368 + cacheRead 782804 = 786172`. It
is the session's largest provider input on any model. Model sequence after it:
- antigravity until L60700;
- 09-22 18:38-18:40: `gpt-6-astra` → `claude-opus-5-5` → `muse-spark`;
- 09-22 19:58: `gpt-6-sol`;
- 09-29 21:32: `gpt-6.1-sol`.

A model switch is supposed to clear `observedSafeInputTokens`
(`context-handler.ts:2766-2802`, in place since May). It did not. The value is still exactly
786,172 and `last_observed_model_key = openai/gpt-6.1-sol`.

Likely leak path (inference, not proved; the Pi log for 09-22 has been rotated away):
1. The antigravity turn ended `aborted` at 18:33:27Z (L60700).
2. The model changes followed 5 minutes later, before the first prompt at 18:40:41Z.
3. If Pi restarted in that gap, the first context pass seeds `liveModelBySession` from the **last**
   `model_change` in the branch (`context-handler.ts:2680-2690`). That would be the already-switched
   muse-spark model.
4. `previousModelKey` would then equal `currentModelKey`, `modelChanged` stays false, and the
   first-pass branch keeps `observedSafeInputTokens` (`:2803-2824`).

Which number is right for Codex:
- 272k is a pricing-tier boundary, not a hard limit. Codex accepted 680,501 input tokens on
  `gpt-6-sol` (L64777, 2026-09-23T19:26:56Z, `stop`) and 551,748 on `gpt-6-astra`
  (L58484, 2026-09-20).
- For `gpt-6.1-sol` itself the largest accepted input is 299,376 (2026-10-01T16:05:38Z).
- OpenRouter's `openai/gpt-6.1-sol` lists 1,050,000, but that is a different route.
- The true Codex hard window for `gpt-6.1-sol` is **not proven** by anything on disk.
- The user's 500k is the only value chosen deliberately for this model and route. MC's 786,172 is
  wrong in where it came from: a different provider and model. It may or may not sit under the real
  limit.
- MC has already warned once that Pi's window is smaller than the proven input:
  `session_meta.cache_alert_sent = 1` is set by the "Pi reports a context limit of … but this
  session has sent … successfully" alert (`index.ts:865-877`). That alert assumes the proven tokens
  came from the current model.

## 5. How usage "reached" 990K

- **No 990K request was sent** (proved). Every assistant row in the window has total tokens of
  288,853 or less.
- **The failed request was about 238K.** Its transform logged 238,085 tokens; the previous success
  was 237,617 and the retry 239,163.
- The provider's `overloaded` error was a genuine transient error, not a reaction to an oversized
  request:
  - the request was ordinary-sized;
  - an identical-sized retry 64 s later succeeded with a full cache hit;
  - Pi classified it as retryable, not as context overflow. `_isRetryableError` returns false for
    `isContextOverflow(…)` (`agent-session.js:2911-2916`); `_prepareRetry` then calls
    `_omitRecoveryAttempt` (`:2963-2981`), which writes the `context_edit` (`:816-831`).
- Where 989,562 comes from:
  - `getContextUsage()` calls `estimateProjectedContextTokens(projection, branch)`
    (`agent-session.js:3398`).
  - When a `context_edit` or `compaction` entry is newer than the last usage-bearing assistant, that
    function ignores provider usage. It sums a character-based estimate of every projected message
    (`dist/core/compaction/compaction.js:135-174`).
  - Pi's projection is the raw session branch (about 68,950 branch entries,
    `collectMessageEntryIdsByRef: … branchEntries=68942`). MC's reductions apply only inside the
    provider request, so they are not in that projection.
- No refusal was skipped, because none was due: MC's 95% emergency path (below) keys off its own
  guarded pressure, which never left about 30%. MC handled the estimate correctly:
  - `persistPiPressureFromMessageEnd` set it aside (`packages/pi-plugin/src/index.ts:884-909`;
    classification at `:2628` and `packages/pi-plugin/src/pi-pressure.ts:228-267`);
  - the transform's guarded snapshot used the persisted 237,913 (`context-handler.ts:2836-2848`,
    `:2998-3008`).
- The 95% path is an emergency reclaim, not a refusal. `EMERGENCY_BLOCK_PERCENTAGE = 95`
  (`context-handler.ts:339`); evaluated at `:3142-3185`. It reads that guarded snapshot, which
  stayed at 30%. It was not skipped for a larger window or a historian in progress.
- **The defect is display-only** (proved from code):
  - `buildPiStatusDetail` (`packages/pi-plugin/src/dialogs/status-dialog.ts:636-667`) and
    `renderStatusText` (`packages/pi-plugin/src/status-line.ts:83-127`) both feed
    `ctx.getContextUsage().tokens` into `resolvePiPressureSnapshot`, which takes
    `Math.max(persisted, live)` (`pi-pressure.ts:146-159`).
  - Neither applies the raw-branch estimate check the transform uses.
  - Exact reproduction: 989,562 / 786,172 = 125.87% (MC); 989,562 / 500,000 = 197.9% (Pi).
- Hypothetical (not this incident): if the 786,172 floor had pushed the transform over a real wall,
  MC would have under-reported pressure against Codex's actual limit. That risk comes from
  section 4, not from the 990K figure.

## 6. What restored it

No MC mechanism. The retry's assistant row at 15:50:33.756Z (L69004) carries provider usage newer
than the `context_edit` at L69002. After it, `estimateProjectedContextTokens` returns the
usage-based estimate again (`compaction.js:155-160`):
- MC status: `mc: 239.2K (30%)`, which is 239,163 / 786,172;
- Pi footer: `49.2%/500k`, the latest usage plus the trailing tool-result estimate, about 246K.

There was no historian publish, no fold, no emergency drop, and no compaction. The only MC
mutation pass in the hour was the 15:22:37 `ttl_idle` HARD fold at 29.8%, half an hour earlier.

## Proved vs inferred

Proved: no request near 990K was sent; the 989,562 figure is Pi's raw-branch estimate after a retry
`context_edit`, and the successful retry restored usage-based figures; the configured models and why
each is "not found"; the absence of any Pi historian run since 09-26 21:22Z; the source and provenance of 786,172, Pi's
estimator and retry code paths, and the display surfaces that lack the estimate check.

Inferred:
- why the floor survived the 09-22 model switches: a Pi restart followed by a model switch before
  the first prompt would seed the "previous model" from the already-switched `model_change`, so no
  switch is detected;
- that the pre-validation child resolved `google/antigravity-…` by matching the model id;
- the exact screenshot moment (15:49:30-15:50:33Z, from "Dreamer last 25m ago" and the log);
- the true Codex window for `gpt-6.1-sol`.

## Follow-up candidates (not done here)

- Config: Pi chains should be `google-antigravity/antigravity-gemini-3.8-flash`, plus an
  `ollama-cloud` id that exists, for example `deepseek-v4.1-flash`.
- `/ctx-status` and the status line should apply the same raw-branch estimate check as the
  transform.
- Key the proven floor (`observed_safe_input_tokens`, the largest input a request has succeeded
  with) to a model. Or clear it when the first pass after a restart takes its "previous model" from
  a `model_change` newer than the last assistant row that carries usage.
- The `/ctx-status` chain warning should skip disabled tasks (`schedule: ""`) and name the expected
  Pi provider id.
- The boot "registered historian trigger" log should reflect validation.

## Separately: leftover test directories in `$TMPDIR` (measured, nothing deleted)

`$TMPDIR` holds **74,018** entries in total; most belong to other repos (`oai-*`, `engram-*`,
`prefrontal-*`, `aft-*`, …). Entries starting with `pi-`, `mc-` or `magic-context-`: **5,591 entries,
5,364.8 MB** (`du -sk`; empty dirs count as 0). Groups in the table are by prefix. "Per run" ≈97 or
≈88 copies, dated 09-27 → 10-01, means one leak per test-suite run.

Creating file:line references (verified by search):
- `packages/pi-plugin/src/inject-compartments-pi.test.ts` creates `pi-m0m1-*` (:462-1408),
  `pi-m1-*` (:1449-1798, :2544-2709) and `pi-tax-*` (:2003-2497).
- The adversarial SIGKILL tests are in `packages/pi-plugin/src/adv-pi-sigkill-*.test.ts`.
- `createTestTempDir` and its allowlist are in `packages/plugin/src/shared/test-temp-dir.ts`.

| Prefix family | Entries | Size | Created by | Cleans up? |
|---|---|---|---|---|
| `pi-m0m1-*` (16 sub-prefixes present) | 1,555 | ~0 | `inject-compartments-pi.test.ts` (`mkdtempSync(join(tmpdir(), "pi-m0m1-…"))`) | Partly. The sub-prefixes with `rmSync` in `finally` (memory-off-transition, memory-on-shape, compaction-off, docs-snapshot, docs-gate, memory-epoch) leave nothing; the 16 present leak 97-98 each |
| `pi-m1-*` (13) | 970 | ~0 | same file | No for the 10 present. `forced-supersede` leaves nothing |
| `pi-m0-*` (3) | 291 | ~0 | same file, `frozen-cp-profile` :383, `siblings` :1838, `watermark` :1891 | No |
| `pi-tax-*` | 582 | 0.8 MB | same file, `newcomp` :2003, `model` :2025, `sys` :2054, `empty` :2237, `docs-soft` :2266, `docs-hard` :2294 | No for these 6 (97 each). `project-*`, `*-reason-*` and `model-alias-*` are removed in `finally` and leave nothing |
| `pi-shadow-*`, `pi-routing-memo-*`, `pi-noprobe-memo-*` | 352 + 176 + 176 | 1.2 MB | `packages/pi-plugin/src/embedding-bootstrap.test.ts` (e.g. :123) via `createTestTempDir` | **No.** These prefixes are not in `TEST_TEMP_DIR_PREFIXES` (`test-temp-dir.ts:8-45`), so `cleanupTestTempDir` returns early (`:63-70`, `:87-89`) and the stale sweep skips them (`:156`). Bun does not type-check, so the `TestTempDirPrefix` type mismatch goes unnoticed |
| `pi-embedding-*` | 217 | 0.3 MB | `embedding-bootstrap.test.ts`: `-shutdown-` :70 (41), `-synapse-` :84 (88), `-synapse-home-` :85 (88) | No, same unlisted-prefix cause. The listed `-bootstrap-` (:34) and `-home-` (:35) are cleaned, 0 present |
| `pi-memory-off-guidance-*` | 90 | ~0 | `packages/pi-plugin/src/system-prompt.test.ts:89` via `createTestTempDir` | No, unlisted prefix |
| `pi-lane-sigkill-*`, `pi-sigkill-*` | 344 + 172 | **537.8 MB** | `adv-pi-sigkill-lane-decision.test.ts:146-151`, `adv-pi-sigkill-conversion.test.ts:157` (`mkdirSync` of `${ADV_ROOT ?? tmpdir()}/pi-…-${Date.now()}`) | No. Neither file calls `rmSync`/`rm` |
| `pi-e2e-*` | 22 | **375.0 MB** (≈17 MB each) | `packages/e2e-tests/src/pi-runner/spawn.ts:133` (`${host}-e2e-${Date.now()}-${random}` with config, data, cache, work, runtime, `.pi`) | No. Nothing in `packages/e2e-tests/src` removes `baseDir` |
| `mc-opencode2-*` | 174 | **3,443.4 MB** | `packages/e2e-tests/src/opencode2-runner/spawn.ts:102` (`mkdtempSync(join(tmpdir(), "mc-opencode2-"))`) | No removal found in the runner |
| `magic-context-index-order-*` | 8 | 3.8 MB | `packages/plugin/src/features/magic-context/storage-db-initialize-order.test.ts:132` | Mostly. `rmSync` at :226-227 and :268; the 8 survivors (09-30 → 10-01) mean some path skips it, not determined |
| `mc-reasoning-wir*` and other `mc-*` | 4 + 82 | 895 + 76 MB | one-off probes and scripts (e.g. `mc-reasoning-wire-20260930-isolation-`) | n/a |
| `pi-journal-legacy-`, `pi-openai-*`, `pi-liveness*`, `pi-activity-*` | 279 + 56 + 5 | 19.6 MB | not created anywhere in this repo (no match in `packages/`) | n/a |

The operator's "about 5,300" matches `pi-*` = 5,322 entries. About 4,980 of those are this repo's
test leftovers. By size, the cost is dominated by `mc-opencode2-*` (3.4 GB), the SIGKILL tests
(0.54 GB) and `pi-e2e-*` (0.38 GB). The many small Pi unit-test prefixes are numerous but nearly
empty.
