# The Rust module (ck-mc)

The Rust workspace in `crates/` re-implements the cache-stability transform and the historian as `ck-mc`, a module of the subconscious daemon (subc). It serves Claude Code through the Thalamus gateway, and it runs the transform for OpenCode 1 projects that opt into Rust transform mode, with the TypeScript plugin acting as a coordinator.

## Where the code is

- `crates/mc-module/src/lib.rs`: request routing, tool facades, session operations, transform dispatch and health.
- `crates/mc-module/src/main.rs`: module entry point under subc.
- `crates/mc-module/src/transform.rs`, `injection.rs`, `m0_compose.rs`, `m1_compose.rs`, `boundary.rs`: the transform pass and `m[0]`/`m[1]` rendering, mirroring the TypeScript runtime.
- `crates/mc-module/src/historian.rs`, `historian_producer.rs`, `historian_chunk.rs`, `historian_validate.rs`: the module historian.
- `crates/mc-module/src/codec/`, `healing.rs`: harness codecs and serializer profiles.
- `crates/mc-store/src/lib.rs`: the module's SQLite store (`store.db`), its migrations and row-version compare-and-set.
- `crates/mc-core/`: the pass classifier (`classify`, which plans a pass) and the decay math. `crates/mc-tokenizer/`: the byte-BPE token estimator.
- `packages/plugin/src/config/transform-mode.ts`: resolves the configured transform mode.
- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts`: the TypeScript coordinator.
- `packages/plugin/src/hooks/magic-context/module-transport.ts`, `module-wire.ts`, `module-state-sync.ts`: transport, ordinal mapping, state sync.
- `packages/plugin/src/hooks/magic-context/lkg-slot.ts`, `lkg-replay.ts`, `rust-refusal-recovery.ts`: fallback and recovery.
- `packages/plugin/src/features/magic-context/context-authority.ts`, `packages/plugin/src/plugin/rust-tool-backends.ts`, `rust-note-backend.ts`, `memory-id-translation.ts`: authority handoff and tool routing.

## Enabling Rust transform mode

`transform_mode: "rust"` is a user config setting. `resolveTransformMode` (`config/transform-mode.ts`) falls back to `"ts"` with a warning when compaction is off or when the user-tier config has no subc configuration. On OpenCode 2, `resolveV2TransformMode` (`v2/hooks/context.ts`) always downgrades to TypeScript and declares the `rust_mode_unsupported` host limitation (`MC-S06`), which `/ctx-status` and the sidebar keep showing. The Pi plugin loads the shared `transform_mode` field but always runs the TypeScript transform.

## The coordinator pass

In Rust mode the TypeScript transform still runs every pass, but it does not compute the output. For each pass it:

1. **Syncs state** (`module-state-sync.ts`). The host keeps a set of watermarks per session: compartment sequence, newest memory id, `m[0]` mutation id, memory-mutation id, todo-state hash, project memory epoch, user-profile version, workspace fingerprint and reasoning-cleared-through tag. When they match what the module last acknowledged, nothing is sent. Otherwise the changed rows go to the module, paged to stay under the subc frame limit (64 MiB body, 16 MiB envelope headroom, 64 KiB continuation chunks for large values). A pending `m[0]` mutation is reported separately because it forces a fold. While the module holds memory authority (below), the host does not send its own view of memories; it only mirrors the module's changes back.
2. **Maps ordinals** (`module-wire.ts`, `resolveOrdinalsForModule`). The module addresses messages by absolute ordinal in the host store. The coordinator keeps a per-session memo from message id to ordinal with page checkpoints. A warm memo that covers every wire id is trusted without a store read; new ids are resolved by reading ordinal pages of 500 rows after the last anchor; if the store count no longer adds up (a message was removed), the walk resumes from progressively older checkpoints instead of re-reading the session. A lifecycle event such as a message removal sets a verify flag so the next pass checks the store even when the memo looks complete. A conflict the rewind cannot repair clears the memo and fails the pass loudly.
3. **Sends the transform** over subc (`module-transport.ts`, using `SubcClient` and `RouteHandle` from `@cortexkit/subc-client`). Requests for one session are serialised on a per-session lane. When a request stalls, the coordinator probes module health; a healthy answer does not prove the original request stopped, so the original keeps its single deadline and no duplicate mutating transform is sent. Connection backoff escalates from 1 s to 30 s; a pass waits through at most 12 s of remaining backoff before failing.
4. **Serves the output**, captures it as the new last-known-good representation, and advances the OpenCode compaction marker from the boundary the module reports through the same compare-and-set path the TypeScript transform uses.

## Last-known-good fallback and freeze

`lkg-slot.ts` stores, per session, the JSON of the last served output together with the input message ids, content digests and model/provider key it was built from. Slots persist in the `lkg_slots` table so they survive a restart. `lkg-replay.ts` replays the slot when the current input still starts with the same ids and content up to the slot's last input message, appending the new raw tail after it; a reshaped history, changed content or different model refuses the replay.

When a module pass fails:

- The coordinator replays the LKG slot. If there is none, it serves the raw input only if a conservative size check proves it fits the context window (a byte proxy of four serialized bytes per token, then the tokenizer); otherwise it refuses the turn with `RawFallbackContextLimitError`. A provider-proven emergency combined with a storage failure refuses before either fallback runs.
- After three consecutive failures (`RUST_FAILURE_PARK_THRESHOLD`), the session is **parked**: the user sees the engine-reconnecting notice, and passes serve LKG or raw without calling the module. A parked session retries the module every fifth pass, or on every pass once usage reaches 90%. A non-retryable state-sync failure parks immediately.
- **Freeze.** A served fallback is kept frozen across the following defer passes so the session does not bust the cache twice (LKG, then module, then LKG again) for one blip. The freeze is released when an authorized cache-busting pass adopts module output, when the LKG replay no longer validates, after eight healthy module passes, or after sixteen new raw messages.

A module that refuses its store because the store is ahead of it (see [Rollback](#rollback)) is not treated as a module failure. The pass neither replays LKG nor serves raw, and the session is not parked. The turn is refused with the store-ahead message (`MC-C13`), and the next turn asks the module again. With compaction off, fail-closed refusals are inert by design, so the turn passes through unmanaged and the refusal appears only in the log.

`rust-refusal-recovery.ts` handles a refused turn. It arms a per-session watcher that probes module health every 2 s for up to 5 minutes and, once the module answers and persisted history still ends at the refused user message (an unfinished assistant reply to it still counts), sends a synthetic continue prompt so the turn resumes. It stands down when compaction is off or when a provider-proven emergency is in force.

## Module store and authority handoff

The module keeps its own store, `store.db`, in the same data directory as `context.db` (`~/.local/share/cortexkit/magic-context/`). `crates/mc-store` owns its schema through its own migration chain, independent of the `context.db` versions, and every durable transition is a compare-and-set on a row version. Notable tables are `mc_pass_trace` (a durable audit of receive, complete and reject events per pass) and `mc_reduce_command_ledger` (command-id idempotency for `ctx_reduce` drops). `context.db` and `store.db` form one consistency unit: restore both from the same backup or neither.

Memories and notes are project-scoped data that both engines can write, so exactly one engine owns each pool at a time. `context-authority.ts` tracks an authority state per project and domain (`memories`, `notes`): `TS`, `PREPARING`, `MODULE`, `DRAINING`. Moving to `MODULE` seeds the module from the host; while `MODULE` holds, the module is the writer and the host pulls a changefeed ("mirror") back into `context.db` so dashboards, search and other hosts still see current rows. The Rust transform pass is the mirror cadence: each pass drains at most 20 pages of up to 1,000 rows (`TRANSFORM_MEMORY_MIRROR_PAGE_BUDGET`), overlapping pulls are coalesced, and an incomplete drain continues on the next pass. Mirror writes are guarded by the host row's own `updated_at` and `classified_at` so a stale module snapshot cannot roll back a newer host state. Draining back to `TS` runs through the module's `authority.drain.*` steps; the CLI exposes `doctor drain-authority <project>` for the same.

Agent-visible memory ids on host-backed harnesses are host (`context.db`) ids. The module records the host id for each of its memories (`host_row_id`), `memory-id-translation.ts` classifies an id at the tool boundary (own mirrored row → module, a foreign workspace-shared row → host, a row whose mirror is still pending → retry advice, otherwise unknown), and `m[0]`/`m[1]` render host ids. Claude Code sessions keep module ids.

### Rollback

A ck-mc rollback is the previous binary **together with** `context.db` and `store.db` restored from the same backup. `scripts/backup-live-stores.sh` snapshots both in one run for this purpose.

Rolling back only the binary across a store migration is refused. `McStore::open` compares the highest version recorded in `store.db` with the newest migration the binary carries. When the store is ahead, the open fails with `McStoreError::StoreAheadOfBinary { db_version, binary_max }` before it reads or writes a row. Older builds logged this case and continued. That half-worked: migration 53 moved note ownership into triggers that read a row an older binary never fills, so note inserts and deletes failed later without naming the cause.

The refusal is terminal until the module restarts on a store it knows:

- `ck health magic-context` reports `failing`, with `storage_state: open_refused_store_ahead`, both versions (`store_db_version`, `binary_max_store_version`) and the remediation.
- Every request lane except `echo` answers with a `store_ahead_of_binary` error frame. Its detail is `{reason_code, db_version, binary_max}`.
- Facade tools answer with the user-facing sentence: "Magic Context refused to start: its store (store.db) is at schema vN but this ck-mc build only knows up to vM. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)".
- The OpenCode plugin maps the code to `StoreAheadOfBinaryError`. A transform refuses the turn with the same sentence, and `ctx_memory` and `ctx_note` return it as their reply.

A store that is older than the binary still migrates forward on open, and a store at the binary's own version opens as before.

## Tool facades

On OpenCode in Rust mode, the tool registry passes `rustToolBackends` to three tools. `ctx_reduce` queues drops through the module's `agent_drops.append` operation, keyed by the host tool-call id for idempotency. `ctx_memory` and `ctx_note` route to the module only after that domain's authority reports `MODULE`; `ctx_note` maps module note ids to host ids and shows `(id pending)` (`NOTE_ID_PENDING`) for a note the mirror has not yet assigned an id. `ctx_search` and `ctx_expand` stay host-served.

The module itself exposes MCP-style facades for all five tools (`ctx_memory`, `ctx_search`, `ctx_expand`, `ctx_reduce`, `ctx_note`), which is how Claude Code reaches them.

## Serializer profiles and epochs

Each request names a serializer profile (`healing.rs`): `opencode-aisdk`, `pi`, `claude-code-anthropic`, and the owned runner profiles. Harness codecs in `codec/` translate harness JSON to canonical wire messages and back. Every shipping profile rebuilds the provider request from the transformed array, so all of them allow tail reclaim as well as prefix folding.

Byte-affecting format changes are coordinated through epochs in `lib.rs` (`MEMORY_RENDER_FORMAT_EPOCH`, `COMPARTMENT_RENDER_FORMAT_EPOCH`, per-profile epochs, `TAGGER_FEATURE_EPOCH`). They are folded into the request's render configuration; any change forces one HARD fold so each session crosses a format change once. Consumers read the epochs at attach through `session.status` and refuse to serve on a mismatch.

## The module historian

The module runs its own historian (`historian.rs`), with the same trigger, protected-tail boundary and validation rules as the TypeScript one (see [historian.md](historian.md)). The host sends its resolved historian model chain with each request (`historian_model_chain`). The producer (`historian_producer.rs`) asks for at most 32,000 output tokens and waits up to 600 s per run. Each skipped fire is recorded durably with a typed cause (`HistorianNoFireCause`: already in progress, below the proactive floor, drain budget spent, no models, and so on) so status can say why nothing happened.

A transform in emergency may wait for historian work it started, but those waits share one 20 s budget (`TRANSFORM_HISTORIAN_FOLLOWUP_BUDGET`) so they cannot stack past the caller's deadline. `/ctx-wrapup` maps to `session.wrapup`, which runs rounds of up to 600 s each within an overall budget of 3,800 s (`MAX_WRAPUP_REQUEST_BUDGET`) and returns a machine-readable disposition (`completed`, `nothing_to_compact`, `already_in_progress`, `failed`). Other session operations are `session.status`, `session.recomp`, `session.flush` and `session.delete`, which removes the session's rows from the store.

On store open during a daemon restart, the module retries the store lease for up to 60 s; an individual request waits at most 500 ms for an in-flight open before refusing.
