# Tokenizer calibration

Magic Context counts tokens locally, and a local tokenizer drifts from each provider's real count by a model-specific amount. Calibration corrects that with measured per-model ratios for three classes of text, and every decision that compares a size against a limit reads those ratios from one frozen per-session snapshot so the decision cannot change between passes that must replay identically.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/hooks/magic-context/tokenizer-calibration-seeds.json`: the measured ratios, shared by the TypeScript and Rust engines.
- `src/hooks/magic-context/tokenizer-calibration.ts`: lookup (`resolveModelCalibration`), family fallback, and the display bucket split (`calibrateBuckets`).
- `src/hooks/magic-context/decision-calibration.ts`: the immutable decision view (`resolveDecisionCalibration`) and `providerMass`.
- `src/features/magic-context/session-decision-calibration.ts`: the per-session frozen snapshot.
- `crates/mc-module/src/decision_calibration.rs`: the Rust resolver, which compiles in the same JSON file.
- `packages/plugin/scripts/calibrate-tokenizer/`: the harness that measures the ratios.

## Seeds

Each seed is keyed by a `provider/model` prefix and holds three ratios, each defined as provider-reported tokens divided by the local count:

- `systemRatio` for plain system-prompt text,
- `toolsRatio` for tool definitions and tool I/O,
- `proseRatio` for conversation text (1.0 when unmeasured).

The ratios come from `scripts/calibrate-tokenizer/`, which sends a fixed system prompt, a fixed tool set and a small conversation to each provider and compares the reported input tokens with the local count. Re-run it when adding models or after a provider changes tokenizer. `CALIBRATION_TABLE_REVISION` names the version of the table and its inheritance rules; bump it whenever either changes, because sessions use it to notice a new table (below).

Both engines load the same file (the Rust module through `include_str!`), so their measurements cannot drift apart.

## Lookup and family fallback

`resolveModelCalibration(provider, model)` tries, in order:

1. **Longest prefix match** on `provider/model`, case-insensitive.
2. **Family fallback**, when the provider has measurements but not this model. The model id is split into family, numeric version and variant (`claude-fable-5-2` is family `claude-fable`, version 5.2; `gemini-3.8-flash` is family `gemini`, version 3.8, variant `flash`). The model inherits from the nearest measured relative with the same provider, family and variant: the newest version below it, else the oldest above it. If that relative is from a different major version, a measured sibling of the requested major version wins instead, because a new major tokenizer generation is closer to its own generation than to its predecessor. A new release is more likely to keep its predecessor's tokenizer than to match no tokenizer at all.
3. **Model-id match**, when the provider has no measurements at all (a relay or custom provider id). The model part alone is matched against every seed; on a tie, the model's canonical provider (Anthropic for `claude-*`, OpenAI for `gpt-*`, Google for `gemini-*`) wins. Failing that, family fallback is tried against the canonical provider.
4. **Neutral**: all ratios 1.0.

The result records where it came from (`derivedFrom`, `matchedByModelId`), and `resolveDecisionCalibration` labels it `seed`, `family-fallback` or `model-id` for logs.

Neutral means "no measurement", not "the tokenizer is exact". Decisions that decide whether something fits (`providerMass(..., fit = true)`) treat an unseeded model conservatively: its whole local count is multiplied by `UNKNOWN_FIT_RATIO`, the larger of 2 and the largest ratio in the table.

## The per-session snapshot

`sessionDecisionCalibration` stores the resolved ratios, their revision and the model they were resolved for in `session_meta` (inside `deferred_execute_state`). Every decision reads that frozen snapshot. A new snapshot is adopted only when the caller passes `bustPermitted: true`, which the transform does once per pass on a pass that is already cache-busting (a fold, the force band, a flush, a history refresh or an execute), with the reason logged. A model switch or a new table revision therefore changes decisions exactly on the next busting pass, never on a defer pass where a changed threshold would change which content is dropped and bust the cache.

`HYGIENE_PROVIDER_UNITS_VERSION` records which unit system a session's persisted nudge state uses. A session whose state is in an older unit system moves to the current one only on a bust-permitted pass, for the same reason.

## Where decisions read it

- **Historian trigger** (`compartment-trigger.ts`): the cheap pre-gate scales its persisted-tag upper bound by the largest ratio before comparing it with the trigger budget.
- **Protected-tail boundary** (`protected-tail-boundary.ts`): sizes the protected tail and eligible head in calibrated tokens.
- **Protection window** (`protection-window.ts`): converts the `protected_tokens` floor using `toolsRatio`.
- **Heuristic cleanup and emergency drops** (`heuristic-cleanup.ts`, `emergency-drop.ts`): measure reclaim and the target headroom with the tools and prose ratios.
- **Nudges** (`transform-postprocess-phase.ts`, `hook-handlers.ts`): `{U, T}` and the band thresholds are in calibrated units.
- **Producer fit** (`producer-window-guard.ts`): the historian and retrospective prompts are admitted with `providerMass` and a 3% margin.
- **Raw fallbacks**: Pi's raw fallback (`pi-raw-fallback.ts`) checks fit with `providerMass` in fit mode.
- **Rust module**: the boundary, chunking, selection, decay rendering and historian code use the Rust resolver over the same seeds.

`calibrateBuckets` is display only. It splits a request's reported input tokens into sidebar and status categories: system and tool definitions are calibrated, history blocks (compartments, facts, memories, docs, profile) are calibrated with the prose ratio, and conversation and tool calls absorb the remainder so the categories always sum to the provider's number. Transform budgets and served bytes never use these display figures.
