# The OpenCode 2 adapter

OpenCode 2 has a different plugin API from OpenCode 1: a `setup(context)` entry, per-session hooks that edit a request draft, host-owned compaction checkpoints and no child-session prompt loop for plugins. `src/v2/` adapts the shared transform core to that host, so the same scheduler, tagger, reclaim and history rendering run on both.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/v2/server.ts`: the `setup` entry and its host check; built separately to `dist/v2/server.js`.
- `src/v2/hooks/context.ts`: registers every session hook and drives `createTransform` per pass.
- `src/v2/hooks/payload.ts`: projects the host draft into the message shape the shared transform reads, and commits the result back.
- `src/v2/store-reader.ts`, `src/v2/hooks/store.ts`: read raw history from the OpenCode 2 database.
- `src/v2/fold/owner.ts`, `fold/restore.ts`, `fold/host-media.ts`, `fold/markers.ts`: fold ownership and restoring history around host checkpoints.
- `src/v2/hidden-completion.ts`, `src/v2/hooks/hidden-child.ts`, `src/v2/hidden-child-native.ts`, `src/v2/hidden-child-cleanup.ts`: hidden model calls and cleanup of their sessions.
- `src/v2/hooks/refusal.ts`: refusing a turn before it reaches the provider.
- `src/v2/hooks/usage-reading.ts`, `hooks/usage-persist.ts`: reading and recording the provider's usage for the latest reply.
- `src/v2/hooks/channel2.ts`, `hooks/commands.ts`, `hooks/tools.ts`, `hooks/dream-trigger.ts`, `hooks/dream-manual.ts`, `hooks/update-check.ts`.
- `src/v2/tui/`: the TUI seam. `src/tui/entry.mjs` serves both TUI loaders.
- `src/shared/host-limitations.ts`: named capabilities a host lacks.
- `src/features/magic-context/store-generation-rebase.ts`, `opencode2-relabel.ts`: moving sessions between OpenCode 1 and 2 stores.

## Loading

The package's default export carries both host shapes: `{ id, server }` for OpenCode 1 and `setup` for OpenCode 2. An OpenCode 1 host can also call `setup` (its core external-plugin layer adopts any module exporting `{ id, setup }`), so `setup` first checks `isOpenCode2HostContext`: only a context whose `session.hook` is a function runs the v2 lane. Anything else logs that the v1 lane owns the host and returns a no-op disposer, which keeps an OpenCode 1 process from being tagged as harness `opencode2`. `build:v2` bundles `src/v2/server.ts` with `@opencode/plugin` as an external and runs `src/v2/server.test.ts` as part of the build.

## The context hook

`registerContext` (`hooks/context.ts`) registers the hooks once per process. On every `context` pass it:

1. Records host media classes (for restoring attachments later), lets hidden-child sessions short-circuit, and removes dreamer-only tools from primary drafts.
2. Reads the model, variant and agent from the draft itself. The draft is authoritative; nothing is reconstructed from message events.
3. Rewrites `ctx_*` tool descriptions for this draft's model (`applyV2PromptSurfaceTools`) and records the tool-definition size. Descriptions are changed on the draft only; the host keeps every `tool.transform` registration for the life of the process, so registration happens once in `tools.ts`.
4. Records the latest reply's usage (below), rebases session coordinates if the session came from the other store generation, runs the system-prompt handler on `draft.system`, and runs the shared per-message duties.
5. Restores history around a host checkpoint (see Fold ownership), projects the draft with `adaptPayload`, runs the shared transform, commits, and delivers any pending Channel 2 nudge.

The shared transform is created with `storeGeneration: "v2"` and with `v2CompactionMarkerStrategy`, whose operations are all inert: OpenCode 2 owns its checkpoint rows, so the v1 synthetic marker writes never happen here.

## Refusals and admission

A turn is refused before the provider with `session.interrupt`; the host records it as an interrupted turn with no error text, so every refusal is also logged to `magic-context.log` with its arm and cause. The arms are:

- **Usage unavailable**: the latest reply's usage could not be read or recorded (the context database is not durable, or a store read failed). A usage figure never refuses a turn by itself, however high it is: the shared transform's force band and emergency reclaim, the historian and folds all run inside the pass, and a refusal ahead of them would leave the stored reading unchanged and refuse every later turn (issue 493). Like OpenCode 1 and Pi, the turn is refused for pressure only by the shared transform after its pass, when the provider has rejected the request as too large and the pass folded nothing; that refusal posts "Context full — /ctx-flush or /clear to continue." before interrupting.
- **Blocking transform errors**: when the shared transform cannot prove a safe prompt (for example fail-closed storage), the hook interrupts and throws `V2ContextRefusal`. With compaction off, native compaction owns recovery and the pass passes the input through.
- **Post-fold restore failure** and **compaction-fold failure**: if history around a host checkpoint cannot be restored, or the fold cannot be supplied, the turn is refused rather than sent with history missing.

## Fold ownership

OpenCode 2 compacts by asking a `compaction` hook for a summary and writing a checkpoint row. Magic Context answers that hook with its own `m[0]` (`folds.supply` in `context.ts`), so the host checkpoint carries the Magic Context baseline instead of a separate model summary. `FoldOwner` (`fold/owner.ts`) persists the fold's identity in the host's plugin storage: the watermark it was cut at, the summary submitted and its hash, and once seen, the rendered checkpoint row. The host assigns the checkpoint's sequence after the hook returns, so the owner stores a provisional watermark and binds the real row when it appears.

On later passes, when the store reader finds a checkpoint in the draft, the adapter:

- verifies the checkpoint is ours (`folds.observe`), forcing a HARD materialization if the host re-rendered it or cut before our watermark;
- restores the raw rows between the last `m[0]` baseline boundary and the checkpoint cut from the store (`fold/restore.ts`), because the host hides everything before its checkpoint while Magic Context still needs the unsummarized part of that range in the tail. A boundary on a row the host never serves by id (an instruction update) is moved back to the nearest served row;
- after the transform, swaps the checkpoint's summary text for the current `m[0]` baseline so the provider sees the Magic Context rendering.

Attachments on restored rows must be instances of the host's own `Media.Asset` class on OpenCode 2.0.15 and later. `fold/host-media.ts` obtains the constructor from an asset the host already put in a draft, or from the host's schema; when neither works, the attachment is replaced by a short deterministic note so the replay stays byte-stable.

## Hidden completions

OpenCode 2 gives plugins no child-session prompt loop, so hidden model work runs through `hidden-completion.ts`, a `generate`-backed executor. `hooks/hidden-child.ts` registers three hidden agents with no tools (`historian`, `dreamer-classifier`, and the base `dreamer` agent), shapes prompts that match a known marker into text-only drafts, applies output caps and temperature only when configured, and refuses unrecognised prompts on sessions it owns. Empty or length-capped completions are rejected before parsing.

What runs through it:

- **The historian**, whenever compaction is on, the executor exists and the historian is not disabled (`historianRunnable`).
- **`/ctx-wrapup`** and manual `/ctx-dream` (`hooks/dream-manual.ts`).
- **Scheduled dreamer tasks**, woken by execution events (`hooks/dream-trigger.ts`). `tool-loop` tasks run through fresh task-scoped hidden children; the host executes their permitted tools and the existing manifest parsers apply the result (see [dreamer.md](dreamer.md)).

OpenCode 2.0.22 or newer is required: startup checks for `session.remove` and `session.compact`, not a version string. Unsupported hosts refuse turns before the provider and show one upgrade notice. Each hidden run gets a fresh child with `parentID`; its location is inherited rather than sent. The host removes it on completion, with idempotent not-found handling and a bounded shutdown wait. `keep_subagents: true` keeps settled children and historian children. On upgrade, legacy `opencode2_hidden_children:*` records are drained through `session.remove` in bounded, resumable boot batches; a completion record stops further sweeps.

## Commands, tools and Channel 2

- `hooks/tools.ts` registers the shared `ctx_*` tools once.
- `hooks/commands.ts` registers `/ctx-status`, `/ctx-recomp`, `/ctx-dream`, `/ctx-flush`, `/ctx-embed` and `/ctx-wrapup` through the host's command domain when it exists; a host without one leaves them TUI-only.
- Channel 2 (see [nudges.md](nudges.md)) is sent with `session.synthetic({ delivery: "steer" })`. Each id is recorded in plugin storage so later passes recognise it as an admitted synthetic message rather than a real user turn.

## TUI seam

`src/v2/tui/index.ts` exports `setup(context)` over the `V2TuiContext` contract (`tui/types.ts`, pinned by `tui/host-contract.test.ts`). It mounts the OpenCode 1 sidebar component into the `sidebar.content` slot through the host's OpenTUI runtime, and mounts the OpenCode 1 status dialog the same way; if the host cannot load them, both fall back to a plain-text projection. OpenCode 2 has no `command.execute.before` hook, so every `/ctx-*` command in the TUI is a keymap-layer command whose `run` calls the matching RPC handler and reports through a dialog or toast. Data comes from the shared RPC-backed layer in `src/tui/data/`. `src/tui/entry.mjs` is the `./tui` export for both hosts: its default object carries the v1 `tui` and a `setup` that loads the v2 seam.

## Host limitations

A host limitation is a capability the current host lacks for the life of the process. `declareHostLimitation` (`shared/host-limitations.ts`) records it once; status surfaces keep printing it with its `MC-*` code. The OpenCode 2 adapter uses native session cleanup and supports Rust transform mode, so neither requires a host limitation.

## Moving between OpenCode 1 and 2 stores

A session can be read from OpenCode 1 tables and later from OpenCode 2's `session_message`, which numbers the same conversation differently. `store-generation-rebase.ts` (`rebaseSessionCoordinates`) records which store generation a session's coordinates belong to (`session_meta.coordinate_generation`) and, on a switch, re-maps stored message ordinals. Compartments whose range cannot be re-mapped are marked in `rebase_status` and excluded from range recovery and history refresh until resolved. The v2 hook rebases before the system-prompt handler so a converted session initialises the new host's prompt hash instead of arming a redundant fold. `doctor` reports these rebases (`doctor-store-generation.ts`).

Session rows carry a `harness` label, `opencode` or `opencode2`. `opencode2-relabel.ts` repairs labels from store evidence, choosing whichever store's activity for the session is newer; `doctor-harness-relabel.ts` exposes the same check.
