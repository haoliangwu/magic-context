# Nightly Rust hermetic lane red on master `304686005f` (2026-09-27)

## Production answer first

A production restart with plugin dists at `304686005f` and `ck-mc` at `7aae18ef`
does **not** hit this for Rust-mode sessions on OpenCode 1 whose historian model
is a mainstream model with a 128k-or-larger window that the module has a
tokenizer calibration seed for (Claude 4.5 and later, GPT-5.x, Gemini 3.x,
Grok 4, GLM 4.7/5.x, Kimi K2.6 and the rest of
`tokenizer-calibration-seeds.json`, including their openrouter and
github-copilot relays).

The cause is the historian prompt-fit guard from issue 541 (`cd1b13f7`, merged in
`e286d94b`; `ck-mc` `7aae18ef` contains it). Before it sends a historian prompt,
the module converts the prompt's local token count to provider tokens with the
historian model's calibration ratio. It then refuses the firing when that count is
above `0.97 × (window − min(output limit, window / 4))`. A model with no
calibration seed is counted at 2× its local size, the worst ratio in the table. The
failing tests run the historian on the session's own mock model, which has a 24k or
30k window and no seed. A 22k-token local prompt counts as 45k against a 21.8k
limit, so every firing is refused and no compartment is ever written.

Which real users are affected. The Rust module sizes the historian chunk from
`historian.context_limit_tokens` (default 128k, so a chunk of up to 32k provider
tokens for a seeded model, or 32k local tokens for an unseeded one). It does not
use the historian model's window for this. So a Rust-mode session never folds,
logging `historian firing failed … producer_prompt_fit_refused` on every pass,
when the head of the historian chain has a window OpenCode knows and:

- the model has no calibration seed and its window is below roughly 90k–105k
  tokens (a full chunk counts as about 2 × (32k + system prompt)); or
- the model is seeded and its window is below roughly 60k tokens.

The guard returns on the first model it refuses. It does not try the next model
in the chain, so a large fallback does not rescue a small head model. A model
whose window OpenCode does not know is sent unguarded, as before.

The second group, seeded models under 60k, got no fold before issue 541 either,
because the provider rejected the prompt. The first group is a real regression
for its window range. An unseeded historian model with a known window of about
64k–100k (a local or custom-provider model, for example) was sent a prompt of
around 40k real tokens before issue 541, which fit and folded. It is now refused
forever. Before the restart, check the operator's configured historian model
against these two conditions. This report did not read the live config.

## First bad commit

Tested `tests/rust-fold-under-pressure.test.ts` locally on OpenCode 1.18.32
(the version CI installs), in a throwaway root:

| ref | result |
|---|---|
| `40e2ef7f32` (first parent of the 541 merge) | pass |
| `e286d94bb1` (merge of `cd1b13f7a2`, issue 541) | fail, same assertion as CI |
| `304686005f` (master) | fail, same assertion as CI |

`cd1b13f7a2`'s own parent (`5646872845`) is an ancestor of `40e2ef7f32`, so the
single commit brought in by the merge is `cd1b13f7a2` "guard issue 541 historian
model chain windows". None of the listed suspects (A3 host-runner default, #546
storage gate, proactive thinking strip, subc-daemon 0.22.0) is involved: the A3
change pinned `runner: broca` in `RustTestHarness`, and every failing test still
runs on the Broca lane.

The failure in the previous nightly (`d17d7a8c`, run 36230112796) was on shard
2, not shard 3: `tests/rust-real-or-absent-drops.test.ts`. `5365b6948d` fixed it,
and shard 2 passes in run 36308635138.

## Evidence

Module log (`magic-context/logs/magic-context.<date>.log` in the kept throwaway
root) for the failing fold-under-pressure run on master:

```
mc-module: historian firing for ses_…: await_timeout_ms=600000 …
mc-module: historian firing failed for ses_…: producer: subc error context_overflow:
  producer_prompt_fit_refused model=mock-anthropic/mock-sonnet calibrated_tokens=45018 limit=Some(21825)
```

The hermetic Broca producer log shows only `[broca] ready`: no historian request
ever reaches it. `limit=21825` is `0.97 × (30000 − 7500)`: the test's
`modelContextLimit: 30_000`, which is also the historian model's window because
the harness points `historian.opencode.model` at the same mock model.

Commit `cd1b13f7` saw this in three sibling tests and changed their
`modelContextLimit` from 30k/24k to 128k (`rust-historian-producer`,
`rust-host-runner-default`, `opencode2/rust-mode-host-runner-default`). It missed
the five files that went red:

- `tests/rust-fold-under-pressure.test.ts` (30k)
- `tests/rust-ctx-reduce-roundtrip.test.ts` (30k)
- `tests/rust-compaction-marker-byte-identity.test.ts` (30k)
- `tests/rust-maintenance-contract.test.ts` (30k)
- `tests/opencode2/rust-mode-fold-cadence.test.ts` (24k)

`rust-host-runner-default.test.ts` passes because the same commit raised it to
128k.

The OpenCode 2 fold-cadence failure has the same cause. Its module log shows
`producer_prompt_fit_refused model=openai/mock-model calibrated_tokens=47420
limit=Some(22286)` ten times: `0.97 × (24000 − 1024)`, from the test's 24k window
and 1k output limit.

The tuning knob does not rescue the tests. With
`historian.context_limit_tokens: 30000` written to the module's user tier, the
chunk budget falls to its 8k floor, but the refusal stays at
`calibrated_tokens=44674`. The 2× unseeded ratio applies to the historian system
prompt too, so no chunk size fits a 30k unseeded model.

## Classification

For these tests this is a harness expectation, not a product regression for
mainstream users. The failing tests share one model between the session and the
historian, give it a 24k/30k window to build pressure quickly, and leave it
without a calibration seed. No real historian setup looks like that, and before
issue 541 only the mock provider, which accepts any size, let them pass. The
product behaviour the tests exist to prove is unchanged: every failing test
passes once the historian has a realistic window.

The guard does have product exposure outside the tests. Unseeded historian models
with windows from about 64k to 100k now never fold (see the top section). There is
also a TS/Rust parity gap behind it. TS mode sizes the historian chunk from the
historian model's own window (`resolveHistorianContextLimit`). The Rust module
sizes it from `historian.context_limit_tokens`, even though issue 541 now sends
the chain's known windows in `historian_model_limits`. The guard also refuses on
the first chain model without trying the fallbacks. None of this is fixed here:
changing Rust chunk sizing changes chunk boundaries for every historian model
under 128k and needs its own review.

## Fix

The tests now give the historian its own mock model with a 128k window. The
session model keeps its 24k/30k window, so the pressure, thresholds and usage
figures each test was tuned for are unchanged. The historian's chunk size is the
same one these tests used when they passed before issue 541. This is the same
remedy `cd1b13f7` applied to its three sibling tests, except that it keeps the
small session window instead of raising it.

- `pinMockAgents` takes an optional per-agent model. Each agent is still pinned to
  one explicitly registered mock model and still rejects anything else, including
  the host model once a separate historian model is named. A new unit test covers
  this.
- OpenCode 1 spawn: a `historianMockModel` option registers a second model on the
  mock provider and pins the historian to it.
- `RustTestHarness`: a `historianModelContextLimit` option registers
  `mock-historian` with that window, pins both the plugin's historian model and
  the harness's own historian pin to it, and keeps it across `restart()`.
- OpenCode 2 spawn: a `historianModel` option does the same on the v2 provider
  block.
- The five failing files opt in with a 128k historian window.

Local results on OpenCode 1.18.32 (throwaway `TMPDIR` under
`$TMPDIR/magic-context/bg_2fbafcdf/`):

| file | before (304686005f) | after |
|---|---|---|
| rust-fold-under-pressure | fail (wire 106612 ≮ 102463) | pass |
| rust-ctx-reduce-roundtrip | fail in CI | pass |
| rust-compaction-marker-byte-identity | fail in CI | pass |
| rust-maintenance-contract | fail in CI | 2 pass |
| opencode2/rust-mode-fold-cadence | fail ("never produced a module boundary") | 2 pass |
| rust-host-runner-default | pass | 2 pass |

`lsof` on the OpenCode 1 host during the final fold-under-pressure run listed only
`…/magic-context/bg_2fbafcdf/tmp/opencode-e2e-*/data/opencode/opencode.db`. The
module process listed only the same root's `data/cortexkit/magic-context/store.db`.
