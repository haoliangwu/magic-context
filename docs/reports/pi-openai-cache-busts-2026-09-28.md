# Pi / OpenAI cache busts — 2026-09-28

## Conclusion

**The 15:00 bust was our `ttl_idle` HARD fold, not a byte-identical defer followed by a provider cold miss.** Magic Context deliberately rematerialized its prefix, drained pending operations, and cleared more reasoning. The session's actual `cache_ttl` is **5m**. Three of the six TTL-triggered busts happened less than 30 minutes after the previous response: **11:34, 14:07, and 15:00 Europe/Madrid**. Those three support Ufuk's diagnosis: we invalidate a prefix while it is still within the GPT-5.6+ documented minimum cache lifetime. This is a **TTL-policy mismatch**, not evidence of mutation on a defer pass. No fix was made.

The other three TTL folds followed gaps over 30 minutes. Their execution is consistent with an idle-maintenance opportunity, although passing 30 minutes does not prove the provider evicted the cache. Two additional HARD folds were caused by render configuration and system-prompt changes, respectively. None of the eight reproduced September 28 busts is a dashboard denominator-only false positive: all have **zero** cached tokens and logged prefix-busting transforms.

The warning denominator is a separate issue. In the measured Pi requests, excluding previous output brings retention much closer to 100%, without changing any severity. In an eight-step Broca Luna gather, it changes **two actual WARNINGs to STABLE**; three other WARNINGs remain. Previous output is not a reliable prediction of the next cache-readable prefix.

Both measured sessions use **ChatGPT OAuth**, despite the different provider labels (`openai-codex` in Pi, `openai` in Broca). Pi records writes as zero; Broca omits the write field. Neither is evidence that paid OpenAI API cache-write usage was dropped.

## Sources, scope, and reproduction

Read-only investigation against repository revision `07978e7bdfadceed45f307dae04fa8e860f6da2a`. Only this report is changed. No live session, configuration, log, or database was modified, and nothing was posted to GitHub.

Source aliases used below:

- **J**: `~/.pi/agent/sessions/--Users-ufukaltinok-Work-Projects-CortexKit-anthropic-auth--/2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl`.
- **L**: `$(getconf DARWIN_USER_TEMP_DIR)/pi/magic-context/magic-context.log`; on this machine, `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/pi/magic-context/magic-context.log`. Line references are to the original log, not the filtered copy. The shared logger derives this path in `packages/plugin/src/shared/data-path.ts:37–57`; Pi selects its harness at module load in `packages/pi-plugin/src/index.ts:909–911`.
- **DB**: `~/.local/share/cortexkit/magic-context/context.db`, queried using `sqlite3 -readonly`.
- **B**: `~/.local/share/cortexkit/broca/wal/ae30e3132e5289f3.wal`, read as binary frames with SHA-256 digest verification; the reader contract is in `packages/dashboard/src-tauri/src/broca_wal.rs:8–35` and `~/Work/Projects/CortexKit/broca/docs/data-model.md`.
- **OpenAI docs**: <https://developers.openai.com/api/docs/guides/prompt-caching>, read September 28, especially “Cache lifetime,” “Summary of model differences,” and “How caching works.”

J's first record verifies session ID **`019de471-4fdc-762d-9286-624dfad0b5fe`**, created May 1. The exact identifying pair is present:

| Dashboard request time (Madrid) | ID / J line | Provider / model | Uncached input | Cached | Prompt = input + cached | Output | Reasoning |
|---|---|---|---:|---:|---:|---:|---:|
| 15:00:58.956 | `ac737c38` / 67725 | `openai-codex` / `gpt-6-sol` | 172,448 | 0 | 172,448 | 181 | 35 |
| 15:01:24.613 | `fca03962` / 67727 | same | 525 | 172,288 | 172,813 | 191 | 0 |

The second row's cached share is **99.6962%**. This is the reported session regardless of its UI title, “Migrated session.”

### Dashboard classification actually used

`packages/dashboard/src-tauri/src/db.rs:1763–1808` reads Pi assistant usage, excludes zero-total records, and uses `message.timestamp` via `pi_sessions.rs:761–775`. That is the request-start timestamp here, not the outer JSONL completion timestamp. Pi already reports **uncached** `input`; adding `cacheRead` once gives prompt size. Reasoning is included in output and must not be added again.

The cross-step pass at `db.rs:2409–2423, 2552–2609` computes:

```text
previous_output = max(previous_total - previous_input - previous_read - previous_write, 0)
growth = previous_write > 0 ? previous_write : previous_input + previous_output
expected = previous_read + growth
retention = current_read / expected
```

With a previously populated cache: zero read → FULL BUST; retention <0.80 → BUST; 0.80–<0.95 → WARNING; ≥0.95 → STABLE. A previous zero read suppresses loss classification on the recovery request. A first row in a bounded window is treated benignly without a baseline.

**Important:** `uses_codex_no_write_cache_model()` at `db.rs:845–847` selects `Harness::Codex` only, **not Pi merely because its provider is named `openai-codex`**. That separate Codex branch uses current cached share, not this cross-step denominator. The Broca sample uses the cross-step branch too.

I extracted all **111 usage-bearing September 28 requests**, plus the preceding request (`d4e4b3e1`, J:67517, September 26 23:36:03.436 Madrid, prompt 218,702, cached 217,600). With that baseline there are **eight FULL BUSTs, no partial BUSTs and no WARNINGs** on September 28 through 15:04:38.388 request time. A window beginning at the first September 28 request would suppress that first classification and show seven instead. There are 95 positive-read comparisons following positive reads and eight recovery comparisons following zero reads.

**Screenshot limitation:** the approximate “eight more red bars between 13:00 and 15:00” and two approximately 390K→170K prompt drops do **not** reproduce in this day's raw Pi usage. Between 13:00 and 15:01 there are four busts. Today's prompt never reaches 390K; the initial drop is 218,702→168,236 across a long idle, and subsequent folds make much smaller drops. I do not invent extra rows or call the unobserved drops pressure folds. The exact 172,448 / 172,288 pair does reproduce. Matching additional bars requires the exact UI window/rows or another session; the table below is the complete reproducible day's set, not a claim about unseen screenshot pixels.

## Per-bust evidence

All dates below are September 28 in **Europe/Madrid (UTC+02:00)**. `start → end` gives dashboard request time and outer J timestamp. `gap` is start-to-start since the previous request; `idle` is current start minus previous JSONL completion, closer to the cache-idle clock. The transform precedes request start by approximately 1–6 seconds. Usage columns are **uncached input / cached / output / reasoning**; `cacheWrite=0` for every row. Output already includes reasoning.

Class **(a)** = logged Magic Context prefix change. No row below meets **(b)** byte-identical prefix + provider cold miss, or **(c)** denominator-only misclassification. System-prompt changes can also be an external contributor, as explicitly noted.

| Start → end | Gap / idle (seconds) | ID; J line | Usage I / C / O / R | Immediate Magic Context pass; L evidence | Class and 30m assessment |
|---|---:|---|---|---|---|
| 11:22:03.593 → 11:22:15.170 | 128,760.157 / 128,741.382 | `29615063`; 67521 | 168236 / 0 / 93 / 39 | HARD `render_config`, `m15000-h88444`→`m15000-h60000`; execute at 29.2%. L:302,308–329. New m[0]/m[1] **417119 + 90 bytes**; explicit flush with 107 pending ops; published-history ride; 53 newly cleared reasoning parts; 2 legacy tool skeleton conversions. | **(a)** legitimate configuration rematerialization, not pressure. System hash also changed at L:287. >30m; not a `ttl_idle` decision. |
| 11:34:23.257 → 11:34:42.267 | 595.548 / 592.116 | `e090568a`; 67540 | 167993 / 0 / 534 / 472 | HARD **`ttl_idle`**, execute at 21.7%; L:794,800–819. m[0]/m[1] **417119 + 90 bytes**; 56 pending ops ride; 8 newly cleared reasoning parts. | **(a)** **premature TTL-policy fold: 5m < idle < 30m**. Not a defer mutation. |
| 11:41:15.736 → 11:41:27.757 | 317.610 / 310.574 | `f92287eb`; 67553 | 168422 / 0 / 207 / 89 | HARD **`system_hash`**; execute at 21.9%; L:1147,1162,1168–1188. m[0]/m[1] **417119 + 90 bytes**; explicit-flush / published-history ride; pending 55 all protected/no-op; 8 newly cleared reasoning parts. | **(a)** legitimate response to an actual system-prompt change (external contributor possible). Within 30m, but **not logged as `ttl_idle`**. |
| 12:57:00.158 → 12:57:13.904 | 4,046.633 / 4,041.745 | `e75cde1e`; 67605 | 171161 / 0 / 281 / 148 | HARD **`ttl_idle`**, execute at 23.1%; L:2596,2602–2621. m[0]/m[1] **417097 + 90 bytes**; 55 pending ops ride; 32 newly cleared reasoning parts. | **(a)** idle fold outside 30m minimum; legitimate under configured policy, no proof cache was already evicted. Also exceeds the earlier-model one-hour in-memory maximum described in the docs; that older policy is not the gpt-6 rule. |
| 13:51:32.534 → 13:51:55.835 | 2,915.632 / 2,906.485 | `3b81627d`; 67643 | 169005 / 0 / 215 / 110 | HARD **`ttl_idle`**, execute at 23.4%; L:3683,3689–3709. m[0]/m[1] **417097 + 90 bytes**; 50 pending ops ride; one dropped injection; 15 newly cleared reasoning parts. | **(a)** idle fold outside 30m minimum; not proof of prior provider eviction. |
| 14:07:51.266 → 14:08:15.187 | 585.833 / 577.450 | `dab40c83`; 67675 | 167591 / 0 / 332 / 139 | HARD **`ttl_idle`**, execute at 22.3%; L:4535,4541–4560. m[0]/m[1] **417097 + 90 bytes**; 33 pending ops ride; 20 newly cleared reasoning parts. | **(a)** **premature TTL-policy fold: 5m < idle < 30m**. |
| 14:38:52.852 → 14:39:42.259 | 1,830.138 / 1,823.979 | `45cd9e50`; 67681 | 168217 / 0 / 1270 / 1013 | HARD **`ttl_idle`**, execute at 21.4%; L:4807,4813–4833. m[0]/m[1] **417097 + 90 bytes**; pending 29 all protected/no-op; 3 newly cleared reasoning parts. | **(a)** just outside 30m, including at fold time (~1818s since last-response clock). Not one of the under-30m counterexamples. |
| 15:00:58.956 → 15:01:23.157 | 788.350 / 768.164 | `ac737c38`; 67725 | 172448 / 0 / 181 / 35 | HARD **`ttl_idle`**, execute at 22.6%; L:6499,6505–6524. m[0]/m[1] **417097 + 90 bytes**; 29 pending ops ride; 19 newly cleared reasoning parts. | **(a)** **premature TTL-policy fold: 5m < idle < 30m**. This is the reported 15:00 FULL BUST. |

Each cited HARD decision says **`executed=true bustsServedPrefix=true`**. The byte counts are **serialized injection lengths**, not byte diffs; equal lengths do not prove identical bytes. The log does not identify every changed byte or the source of every queued operation. “Pending ops” therefore should not be read as “every item definitely came from `ctx_reduce`.” It does prove that the fold opened the drain and reasoning-cleanup opportunity. New reasoning-clearing counts above are distinct from `stripClearedReasoning`, which also replays previously cleared parts on healthy passes.

No listed pass is a standalone SOFT cleanup, emergency fold, or SOFT+ defer. The `emergencyRecoveryBlock` stage name occurs in ordinary transforms too; it is not evidence of an emergency. All observed HARD causes are listed above. No pressure fold is needed to explain these rows: recorded pressure was only 21.4–29.2% of a 786,172-token limit.

### Exact evidence for the TTL mismatch

Read-only query:

```sql
SELECT session_id, cache_ttl, last_response_time
FROM session_meta
WHERE session_id = '019de471-4fdc-762d-9286-624dfad0b5fe';
-- 019de471-4fdc-762d-9286-624dfad0b5fe | 5m | 1790600688572
```

The scheduler (`packages/plugin/src/features/magic-context/scheduler.ts:96–119`) executes when `currentTime - lastResponseTime > parseCacheTtl(sessionMeta.cacheTtl)`. Pi's materializer (`packages/pi-plugin/src/inject-compartments-pi.ts:1146–1161`) turns `hard.cacheExpired` plus a response newer than the previous materialization into `ttl_idle`. Pi updates that clock on served assistant usage, not user/tool messages (`packages/pi-plugin/src/index.ts:774–785`).

For the reported bust, original log excerpts (UTC; session prefix omitted):

```text
L:6499 [13:00:56.262] transform: usage=22.6% (177646 tokens, limit=786172) decision=execute
L:6505 [13:00:56.293] pi m[0] HARD fold firing: reason=ttl_idle mismatch={"signal":"lastResponseTimeAfterMaterialization","cached":1790599127366,"current":1790599690787}
L:6508 [13:00:57.125] injected m[0]/m[1] into Pi messages (417097 + 90 bytes, materialized=true reason=ttl_idle)
L:6509 [13:00:57.131] pi m[0] HARD fold decision: reason=ttl_idle mismatch={"signal":"lastResponseTimeAfterMaterialization","cached":1790599127366,"current":1790599690787} executed=true bustsServedPrefix=true
L:6512 [13:00:57.622] pending ops WILL APPLY — reason=ride=hardFold (scheduler=execute), pendingOps=29 context=22.6%
L:6524 [13:00:58.199] reasoning cleanup: cleared=19 inlineStripped=0 watermark=42585→42615
```

Here `cached` in the mismatch JSON is the **prior materialization timestamp**, not a cache-token count. `current` is the last-response timestamp. At fold firing, that response was only **765.506 seconds** old: over our 300 seconds, well short of OpenAI's 1,800 seconds.

The docs now say for GPT-5.6 and later:

> A cached prefix remains eligible for reuse for 30 minutes after its most recent write or reuse, though OpenAI may retain it longer.

This replaces the old assumption of 5–10 minutes inactivity / up to one hour for earlier in-memory models. The documentation is for the API; these traces are the ChatGPT OAuth route. Taking the gpt-6 retention premise supplied for this investigation, three folds are clearly premature. Even without assuming an identical contractual retention guarantee on the subscription endpoint, **the local cause remains proven**: our 5m clock triggered a prefix-busting HARD fold; the logs do not support blaming a byte-identical request's cache routing or eviction. Cache eligibility is also not a guarantee of routing to the same cache-holding machine.

The immediately following request is a healthy defer, not another fold:

```text
L:6562 [13:01:23.924] transform: usage=22.0% (172747 tokens, limit=786172) decision=defer
L:6570 [13:01:24.060] pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=28 context=22.0%
L:6574 [13:01:24.072] reasoning replay: cleared=846 inline=0
L:6579 [13:01:24.259] heuristics WILL NOT RUN — reason=scheduler_defer
L:6582 [13:01:24.318] injected m[0]/m[1] into Pi messages (417097 + 90 bytes, materialized=false)
```

It receives 172,288 cached tokens. This is consistent with SOFT+ replay, and demonstrates why a `stripClearedReasoning` stage alone is not evidence of a new bust. There is no observed defer-pass defect here. Investigation stops at the diagnosed TTL-policy mismatch; no configuration, provider, or dashboard patch is included.

The “system and tools stable” premise is not true of the whole morning: L:287 records a system hash change, and L:1147 records `dc140d05849a438b6075912d1a35f81c`→`50f55ee3d0038f434b40c482e64096c4` (length 9,878). It must not be used to label the 11:41 zero a provider cold miss. No tool-set-change cause is logged in the reproduced folds.

## Warning formula: measured comparison

For these no-write records, compare:

```text
R_with_output    = current_cached / (previous_cached + previous_uncached_input + previous_output)
R_without_output = current_cached / (previous_cached + previous_uncached_input)
```

These are retention estimates, **not current-request cache-hit ratios**. A growing tool result can make the current cache share low while retaining the earlier cached prefix. Conversely, omitting output is not a universal proof that all previous input was eligible for caching.

### Pi `openai-codex/gpt-6-sol`

Across the 95 positive→positive comparisons on September 28:

| Denominator | Minimum | Maximum | WARNINGs |
|---|---:|---:|---:|
| Previous input + cached + output | 98.3448% | 99.9331% | 0 |
| Previous input + cached | 99.8779% | 99.9569% | 0 |

Concrete example: J:67567 `6641bdd2` has previous input 371, cached 170,624, output **2,761**, of which **2,556 reasoning**. J:67569 `074377e9` reads **170,880** from cache. Thus:

- With output: `170880 / 173756 = 98.3448%`.
- Without output: `170880 / 170995 = 99.9327%`.

Both are STABLE, but input-only matches the measured reusable prefix far more closely. The eight real zero-read rows stay zero under either formula. At 15:01 the dashboard's recovery exception applies because the previous read was zero; 99.7% in the UI is the current share, not a cross-step warning calculation.

### Broca `openai/gpt-6-luna` gather

Sample: **`alfonso:gather-00000000-0000-4017-98d8-103387decc40`**, run **`run-sid-0cszq8X8erIMhmir41nWI4`**, B above. This is the bounded repository-research gather launched during this investigation, not a run aggregate mistaken for a request. It has eight `model_step_finished` records and no retries. The WAL bind triple includes this investigation's worktree, harness `broca`, and the gather session ID. All frame digests were checked. Step-completion times below come from `model_attempt_finished.ts_ms` (the bare records lack an envelope timestamp).

| Step; Madrid finish | Uncached input | Cached | Output (reasoning subset) | R with output | R without output | Dashboard classification with → without |
|---|---:|---:|---:|---:|---:|---|
| 1; 15:06:40.248 | 5726 | 0 | 205 (51) | — | — | First request |
| 2; 15:06:48.036 | 559 | 5632 | 177 (17) | 94.9587% | 98.3584% | STABLE → STABLE: previous read is zero |
| 3; 15:06:56.953 | 6012 | 5632 | 349 (128) | 88.4422% | 90.9708% | WARNING → WARNING |
| 4; 15:07:07.579 | 5141 | 10752 | 345 (124) | 89.6523% | 92.3394% | WARNING → WARNING |
| 5; 15:07:17.315 | 10485 | 14848 | 448 (247) | 91.4398% | 93.4248% | WARNING → WARNING |
| 6; 15:07:28.714 | 1956 | 25088 | 455 (315) | 97.3120% | 99.0329% | STABLE → STABLE |
| 7; 15:07:50.937 | 3053 | 26112 | 825 (730) | 94.9562% | 96.5538% | **WARNING → STABLE** |
| 8; 15:08:48.069 | 2650 | 28160 | 3053 (1362) | 93.8980% | 96.5541% | **WARNING → STABLE** |

Example step 8: the previous prompt is `26112 + 3053 = 29165`; adding output 825 makes expected 29,990, while the next read is 28,160. The 730 reasoning tokens are already inside 825, not an additional term. The output term alone pushes this across 95%.

**Finding:** input-only is the better empirical retention baseline for these traces. There are five actual Broca WARNINGs with output versus three without; the sixth sub-95% arithmetic result (step 2) is suppressed by the recovery rule. Two warnings are therefore **(c) denominator-sensitive false alarms under the existing 95% retention criterion**, not demonstrated prefix busts. This is not proof that every remaining WARNING is a real mutation or provider failure: cacheable boundaries, hidden tokens, and rounding can leave a residual deficit. The docs distinguish eligible visible-prefix accounting from hidden tokens, and these OAuth samples return counts in multiples of 128. Do not universalize the claim that output or reasoning can *never* be reused; the narrower supported claim is that generated-output counts are not automatically next-step **cached-input** counts. No raw wire-prefix comparison was performed for this gather.

## Cache writes and provider labels: OAuth is not API billing

Ufuk clarified that the GPT-5.6+ **1.25× write charge** and `usage.input_tokens_details.cache_write_tokens` concern the **OpenAI API path**, not the ChatGPT OAuth subscription route. This report respects that distinction rather than inferring billing from a provider label.

| Dashboard label / harness | Observed transport/auth path | Write evidence | Interpretation |
|---|---|---|---|
| Pi `openai-codex / gpt-6-sol` | ChatGPT OAuth subscription (`openai-codex`) | All 111 day's J usage objects carry `cacheWrite: 0`; no raw `input_tokens_details.cache_write_tokens` is present in those usage objects. | Zero is correct for this route; not evidence of a missing API write charge. |
| Broca `openai / gpt-6-luna` | **ChatGPT OAuth**, not API-key billing | B `run_started.config.auth_selection.credential_id` and `resolved_credential_id` are `chatgpt:openai:gmail`; all eight step usages **omit** `cache_write_tokens`. The export fact records `charge_basis: subscription_included`. | Missing is not a provider-reported zero. Dashboard renders no writes for this sample, but the label `openai` does not mean API-key transport. |
| Native Codex harness | Separate dashboard harness branch, generally subscription route here; not a second measured session in this report | `uses_codex_no_write_cache_model` matches the harness, not auth credentials or model generation. | Its shortcut is not applied to Pi or Broca. No evidence from these two OAuth sessions that its no-write treatment is wrong. |
| OpenAI API-key path, including an OpenCode/Broca `openai` label when configured that way | Must be established from actual auth/transport, not the string `openai` alone | GPT-5.6+ docs report write usage in `input_tokens_details.cache_write_tokens` and 1.25× write pricing. No API-key run was sampled here. | Report actual write counts when present. This investigation does **not** establish that either provider mapper drops API counts. |

Independent auth corroboration:

- `~/.config/cortexkit/broca/auth-methods.json:6`: `"openai": "chatgpt"`.
- `~/.config/cortexkit/broca/broca.jsonc` configures WAL archival only; it does not override the above to API-key auth.
- Read-only `run-index.db` `export_facts` lookup for `run-sid-0cszq8X8erIMhmir41nWI4`: provider `openai`, model `gpt-6-luna`, auth selection `chatgpt:openai:gmail`, charge basis `subscription_included`; aggregate usage input 35,582, cached 116,224, output 5,857, reasoning 2,974, with no write field.
- B's assistant reasoning objects identify `provider_format: open_ai_responses_chatgpt`; their encrypted content is intentionally not copied into this report.
- Broca's data-model contract defines optional `cache_write_tokens` and specifies reasoning as a subset of output. The dashboard WAL reader has a corresponding optional field (`broca_wal.rs:111–118`), and the cross-step classifier can consume positive writes. The comment that “other providers never report cache_write” is not a safe general statement about the new paid API path.

No credential secrets, account UUIDs, raw prompts, or encrypted reasoning payloads are included; only the non-secret auth-selection alias is shown. No provider mapping change is proposed or made on the basis of this OAuth-only sample.

## Verification and limits

- Streamed J read-only; matched the exact two supplied usage values and verified its session header ID.
- Recomputed Pi classifications from usage, suppressing loss classification when the previous request read zero cache tokens or when a window's first row has no previous baseline. Compared the eight zero-read rows with the log's independently timestamped prefix-rematerialization decisions.
- Read actual DB TTL with `sqlite3 -readonly`; correlated the last-response clock with the materializer and scheduler code, not merely with a default constant.
- Decoded B read-only, checked frame SHA-256 digests, and calculated retention from per-step usage, not summed export facts. Checked OAuth via both WAL auth selection and local auth-method configuration; queried the run index with `sqlite3 -readonly`.
- Compared updated official cache lifetime and billing documentation; kept the API/subscription distinction explicit.
- Scratch extracts are under `$TMPDIR/pi-cache-diagnosis/`, not in live source directories or the commit. They are local investigation aids, not required build artifacts.
- No executable code changed; typecheck, runtime tests, and mutation tests are not applicable to this documentation-only diagnosis. No claim is made that a provider request was byte-identical merely because injection lengths match.
