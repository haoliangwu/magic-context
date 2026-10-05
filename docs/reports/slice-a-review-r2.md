# Slice A re-review (round 2): frozen last-known-good replay after the review fixes

Base: `alfonso/slice-a-on-master` at `6e76e1bc83` (slice A merged onto master, refusal code
renamed MC-H07). Reviewed the fix commits `2bc947ac33`, `179e5d94b4`, `c7586f2bda`,
`12f5f287a1`, `1374a0de38`, `f8a09787b6` against the first review (`65aa621676`) and plan
section 3 (`.cortexkit/alfonso/plans/frozen-replay-recovery-debt-r2.md`). No production code was
changed. New evidence:

- `packages/plugin/src/hooks/magic-context/rust-mode-frozen-review-r2.test.ts`: unit findings.
  Tests named `FINDING` are red on purpose; tests named `CONFIRMS` are green.
- `packages/e2e-tests/tests/rust-frozen-restart-review-drill.test.ts`: the hermetic restart and
  refusal drills plan §3.8 asked for, against OpenCode 1.18.30 and the real ck-mc/ck-subc
  (hermetic Rust e2e harness). Results below.

Every host run used throwaway roots (`TMPDIR`, `XDG_*`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/slice-a-review-r2/`). `lsof` on the
spawned `opencode serve` (pid 43506) listed only
`$TMPDIR/magic-context/slice-a-review-r2/tmp/opencode-e2e-FHRPyJ/data/opencode/opencode.db{,-shm,-wal}`.

## Summary

| # | Finding | Rank | Proof |
|---|---|---|---|
| R1 | A restart right after an uncaptured failure replay sends signed thinking behind retagged bytes (provider 400 on Opus 5.5 / Sonnet 5.5 / Fable 5.1) | **blocking** | e2e drill, red |
| R2 | Every LKG replay is admitted against the usable hard limit, which is above a provider-enforced prompt cap (GitHub Copilot) | **blocking** | unit `FINDING`, red |
| R3 | The 4-bytes/token proxy refuses a failure/wrapper replay whose wire fits (OpenCode tool metadata, images) | **blocking** (regression from `f8a09787b6`) | unit `FINDING`, red; mutation proves the cause |
| R4 | Each restart resets both count-release budgets; a freeze resumed by restarts never count-releases | non-blocking | unit `FINDING`, red |
| R5 | Rust sessions now refuse every ordinary transform bug (MC-S06), including a session's first pass with no slot | non-blocking (design note) | code trace |
| R6 | `server.instance.disposed` for a same-directory reopen can unregister the new adapter | non-blocking (no production effect) | code trace |
| R7 | Frozen-pass measurement cost | non-blocking | benchmark |

Items the review confirmed hold: item 1 (no retention; production never resolves through the
registry), item 2 (the restart strip, on all three prefix-bound models), item 3 (stale slot), item
6 (MC-H07 ends), item 8, item 9's no-raw-send, and the restart drill (byte-identical across a
host restart during a captured freeze).

## Blocking findings

### R1. A restart right after an uncaptured failure replay sends thinking bound to a changed prefix

- **Where:** `rust-mode-transform.ts:3757-3786` (the cold-start check fires only on a slot that
  ends in raw-served messages), `lkg-replay.ts:677-715` (`coldStartRawServedIndex`). The failure
  replay (`rust-mode-transform.ts:1955-2035`) serves the slot plus the raw tail but captures
  nothing, so the slot does not hold the raw-served messages.
- **Scenario (most common outage shape):** ck-mc dies; the user's next turn is served from the
  slot (freeze entered, not captured); the user restarts OpenCode; the first pass is a healthy
  SOFT+. The new adapter has no freeze and no last-served array, so it adopts module output, which
  retags the user message the replay served raw, and keeps the signed thinking block the model
  produced against the untagged prefix. On Opus 5.5, Sonnet 5.5 and Fable 5.1 that request is a
  400 (any prefix edit other than a gap-free oldest-prefix thinking removal requires stripping
  every later signed block); on other models it is a cache bust.
- **Proof (real host, OpenCode 1.18.30 + real ck-mc):** e2e `rust-frozen-restart-review-drill.test.ts`
  "a restart right after the uncaptured outage replay (the documented residual)", **red** (twice).
  Output: `firstChanged: 8` (`"outage turn: …"` became `"§9§ outage turn: …"`),
  `boundBlocks: [{signature: "sig-outage", producedBy: 4, changedAt: 8}]`; the post-restart pass
  logged `rust pass: decision=SOFT+ … served_from=transform in=11 out=13`, with no strip.
- **Status:** the plan (§3.5) documents this window as a residual closed by Slice B's durable
  marker, but describes it as module adoption (a bust). The slice's own pin
  (`rust-mode-frozen-defects.test.ts:707`) uses a thinking-free assistant, so the 400 is not
  visible there. It is pre-existing, not a regression. It is still the blocking class and the
  likeliest real sequence (module crash, then restart).
- **Interim option (no migration):** on the first applied pass of a process, compare module
  output with raw input for messages past the slot's end. When the module renders one of them
  differently, hand the strip gate the slot as an unproven last-served array (strip from the slot
  end). That over-strips only when a healthy session also lost its last capture.

### R2. Every LKG replay is admitted above a provider-enforced prompt cap

- **Where:** `lkg-replay-fit.ts:49-69` (`lkgReplayLimit`: usable hard limit first), used by the
  failure replay (`rust-mode-transform.ts:2016`), the wrapper replay
  (`rust-mode-transform.ts:2093-2112` → `messages-transform.ts:484-490`) and the healthy frozen
  admission (`rust-mode-transform.ts:2500-2522`). For a catalog row with an input cap below the
  window, `deriveWindowGeometry` sets `usableSoft = input` (`window-geometry.ts:545`) but
  `usableHard = window − min(output, 32k)` (`:609-610`); the clamp at `:613` only raises hard.
- **Which models:** GitHub Copilot rows in OpenCode's current catalog: `gpt-5-mini`
  264k/128k/64k (hard 232k vs prompt cap 128k), `claude-haiku-4.5` 200k/136k (168k vs 136k),
  `gemini-3.5-flash` 200k/128k (168k vs 128k), `mai-code-1.1-flash` 256k/128k (224k vs 128k),
  `grok-4.x` 500k/372k (468k vs 372k), gpt-5.x 400k/272k (368k vs 272k). Copilot enforces its
  prompt limit and answers "Prompt exceeds the limit of N tokens"
  (`overflow-detection.ts:38,75`). For the OpenAI first-party/Codex rows the project's own
  geometry research (`.cortexkit/alfonso/plans/context-window-geometry-v1.md`) says the input
  figure is an allocation the backend does not enforce, so those are not over.
- **Before this slice:** the failure and wrapper replays used `trusted ?? detected`
  (= `usableSoft` = 128k here). `f8a09787b6` widened them to the hard limit; the frozen admission
  (new in this slice) used the hard limit from the start.
- **Scenario:** a Copilot `gpt-5-mini` session freezes; slot plus raw tail is 150k tokens. The
  failure/wrapper replay and every healthy frozen pass admit it (`150k ≤ 232k`) and send an
  over-window request; Copilot returns 400. It self-heals after one rejection (the detected
  limit caps the geometry), at the cost of a failed turn.
- **Proof:** unit `FINDING: a failure or wrapper replay is admitted above a provider-enforced
  prompt limit`, **red**: `{limit: 232000, fits: true}`, expected `fits: false`. The trusted
  limit for the same row is 128000 (asserted in the test).

### R3. The 4-bytes/token proxy refuses failure and wrapper replays whose wire fits (item 5)

- **Where:** `lkg-replay-fit.ts:84-113` (`measureLkgReplay`) serializes the whole OpenCode
  message (`rawFallbackSerializedBytes`, `:21-39`), including fields the provider never sees:
  tool `state.metadata` (the edit tool keeps the whole file before and after, the bash tool a
  second copy of its output) and `data:` image URLs (the estimator counts images by pixel size;
  the proxy counts base64 bytes). `f8a09787b6` added this proxy to the failure and wrapper replays,
  which had none; an "over" verdict declines the replay.
- **Scenario:** a session that edited a 300 KB file twice carries about 1.2 MB of metadata; with
  a 200k limit the proxy allows 800 KB. During a module outage every turn is refused
  (`RawFallbackContextLimitError`) although the request is a few hundred tokens. The same holds
  for a pasted screenshot of about 1 MB. The refusal lasts for the whole outage (and the parked
  shortcut uses the same admission). With emergency recovery armed, the frozen path's proven-limit
  branch uses the same measurement and can refuse with MC-H07 until a bust; `/ctx-flush` ends it.
- **Proof:** unit `FINDING: a failure replay whose only bulk is edit-tool metadata the wire
  never carries is refused`, **red**: received `{refused: "RawFallbackContextLimitError",
  served: 0}`; the trusted estimate of the same array is under 20,000 tokens (asserted). Cause
  isolated by mutation: with the proxy branch of `measureLkgReplay` disabled
  (`if (false && …)`), this test turned green and no other test in the file changed
  (restored; `git diff --stat` empty after).
- **Answer to "can it refuse a turn that fits":** yes, on the failure and wrapper replays (a
  regression) and on the frozen emergency branch. On a healthy frozen pass it can also release
  (bust) when the module's array is smaller by proxy. With equal metadata on both sides it serves
  `frozen_fit_both_over`.

## Non-blocking findings

### R4. A restart resets both count-release budgets (item 10)

- **Where:** the cold-start resume sets `lkgFrozenAtInputCount = inputCount`
  (`rust-mode-transform.ts:3771`), and a fresh state has `lkgFrozenHealthyPasses = 0`; the release
  limits are 8 passes / 16 messages (`:206-207`).
- **Proof:** unit `FINDING: a freeze resumed by each restart never reaches its count release`,
  **red**: after three restarts, each after six frozen passes, `{frozenPasses: 18,
  rawTailGrowth: 38, stillFrozen: true}`.
- **Does the freeze still end?** Yes, but not by count: it ends on a module bust, on context-fit
  admission (frozen array over the limit while module output fits), or by a pass without a
  restart in between. It takes restarts more often than every 8 passes to keep it going. The
  cost is that compaction stays off the wire while the raw tail grows. Slice B's durable marker
  should carry the budget.

### R5. Rust sessions now refuse every ordinary transform error (item 9)

`messages-transform.ts:536-552` throws `DegradedPassRefusalError` (MC-S06) for any non-transient
error in a Rust-mode instance whose replay could not serve. That includes a session's first pass
(no slot yet, so `lkg_miss`), where the raw input would usually fit. A deterministic bug before
the adapter's capture therefore leaves the session refused on every pass, where master degraded to
an unmanaged pass. This matches the adapter's own `serveRawFallback` (it refuses with compaction
on), so it is consistent. The commit names it as deliberate. It is a product decision to confirm,
not a defect. The no-raw-send property holds: no path in the wrapper sends a Rust session's raw
input with compaction on.

### R6. Registry lifetime (item 1)

- Production never resolves through the registry: OpenCode 1 (`index.ts:915-920`) and both
  OpenCode 2 handlers (`v2/hooks/context.ts:1620,1681`) pass their own instance's participant,
  so attribution with two live instances, or a stale instance not yet disposed, cannot pick the
  wrong adapter. The registry is a fallback that only tests use.
- Nothing is retained: unit `CONFIRMS: an undisposed adapter that ran a session is collected` is
  green, so the weak reference is the only registry hold. It turns red when the registry holds the
  participant strongly (mutation: `new WeakRef(participant)` replaced by a strong holder;
  restored, diff empty). OpenCode 2's `dispose()` calls `disposeRust()` (`context.ts:1943`).
- Minor: OpenCode 1's dispose filter matches by directory only (`index.ts:864`). If a reopened
  instance for the same directory receives the old instance's `server.instance.disposed`, it
  unregisters its own adapter. That has no production effect, since the registry is not used.

### R7. Speed of a frozen healthy pass (item 7)

`measureLkgReplay` on candidates the proxy cannot reject (the estimator runs). Measured with Bun
1.4.2 on this machine at load average 76:
- 170 messages, 746 KB (about 215k estimated tokens, 200k window): median 6.9 ms (6.6–7.9).
- 880 messages, 3.9 MB (about 1.1M estimated tokens, 1M window): median 32.1 ms (30.7–34.9).

When the frozen array is over, module output is measured too, which doubles the cost. The proxy
aborts early on arrays it proves over (about 1 ms at 1.7 MB). This is not significant next to
module transport.

## Items checked and found to hold

- **Item 2 (thinking strip on the first pass after a restart):** unit `CONFIRMS` tests for
  `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1` are all green. A trim-only SOFT
  after a restart over a captured frozen slot strips every signed block from the first changed
  message. That over-strips the oldest-prefix trim, which is valid for all three. All three go red
  with the cold-start last-served array neutralized (`coldStartLastServed = null`; restored).
- **Item 3 (stale slot):** the trailing-run rule holds against the review's restored-backup case.
  A healthy slot's messages are tagged (the Rust overlay tags user text, assistant text and tool
  results, `mc-module/src/transform.rs:9941-10047`), so a healthy slot rarely ends in a raw run. In
  the e2e residual drill, whose durable slot is healthy module output captured before the outage,
  the check correctly did not fire (no `lkg_cold_start_frozen_slot_*` line).
- **Item 6 (MC-H07):** the refusal keeps the freeze and ends on the first fitting module output or
  any module bust (`/ctx-flush`). It can loop only while both arrays stay over the proven limit
  (see R3 for a proxy-only cause).
- **Item 8:** the wrapper declines a replay when its own adapter is in the emergency band, whatever
  threw (`messages-transform.ts:441-452`). Attribution: see R6.
- **Hermetic drills (plan §3.8), which did not exist before.** The existing byte-identity lanes do
  not cover a restart during a freeze. `rust-steady-state-byte-identity` never kills or restarts.
  `rust-compaction-marker-byte-identity` restarts a healthy session. `rust-fm-oc-*` and
  `rust-park-self-heal` kill ck-mc without restarting OpenCode. The new drill file, run three
  times, ends with:
  - restart drill (outage replay, two captured frozen turns, host restart, one turn):
    **green**. `lkg_cold_start_frozen_slot_resumed raw_served_index=10`, then
    `served_from=lkg_frozen`. All 13 earlier messages are byte-identical, system and tools are
    unchanged, and 4 signed thinking blocks are carried with none behind a change.
  - residual drill: **red** (R1).
  - refusal drill (outage replay at 96% usage, an emergency-band turn refused with
    `mc_rust_emergency_refusal`, no provider request, module restored): **green** for thinking
    safety. The resumed turn was an emergency `HARD reason=coverage_fold`, a legitimate full
    bust, so this drill shows no 400 but cannot show frozen-byte identity across a refusal; the
    unit tests in `rust-mode-frozen-defects.test.ts` cover that.

## Commands

- Unit: `bun test src/hooks/magic-context/rust-mode-frozen-review-r2.test.ts` (packages/plugin):
  4 pass, 3 fail (the three `FINDING` tests, by design).
- E2E: `RUSTC_WRAPPER= TMPDIR=… XDG_*=… bun test --timeout 2400000 --max-concurrency=1
  tests/rust-frozen-restart-review-drill.test.ts` (packages/e2e-tests): 2 pass, 1 fail (R1, by
  design).
