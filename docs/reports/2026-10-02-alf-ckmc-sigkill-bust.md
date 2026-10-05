# ALF: ck-mc health-restart SIGKILL and frozen-replay release bust

Investigation date: 2026-10-02. All incident times below are UTC. ALF's OpenCode conversation is identified by session `ses_227ce5788ffeRPA9THoPLOQreO`. Rust transform mode selects the recovery adapter investigated here; Anthropic Opus 5.5 identifies the provider/model whose prompt-cache usage measures the bust. Source inspected at task base `dea80cf4a4eea6a2499619b45c48baddbdab87b6`; deployed binary source equivalence was not established.

## Cause first

1. **The subc supervisor killed ck-mc PID 64638 at 03:53:39.316Z.** Repeated unanswered five-second health probes triggered a restart at 03:53:09.241Z; the module did not exit within its 30-second drain budget, so the daemon killed it. This is positive daemon evidence, not an inference from signal 9. No jetsam evidence appeared in the system-log queries. Extreme host overload is strongly supported as a contributor to unresponsiveness, but the precise scheduling/lock/I/O bottleneck is not recorded.
2. **The 03:51:27Z full-sync demand means the process-local ingress projection and matching request fallback could not supply ALF's delta base.** The logs do not identify the specific eviction/invalidation event. Last-session-route teardown, projection LRU eviction, or a revert-epoch change are source-supported possibilities; it is not justified to call this confirmed memory-pressure eviction. It happened *before* this SIGKILL. The 84.56 seconds is a failed plugin pass including delta wait, full-array retry, deadline recovery and route-bind failure—not the measured runtime of a successful full sync. Earlier and subsequent similarly sized full-array passes completed in seconds.
3. **The later 395,859-token bust was avoidable as a recovery-policy bust.** At 04:02:44Z the adapter released a still-valid frozen replay solely because raw input growth reached its bound. The module decision remained `SOFT+`, scheduler `defer`. Replacing previously served raw tail with tagged module output changed message[627]. This is a confirmed conflict with the architecture's ride-only deferred-change rule. The bound is intentional protection against stale replay, not an unexplained malfunction; removing it without replacement would exchange a cache defect for unbounded recovery exposure.

**Changes in this task:** report only. No runtime code, live stores, modules, architecture or structure documents changed. The frozen-replay release fix is a design proposal below, not an implementation.

## Evidence sources and method

Live sources were read only; no database queries, copies, restarts or signals were needed:

- **D:** `~/.local/share/cortexkit/run/logs/subc.2026-10-02.log`. `ck daemon triage` locates it under the run directory; it reports daemon PID 64530 alive and port 8757. Line citations below refer to this day's file as read during investigation.
- **M:** `~/.local/share/cortexkit/magic-context/logs/magic-context.2026-10-02.log`.
- **P:** `$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context/magic-context.log`; resolved to `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/opencode/magic-context/magic-context.log` (the tools also display its `/private/var/...` alias).
- Authentication request dumps under that temporary directory's `opencode-anthropic-auth-dumps`, read by the repository analyzer.
- macOS unified log, queried with explicit `--timezone UTC`, 03:48–03:56Z. Both queries returned only the timestamp header: one with `process == "kernel"`; another with `eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "ck-mc"`. Absence here does not prove absence of system pressure or complete log retention; the supervisor's explicit kill record settles the sender without relying on it.

## 1. Who sent SIGKILL, and why?

The daemon records the sequence unambiguously:

> D:7270, 03:51:18.727Z: `health.check probe failed module_id=magic-context consecutive_failures=1 threshold=3 evidence=no-answer ... module did not answer health.check within 5s`
>
> D:7271, 03:51:26.975Z: `late health.check answer proves the module is alive module_id=magic-context latency_ms=13386`
>
> D:7286, 03:52:31.586Z: `health.check probe failed module_id=magic-context consecutive_failures=2 threshold=3 evidence=no-answer`
>
> D:7296–7299, 03:53:09.241Z: `module health threshold breached ... status=unresponsive`; `health-triggered module restart ... restart_count=1`; `module drain began; route admission closed ... reason=Restart`; `module drain complete ... routes_notified=13 route_goodbyes=13 ... drained=true`
>
> D:7312, 03:53:39.316Z: `drain budget expired before the module exited; killing it module_id=magic-context pid=64638 budget_ms=30000 reason=Restarting stop_notice=SentOverConnection`
>
> M:1837, 03:53:40.458Z: `mc-module: logger initialized`
>
> D:7315, 03:53:40.461Z: `module registered module_id=magic-context ... connection_id=1184`

`ck module status magic-context` independently showed `last exit: signal 9`, `drain 30s`, and one lifetime restart. “Drain complete” at 03:53:09 refers to route/consumer notifications, not process exit; the subsequent process-exit budget still expired. D:7302's `initiated_by=unexplained` is a route-refusal diagnostic, not evidence that an unknown actor initiated this restart: D:7297 explicitly identifies the health-triggered restart.

The outage was broader than a single slow transform. D:7273 logs `slow control dispatch ... elapsed_ms=9225` for magic-context route.open; D:7280 shows prefrontal-core also missing a health probe. The reproduced request diff contains the contemporaneous tool output:

> `load averages: 926.62 635.18 322.31`

This supports severe machine overload. It does not establish which processes caused it, whether CPU starvation or paging dominated, or whether synchronous module work blocked health handling. The brief's approximately 917 MiB footprint was before the *earlier* 02:05Z cut; it is not a measurement at this kill and cannot diagnose this kill as OOM.

**Recommendation:** treat this incident as health-watchdog restart followed by drain-timeout SIGKILL, not jetsam. Investigate fleet concurrency/load and module control-plane responsiveness under saturation together. Instrument health queue/handler delay and stop-notice receipt/completion; distinguish an alive-but-starved module from a genuinely hung one before changing watchdog policy. Simply raising the drain timeout would delay recovery without addressing the load or the later cache transition. No supervisor code defect is proven here.

## 2. Why full sync, and why 84 seconds?

### What the miss does and does not mean

`crates/mc-module/src/lib.rs:4950–5002` loads the durable revert epoch (a generation counter invalidating cached state after a store-side rewrite), snapshots `self.projections`, and selects:

> `None => "projection_cache_missing_or_reverted"`

It first tries that projection's prefix, then a ready transform request with a matching `after` fingerprint. Only when neither supplies the prefix does it return this miss. Fingerprint and context mismatch have distinct labels. Thus the record proves an unavailable projection, not a specific eviction mechanism.

The relevant source mechanisms are:

- `ProjectionCache::snapshot`, `lib.rs:3598–3617`, silently removes an entry with a different persisted revert epoch.
- `ProjectionCache::replace`, `lib.rs:3620–3650`, refuses oversized entries and evicts oldest other sessions when retained bytes exceed the total budget. Constants at `lib.rs:1429–1430`: **256 MiB total, 192 MiB per entry**. This projection LRU is distinct from the native-attachment cache; `native_cache_evicted=0` cannot exonerate it. Its eviction has no per-victim log here.
- `unbind_route`, `lib.rs:5177–5254`, removes projections **and** transform snapshots when the session's last bound route closes. SUBC route-gone handling calls it (`lib.rs:13781–13785`). Projection removal has no corresponding event log. The transform-page discard log is conditional on staged pages, so lack of that log does not rule out teardown.

The previous delta really did execute: M:1832 at 03:51:24.574Z reports `handler_total=20844.7`, `projection_reused_messages=3349`, `projection_projected_messages=2`, and `projection_cache_store=2.4`. At 03:51:27.127Z, M:1834 reports the missing/reverted projection. There is no logger restart between those records. A process restart at 03:53 cannot explain the earlier loss.

One plausible sequence is timeout/reconnection followed by last-route cleanup: P:38394 logs a final-page deadline at 03:51:17.710Z; D:7272–7273 logs a newly accepted magic-context route at 03:51:26.975Z after 9.225 seconds of dispatch delay. The adapter retries identical final-page completion (`rust-mode-transform.ts:1660–1741`); transport cancellation can abandon a response while module work still finishes (`module-transport.ts:561–565`). However, a timeout while asking the module to execute an already-uploaded page series specifically avoids connection invalidation (`module-transport.ts:643–650`). **A timeout alone is therefore not proof of last-route teardown.** Neither inspected log records ALF's projection eviction, last-route close, or old/new revert epoch. No particular victim/admitting session can be named honestly.

### Timing comparison

Selected M records (all milliseconds, full-array ingress sizes—not provider-body sizes):

| Full-array pass | Bytes | Digest / size encode | Handler total | Projection work |
| --- | ---: | ---: | ---: | ---: |
| 00:46:31–33Z after context mismatch (M:501,504) | 36,249,724 | 175.6 / 27.3 | 1,615.6 | 62.4; 3,127 messages |
| 02:06:15–17Z after earlier restart (M:1091,1094) | 36,798,966 | 206.7 / 29.1 | 2,407.2 | 82.1; 3,215 messages |
| 03:51:48Z failed incident retry (M:1835) | 37,969,767 | **15,951.8 / 1,880.1** | **No completed timing record before kill** | Not available |
| 03:56:46–48Z recovery (M:1846,1848) | 38,011,325 | 187.4 / 24.0 | 2,135.9 | 59.8; 3,362 messages |

The incident's digest alone was about 85 times the recovery digest at almost identical byte size. Even ordinary small-delta work was already very slow: M:1829 has `handler_total=15200.2`; M:1832 has `20844.7`, with delays spread across state evolution, output build, store work and followup. That distribution and the machine load argue against intrinsic 38 MB full-sync cost as the sole explanation.

P:38393–38399 reconstructs the plugin pass:

- 03:51:03.704Z: sends two-message tail delta.
- 03:51:17.710Z: deadline; waits up to 45 seconds for identical final-page completion.
- 03:51:27.226Z: delta transport returns after **23,520.3 ms**, requesting full sync.
- 03:51:27.315Z: full-array wire retry built; cached message-ordinal lookup kept instead of rebuilding it. The retry did not reseed module state.
- 03:51:48.865Z: module records full page's slow digest/encode.
- 03:51:59.890Z: module reaches `pending drops held ... scheduler=Defer` (M:1836).
- 03:52:12.646Z: another final-page completion deadline wait (P:38521).
- 03:52:27.538Z: LKG served after `module_id 'magic-context' did not answer route.bind within 12s` (P:38709–38719).

Final record:

> `decision=NEED_FULL_SYNC reason=module_timeout served_from=lkg ... applied=false ... elapsed=84559.9 ms module=0.0 ms`

The elapsed interval starts before the full-sync demand; it is not an 84-second completed module full sync. The retry's exact internal bottleneck is unavailable because it never logged completion. Overload is the best-supported explanation for the anomalous timing, not a proven lock or algorithmic defect.

**Recommendation:** add cause-specific projection-cache diagnostics (LRU victim/admission/charge, rejected store size, last-route cleanup, epoch mismatch), plus correlation for original and retried final pages. Record time spent before handler admission separately from actual work. Investigate route lifecycle/cache retention under timeout as a hypothesis before changing budgets. Do not raise projection budgets on the strength of this generic reason alone; earlier comparable full syncs are already fast. A reliable eviction attribution needs new telemetry or a controlled reproduction, not a current live-store snapshot of an ephemeral historical cache.

## 3. Was release avoidable? Design sketch

### What freezes and why tags differ

The LKG slot freezes a serialized **provider-visible output prefix**, not the module process or durable state. `lkg-slot.ts:555–575` and `lkg-replay.ts:581–644` validate the slot/anchor and append the current pristine input tail. The adapter skips normal postprocessing for replay to preserve previously served bytes; persisted binding-mismatch strips are still replayed (`rust-mode-transform.ts:3511–3564,3575–3578`). Hence messages beyond the captured anchor are raw, and have not gone through the module's tag rendering. On release the adapter adopts module output and normal postprocessing. Adding an ordinal tag is a real provider-byte change, even if the tool result's semantics are unchanged.

The module continues healthy transforms while frozen; the message prefix it returned and acknowledged is not the same as the frozen message prefix the plugin actually sends to the provider. A delta based on one must not be spliced into the other. Full-wire transport therefore stays enabled until a bust adopts module output (`rust-mode-transform.ts:3812–3815`). This is a deliberate recovery bridge, not simply replaying the same request forever.

The bound's rationale and values at `rust-mode-transform.ts:171–174` are explicit:

> “A frozen defer prevents an immediate LKG/module/LKG double bust. After eight healthy module passes or sixteen new raw messages, continued replay adds more stale-snapshot risk than value.”

At `rust-mode-transform.ts:3536–3548`, a still-valid replay becomes a priced pass when raw input growth is **at least 16**, or healthy passes reach **8**. Those are message-count/pass-count bounds, not byte or token limits. Outage fallback resets the input baseline (`3985–4005`), so counts need not start at the first failure. P:39625,39754,40324,40455 show healthy `SOFT+` frozen passes at 03:56:49, 03:56:56, 03:57:46 and 03:57:55; P:43639–43641 shows:

> 04:02:44.444Z: `lkg_frozen_replay_released reason=raw_tail_growth_limit`
>
> 04:02:44.445Z: `decision=SOFT+ reason=none scheduler=defer ... served_from=transform in=3369 out=609`

The adapter—not a genuine module bust—turned this defer pass into a priced recovery pass.

### Reproduction and cache price

Run from `packages/plugin`:

```sh
bun scripts/analyze-cache-busts.ts --session ses_227ce5788ffeRPA9THoPLOQreO --since 2026-10-02T03:57:57.114Z --until 2026-10-02T04:02:50.878Z --show-diff --all-rows
```

The analyzer found two request dumps, one metered bust:

> `read=184,413 + input=4 = 184,417; floor=579,996 (prevTotal=580,060, ε=64); rewritten≈395,859`
>
> `meterVsBytes: AGREE`; `first-divergence: message[627]`; `divergence-class: unaccounted_rewrite`
>
> Previous tool result content: `[queued pmid=pm_2ec8c55c2dbd6dae\n...`
>
> Current: `[§24990§ queued pmid=pm_2ec8c55c2dbd6dae\n...`

The rewritten-token number is a usage-based estimate, not the number of newly added tags or changed tokens. A small early change invalidates the reusable suffix. Body sizes were 1,797,610 → 1,792,363 bytes, so tagging is the **first** divergence, not necessarily the only rewrite.

`ARCHITECTURE.md:81–83` says a defer pass must replay byte-identical and “Deferred work rides the next bust cycle; it never forces its own.” The forced release conflicts with that invariant. The four-minute-54-second request gap does not itself prove TTL expiry; the meter shows a substantial reusable cache still existed. A timer alone must not be treated as proof of a dead provider cache.

### Recommended design (not implemented)

**Prefer explicit recovery debt that rides the next genuine bust over count-triggered adoption.** Keep replay validation and corruption/provider-safety escapes; do not equate successful-pass count or raw-message count with cache-bust permission.

1. Separate `moduleDecisionBusts` from `recoveryDebt` and explicit unsafe-replay reasons. Mark debt when the existing bounds are reached, but retain the exact frozen representation if validation and safety/resource checks still pass. Healthy module passes can keep advancing durable state off-wire.
2. Adopt module output on a genuine `HARD`, `MIGRATE_HARD`, `EXECUTE`, or `SOFT` decision (already supported at `3448–3567`), or a separately established natural cache invalidation. TTL-based release needs actual provider policy and last-use/cache-breakpoint knowledge, not elapsed wall time guessed from one request.
3. Replace vague “stale-snapshot risk” with enforceable safety budgets: retained bytes, appended raw-tail tokens/context headroom, replay identity/anchor validity, model/provider binding, and reasoning-signature safety. The current raw-tail count misses a single enormous result. If safety requires an emergency adoption before a natural bust, log it as an explicit recovery-originated priced exception with divergence/debt/budget evidence—not as harmless `SOFT+`. Preserve failure recovery and ability to stop unsafe replay.
4. Track the **actual last provider-served array**, including every outage-appended raw tail, and prove prefix equivalence before adoption. Preserve the first-divergence reasoning strip gate, which removes signed thinking blocks after changed provider bytes while leaving unchanged earlier reasoning intact (`transform-postprocess-phase.ts:561–602`); never globally strip unchanged cached reasoning merely because recovery debt exists. Existing `rust-mode-release-strip-gate.test.ts:254–320` protects reasoning after a raw-tail divergence, not zero-bust release.
5. Add integration cases that freeze, append more than 16 raw messages/run more than eight healthy defer passes, and compare actual outgoing provider bytes across all previously served messages. They must stay identical until a genuine bust. Also test invalid anchor/model, resource emergency, reasoning blocks in outage tail, and a genuine execute/fold landing debt once without a second rewrite.

**Do not merely pre-tag the already-served raw tail at release:** that is the observed bust. Tagging each new raw part on its *first* outage serve could help future recovery, but exact parity requires stable ordinal/tag mapping, native serializer and drop/strip state while the module may be unavailable. Guessing tag allocation risks inconsistent IDs; tags alone do not cover compaction-marker insertion, injected agent-reminder nudges, or signed-reasoning differences. A versioned deterministic tail-render contract with authoritative preallocated IDs, append-only replay capture, and byte-parity tests would be a larger alternative design. It cannot retroactively repair this incident's untagged prefix.

**Recommendation:** implement the ride-only recovery-debt design in a separate task, including measurable safety exceptions and provider-byte tests. This is a confirmed release-policy defect relative to the documented invariant, but not authorization to remove safety bounds blindly. No runtime fix is made in this investigation.
