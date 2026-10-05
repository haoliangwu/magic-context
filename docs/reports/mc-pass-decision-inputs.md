# Magic Context per-pass decision inputs (TypeScript transform)

Date: 2026-09-26. Base: `2e9293d2`. Research only; nothing in the code was changed.

## Purpose and scope

We are designing a runner-driven interface. A runner (Broca, later Thalamus) calls Magic Context's
CompactionProvider on every model step with a *context status*. MC answers `NOOP` or a
`CompactionMessage`. This report lists every input that the current OpenCode TypeScript transform
reads when it makes its per-pass decisions. The status can then carry everything MC needs and
nothing extra.

**Covered.** The TypeScript path under `packages/plugin/src/hooks/magic-context/`:
- `transform.ts`;
- the scheduler, in `features/magic-context/scheduler.ts` and `transform-context-state.ts`;
- `transform-postprocess-phase.ts`, `inject-compartments.ts` and `transform-compartment-phase.ts`;
- `compartment-trigger.ts`, `protected-tail-boundary.ts` and `emergency-drop.ts`;
- `heuristic-cleanup.ts` and `cache-busting-signals.ts`;
- `ctx-reduce-nudge.ts`, `tail-hygiene-walk.ts` and `channel2-delivery.ts`.

It also covers the OpenCode hooks that feed those modules state:
- `event-handler.ts`, which handles `message.updated`, `session.error` and `session.created`;
- `system-prompt-hash.ts`, the `system.transform` hook;
- `hook-handlers.ts`, the `chat.message` and `tool.execute.after` hooks;
- the `/ctx-flush` wiring in `hook.ts`.

**Not covered.**
- The Rust-authority path. When `transformMode === "rust"`, `transform.ts:1118-1135` delegates to
  `rust-mode-transform.ts` and the TypeScript decisions below do not run.
- The note nudger, commit nudges and auto-search. These are not compaction decisions.

### Input classes

| Class | Meaning |
|---|---|
| **(a)** | The runner must send it on each step (in OpenCode today it comes from the host: message array, events, SDK, catalog). |
| **(b)** | MC already holds it in its own state (`session_meta`, `tags`, `pending_ops`, `compartments`, memory tables, or process-local maps MC owns). |
| **(c)** | Config MC resolves itself (plugin config plus built-in constants). |

Some values are marked **(a→b)**. Today MC derives them from host data, but MC could persist them
itself, provided the runner reports the underlying (a) fact once.

### Shared derived values (used by several decisions)

Most decisions read the same handful of derived numbers. They are listed once here and
referenced by name below.

| Derived value | How it is computed | file:line |
|---|---|---|
| `totalInputTokens` (pressure) | `tokens.input + tokens.cache.read + tokens.cache.write` of the newest completed assistant response | `event-handler.ts:657-660` |
| `contextLimit` (usage denominator) | `resolveContextLimit(provider, model, {db, session})`: catalog (`getSdkContextLimit`, i.e. models.dev + opencode.json + auth caps) narrowed by a detected overflow limit, raised to the session's proven safe input for the same model (`observedSafeInputTokens`); default 200K | `event-resolvers.ts:120-167`, `event-handler.ts:727-743,816-818` |
| `contextUsage.percentage` | `totalInputTokens / contextLimit × 100` | `event-handler.ts:829-830` |
| `contextUsageEarly` | The in-memory `contextUsageMap` entry written by `message.updated`, else `session_meta.last_context_percentage/last_input_tokens`, else 0 | `transform-context-state.ts:84-131`, `transform.ts:1384-1389` |
| synthetic 95% bump | When `needs_emergency_recovery` is set and the no-head escape is not active, `percentage` is overwritten to 95 | `transform.ts:1496-1513` |
| outgoing model | Model of the newest user message, else the live map, else the last assistant message | `transform.ts:1266-1269`, `365-385`, `332-348` |
| `resolvedContextLimit` | `resolveTrustedContextLimit(outgoing model)` (catalog, detected limit, proven floor, or last usage limit for the same model) | `transform.ts:1566-1571`, `event-resolvers.ts:188-235` |
| `windowGeometry` (`usableSoft`, `usableHard`, absolute wall) | `resolveContextWindowGeometry` (SDK geometry + detected limit + proven floor) | `transform.ts:1572-1577`, `event-resolvers.ts:80-110` |
| `thresholdContextLimit` | `resolvedContextLimit`, else `inputTokens / (percentage/100)` | `transform.ts:1596-1601` |
| `effectiveExecuteThresholdPercentage` | `resolveExecuteThreshold(execute_threshold_percentage \| per-model, modelKey, 65, {tokensConfig: execute_threshold_tokens, contextLimit})`, capped at 90 | `transform.ts:1602-1611`, `event-resolvers.ts:458-469` |
| `forceMaterializationPercentage` | `max(85, threshold + 2)` (the "force band") | `transform.ts:1612-1614`, `shared/escalation-bands.ts:10-18` |
| emergency wall | Constant 95 (`ABSOLUTE_EMERGENCY_PERCENTAGE`, `BLOCK_UNTIL_DONE_PERCENTAGE`) | `shared/escalation-bands.ts:2`, `compartment-trigger.ts:45` |
| `boundaryContextLimit` / `boundaryExecuteThreshold` | `resolvedContextLimit`, else emergency ceiling limit, else back-derived, else 128K; threshold re-resolved against it | `transform.ts:1692-1710` |
| `boundaryUsageForProtectedTail` | Persisted pre-reset usage if it is at most 10 minutes old and was measured on the same model and limit, else `contextUsageEarly` | `transform.ts:1615-1628` |
| `historyBudgetTokens` | `contextLimit × threshold% × history_budget_percentage` | `transform.ts:1630-1637,3098-3145` |
| `emergencyCeilingTokens` | `thresholdContextLimit × threshold%` | `transform.ts:1646-1650` |
| `isCacheBusting` (history refresh) | An explicit `historyRefreshSessions` flag, or a pending deferred-history flag that this pass may consume | `transform.ts:1672-1690` |
| calibration | `sessionDecisionCalibration`: frozen per session and re-adopted from the model-keyed seed table (`tokenizer-calibration-seeds.json`) only on a bust-permitted pass | `transform.ts:2514-2519`, `features/magic-context/session-decision-calibration.ts:183-213` |

---

## 1. Execute vs defer (the scheduler)

The decision is `createScheduler().shouldExecute`. Its call site is `transform.ts:1655-1664`, via
`resolveSchedulerDecision` (`transform-context-state.ts:133-159`). The logic is:
1. Defer if `percentage == 0 && lastResponseTime == 0` (`scheduler.ts:67`).
2. Execute if `percentage ≥ threshold` (`scheduler.ts:92`).
3. Execute if `now − lastResponseTime > ttl` (`scheduler.ts:114-116`).
4. Otherwise defer.

Compaction-off forces defer (`transform.ts:1655`).

| Input | Source | file:line | Class |
|---|---|---|---|
| `contextUsage.percentage` | Provider usage ÷ context limit (see shared table); may be the synthetic 95 | `scheduler.ts:67,92`; `transform.ts:1660` | (a) usage + (a) window; (b) for the 95 bump |
| `contextUsage.inputTokens` | Provider usage (input + cache read + cache write) | `scheduler.ts:78-79` | (a) |
| `contextLimit` passed in | `resolvedContextLimit` (catalog / detected / proven) | `transform.ts:1663`; `scheduler.ts:76-80` | (a) catalog window; (b) detected / proven |
| `execute_threshold_percentage` (number or per-model map) | Config | `scheduler.ts:82-91` | (c) |
| `execute_threshold_tokens` (per-model) | Config, converted with `contextLimit` | `scheduler.ts:87-88` | (c) |
| `modelKey` | `getModelKey` = the live outgoing model | `transform.ts:1662`; `hook.ts:777-780` | (a) |
| `sessionMeta.cacheTtl` | `session_meta.cache_ttl`, written from config `cache_ttl` (string or per-model map) on `session.created` and every `message.updated` | `scheduler.ts:98`; `event-handler.ts:315,651-655`; `event-resolvers.ts:237-243` | (c) resolved per model; stored (b) |
| `sessionMeta.lastResponseTime` | `session_meta.last_response_time`, stamped `Date.now()` on each assistant `message.updated` with usage | `scheduler.ts:67,114`; `event-handler.ts:647-649` | (a→b): the runner reports "response completed at" |
| now | `Date.now()` | `scheduler.ts:60`; `transform-context-state.ts:145` | MC clock (b) |
| `compactionOff` | Boot-resolved mode | `transform.ts:1023,1655` | (c) |
| first-pass reset | `loadedSessions` (process-local); the first pass after a restart zeroes `last_context_percentage/last_input_tokens` | `transform.ts:1348,1360-1380` | (b) process-local; **no runner equivalent** (see the last section) |
| model-change reset | Outgoing model ≠ `session_meta.last_observed_model_key`: zero usage, clear detected limit, emergency, reasoning watermark, historian failures | `transform.ts:1287-1341` | (a) outgoing model; (b) last observed key |

## 2. HARD fold: `mustMaterialize` triggers and the pressure-backstop refold

`mustMaterialize` (`inject-compartments.ts:1681-1859`) is evaluated three times per pass:
- the protection-floor pre-check (`transform.ts:2479-2494`);
- the postprocess fold preflight (`transform-postprocess-phase.ts:1420-1435`);
- inside `injectM0M1` (`inject-compartments.ts:3827-3840`).

A fold executes when `foldDueDecision.value || softRefreshOpportunity`
(`transform-postprocess-phase.ts:1485`). It is enabled only when the project identity is present
and `(fullFeatureMode || compactionOff)` (`:1416-1419`). The hard signals are assembled at
`transform.ts:2439-2460`.

The triggers, in order, are:
1. `first_render` / `cached_m1_missing` (`:1696-1697`).
2. `render_config`: memory is off while a memory block is still cached (`:1711`).
3. `compartment_render_epoch` (`:1717`).
4. `render_config`: the mural flag or the budget identity changed (`:1731`).
5. `model_change` (`:1745`).
6. `system_hash` (`:1754`).
7. `ttl_idle` (`:1784`).
8. `host_compaction` (`:1797`).
9. `project_change` (`:1811`).
10. `project_memory_epoch`, or a change in the workspace fingerprint (`:1826,1829`).
11. `max_mutation_id` (`:1854`).
12. `upgrade_state` (`:1857`).

A tool-set hash change is observed but never folds.

| Input | Source | file:line | Class |
|---|---|---|---|
| `cachedM0Bytes`, `cachedM1Bytes` | `session_meta.cached_m0_bytes/cached_m1_bytes` | `inject-compartments.ts:1696-1697` | (b) |
| `memoryEnabled`, `muralEnabled` | Config `memory.enabled`, mural flag | `:1710,1726-1729` | (c) |
| `memoryInjectionBudgetTokens`, `historyBudgetTokens` (render budget identity) | Config budget + `historyBudgetTokens` (derived from the context window) | `:1726-1729,1541-1545` | (c) + (a) window |
| cached upgrade identity (render epoch, mural, budget id, upgrade state) | `session_meta.cached_m0_upgrade_state` | `:1703,1716-1731,1856` | (b) |
| `COMPARTMENT_RENDER_EPOCH` | Code constant | `compartment-render-epoch.ts:1` | (c) |
| `hardSignals.modelKey` | Live outgoing model `provider/model` | `transform.ts:2439-2440`; `inject-compartments.ts:1740-1748` | (a) |
| `cachedM0ModelKey` | `session_meta.cached_m0_model_key` | `:1741` | (b) |
| `hardSignals.systemHash` | `session_meta.system_prompt_hash`: MD5 of the system prompt, written by `system.transform`, which runs **after** the messages transform, so this pass sees the previous request's hash | `transform.ts:2442-2443`; `system-prompt-hash.ts:478-480,534-543` | (a) the runner sends the hash of the prompt it will send |
| `cachedM0SystemHash` | `session_meta.cached_m0_system_hash` | `:1750` | (b) |
| `hardSignals.toolSetHash` | `getCurrentToolSetHash(provider, model, agent)` from the `tool.definition` hook | `transform.ts:2441`; `hook.ts:781-789` | (a); observational only |
| `hardSignals.cacheExpired` | `computeHardCacheExpired(cacheTtl, lastResponseTime, now)`, strict `>` | `transform.ts:308-326,2444-2452` | (a→b) last response time; (c) TTL |
| `hardSignals.lastResponseTime` vs `cachedM0MaterializedAt` | `session_meta.last_response_time` vs `cached_m0_materialized_at` | `inject-compartments.ts:1779-1783` | (a→b) / (b) |
| `hardSignals.hostCompaction` (`completedAt`) | `findHostCompactionWindow(messages)`: native OpenCode `/compact` rows at the head of the served window | `transform.ts:989-992,2459`; `inject-compartments.ts:1792-1797` | (a) |
| `projectIdentity` vs `cached_m0_project_identity` | `resolveProjectIdentity(sessionDirectory)`; the session directory comes from `client.session.get` | `transform.ts:1199-1230,1878-1881`; `inject-compartments.ts:1801-1812` | (a) session directory; (b) cached |
| `project_memory_epoch` / workspace fingerprint | `project_state`, `workspace_members`, `workspaces`, `v22_identity_rekey_map` | `inject-compartments.ts:1282-1285,1339-1412,1820-1830` | (b) |
| `max_mutation_id` | `MAX(m0_mutation_log.id)` for the session | `:1339-1412,1853` | (b) |
| `upgradeState` | `getUpgradeState(db, session)` (count of legacy compartments) | `:1537,1856` | (b) |
| read but not triggers: `project_user_profile_version`, `max_compartment_seq`, `max_memory_id`, `max_memory_mutation_id`, project docs hash | Marker probe | `:1832-1852` comments | (b) |

**Pressure-backstop refold** (`inject-compartments.ts:3979-4033`). This runs only on a
cache-busting pass where m[1] was just recomputed and no fold happened this pass
(`!rematerialized && !contentionExhausted && m1Recomputed && isCacheBustingPass`). It folds if
any of the following holds:
- `memoryUpdateCount > 40`;
- `m1Tokens > historyBudgetTokens × 0.2`;
- `m0Tokens ≥ 500 && m1Tokens > 0.15 × m0Tokens`.

| Input | Source | file:line | Class |
|---|---|---|---|
| `memoryUpdateCount` | Output of `renderMemoryUpdatesBlock` (the memory mutation log since `maxMemoryMutationId`) | `inject-compartments.ts:2826-2833,4011` | (b) |
| `m1Text` / `m0Text` token estimates | `estimateTokens` over the cached bytes | `:4002-4006` | (b) |
| `historyBudgetTokens` | Derived from the context window and config | `:3997-3998` | (a) window + (c) |
| thresholds 40 / 0.2 / 0.15 / 500 | Code constants | `:3993-3995,4011-4015` | (c) |
| `isCacheBustingPass` | Always `true` from the postprocess preflight | `transform-postprocess-phase.ts:1502` | (b) |

## 3. SOFT m1 refresh: new compartments, memories, profile, flush

This is the non-HARD branch of `injectM0M1`. When `isCacheBustingPass`, it calls
`softRefreshCachedM1` (`inject-compartments.ts:3946-3972`), which calls `renderM1WithMetadata`
(`:2792-2925`). Otherwise it replays cached m[1].

The postprocess preflight runs `injectM0M1` when
`softRefreshOpportunity = schedulerDecision === "execute" || deferredMaterialize`
(`transform-postprocess-phase.ts:1459,1485`). Here
`deferredMaterialize = canConsumeDeferredLate && deferredMaterializationSessions.has(sid)`
(`:1406`). `publishedM1RefreshedThisPass` is set when the m[1] bytes changed (`:1534-1536`).

| Input | Source | file:line | Class |
|---|---|---|---|
| `schedulerDecision` | Decision 1 | `transform-postprocess-phase.ts:1459` | derived from (a)/(b)/(c) |
| `deferredMaterializationSessions` | Process-local set, filled by the historian publish callback (`onCompartmentStatePublished`) | `transform.ts:1810-1813,2412-2415`; `pp:1357-1359` | (b) process-local |
| `canConsumeDeferredLate` | `justAwaitedPublication \|\| schedulerDecision==="execute" \|\| percentage ≥ force band` | `transform.ts:2465-2471`; `cache-busting-signals.ts:13-24` | derived |
| new compartments | `compartments WHERE sequence > cached_m0_max_compartment_seq` | `inject-compartments.ts:2092-2108,2839` | (b) |
| new memories | `memories.id > cached_m0_max_memory_id`, filtered by project/workspace/status/expiry; trimmed to 25% of the memory budget | `:2809-2825,2853-2873` | (b) + (c) budget |
| memory updates | `memory_mutation_log.id > cached_m0_max_memory_mutation_id` | `:2826-2833` | (b) |
| user profile delta | `project_state.project_user_profile_version` (global) ≠ marker; user memories trimmed to 25% of the profile budget | `:2886-2904` | (b) + (c) |
| CAS row match | Every `session_meta.cached_m0_*` column vs process state | `:3004-3091,3138` | (b) |
| temporal awareness | Config flag (compartment dates) | `:2838-2842` | (c) |
| `/ctx-flush` | `onFlush` adds the session to `historyRefreshSessions`, `systemPromptRefreshSessions` and `pendingMaterializationSessions` | `hook.ts:1015-1019` | (b); a user command that MC owns |
| system prompt change | The hash changed: the same three sets, plus clearing `lastHeuristicsTurnId` | `system-prompt-hash.ts:492-504` | (a) hash |
| variant change | `chat.message` variant differs from the previous one and `variantChangeBustsProviderCache(provider, model)`: the same three sets | `hook-handlers.ts:268-286` | (a) variant + model |
| m[0] mutation drift | `MAX(m0_mutation_log.id)` ≠ cached, which queues the next pass's materialization | `transform-postprocess-phase.ts:3215-3234` | (b) |

## 4. Emergency recovery (≥95%) and the force band (~85%), including provider overflow errors

### 4a. Provider overflow detection (event side)

| Input | Source | file:line | Class |
|---|---|---|---|
| error payload of `session.error` | `detectOverflow(error)` gives `isOverflow`, `reportedLimit`, provenance, `reportedInputTokens` | `event-handler.ts:323-351` | (a) |
| error on assistant `message.updated` (`info.error`) | Same detection path, a second route | `event-handler.ts:519-604` | (a) |
| error provider / model | `errInfo.providerID/modelID`, else `session_meta.last_observed_model_key` | `event-handler.ts:372-375,538` | (a) |
| attempted tokens | `tokens.input + cache.read + cache.write` of the failed message | `event-handler.ts:532-535` | (a) |
| `isSubagent` | `session_meta.is_subagent` (from `session.created` `parentID`); subagents record the limit only | `event-handler.ts:314,376-398,540-559` | (a) once, then (b) |
| thinking-binding mismatch | `detectThinkingBindingMismatch(error)` + model family arms a separate recovery | `event-handler.ts:329-346,487-511` | (a) |
| **writes**: `needs_emergency_recovery`, `emergency_recovery_origin`, `detected_context_limit(_model_key, _provenance)` | `recordOverflowDetected` / `recordDetectedContextLimit` | `event-handler.ts:385-391,426-434`; `storage-meta-persisted.ts:2108` | (b) |
| success clears a stale detected limit | A successful request larger than the detected limit for the same model | `event-handler.ts:707-725` | (a) usage + (b) |

### 4b. Transform-side arming and the 95% bump

| Input | Source | file:line | Class |
|---|---|---|---|
| overflow state (`needsEmergencyRecovery`, origin, `detectedContextLimit`, model key) | `loadTransformPassStateSnapshot` → `session_meta` | `transform.ts:1357,1484-1490`; `storage-meta-persisted.ts:2060-2100` | (b) |
| proactive shrink arm: last measured input and its model | `last_input_tokens`, `last_observed_model_key` (pre-reset snapshot) | `transform.ts:1438-1480` | (b) |
| proactive shrink arm: the new model's catalog limit | `getSdkContextLimit(outgoing provider, model)` | `transform.ts:1445-1452` | (a) |
| `recovery_no_eligible_head_count` vs `RECOVERY_NO_HEAD_LIMIT = 2` | `session_meta`; reset when `< 80%` and not armed | `transform.ts:1492-1498`; `protected-tail-boundary.ts:218` | (b) + (c) |
| `usagePercentageSynthetic` | Result of the bump | `transform.ts:1500-1513` | derived |
| `emergencyUsagePercentageEarly` | `inputTokens / windowGeometry.usableHard × 100` (or 95 if synthetic) | `transform.ts:1578-1582` | (a) usage + window |

### 4c. Emergency historian recovery and the 95% block

**Historian recovery at ≥95% after prior failures** (`transform.ts:1817-1845`). Condition:
`fullFeatureMode && !compactionOff && historian_failure_count > 0 && emergencyUsagePercentageEarly ≥ 95 && !noHeadEscape`.

**Recovery on session load** (`:1849-1867`). Condition: first pass in this process and
`failureCount > 0`.

**Blocking at 95%** (`transform-compartment-phase.ts:434-526`). The phase force-starts the
historian if it is not already running, sends a notice once, and awaits it for at most
`min(historian timeout, 60s)` (`:39-44,326`). A timed-out join combined with an untrusted final
estimate fails closed (`transform.ts:2744-2759`).

| Input | Source | file:line | Class |
|---|---|---|---|
| `historian_failure_count`, `last_error` | `session_meta`; cleared by `message.updated` when `< 90%` | `transform.ts:1358,1820`; `event-handler.ts:856-863` | (b) |
| `contextUsage.percentage ≥ 95` | Usage (possibly synthetic) | `transform-compartment-phase.ts:437` | (a)/(b) |
| active run | `getActiveCompartmentRun(session)` (process-local) | `transform-compartment-phase.ts:439` | (b) process-local |
| runnable window | Protected-tail boundary snapshot (decision 5); `≥80%` retries with tail scale 0.5, and `≥95%` with 0.25 | `transform-compartment-phase.ts:298-314`; `transform.ts:1743-1748` | (b) + raw transcript (see the last section) |
| `canRunCompartments` | Primary session, compaction on, historian enabled, host client present, session directory known | `transform.ts:1233-1238` | (a) is_subagent + directory; (c) |
| historian config: chunk tokens, timeout, model, fallback models, two-pass, context limit | Config and `resolveHistorianRun` | `transform.ts:2375-2402` | (c) |
| `isFirstTransformPassForSession` | Process-local `loadedSessions` | `transform.ts:1348,1851` | (b) process-local |

### 4d. Fail-closed abort (≥95%)

`evaluateEmergencyFailClosed` is defined at `transform-postprocess-phase.ts:1232-1273` and called at
`transform.ts:2784`. It can disarm or abort:
- **Disarm** when recovery is armed, the trusted final-wire estimate is under 80% of the
  provider-proven limit for the same model.
- **Abort** when all of these hold: `usage ≥ 95`, armed, origin `provider_overflow`, and no
  historian fold was materialized this pass.

An abort sends `EMERGENCY_REFUSAL_NOTICE`, then calls `hostRefuse` (`transform.ts:568,2799-2840`; refuse at `:2815`).

| Input | Source | file:line | Class |
|---|---|---|---|
| `emergencyUsagePercentage` | `inputTokens / usableHard` (or synthetic 95); `inputTokens` falls back to a wire estimate on priced passes with unknown usage | `transform.ts:2523-2558,2722-2726` | (a) |
| `finalWireEstimate` (`tokens`, `trusted`) | `estimateFinalWireInputTokens(messages, systemPromptTokens, provider, model, agent)` | `transform.ts:2525-2531,2727` | (a) messages + system tokens; **or** (a) a runner-supplied pre-send token count |
| `providerProvenLimitTokens` | `detected_context_limit` only when its model key equals the current one | `transform.ts:2767-2783` | (b) |
| `emergencyRecoveryArmed`, origin | `session_meta` | `transform.ts:1488-1489` | (b) |
| `historianFoldMaterializedThisPass` | Postprocess result | `transform.ts:2788` | (b) |
| `systemPromptTokens` | `session_meta.system_prompt_tokens` (written by `system.transform`) | `system-prompt-hash.ts:522-536` | (a) |

### 4e. Force band (`forceMaterializationPercentage = max(85, threshold+2)`)

| Decision | Condition | file:line |
|---|---|---|
| `forceMaterialization` (primary only) | `fullFeatureMode && !compactionOff && pct ≥ force` | `transform-postprocess-phase.ts:1365-1368` |
| `emergencyDropEligible` (primary and subagent) | `!compactionOff && pct ≥ force` | `:1376-1377` |
| fresh non-persisted m[0] allowed under contention | `forceMaterialization \|\| emergencyDropEligible` | `:1504,2222` |
| tiered emergency tool drop | `planEmergencyDrop` with ceiling = `emergencyCeilingTokens`, target = `floor + 0.3 × (ceiling − floor)`, no-op if reclaim ≤ 2000, pressure-episode latch `last_emergency_input_sample` | `heuristic-cleanup.ts:110-207`; `emergency-drop.ts:26-36,127-303` |
| latch rearm | `pct < force − 5` and sample > 0, or an independent mutation this pass | `transform-postprocess-phase.ts:1393-1398,1822-1828` |
| historian force fire | See decision 5 (`force_band`) | `compartment-trigger.ts:639-698` |
| `≥80%` boundary tail scale 0.5 | Compartment phase | `transform-compartment-phase.ts:306-309` |

| Input | Source | file:line | Class |
|---|---|---|---|
| `contextUsage.percentage`, `inputTokens` | Usage | as above | (a) |
| `emergencyCeilingTokens` | `thresholdContextLimit × threshold%` | `transform.ts:1646-1650` | (a) window + (c) |
| `last_emergency_input_sample` | `session_meta` | `storage-meta-persisted.ts:1063`; `heuristic-cleanup.ts:112,205`; `pp:1393-1398` | (b) |
| active tags (type, status, tool name, byte sizes, tag number) | `tags` table (active only) + `getMaxTagNumberBySession` | `heuristic-cleanup.ts:94-96,117-140` | (b) |
| per-tag served/reclaimable tokens | `target.measureReclaim` over the **live message parts** × calibration ratios | `emergency-drop.ts:305-330` | needs the message content (see the last section) |
| `protectedCutoff` / `protectedTagNumbers` | Protection window: `resolveEpochFloorForPass(protected_tokens config, tier overrides, usableSoft)` + persisted tag mass | `transform.ts:2560-2586` | (c) + (a) window + (b) |
| tool tiers T1/T2/T3, reserve 20% | Code constants | `emergency-drop.ts:26-29,45-46` | (c) |
| calibration (`toolsRatio`, `proseRatio`) | `sessionDecisionCalibration` | `heuristic-cleanup.ts:132` | (b)/(c) keyed by the (a) model |

## 5. The historian trigger (`compartment-trigger.ts`)

The call site is `transform.ts:1977-2029`. It is gated on
`fullFeatureMode && !compactionOff && historianRunnable && !compartmentInProgress`.
`checkCompartmentTrigger` (`compartment-trigger.ts:427-793`) evaluates, in order:
1. Skip if a run is already in progress (`:444`).
2. Cheap-skip below the proactive floor when the live-tail upper bound is under `triggerBudget`
   (`:506-573`).
3. Skip if there is no new raw history (`:594-615`).
4. `force_band` at or above the force band. It is skipped when queued or automatic drops are
   projected to reach `0.75 × threshold` on a pass that has a reclaim ride (`:639-698`).
5. `commit_clusters` (`:700-718`).
6. `tail_size` (`:737-750`).
7. Proactive: below the floor, stop (`:753-762`); apply the redundancy skip (`:764-774`); stop if
   the tail is too small (`:776-782`); otherwise fire `projected_headroom` (`:784-792`).

A fire sets `compartment_in_progress = 1` (`transform.ts:2020`).

| Input | Source | file:line | Class |
|---|---|---|---|
| `compartmentInProgress` | `session_meta.compartment_in_progress` | `compartment-trigger.ts:444`; `transform.ts:1981` | (b) |
| `usage.percentage`, `usage.inputTokens` | `boundaryUsageForProtectedTail` (fresh persisted or live) | `transform.ts:1994`; `compartment-trigger.ts:509,643,756` | (a) |
| `executeThresholdPercentage` | `boundaryExecuteThreshold` | `transform.ts:1996` | (c) + (a) window |
| `triggerBudget` | `deriveTriggerBudget(contextLimit, threshold)`: `clamp(5K, 50K, 5% of limit × threshold)` | `transform.ts:1997`; `derive-budgets.ts:27-58` | (a) window + (c) |
| `contextLimit` | `boundaryContextLimit` | `transform.ts:2001`; `compartment-trigger.ts:300-306` | (a) |
| proactive floor | `threshold − 2` | `compartment-trigger.ts:39,206-210` | (c) |
| force band | `escalationBands(threshold)` | `:639-641` | (c) |
| `clear_reasoning_age` | Config | `transform.ts:1998`; `compartment-trigger.ts:245-262` | (c) |
| `commit_cluster_trigger` `{enabled, min_clusters=3}` | Config (or `historianRun`) | `transform.ts:1999`; `compartment-trigger.ts:701-707` | (c) |
| tagger load floor | `deriveTagLoadFloor(db, first K wire message ids)` | `transform.ts:1963`; `compartment-trigger.ts:480-489` | (a) newest window ids + (b) tags |
| persisted tag token upper bound, `nullCount` | `tags` (active + dropped, `tag_number ≥ floor`) | `compartment-trigger.ts:532-537` | (b) |
| untagged in-memory tail estimate | True-raw tokens of messages in `inMemoryTail` that have no tag yet | `:143-163,538-545` | **message content** |
| `protected_tail_policy_version` | `session_meta` (v3 required for the in-memory tail) | `:457-464,577-578` | (b) |
| calibration seed ratios (prose, tools, system) | `sessionDecisionCalibration` | `:385-386,546-550` | (b)/(c) |
| `lastCompartmentEnd` ordinal and message id | `compartments` | `:350-351`; `protected-tail-boundary.ts:1105-1120` | (b) |
| raw message count, raw messages after the last compartment | `readRawSessionMessageRange` / `getRawSessionMessageOrdinalCount` (OpenCode DB, or the in-memory tail primed from `messages`) | `protected-tail-boundary.ts:519-526,1112-1113`; `compartment-trigger.ts:335-353` | **OpenCode store / full message array** |
| protected tail boundary (`offset`, `protectedTailStart`, `eligibleEndOrdinal`, `trueRawEligibleTokens`, `N`) | `resolveOpenCodeProtectedTailBoundary(contextLimit, threshold, usage, taggerFloor, prior_boundary_ordinal)` | `compartment-trigger.ts:361-374`; `protected-tail-boundary.ts:514-803,1126-1138` | derived from raw transcript + (b) + (a) |
| chunk scan (`tokenEstimate`, `hasMore`, `messageCount`, `commitClusterCount`) | `readSessionChunk(scanBudget = max(6000, budget×3)/ratio, offset, protectedTailStart)` | `compartment-trigger.ts:387-403` | **raw transcript** |
| pending drops | `pending_ops WHERE operation='drop'` | `:232-238` | (b) |
| `cleared_reasoning_through_tag` | `session_meta` | `:630` | (b) |
| can clear reasoning | `modelAcceptsEmptyContent(providerID)` | `:621-623` | (a) provider |
| reclaim ride `{hardFold:false, force, explicitFlush, publishedHistory}` | force: `pct ≥ force && (pct ≥ 95 \|\| emergency sample == 0)`; flush: `pendingMaterializationSessions`; published: `isCacheBusting` | `transform.ts:2005-2013`; `compartment-trigger.ts:636-637` | (b) + (a) |
| thresholds 6000 tokens / 12 messages / ×3 / 0.75 | Constants | `compartment-trigger.ts:39-45` | (c) |

## 6. Heuristic cleanup and pending-op drains

The gates live at `transform-postprocess-phase.ts:1354-1636`. A drain happens when
`hasReclaimRide(rideSignals)` holds (`:1599-1615`; `cache-busting-signals.ts:49-51`). The ride
signals are:
- **hardFold**: the fold busts the served prefix, or this is the first render;
- **force**: emergency-eligible and (`≥95` or the latch is armed);
- **explicitFlush**: a `/ctx-flush` is pending, or a deferred materialization is being consumed;
- **publishedHistory**: m[1] was refreshed, or history was rebuilt with no m0/m1.

Heuristics additionally need one of: a published ride, a flush, force, a fold, first render,
emergency eligibility, or (`execute` and not yet run this turn, or a subagent) (`:1616-1633`).
The routine lanes are:
- system-injection strip;
- duplicate tool drop;
- caveman compression;
- reasoning clearing older than `clear_reasoning_age` (Anthropic only).

These are frozen within a force-band pressure episode (`:1832-1838`).

| Input | Source | file:line | Class |
|---|---|---|---|
| `pendingMaterializationSessions` (`isExplicitFlush`) | Process-local set (`/ctx-flush`, system hash, variant, degraded injection, m0 drift) | `pp:1354-1360` | (b) process-local |
| `deferredMaterializationSessions` | Historian publish callback | `pp:1357-1361,1406` | (b) process-local |
| `currentTurnId` vs `lastHeuristicsTurnId` | Id of the newest user message in `messages`; the map is set after heuristics run | `transform.ts:969`; `pp:1362-1364,1995` | (a) newest user message id; (b) map |
| `schedulerDecision` | Decision 1 | `pp:1378,1586,1632` | derived |
| `contextUsage.percentage`, `inputTokens` | Usage | `pp:1365-1377,1603,1778,1834,1858` | (a) |
| `forceMaterializationPercentage` | Derived | `pp:1368,1377` | (c)+(a) |
| `fullFeatureMode` | `!session_meta.is_subagent` | `transform.ts:1145-1146` | (a) once / (b) |
| `compactionOff` | Config | `pp` passim | (c) |
| active compartment run | `getActiveCompartmentRun` | `pp:1399-1405` | (b) process-local |
| fold outcomes (`foldBustsServedPrefix`, `firstRenderBust`, `publishedM1Refreshed`) | Decisions 2 and 3 | `pp:1450,1532-1536` | derived |
| `pending_ops` rows | `getPendingOps` (read only on eligible passes) | `pp:1583-1592` | (b) |
| protected ids (`≥95%` switches to the newest ctx_reduce exemplars) | Protection window / tags | `pp:1774-1786` | (b) + (c) |
| active tags | `getActiveTagsBySession` | `pp:1811-1813`; `heuristic-cleanup.ts:94` | (b) |
| system-injection text, tool fingerprints (tool name + args + owner) | **Live message parts** via `targets` / `messageTagNumbers` | `heuristic-cleanup.ts:209-270,282-338` | **message content** |
| `caveman_text_compression {enabled, minChars}` (primary only) | Config | `pp:1801-1806`; `heuristic-cleanup.ts:346-367` | (c) |
| `clear_reasoning_age` | Config | `pp:1940-1951` | (c) |
| reasoning-clear eligibility | `canUseEmptySentinels = modelAcceptsEmptyContent(provider)` | `transform.ts:1565`; `pp:1940` | (a) provider |
| `routinePressureAppliedBySession` | Process-local episode map | `pp:1378-1390` | (b) process-local |
| `didMutateFromFlushedStatuses`, `historyRebuiltThisPass`, `compartmentInjectionRebuiltFromDb` | Earlier phases of this pass | `pp:1815-1821` | derived |

## 7. Nudge bands: Channel 1, Channel 2, tail hygiene, grace

Both channels read the **tail-hygiene baseline**, not context percentage. The tail totals are:
- `T = baselineT + turnDeltaT` (all tail tokens);
- `U = min(T, baselineU + turnDeltaU)` (unstamped reclaimable tokens);
- `severity = U / T`.

**Channel 1.** It is quiet if `T < 60K` or `U < 25K`. Otherwise the band is gentle (≥0.2),
firm (≥0.4) or urgent (≥0.6) (`ctx-reduce-nudge.ts:26-92`). It holds for any of:
- an unevaluable or invalidated baseline;
- a recent reduce;
- agent drops applied this pass;
- a pending post-reduce grace;
- post-reduce grace until U regrows by `max(25K, 0.08·T)` or the band escalates.

It fires on an upward crossing. It re-fires in the same band only when U has grown by
`max(25K, 0.08·T)` **and** at least 5 real user turns have passed (`:142-285,460`). Delivery
appends the reminder to the next tool output in `tool.execute.after` (`hook-handlers.ts:520-600`).

**Channel 2.** It fires when `T ≥ 60K`, `U ≥ 50K` and `severity ≥ 0.75` (`ctx-reduce-nudge.ts:312-348`).
The transform arms a `pending` lease by CAS (`transform.ts:3009-3054`, CAS at `:3035`). Delivery happens on
`message.updated` with `finish ∈ {stop, tool-calls}`, as a synthetic user message
(`event-handler.ts:898-905`; `channel2-delivery.ts:179-~300`). It is revalidated before sending
and skipped for a terminal subagent.

| Input | Source | file:line | Class |
|---|---|---|---|
| final message array (text, file, tool input, tool output parts; synthetic flags; drop sentinels) | `measureTailHygiene(messages)` after every mutation of this pass | `tail-hygiene-walk.ts:607-771`; `pp:3057-3069` | **message content** |
| tags (status, number) | `postprocessTailTags` | `pp:3039`; `tail-hygiene-walk.ts:489-517` | (b) |
| `protectedTagNumbers` | Protection window | `pp:3060` | (b)+(c)+(a) |
| pending drop tag numbers | `pending_ops` (drop) | `pp:3042-3046` | (b) |
| `bustedThisPass` (re-measure or keep frozen ratios) | Postprocess | `pp:3052-3064`; `tail-hygiene-walk.ts:1929-1948` | derived |
| hygiene calibration (`toolsRatio`, `proseRatio`, units version) | `sessionDecisionCalibration` + `transitionSessionHygieneUnits` | `pp:3050-3066` | (b)/(c) |
| previous baseline | `channel1StateBySession` (process-local) | `pp:3047` | (b) process-local |
| post-reduce grace (`pending`, `baselineU`, `preLevel`) | `session_meta` Channel 1 nudge state | `pp:3085-3100`; `storage-meta-persisted.ts:1215` | (b) |
| `lastNudgeUndropped`, `level`, `ordinal` | `session_meta` | `transform.ts:3012-3024`; `storage-meta-persisted.ts:1198,1215` | (b) |
| `realUserTurnCount` | `countRealUserMessages(messages)` | `pp:3106` | (a) count of real user turns |
| `usableWindow` | `resolvedContextLimit` | `transform.ts:2616`; `pp:3105` | (a) |
| `reducedSinceRefresh`, `agentDropsAppliedThisPass` | `ctx_reduce` tool activity (process-local state) | `ctx-reduce-nudge.ts:16-24` | (b) |
| `turnDeltaT` growth between passes | `tool.execute.after`: output tokens × `toolsRatio` | `hook-handlers.ts:1556` | (a) tool results as they complete |
| `ctxReduceCallable` | Frozen verdict from the first user message's tools map + agent/session permissions (`primeCtxReduceSpawnPermission`) | `transform.ts:1107-1113,1164-1166` | (a) |
| Channel 2 lease | `session_meta` Channel 2 state (CAS) | `transform.ts:3027-3040`; `storage-meta-persisted.ts:1366` | (b) |
| step-boundary `finish` reason, subagent run active | `message.updated.info.finish`; live run tracking | `event-handler.ts:898-905`; `channel2-delivery.ts:192-196` | (a) |
| thresholds 60K / 25K / 50K / 0.2 / 0.4 / 0.6 / 0.75 / 0.08 / 5 turns | Constants | `ctx-reduce-nudge.ts:26-35,460` | (c) |

---

## Proposed context-status fields (class (a), deduplicated)

These are the class (a) inputs above, collapsed into one per-step record. Anything not in this
list is MC state (b) or config (c) and should stay out of the status.

| Field | Type | Meaning |
|---|---|---|
| `session_id` | `string` | Stable conversation id MC keys all state on. |
| `step_id` | `string` (monotonic, sortable) | Id of this model step. It replaces OpenCode's ascending message ids for the late-event guard (`event-handler.ts:798-814`). |
| `is_subagent` | `boolean` | The session was spawned by a parent. It selects reduced mode and disables historian and emergency recovery. |
| `session_directory` | `string` | Working directory of the session. MC derives the project identity and memory scope from it. |
| `agent` | `string \| null` | Active agent name. It is used for the tool-set hash, notifications and ctx_reduce permission. |
| `model` | `{ provider_id: string, model_id: string }` | The model this step's request will go to. |
| `variant` | `string \| null` | Reasoning-effort variant. On some models a change busts the provider cache. |
| `context_window` | `{ limit_tokens: number, max_output_tokens?: number, absolute_wall_tokens?: number }` | Catalog window for `model`. MC still narrows it with detected-overflow and proven-floor state. |
| `last_usage` | `{ input_tokens: number, cache_read_tokens: number, cache_write_tokens: number, output_tokens?: number, model: {provider_id, model_id}, step_id: string, completed_at_ms: number, finish: "stop" \| "tool-calls" \| "length" \| "error" \| string } \| null` | Usage of the newest completed provider response. MC computes pressure from it and stamps `last_response_time`, which drives the TTL scheduler and `ttl_idle`. |
| `last_error` | `{ kind: "context_overflow" \| "thinking_binding" \| "other", message: string, reported_limit_tokens?: number, reported_limit_provenance?: "prompt_only" \| "combined" \| "unknown", reported_input_tokens?: number, attempted_input_tokens?: number, model: {provider_id, model_id}, message_ref?: string } \| null` | Provider rejection from the previous step. It arms emergency recovery or records the limit. The runner may send the raw error and let MC classify it with `detectOverflow`. |
| `system_prompt_hash` | `string` | Hash of the system prompt exactly as it will be sent this step. It removes today's one-pass lag. |
| `system_prompt_tokens` | `number` | Size of that system prompt. It feeds the final-wire estimate. |
| `tool_set_hash` | `string` | Fingerprint of the tool definitions sent this step. It is attribution only and never folds. |
| `tools_available` | `{ ctx_reduce: boolean, todowrite: boolean }` | Whether the model can call these tools this session. MC freezes the first value. |
| `turn` | `{ newest_user_message_id: string, real_user_turn_count: number }` | Once-per-turn heuristics guard, plus the Channel 1 sticky-turn floor. |
| `window_head` | `{ first_message_ids: string[] }` | Ids of the first K messages the runner will send. They give the tag load floor and tell MC where the served window starts. |
| `host_compaction` | `{ compaction_message_id: string, summary_message_id: string, completed_at_ms: number } \| null` | The runner's own compaction heads the window. It triggers the `host_compaction` fold. |
| `pre_send_input_tokens` | `{ tokens: number, trusted: boolean } \| null` | Optional runner-side token count of the request about to be sent. It replaces `estimateFinalWireInputTokens`, which walks the message array, for the fail-closed and unknown-usage paths. |
| `transcript` | see the next section | Message content, or a delta of it, when MC does not already hold a copy. |
| `now_ms` | `number` (optional) | Runner clock for this step. MC can use its own clock; supplying this makes replays deterministic. |

### Not needed in the status (MC holds or resolves them)

- **Scheduler state.** `cache_ttl` (config, per model), `last_response_time` (MC stamps it from
  `last_usage.completed_at_ms`), and the execute thresholds and tokens.
- **Per-model and recovery state.** Last observed model key, `observed_safe_input_tokens`, detected
  limit, emergency latch, historian failure count, overflow origin, no-head count, and the
  emergency input sample.
- **m[0]/m[1] state.** All m0/m1 cache columns and markers, compartments, memories, profile
  version, workspace signatures, and the mutation logs.
- **Reduction state.** Tags, `pending_ops`, protection floor snapshot, calibration,
  hygiene-unit version, and nudge state for Channel 1 and Channel 2.
- **User intent.** `/ctx-flush` and recomp arrive through MC commands, not through the status.

---

## Current decisions with no runner-model equivalent

These are the things the current TypeScript decisions obtain only from OpenCode's own store, from
the full message array on every pass, from process lifetime, or from host side effects. Each one
needs a design decision; a plain status field does not cover it.

1. **The raw transcript for the historian trigger and the protected-tail boundary.**
   `resolveProtectedTailBoundary`, `getRawHistoryEligibility` and `readSessionChunk` read the
   session's messages after the last compartment from the OpenCode DB, or from the transform's
   in-memory tail (`protected-tail-boundary.ts:519-526,1105-1120`; `compartment-trigger.ts:335-398`).
   They need ordinals, true-raw token sizes, tool arcs (open and closed), commit clusters and
   message ids. A runner-driven MC must either keep its own transcript (append-only ingest per
   step) or receive a delta each step. The historian itself (`startCompartmentAgent`) also reads
   raw history.
2. **Content-bearing reductions run over the live message array.** The following all read or
   rewrite actual message parts through `targets`/`messageTagNumbers`, built by tagging the array
   the host just served:
   - heuristic cleanup: system-injection strip, tool fingerprint dedup, caveman;
   - emergency `measureReclaim`;
   - reasoning clearing;
   - `measureTailHygiene`.
   In a NOOP/CompactionMessage protocol MC does not own the wire bytes each step. Either MC holds
   the transcript and emits a full replacement or edit list, or these lanes move to the runner.
3. **Tagging and §N§ ids.** `tags`, pending-op tag ids and protection windows are all keyed to
   tag numbers assigned by tagging the served array (`deriveTagLoadFloor` over the wire ids,
   `transform.ts:1963`). They need a stable per-message identity from the runner and an MC-side
   tagger over that identity.
4. **The first pass after a process restart.** `loadedSessions` (`transform.ts:1348`) zeroes usage
   and triggers historian recovery on load (`:1360-1380,1849-1867`). Process lifetime is not
   observable through a status call. MC must decide whether "first call after MC start" keeps
   these semantics.
5. **Event ordering and timing.** Today usage arrives on `message.updated`, which is asynchronous,
   can arrive out of order, and fires per streaming delta. It is separate from the transform, and
   `lastResponseTime` is MC's `Date.now()` at event time. In the runner model both arrive together
   in one call. The late-event guard and the "idle > TTL" measurement then depend on
   `last_usage.completed_at_ms` being the real completion time, not the time of the next call.
6. **The system prompt hash lags one step.** `system.transform` runs after the messages transform,
   so today's `system_hash` fold and the `/ctx-flush`-style refresh fire one pass late
   (`system-prompt-hash.ts:492-504`; `transform.ts:2432-2438`). A runner that sends the hash up
   front changes when this fires. That is an improvement, but it is a behavior change.
7. **Blocking and refusing.** At 95% MC awaits the historian inside the transform for up to 60s
   (`transform-compartment-phase.ts:434-526`). On a provider overflow with no fold it sends a
   notice and **aborts** the request (`transform.ts:2784-2840`). NOOP/CompactionMessage has no
   "wait" or "refuse this step" answer, so the protocol needs one, for example `BLOCK`/`REFUSE`
   with a user-facing notice.
8. **Out-of-band host side effects.** MC currently drives several host actions directly:
   - `sendStatusNotification` toasts and notices;
   - Channel 2 delivered as a synthetic user message through `promptAsync` at a step boundary
     (`channel2-delivery.ts`);
   - Channel 1 appended to a tool output in `tool.execute.after` (`hook-handlers.ts:520-600`);
   - native-compaction interplay (`session.compacted` clears markers, `event-handler.ts:977-1000`).
   Each needs a response channel, or a separate runner hook call such as a tool-result callback.
9. **Model recovery from OpenCode's DB and SDK.**
   - `hostModelFallback`, i.e. `findLastAssistantModelFromOpenCodeDb` (`transform.ts:1550-1559`);
   - `client.session.get` for the session directory (`:1199-1230`);
   - `getSdkContextLimit` / `refreshModelLimitsFromApi` over OpenCode's resolved provider config
     (`event-handler.ts:697-770`).
   These disappear if the runner always sends `model` and `context_window`.
10. **ctx_reduce availability from the first user message's tools map and OpenCode permission
    APIs** (`transform.ts:1107-1113,1164-1175`). The runner must state tool availability
    explicitly. MC's once-per-session freeze stays on MC's side.
11. **Store-generation rebase and coordinate re-derivation** (`transform.ts:928-962`) exist because
    OpenCode can serve a different projection of the same conversation. With a runner-owned
    transcript and stable ids this becomes a runner guarantee, not an MC check.
12. **Process-local cross-pass sets.** The following are process-local sets and maps that carry
    intent between passes:
    - `historyRefreshSessions`, `pendingMaterializationSessions`,
      `deferredHistoryRefreshSessions`, `deferredMaterializationSessions`;
    - `lastHeuristicsTurnId`, `routinePressureAppliedBySession`, `channel1StateBySession`;
    - the active-run registry.
    They work only because one process sees every pass. A runner calling MC over a boundary needs
    them persisted, or needs the call to be served by a single long-lived MC instance.
