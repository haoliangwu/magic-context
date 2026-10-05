# OpenCode 1 ↔ OpenCode 2 parity

This document records the effective-behavior contract between the OpenCode 1
adapter (`packages/plugin/src/plugin/` and `src/hooks/magic-context/`) and the
OpenCode 2 adapter (`packages/plugin/src/v2/`). Differences listed as
**host-imposed** are not product preferences: each cites the GA 2.0.5 surface
that prevents the v1 mechanism from being reused.

The comparison target for OpenCode 2 is exactly `@opencode/cli@2.0.5`,
`@opencode/cli-linux-x64@2.0.5`, and `@opencode/plugin@2.0.5`.

---

## Identical effective behavior

- **One transform core.** Both adapters call the shared transform in
  `packages/plugin/src/hooks/magic-context/transform.ts`. Tagging, deterministic
  replay, pending reductions, protected-tail rules, m[0]/m[1] composition,
  memory injection, pressure scheduling, and fail-closed storage behavior remain
  shared rather than forked.
- **Stable defer passes.** Persistent mutations replay on every pass. The v1
  pure-replay differential remains the byte-level regression oracle; the v2 GA
  lane separately checks the transformed provider head after repeated turns.
- **One Magic Context store.** Both write
  `cortexkit/magic-context/context.db`. Session-scoped rows are distinguished by
  `harness='opencode'` and `harness='opencode2'`; project memories remain shared.
- **Commands and tools.** The same `ctx_reduce`, `ctx_expand`, `ctx_note`,
  `ctx_memory`, and `ctx_search` behavior is adapted onto the host hook surface.
  OpenCode 1.x keeps process-scoped tool descriptions; OpenCode 2 rewrites the
  five `ctx_*` descriptions per `context` pass from the draft model.
  Status and recomp data remain on the authenticated Magic Context RPC surface;
  the GA v2 command-registration gap below currently prevents their slash-command
  entry points.
- **Historian validation and publication.** The calibrated prompt, validation,
  repair/fallback orchestration, compartment publication, and accounting rules
  are shared. Only the completion transport differs.
- **Configuration semantics.** Magic Context still reads the same user/project
  `magic-context.jsonc` layers and applies the same schema, security stripping,
  defaults, and warnings.
- **No v1 packaging regression.** The package keeps its v1
  `@opencode-ai/plugin` runtime dependency and has no `@opencode/*` runtime
  dependency. The server and TUI each expose one union object so the two host
  generations select their own callback without a competing subpath export.

---

## Host-imposed mechanism differences

### 1. Hook carrier

**OpenCode 1:** `experimental.chat.messages.transform` supplies the mutable
message array used by the established adapter.

**OpenCode 2:** the GA `Context.session` hook domain supplies `context`,
`compaction`, `generate`, and tool hooks. The adapter projects those drafts into
the same transform core.

**Constraint:** `@opencode/plugin@2.0.5` exposes the v2 hook surface through
`dist/promise/session.d.ts`; it does not expose the v1 experimental transform
callback.

### 2. Fold ownership

**OpenCode 1:** Magic Context owns its deferred compaction marker and trims the
host-visible history at that marker.

**OpenCode 2:** the host creates the durable compaction row and chooses its
sequence cut. Magic Context answers the host `compaction` hook with its frozen
baseline, binds the actual persisted cut on the following context pass, and
restores any unarchived pre-cut rows after the checkpoint.

**Constraint:** GA dispatches provider-mode compaction before publishing the
`Compaction.Started` event, so the final cut sequence does not exist at hook
time. The `Context.session` Pick also has no `compact` method
(`@opencode/plugin@2.0.5`, `dist/promise/session.d.ts:105-106`). Predicting the
sequence or inventing an endpoint would violate the host contract.

### 3. Hidden completions

**OpenCode 1:** historian and Dreamer work can use child sessions with an
explicit model and a host tool loop.

**OpenCode 2 (2.0.22 or newer):** historian/classifier/compress-cues work uses a
fresh child per run, parented to the user's session when one exists. The child is created on
the resolved historian or Dreamer chain head, so the configured cheaper model is
independent of the user's session model. A narrowly discriminated `context` hook
replaces the marker with the exact calibrated `[system, user]` pair, generation
options, and an empty tool surface. Completion text and provider usage come from
the child's persisted assistant row; the local meter is only a missing-usage
fallback. Retryable fallback switches the child's model before re-prompting.

**Lifecycle:** the plugin requires `session.remove` and `session.compact` capabilities.
A child inherits its parent's location and carries its hidden-run metadata on create.
Completion removes it through the native API, with idempotent missing-session handling
and a timeout so shutdown cannot hang. No service registration or offline doctor deletion
is needed. Legacy bookkeeping is drained through the host once, in resumable boot batches.
The marker hook still refuses any unregistered prompt on a Magic Context child.

**Retention:** `keep_subagents: true` keeps settled children and historian children.
Unsettled Dreamer children are removed. Each retained child holds only its own run;
retained sessions accumulate until manually cleared.
Kept children stay in the retired list, so every boot still registers them as
hidden, and the boot sweep skips them until the setting is turned off.

### 4. Fail-closed interruption

**OpenCode 1:** the adapter uses the v1 abort carrier before an unsafe provider
request.

**OpenCode 2:** it awaits `session.interrupt` with a two-second bound and throws
a typed refusal when interruption is rejected, times out, or arrives too late.

**Constraint:** `session.interrupt` is the only abort-like operation projected on
the GA `Context.session` surface. The protocol route returns
`{interrupted:boolean}`, where `false` is an idle no-op.

### 5. Host store reader

**OpenCode 1:** history is normalized from the legacy `message` and `part`
tables.

**OpenCode 2:** history is normalized from ordered JSON rows in
`session_message`, including idle and host compaction rows. Generation-specific
readers inspect the schema and refuse the wrong store before querying.

**Constraint:** GA 2.0.5 persists the session union as JSON in
`session_message`; the legacy tables are not its history authority.

### 6. TUI loader and surface

**OpenCode 1:** the `./tui` default export is consumed as `{id,tui}`. The loader
at OpenCode 1.18.30 `packages/opencode/src/plugin/shared.ts:272-304` reads only
`id`, `server`, and `tui`, rejects a simultaneous server/tui pair, and ignores
unrelated keys.

**OpenCode 2:** the same `./tui` module is consumed as `{id,setup}`. GA
`packages/tui/src/plugin/context.tsx:647-693` resolves the exports-map `./tui`
entry, validates `id/setup`, and calls `setup(context)` at lines 634-641. The v2
TUI registers `sidebar.content` through `ui.slot`. The contract advertises
palette/slash registration through `keymap.layer`, but the GA implementation's
unbound callback is the recorded gap below.

**Constraint:** the APIs are different contracts. The package therefore exports
one `{id,tui,setup}` union from the existing `./tui` entry. Adding a second
loader-specific export would let an older host select the wrong object, while
putting the v2 implementation elsewhere would leave it unreachable.

---

## Recorded gaps

These gaps remain visible until the GA host supplies the missing carrier. None
is implemented with a private endpoint, generated client, credential scrape, or
manufactured tool loop.

1. **Agentic Dreamer tasks are refused.** The interim child carrier deliberately
   strips tools from text-only hidden requests. `curate`, retrospective,
   `maintain-docs`, primer promotion/refresh, user-memory review, tool-driving
   mural rendering, `map-memories`, `verify`, and `verify-broad` are refused
   before provider dispatch because their evidence or output depends on tools.
   The historian, classifier, and compress-cues remain available because their
   calibrated work is text-only.
2. **Magic Context cannot initiate native compaction.** `compact` is absent from
   the GA `Context.session` Pick. Host-scheduled compaction is supported; an
   MC-initiated native fold remains unavailable.
3. **No resolved config reader exists on the GA Context surface.** Conflict
   detection can inspect filesystem config layers but cannot report managed or
   host-only merged layers. The v2 host still routes every automatic compaction
   firing through Magic Context's hook.
4. **Desktop generation detection is unknown without a CLI.** Desktop app IDs
   identify that Desktop has run, but its persisted settings do not expose the
   host major version. A Desktop-only install therefore reports version
   `unknown`; `OPENCODE_DB` remains the explicit disambiguation until Desktop
   exposes generation metadata.
5. **The GA keymap registration helper is unusable during plugin setup.** The
   type surface advertises `context.keymap.layer`, but GA
   `packages/tui/src/plugin/api.tsx:141-149` assigns the unbound
   `Keymap.createLayer` function. Calling it from `plugin.setup` fails with
   `Keymap.Provider is missing`, before either command can register. Magic
   Context records that exact gap, keeps the sidebar active, and does not reach
   into host internals as a workaround. `/ctx-status` and `/ctx-recomp` remain
   unavailable in the v2 TUI until the host binds this surface.
6. **No server-to-TUI plugin RPC bridge is supplied.** `Host.resolve` tolerates
   an absent `./rpc`, and `@opencode/plugin@2.0.5` exports only the generic RPC
   schema from `dist/rpc.js`; it does not connect a server plugin to its TUI
   plugin. The v2 sidebar and prepared dialogs therefore use Magic Context's
   authenticated localhost discovery/socket transport rather than an invented
   host API.
7. **Provider request bodies are not byte-identical across host generations.**
   Equivalent drafts differ in host-owned tools, options, and message shaping.
   Cache-stability parity is asserted within each generation; no new Rust codec
   profile is claimed from cross-host body identity.
8. **Hidden roots cannot be removed by the plugin.** The GA `Context.session`
   Pick has no `remove`, and metadata does not hide root sessions. Doctor can
   inventory active and retired Magic Context roots but intentionally performs no
   mutation; users remove unwanted roots through OpenCode.

---

## Verification lanes

- `tests/docker/opencode2/run.sh` builds the publishable plugin and runs the exact
  OpenCode 2.0.5 Linux host in a clean container. It fails on a missing binary,
  wrong pin, plugin activation failure, absent transformed provider head,
  missing completed host fold, wrong/missing `opencode2` Magic Context row,
  non-hermetic database placement, or a TUI that does not execute `setup` and
  paint the sidebar.
- `packages/plugin/src/v2/tui/host-contract.test.ts` executes the GA exports-map
  resolver and union `setup`, then executes the v1 `tui` registration path while
  pinning the v1-visible projection.
- `packages/e2e-tests/tests/opencode2/` remains the deeper real-GA behavior lane
  for hook, safety, fold, hidden-completion, and store-reader contracts.

## Pi / OMP host-scenario adjudication

The Pi-family matrix is maintained in
[`packages/e2e-tests/HOST-SCENARIO-MATRIX.md`](packages/e2e-tests/HOST-SCENARIO-MATRIX.md).
This does not change the OpenCode 2 results above.

| Surface | Pi / OMP result |
| --- | --- |
| Whole-system cache stability | OMP 18.2.6's request-body `cch` attestation changes `system[0]`; cache-stability and long-session phase 1 are declared host-imposed divergences, not relaxed assertions. [Evidence](packages/pi-plugin/PARITY.md#35-omp-provider-attestation-prevents-whole-system-byte-parity). |
| Historian, todo, memory, compaction-off and pressure fixtures | OMP configuration filenames, shared config location, tool transport and macOS cwd spelling required harness corrections; real-host assertions remain enabled. [Adjudication](packages/pi-plugin/PARITY.md#36-omp-parity-fixtures-use-native-configuration-and-wire-conventions). |
| Same-path window overlay | Pi/OMP product fix classifies the host model window as catalog metadata; observed overlay limits take precedence. Pi hot-reloads; OMP RPC restarts and resumes because its reload callback is a no-op. |

## Static tokenizer decision calibration

History materialization converts provider-token allowances to local prose allowances in OpenCode, Pi and Rust. Pressure and exact demotion consume the same allowance; cache identity still uses the configured provider-token budget. The static measurement table is shared JSON, with matching longest-prefix and nearest-family inheritance.

The canonical protected tool-window walk lives in `protection-window.ts` (not `storage-tags.ts`); all TS/Pi consumers share it. Rust applies the same tool ratio while keeping persisted member rows raw. Boundary indexes weight tool and prose source classes on read; neither engine changes tokenizer caches.

Fallback admission now requires complete calibrated counts and a known current-model window. A serialized-byte approximation may reject but cannot admit. OpenCode LKG admission now checks `trusted`. Pi's storage-failure handler currently lacks held system/tool observations at that catch boundary: it refuses replay/raw fallthrough rather than pretending its byte estimate proves fit. The Pi fit helper accepts complete explicit observations and has positive/negative admission tests.

Historian sends count assembled instructions/reference/source text with the selected producer model, reserving output once and retaining the 3% margin. Rust's current assembled request contains only the primary producer window; an unobserved fallback window is refused, not borrowed from the primary model. TS/Pi resolve fallback windows independently. Transport/provider framing and host-hidden additions are not exact provider tokenization.

### Tail-hygiene provider units

OpenCode, Pi and Rust now classify the rendered tail in provider-token units. Tool input/output uses the frozen tools ratio; text and file content use the frozen prose ratio. Fractional class mass is accumulated before one aggregate ceiling, while the 0.20/0.40/0.60/0.75 bands remain ratios. The 60K tail, 25K Channel-1 reclaimable and 50K Channel-2 reclaimable floors, cadence growth, post-reduce grace and reminder figures all consume the calibrated totals.

The active ratio is frozen with the session generation. OpenCode/Pi store it under `session_meta.deferred_execute_state.magicContextTokenizerCalibration`; Rust stores the twin in `mc_cache_state.meta.decision_calibration`. Legacy rows remain neutral on defer. The first authorized bust adopts the current static table, converts the persisted U watermarks once and stamps `hygieneUnitsVersion=2` / `hygiene_units_version=2`. No SQL migration or schema-fence movement is required.

Historian source caps now convert using the producer's larger prose/tool seed before formatted-source splitting in TS, Pi and Rust. Main-model trigger mass uses the consumer's class policy independently. The legacy projected-reclaim calculation is still unresolved: its byte-ratio attribution does not establish actual served before/after replacement mass. It must not be reported as calibrated reclaim proof; replacing that projection remains required for complete Phase A.

Emergency planning now separates served mass from reclaimable mass. OpenCode and Pi targets preview current tool input/output and retained skeletons without mutating cached messages; unavailable replacement observations receive no reclaim credit. Shared thinking is not credited per tool, avoiding duplicate reclaim. Rust uses raw active token counts (tokenizing missing counts), class weights and retained skeleton payload counts; it includes a conservative 32-local-token allowance per retained block for the later tag overlay. This may select more Rust candidates than exact host-side previews, never treating the original byte mass as fully reclaimable. Existing pressure-episode latches and protected exemplars are unchanged.

### Static-only calibration lifecycle

Calibration is curated by periodic measurement sweeps and has only `seed` and `family-fallback` provenance. There is no request-level L/P capture, EMA, learned candidate, runtime adaptation or learned-state persistence in OpenCode, Pi or Rust. A binary table revision is adopted only at the next authorized bust and is logged as `calibration revision <old> → <new> adopted (bust=<reason>)`; the revision change itself never originates a HARD.

### Calibration verification and remaining scope

Pinned OpenCode captures compare master `7486664df07096385e3a5985427b335a221a2bd2` with runtime candidate `6eddf386937058ffcde18b88179c3bb987d517f0`. The neutral control preserves the complete captured messages at the same model-change HARD edge. Fable uses the independently supplied 38,173-local history allowance instead of 60,000. A common legacy cached history is then adopted on both revisions: a real tail-only execute preserves its bytes while dropping exactly two eligible tool tags on master and four on the calibrated candidate. Each path then observes four actual scheduler defers, including a restart; neutral messages/system/tools hashes match across revisions. No provider body is reconstructed by a second serializer. Hash evidence and limitations are in `docs/reports/tokenizer-calibration-phase-a-verification.md` and the adjacent gate JSON files.

The fix round reran both full adapter suites under isolated HOME/XDG roots: plugin 5,254 pass / 1 skip / 0 fail; Pi 1,225 pass / 3 skip / 0 fail. Rust's locked `mc-module` suite passed with 1,217 library tests and 8 ignored plus all integration targets; clippy passed with warnings denied.

These records do not close the unresolved legacy projected-reclaim attribution or the complete docs/memory/profile/facts and m1 cap inventory. The standalone full scheduler-to-provider adversarial HTTP matrix is not claimed complete. The table-revision defer freeze and one-time hygiene stamp were exercised on TS and Rust, including restart-shaped durable reloads; the missing-stamp mutation reddened and was restored. Pi child-runner tool schemas and later host/provider framing remain outside static decision calibration.
