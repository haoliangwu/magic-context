# Pi and OMP

The Pi plugin (`@cortexkit/pi-magic-context`, `packages/pi-plugin/`) runs Magic Context inside Pi and inside oh-my-pi (OMP), importing the shared core from the OpenCode package through the `@magic-context/core` alias. It must produce the same effective behaviour as OpenCode (cache stability, overflow protection, decay tiers) through Pi's different host surface; this page covers the Pi-specific machinery, and `packages/pi-plugin/PARITY.md` lists every deliberate divergence with its rationale.

Read `PARITY.md` before changing anything here that has an OpenCode counterpart. It is the authority on which differences are intentional.

## Where the code is

- `packages/pi-plugin/src/index.ts`: extension entry, boot, hook wiring.
- `packages/pi-plugin/src/context-handler.ts`: the per-pass context transform.
- `packages/pi-plugin/src/pi-harness-kind.ts`, `packages/plugin/src/shared/pi-executable.ts`: Pi versus OMP detection.
- `packages/pi-plugin/src/pi-lkg.ts`, `pi-raw-fallback.ts`: last-known-good replay and the raw fallback.
- `packages/pi-plugin/src/pi-pressure.ts`, `pi-context-limit.ts`: pressure accounting.
- `packages/pi-plugin/src/system-entry-pi.ts`, `compaction-marker-manager-pi.ts`: Pi system entries and compaction checkpoints.
- `packages/pi-plugin/src/clone-inheritance.ts`, `packages/plugin/src/features/magic-context/storage-clone.ts`: state inheritance on fork.
- `packages/pi-plugin/src/subagent-runner.ts`, `subagent-entry.ts`, `pi-historian-runner.ts`, `dreamer/`: hidden-agent execution.
- `packages/pi-plugin/src/pi-context-refusal.ts`: the refusal guard.
- `packages/pi-plugin/src/ctx-reduce-nudge-pi.ts`, `served-array-ledger.ts`, `provider-error-recovery-pi.ts`, `pi-boot-deadline.ts`.
- `packages/plugin/src/shared/harness-provider-map.ts`: provider-id translation between OpenCode and Pi model references.

## Detection: Pi or OMP

Pi and OMP share the extension API, so the plugin decides which host it is in at boot (`resolvePiHarnessDetection`) and memoises the answer process-wide. The rungs, in order:

1. `process.title`, which both hosts set to their app name before loading extensions.
2. The host package name, found by walking the real path of the host entry (`@oh-my-pi/pi-coding-agent` for OMP; `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent` for Pi).
3. Importing the host's utilities module and reading `APP_NAME`.
4. The launcher's executable name (`piHarnessKindFromExecutable`).
5. Otherwise, Pi.

The deciding rung is logged at boot. The result sets the harness id, which selects the per-harness model blocks in config (`historian.omp`, `dreamer.omp`, profile `omp` overlays alongside `opencode` and `pi`), the scratch and log directory (`${tmpdir}/pi/magic-context/` or `${tmpdir}/omp/magic-context/`), the agent config directory, and which `bin` entry subagents launch. Model references are translated between OpenCode's canonical provider prefixes and Pi's at the config read and write edges (`harness-provider-map.ts`), so one config works on every host.

Pi runs only the TypeScript transform; `transform_mode: "rust"` is accepted by the shared config but has no effect here.

## Every pass rebuilds from JSONL

Pi sessions are JSONL files, and Pi rebuilds the `AgentMessage[]` from the branch on every pass. Stable identity therefore comes from JSONL entry ids (`SessionEntry.id`), not from message objects. Tags, compartment boundaries, LKG slots and clone filters all key on those ids.

## Last-known-good replay

Both hosts persist the last successfully served representation of a session in the shared `lkg_slots` table. On Pi (`pi-lkg.ts`), each pass snapshots its inputs and their entry ids at the start. After a pass applies, the served JSON bytes are captured synchronously, while digests and the durable write are deferred to `setImmediate`; if that deferred capture fails, the next applied pass captures synchronously. A cache-busting pass drops the old slot before capturing the new one, and successful defer passes refresh it too, so the recovery prefix never goes stale.

On a transient `SQLITE_BUSY` or `SQLITE_LOCKED` failure, the handler replays the slot and appends the untouched new tail. Replay requires the exact entry-id sequence and content digests up to the slot's anchor, the same model and provider, and the same Pi system entries; any mismatch refuses the replay. Schema-fence, migration and storage-open failures are never replayed: they are loud startup refusals. When no replay is possible, `pi-raw-fallback.ts` serves the untransformed messages only if they are complete and a calibrated token count proves they fit; otherwise it throws `PiStorageBusyError` and the user is asked to resend.

## Pressure

Pi's own usage percentage includes output tokens, so the plugin computes pressure itself from the latest assistant `usage` (`computePiPressure`): prompt tokens are the smaller of input + cache read + cache write and total minus output, divided by the output-reserved safe window with any learned provider limit applied. That one snapshot drives the scheduler, historian trigger, transform logs, status and footer. A trusted absolute wall caps a reading that would exceed the real window. `PARITY.md` §9b covers how persisted pressure is floored with live forward usage.

## System entries and compaction

Newer Pi transcripts contain `role: "system"` entries carrying the prompt, named sections and tool additions or removals. `system-entry-pi.ts` treats them as protocol state that is never reclaimed, keeps the initial system entry with its tools at index 0 (where Pi's transports look for initial tool declarations), and inserts the two synthetic history messages after the leading system run.

Pi owns compaction through `session_before_compact`: Magic Context cancels native compaction, stages its own marker (`pending_pi_compaction_marker_state`) and drains it on the next materializing pass, so `getBranch()` returns the compacted tail. The model-visible trim runs every pass independently of the JSONL marker. When a compaction checkpoint is written, `adoptPiCompactionSystemSnapshot` adopts the host's persisted system state only if it matches the effective prompt and tool set Magic Context folded; on Pi versions that withhold system messages from context handlers, the host's checkpoint is adopted as is.

## Clone inheritance

Pi keeps JSONL entry ids when cloning a branch, so a fork can inherit context state. On `session_start` with reason `fork`, `handlePiCloneSessionStart` reads the source session id from the previous session file and calls `copySessionStateForClone` with a filter built from the new branch. The copy runs in one immediate transaction and refuses if the destination already has compartments, tags, notes or facts. It copies compartments whose boundaries exist in the branch (re-mapping their ordinals), tags for copied entries with their source contents and pending operations, Pi session notes and facts, and the replay-relevant `session_meta` fields (strip watermarks, frozen id sets, pending marker, synthetic todo state). A pending marker that survives the copy is signalled for the new session. Failure is logged and leaves the clone without inherited state. OpenCode's `/fork` does not inherit, because OpenCode re-mints message ids on fork.

## Hidden agents: the subagent runner

Pi has no in-process child sessions, so the historian, recomp and dreamer run as separate `pi --print --mode json --no-session` processes (`subagent-runner.ts`, `pi-historian-runner.ts`, `dreamer/`). `--no-session` keeps their transcripts out of the user's session picker. Children load the lean `subagent-entry.ts`, which does not register a context hook, so a subagent cannot recurse into Magic Context. Prompts over about 96 KiB go through stdin instead of the command line to stay under the operating system's argument limit. The runner resolves the host's own CLI (Pi or OMP), captures provider errors from the child's JSON output, and enforces timeouts by killing the process; there is no in-config step cap on Pi. Dreamer module resolution (`dreamer/pi-session-api.ts`) prefers the running host's own `pi-coding-agent` package.

In pi-web, several sessions share one process. Startup maintenance runs once per process; dreamer registration is process-shared and tracks which instance owns each project timer, so one session's shutdown cannot stop another's. `session_shutdown` drains only that session's in-flight work.

## Refusal guard

Pi catches exceptions from context handlers and continues with the original messages, which would send an unmanaged prompt. `registerPiGuardedContext` wraps both the main context handler and the fail-closed handler: when either throws, it logs the error, appends a display-only `magic-context-turn-refused` entry asking the user to resend, and calls `ctx.abort()`. The entry is never shown to the model.

## Other Pi-specific pieces

- **Channel 2 nudges** are sent with `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })` and `display: false`. During a busy run, `steer` waits for every scheduled tool to finish and injects the nudge before the next model call; when idle, `triggerTurn` starts a turn.
- **Served-array ledger** (`served-array-ledger.ts`) records per-pass digests of what was served, for cache-bust attribution.
- **Provider error recovery** (`provider-error-recovery-pi.ts`) reads provider errors from `message_end`, including thinking-signature binding errors, and arms a one-turn reasoning strip with an LKG slot drop.
- **Boot** is bounded by a 15 s deadline (`PI_BOOT_DEADLINE_MS`, `pi-boot-deadline.ts`); a storage open that settles late is adopted rather than restarted.
- **Transient UI** uses `ctx.ui.notify` toasts and RPC dialogs instead of ignored chat rows.
