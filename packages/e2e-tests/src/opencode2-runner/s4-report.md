# OpenCode 2 slice 4 store/read report

## Store resolution and dispatch

`packages/plugin/src/shared/opencode-db-path.ts` is the single TypeScript authority for both host shapes. `resolveOpenCodeDbPath()` remains the unchanged v1 default (override, channel handling, candidate discovery and diagnostic text); `resolveOpenCodeDbPath("v2", …)` implements the GA/R16 filename table. `packages/plugin/src/v2/store-reader.ts` now delegates both compatibility exports to that resolver. Generation-specific readers inspect SQLite tables before their first query and refuse with `OpenCode store generation mismatch …; refusing generation-specific database access`.

### TypeScript/CLI call-site inventory

| Call site | Generation served |
| --- | --- |
| `packages/plugin/src/hooks/magic-context/read-session-db.ts:68` | v1 historian chunks, `ctx_expand`, turn probes and model/time fallbacks; schema-asserted v1. |
| `packages/plugin/src/features/magic-context/compaction-marker.ts:190` | v1 marker discovery/read/write only; schema-asserted v1. v2 uses the inert marker strategy and never opens this writer. |
| `packages/plugin/src/features/magic-context/tool-owner-backfill.ts:158` | v1 legacy tool-owner backfill; attached source is schema-asserted v1 before `message`/`part` SQL. |
| `packages/plugin/src/features/magic-context/message-index.ts:813` | v1 or v2 orphan sweep, selected from the boot harness; context-store candidates/cursor/deletes use `opencode` or `opencode2`, while the common host `session` table is the existence oracle. |
| `packages/plugin/src/features/magic-context/dreamer/open-opencode-db.ts:33` | v1 retrospective/orphan-child raw provider only; a v2 store is refused before legacy SQL. |
| `packages/plugin/src/v2/store-reader.ts:89` | v2 `session_message` reader; schema-asserted v2. |
| `packages/plugin/src/v2/hooks/context.ts:143,167,229,347` | v2 historian/`ctx_expand`/message-index raw provider, safety oracle, compaction owner and restored-window reader respectively. |
| `packages/cli/src/lib/diagnostics-opencode.ts:568,818` | doctor diagnostics select v1/v2 from the active CLI major version, resolve that generation's path, then assert the opened store before recent-session SQL. |
| `packages/cli/src/commands/doctor-opencode.ts:806` | doctor path check selects the resolver shape from the active CLI major version. Existing v1 success/failure text is unchanged. |
| `packages/cli/src/commands/migrate.ts:1378` | v1-only OpenCode→Pi/OMP migration; refuses a v2 store before `message`/`part` reads. |
| `packages/cli/src/commands/migrate-session.ts:635` | v1-only session relocation; refuses a v2 store before mutation. |

### Dashboard Rust reader inventory

Every resolved OpenCode path below is opened through `open_opencode_readonly` (`packages/dashboard/src-tauri/src/db.rs:336`), which classifies `session_message` as v2 (even beside migrated legacy tables), classifies a legacy store as v1, and refuses an unknown schema. The dashboard carries `opencode2` as a distinct harness.

| Call site | Data read and generation behavior |
| --- | --- |
| `packages/dashboard/src-tauri/src/db.rs:1391` | global cache events; v1 `message` SQL or v2 `session_message` SQL. |
| `packages/dashboard/src-tauri/src/db.rs:1900` | first-cache-event probe; generation-specific query. |
| `packages/dashboard/src-tauri/src/db.rs:2430` | recent cache sessions; common `session` metadata plus generation-specific message/cache probes. |
| `packages/dashboard/src-tauri/src/db.rs:2694` | cache-session titles; common `session` table, generation-labelled result. |
| `packages/dashboard/src-tauri/src/db.rs:3008` | one-session cache events; generation-specific query and harness. |
| `packages/dashboard/src-tauri/src/db.rs:3397` | session-directory/identity mapping; common `session` table, generation-specific context-store harness lookup. |
| `packages/dashboard/src-tauri/src/db.rs:3507` | project enumeration; common `project`/`session` tables, generation-labelled result. |
| `packages/dashboard/src-tauri/src/db.rs:5203` | session listing; common metadata, generation-labelled result. |
| `packages/dashboard/src-tauri/src/db.rs:5462` | message tab; v1 joins `message`/`part`, v2 reads ordered `session_message` rows and excludes non-conversational switch/idle rows. |
| `packages/dashboard/src-tauri/src/db.rs:5495` | session detail/counts; common metadata plus generation-specific message/cache counts. |
| `packages/dashboard/src-tauri/src/db.rs:5847` | session title/identity backfill; common metadata with generation-specific context harness. |
| `packages/dashboard/src-tauri/src/db.rs:5919` | compartment boundary times; v1 `message` or v2 `session_message`. |
| `packages/dashboard/src-tauri/src/config.rs:360` | config-editor project enrichment; common `project` table after generation classification. |

## Conflict-detector decision

The GA 2.0.3 schema evidence (`.cortexkit/alfonso/drafts/oc2-evidence/oc-audit-7a31b5c0f7.md:220-243`) contains `compaction.auto`, `compaction.keep.tokens`, and `compaction.buffer`; it has no `compaction.prune`. On v2, `compaction.auto=true` is expected because Magic Context owns the host compaction hook and supplies the summary. Therefore auto/keep/buffer are observed but do not disable Magic Context, and the v2 arm never reads `prune`. DCP and OMO competing context hooks remain conflicts. The v2 entry invokes this policy before registering hooks.

The GA host-supplied `Context.session` Pick exposes no config reader (R31), so product code does not invent a client or endpoint. **Gap:** on v2 the detector can only inspect the existing filesystem config layers; managed/merged host-only config layers cannot be reported until the host supplies a resolved-config surface. This does not affect compaction ownership because every v2 auto firing runs through Magic Context's hook.

## I11 golden contents

`reader-s4-golden.json` is data, not an expectation derived by the test. It pins:

- v1 normalized raw-message byte SHA-256 `6d4d3f742375174e2475816e05450451c061df66b19e69924cb6502290b81035`;
- the shared transform-core chunk text, four stable message IDs/ordinals, message count 4 and token estimate 44;
- the v1 marker summary row `marker-summary`;
- the v2 host-owned compaction row `{id: "host-checkpoint", summary: "host-owned"}`;
- an empty v2 legacy-marker table/row set.

The test constructs equivalent v1 `message`/`part` and v2 `session_message` stores, feeds each normalized conversation through the same `readSessionChunk` core, and asserts equal output plus the intentional host-row differences.

## Named gaps

- The v2 retrospective task is agentic/tool-dependent and is refused before dispatch under R38/R38a. Its legacy raw provider therefore remains v1-only and now loudly refuses a v2 schema instead of executing v1 SQL. A v2 retrospective reader should only be enabled with a real host tool-loop carrier.
- Node-only doctor cannot open Bun SQLite merely to schema-probe; it selects the host path shape from the active CLI version. The richer Bun diagnostics path performs the schema assertion. A Desktop-only installation reports version `unknown`, so `OPENCODE_DB` remains the explicit disambiguation mechanism until Desktop exposes its host generation.

## Verification capture

### Pure replay differential

Command: `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only master HEAD`

The instrument compared `master` (`f3e438e626edbaaad952d963e0504b7d9b5b90e6`) with the implementation commit (`b5b7b50d6a7a48929713f763d8bab74ed9730176`) and printed `RESULT IDENTICAL defer_passes=4`:

| pass | bytes | SHA-256 | result |
| --- | ---: | --- | --- |
| 1 | 262 | `165aed197ad1aa46c0684bd42be821ce39aba9c766afe42ff3e6b992f117c938` | IDENTICAL |
| 2 | 428 | `05945f88a5aabd1dd6152301133488ce317d4b400485496a3d65a22b4a53be73` | IDENTICAL |
| 3 | 594 | `d649359b66b444497d1e4d8be711382c23aefcccd2d19fd00a69d8d4c322eaed` | IDENTICAL |
| 4 | 760 | `9e81ff690576752bb4c5d9b87f69ae93474f6c10dca4230b278617a2fc552ae2` | IDENTICAL |

### Red-first mutation captures

Before each mutation, all live implementation files were staged and `git diff --stat` was empty. Each mutation produced a non-empty one-file diff, the named test alone reddened, and `git checkout -- <path> && touch <path>` restored an empty diff.

1. Neutralized `assertOpenCodeStoreGeneration` in `packages/plugin/src/shared/opencode-db-path.ts`. `host-aware dispatch refuses a v1 store before a v2 query` failed: `Received function did not throw`; 0 pass, 3 filtered, 1 fail.
2. Changed the pinned v1 SHA in `packages/e2e-tests/src/opencode2-runner/reader-s4-golden.json`. `I11 v1/v2 readers feed the same transform core with pinned host differences` failed with expected `0d4d…` / received `6d4d…`; 0 pass, 3 filtered, 1 fail.
3. Reversed the v2 auto-compaction ownership gate in `packages/plugin/src/shared/conflict-detector.ts`. `detectConflicts > OpenCode 2 compaction ownership > keeps MC enabled when host auto-compaction is on and never reads v1 prune` failed with expected `false` / received `true`; 0 pass, 49 filtered, 1 fail.

### Passing gates

- Plugin: 4,857 pass, 0 fail.
- Pi: 1,154 pass, 1 intentional skip, 0 fail.
- CLI: 384 pass, 2 platform skips, 0 fail; repair-db 5 pass; helper subprocess suites 16 pass.
- OpenCode 2 lane after building Pi and plugin artifacts: 51 pass, 0 fail.
- Root typecheck: plugin, Pi, CLI and retina TypeScript projects passed.
- Pinned Biome 2.5.1 `lint`: plugin, Pi, CLI and retina passed (existing warnings only; no fixes applied). Dashboard/e2e were intentionally excluded from Biome.
- Dashboard: `cargo fmt --check`, `cargo check`, targeted Rust tests and Vite production build passed.
