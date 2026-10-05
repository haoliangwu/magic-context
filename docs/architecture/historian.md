# The historian

The historian turns older raw conversation into compartments: summaries of a stretch of work, each written at four levels of detail with an importance score, facts and events. It runs out of band in a hidden session; the transform only decides when to fire it and, on a later busting pass, renders what it published.

Paths are relative to `packages/plugin/`. Pi uses the same core through `packages/pi-plugin/src/pi-historian-runner.ts`; the Rust module has its own port in `crates/mc-module/src/historian*.rs` (see [rust-module.md](rust-module.md)).

## Where the code is

- `src/hooks/magic-context/compartment-trigger.ts`, `derive-budgets.ts`: when to fire.
- `src/hooks/magic-context/protected-tail-boundary.ts`, `read-session-true-raw-tokens.ts`, `host-served-rows.ts`: which raw messages are eligible.
- `src/hooks/magic-context/read-session-chunk.ts`: formatting the eligible range into a chunk.
- `src/hooks/magic-context/compartment-runner-incremental.ts`, `compartment-runner-historian.ts`: running the model and publishing.
- `src/hooks/magic-context/reference-retrieval.ts`, `reference-seeds.generated.ts`, `historian-prompt.source.md` (built into `historian-prompt.generated.ts`): the prompt.
- `src/hooks/magic-context/compartment-parser.ts`, `compartment-runner-validation.ts`: parsing and validation.
- `src/hooks/magic-context/producer-window-guard.ts`: checking the prompt fits the model.
- `src/hooks/magic-context/decay-curve.ts`, `decay-render.ts`: rendering compartments by age.
- `src/hooks/magic-context/compartment-runner-recomp.ts`, `compartment-runner-partial-recomp.ts`, `recomp-orchestrator.ts`, `wrapup-orchestrator.ts`: `/ctx-recomp` and `/ctx-wrapup`.
- `src/features/magic-context/compartment-storage.ts`, `compartment-events.ts`: the stored rows.

## Trigger

`checkCompartmentTrigger` runs during the transform, off the in-memory message tail, so steady-state passes do not read the host database. It never fires while a historian run is already in progress. Its budget, `triggerBudget`, is 5% of the usable window (context limit × execute threshold), clamped to 5,000–50,000 tokens (`deriveTriggerBudget`).

Below the proactive floor (execute threshold − 2%), a cheap gate first bounds the eligible tail from persisted tag token counts, scaled by the session's calibration; if even that upper bound is under `triggerBudget`, no size trigger is possible and the full tail inspection is skipped. Otherwise the reasons to fire, in order:

1. **Force band** (usage at or above `max(85%, threshold + 2%)`): fire, unless queued and automatic drops are already projected to bring usage down to 75% of the threshold. If the normal boundary leaves nothing runnable, the protected tail is scaled down (to half, or a quarter at 95%) and re-resolved.
2. **Commit clusters**: at least three distinct work phases ending in commits (configurable), with at least `triggerBudget` tokens in the eligible prefix. Commit detection is shared with the note nudges (`src/shared/commit-detection.ts`).
3. **Tail size**: the eligible tail, measured as the condensed chunk the historian would actually read, reaches three times `triggerBudget`. This is deliberately measured on the chunk and not on raw size, so a tool-heavy tail with little narrative does not produce thin compartments; tool-heavy pressure is handled by the pressure triggers.
4. **Projected headroom**: usage at or above the proactive floor, drops not projected to be enough, and a meaningful eligible head exists.

The trigger hands the resolved boundary snapshot to the runner, so the historian reads exactly the range the decision saw. Drain work is also bounded by a session-scoped budget over rolling ten-minute windows (`reserveProtectedTailDrainTokens` in `storage-meta-persisted.ts`). On OpenCode 1 the historian runs whenever compaction is on and it is not disabled; on OpenCode 2 it needs the hidden-completion executor. The historian's own sessions are never managed by the transform, so it cannot recurse: hidden child sessions are recognised by their `magic-context-` title prefix, and in the Rust module by the `mc-historian:` session-id prefix.

## Protected-tail boundary

`protected-tail-boundary.ts` decides which prefix of the raw history above the last compartment is eligible and which suffix stays protected as the live tail. It sizes the tail from true raw token counts (text and tool I/O), not from counts of user turns, so a session with few user messages cannot stall the historian.

With `usable` = context limit × execute threshold, the protected tail target is `N = clamp(round(usable × 0.3 × (1 − usage)), floor, ceiling)`, where the floor is 8% of usable bounded to 2,000–12,000 tokens and the ceiling is the smallest of 96,000 tokens, 40% of usable, and usable minus a headroom reserve (`deriveProtectedTailTokenTarget`). The eligible range per run is then capped by pressure: roughly two, three or four times `N` in the normal, 80%+ and 95%+ tiers (`selectPerRunCap`). An emergency catch-up latch lifts the per-run cap at the force band and keeps draining until usage falls back below the safe threshold. A live-prompt floor stops the boundary crossing the newest meaningful user message below the force band.

Tool arcs are kept whole:

- A **completed** arc (a call and its result) is never split across a compartment boundary. Boundaries fence backward around it. If the head cap lands inside the first completed arc, the whole arc is admitted as one oversize unit rather than fencing back to an empty head, and the chunk reader delivers it whole.
- An **open** arc (a call with no result yet) holds the boundary back only if it is recent, inside the live window. An older interrupted call is compactable, because one dead running call would otherwise freeze the historian forever.

On OpenCode 2, a boundary never lands on a row the host does not serve by its own id (such as an instruction update); `retreatPastHostUnservedRows` moves it back to the nearest served row. Every boundary decision carries self-describing diagnostics (`ProtectedTailBoundarySnapshot.diagnostics`) explaining no-ops and wrapup choices. The trigger and runner share a content-stable fingerprint of the raw range (`computeRawRangeFingerprint`), which hashes only ids, part types and content lengths, so a concurrent drop cannot invalidate an in-flight run.

## Producer

`compartment-runner-incremental.ts` reads the eligible chunk and runs the historian model on it with a bounded prompt: four rotating seed example compartments, the last six persisted compartments of this session (`reference-retrieval.ts`), and the project-memory block so it does not re-emit known facts. It never sends a full state dump. The prompt carries the session's content-language directive.

The historian emits, for each compartment:

- four paraphrase tiers, `p1` (full detail) to `p4` (anchor only);
- an `importance` from 1 to 100, which acts as a decay rate;
- an episode type;
- `<facts>` in the five memory categories;
- `<events>`.

On OpenCode 1 it may use a small read-only tool allow-list (`read`, `aft_outline`, `aft_zoom`, `aft_search`, reducible with `historian.disallowed_tools`), and `historian.two_pass` adds an editor pass that removes low-signal lines and duplicates across compartments.

Before sending, `producer-window-guard.ts` checks the prompt fits the model's usable input window with a 3% estimator margin, using calibrated token ratios and an output reserve derived from the configured `maxTokens` or the catalog. A prompt that cannot fit a known window is refused before dispatch (`producer_prompt_exceeds_window`) and its drain reservation is released. An unknown window sends with a warning. A single atomic component too large to fit is split at its largest result boundary with a truncation marker instead of being refused forever. A timeout falls back to the next model in the configured chain.

## Validation

`compartment-parser.ts` extracts compartments, tolerating a mismatched closing tier tag (a tier ends at any closing tier tag or the next opener). `validateHistorianOutput` then requires strictly increasing, non-overlapping ordinal ranges and a correct `unprocessed_from`. Gaps containing only tool calls are healed; gaps containing narrative are rejected so the range is re-read. A result that does not advance past the previous boundary counts as a failure.

**Discard-last.** The last compartment of a run is written without lookahead, so its end is unreliable. When the historian consumed almost the whole chunk, that last compartment is dropped and re-read at the head of the next run with real context after it. This needs at least two emitted compartments, never splits a completed tool arc, and is skipped at emergency pressure where relief matters more than boundary quality. Facts, user observations and primer candidates from a run that discarded its last compartment are not promoted (they cannot be separated from the discarded range and would double up on the re-read), and events anchored to the discarded compartment are dropped.

## Publish

Publishing runs in one immediate transaction under the session's compartment lease:

- New compartments are appended with their tier columns; existing rows are untouched. A boundary that disappeared from the store during the run is refused (`findDanglingPublicationBoundary`).
- Facts are promoted to project memories when `memory.enabled` and `memory.auto_promote` are on, with exact deduplication.
- User observations are stored only when `dreamer.user_memories.enabled` is on.
- Events go to `compartment_events`. Compartment-chunk embeddings are produced when memory is enabled.
- Side-channel writes (events, primers, observations) are best effort and never block compartment progress.
- Drops are queued for the summarised messages (`queueDropsForCompartmentalizedMessages`), idempotent against tags already dropped.
- The compaction-marker move is stored as a pending blob in the same transaction, so a crash cannot leave the marker and the compartments out of step.

Publishing does not bust the cache. It signals a deferred history refresh, and the new compartments, the marker move and the queued drops all land together on the next pass that busts anyway: new compartments reach the prompt through `m[1]` and fold into `m[0]` on the next HARD fold. The one exception is the first compartment of a session with no history yet, which forces a HARD fold because there is no baseline to add a delta to.

## Decay rendering

`decay-render.ts` (shared by OpenCode and Pi) picks one tier per compartment from `decay-curve.ts`:

```
H = H50 · 2^((importance − 50) / D) / max(p, 0.10)      H50 = 24, D = 25
z = (age in compartments) / H
tier = P1 if z < 0.201, P2 if z < 0.729, P3 if z < 1.322, P4 if z < 2.587, else archived
```

`p` is budget pressure, computed once per pass from the history budget (`history_budget_percentage` of usable context, default 15%). Higher importance decays slower (75 doubles the half-life, 100 quadruples it); higher pressure decays faster; the tier boundaries are geometric means of the measured average token cost of adjacent tiers. The renderer makes no model calls and adapts automatically when the context window or budget changes. Legacy compartments without tiers render at P3 when they carry a user line and P4 otherwise. Re-tiering only happens on a HARD fold, because it changes `m[0]` bytes.

## Recomp and wrapup

`/ctx-recomp` rebuilds compartment structure from raw history, including compartments written in older layouts. It emits no facts, so curated memories are not duplicated. A partial recomp rebuilds a range.

`/ctx-wrapup [messages_to_keep]` (default 20) compacts older raw history into compartments on demand while keeping the newest messages raw. `resolveWrapupProtectedTailBoundary` counts raw messages, tool messages included, to place the keep watermark, and applies the same tool-arc fencing and user-boundary snapping. The orchestrator runs token-capped chunks in sequence under a session wrapup lease and waits up to ten minutes for a busy historian lease. Its final chunk keeps its last compartment for coverage but, like discard-last, promotes nothing unanchored from it. On OpenCode 2 wrapup runs through the hidden-completion executor; in Rust mode it is the module's `session.wrapup` operation.
