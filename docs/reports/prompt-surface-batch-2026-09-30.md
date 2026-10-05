# Prompt-surface batch — 2026-09-30

## Delivered surfaces

- Merged issue 575 commit `b89f110c5c`: empty search sources mean all sources, `primer` is advertised, omitted note filters include pending smart notes, note reads accept at most 50 IDs, and primary `ctx_memory` no longer advertises legacy `limit`. Rust's light search description now also lists `primer`.
- Appended the exact approved variant C self-tag paragraph after built-in tagged guidance, including full/light primary and subagent variants. TypeScript and Rust primary assets remain byte-identical. Pi and both OpenCode integrations share the TypeScript guidance builder.
- Added `ctx_expand(tag=N)` with number/string schemas. Copied bare digits, complete/incomplete section-sign handles, `tag 12`, dropped placeholders, and surrounding whitespace normalize to a single positive safe integer. Invalid input lists the accepted forms. Tag ownership resolves one raw text part or one tool call's input/output, not an ordinal or all siblings. Dropped items recover from original history. Ordinal modes are unchanged.
- Updated full/light descriptions, parameter descriptions, reduction guidance, reference tools documentation, and TypeScript/Rust prompt goldens. Regenerated the editor schema and configuration docs; their bytes did not change because no configuration option changed.

## Operator decisions

When `ctx_reduce` is unavailable, the existing integrations suppress tag prefixes and use a tagless guidance variant. Although the initial request also listed that variant for self-tag instructions, the operator clarified that the line belongs **only where tag prefixes are shown**. Those tagless variants remain without the line, with existing no-section-sign assertions and a new explicit absence test. The tagless guidance retains `message=N` in its recovery instructions because the model using that variant sees ordinals, not tag placeholders. No tag assignment or persisted-assistant stripping behavior changed.

The initial locked Rust gate was blocked by unrelated sibling dependency drift: `subc-client-rs` was 0.23.4 while the lock pinned 0.23.3. The operator directed integration of master commit `282445eeff`, which updates that lock entry to 0.23.4 and adds its `tracing` dependency. That commit was cherry-picked, rather than inventing a separate dependency change.

## Cache epochs

The four compile-time constants that pin cache-visible renderer behavior stay unchanged:

| Constant | Value | Reason |
| --- | --- | --- |
| `PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC` | 3 | No profile-local codec or rendered-tail change. |
| `TAGGER_FEATURE_EPOCH` | 4 | Tag assignment, replay prefix injection, temporal decisions, and skeleton rendering are unchanged. |
| `MEMORY_RENDER_FORMAT_EPOCH` | 3 | Project-memory rendering is unchanged. |
| `COMPARTMENT_RENDER_FORMAT_EPOCH` | 2 | Compartment rendering is unchanged. |

Guidance/tool definitions already participate in `prompt_surface::unified_content_epoch`; `m0_content_epoch_for_pass` incorporates that identity alongside the system-prompt hash. The guidance and tool-definition content hash triggers the single prefix rebuild. Bumping `TAGGER_FEATURE_EPOCH` would unnecessarily force an independent tag-rendering migration. The existing tests that isolate historical reasoning-clear migrations under a fixed rendering epoch show that such a bump would add unrelated HARD folds. This batch changes guidance and tool definitions, not tag rendering.

## Verification

- Focused guidance/parity, tag recovery, input forms, reduction ranges, persistence round-trip, and issue 575 parameter suites: **168 passed**.
- Plugin/Pi tool suites, tool registration, prompt surface, and CLI suites: **1031 passed**, initially two advertised-field expectations failed because the new `tag` field was intentionally added. Updated those field-list assertions, not their behavior assertions.
- Impacted registration/recovery suites after that update: **76 passed**. Final native-part-index/Pi recovery recheck: **33 passed**.
- `bun run typecheck`: passed across plugin, Pi, CLI, and local filesystem package.
- Additional `bunx tsc --noEmit -p packages/e2e-tests/tsconfig.json`: failed on diagnostics in untouched health-probe, replay/harness, and integration-test files (SQLite interface mismatches, session SDK methods, and missing filesystem aliases). It reported no diagnostic in the changed pure-replay script; the real-host replay exercised that script successfully.
- `bun run lint`: passed; existing unrelated warnings/information remain in `inject-compartments-pi-mural.test.ts` and CLI maintenance tests.
- `bun run build`: passed for plugin/OpenCode 2, Pi, and CLI; OpenCode 2 loader tests: **4 passed**.
- Rust tag recovery and ordinal modes: `cargo test --locked -j 2 -p mc-module ctx_expand_`: **10 passed**.
- Rust `broca-facade-tools-full.json` and `broca-facade-tools-light.json` regenerated with `MC_BLESS_BROCA_FACADE_GOLDENS=1 cargo test --locked -j 2 -p mc-module broca_facade_tool_arrays_match_the_per_preset_goldens`.
- `cargo test --locked -j 2 -p mc-module`: all **1439 library tests passed**, 17 ignored. Earlier integration targets passed, but `real_daemon::mc_pipe_only_supervision_through_real_daemon` failed before tool dispatch: **supervised HELLO did not register**. The same targeted test still failed after refreshing the module binary with `cargo build --locked -j 2 -p mc-module --bin ck-mc`. This is an unresolved daemon-registration failure, not a proven baseline failure; no daemon code was changed in this batch.
- The four later integration targets, which Cargo had not reached after that failure, passed when run explicitly: `real_daemon_store_ahead`, `real_store_copy_migration`, `serde_json_feature_fidelity`, and `tag_cache_allocation` (**one test each**).

Tests now explicitly exercise tag 4 belonging to ordinal 3 while ordinal 4 belongs to a different message, one single tool, a selected sibling of a multi-tool message, dropped raw content, missing tags, copied input forms, and byte-identical strip-then-retag on OpenCode 1 and Pi paths. For text recovery, OpenCode's stored locator counts every part of a message (including structural parts), whereas Pi's locator counts only text parts. The shared recovery helper takes that distinction explicitly from its caller, rather than guessing from whether a raw-message provider is registered.

## Isolated real-host rollout

OpenCode reports version **1.18.30**. Replay roots and evidence are beneath `$TMPDIR/magic-context/prompt-batch/`; the replay harness now accepts `MC_REPLAY_SCRATCH_ROOT` so its extracted comparison checkouts can also stay there. Each host's stores/config are isolated, and lsof evidence records the active process tree's database paths. No live OpenCode, CortexKit Magic Context, or user config store is used.

### Results

The captured implementation ref was `3f96bf457280fe5060ad4ad3973390e25c219f37`. These are real OpenCode processes with an Anthropic-compatible mock provider, not transform-only fixtures.

1. `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only d8a6963308f750f3c0959bacfd995d2fa0a81eb7 3f96bf457280fe5060ad4ad3973390e25c219f37`: the existing whole-wire comparator intentionally reports **DIVERGENT / exit 1** because both the system and tool-definition hashes changed. All four message arrays stayed byte-identical between old and new captures (588, 754, 920, and 1088 bytes). Within each ref, system/tool hashes stayed fixed across all four defer passes. This is the expected initial prefix rebuild, not replay drift.
2. `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only --priced 3f96bf457280fe5060ad4ad3973390e25c219f37 3f96bf457280fe5060ad4ad3973390e25c219f37`: **PRICED_EXPECTATIONS_MET / exit 0**. Both independent runs had matching HARD message/history hashes, a calibrated local budget of 38173, matching dropped tags `[56,59,62,65]`, and identical cached history. Four subsequent passes per run were `defer`, including a host restart; the cached history hash did not change.
3. `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only 3f96bf457280fe5060ad4ad3973390e25c219f37 3f96bf457280fe5060ad4ad3973390e25c219f37`: **IDENTICAL / exit 0**, including system, tool definitions, and all four message arrays. The harness refuses a fixture work directory outside its throwaway comparison root. A first invocation used macOS's `/var` spelling while the imported script path resolved to `/private/var`, so that equality check failed. Canonicalizing the scratch parent before allocating the comparison root fixed the mismatch.

| Prefix surface | Base SHA-256 | Rebuilt SHA-256 |
| --- | --- | --- |
| System | `bbfa7c13b3ac0e9addb6f158a7ed22ccef1fe77f2370520e661060523928fadb` | `dd3cf3f23db14c71735e64c763a4558a86772301b5df3a739a99ec02ca0228fc` |
| Tool definitions | `be751f604b4fd78900273c7e7932bf51b6e351371e921172ca5bd0bc71cd8827` | `f736c67624e74e05ed9b0411055d69f4e10819cf5548b90b2e5edc70b02d7ceb` |

The four ordinary defer message hashes were `8e44911693c99c96462f474ea2c8c327799333f11a19ad15ad802fb7ac130221`, `a6391f075ba8a95501c2b241a3f04e0bb5104ad48a49ebfcaa69be8b295695dd`, `4a86507e5ba0bd6b7083a0af0357e2f15c4f550eb48385e50add5707f3430739`, and `c03c4fc133c46c4cca6401fa2a3c1cf3fd80be378077fa353c49f0676b57f53a`. The priced cached-history hash was `4ce19ae00732aa6549dfe829aaf01c8ee6da2dd212b86f9ac5a0718c2511a777`.

### Isolation evidence

Artifact root: `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/prompt-batch/`.

`pure-lsof.txt` and `priced-lsof.txt` were captured with `lsof -p <runner-and-descendant-pids> -Fn`. The ordinary process tree included PIDs 76660, 76703, and 76740. Its open databases were exclusively inside `replay/opencode-e2e-1790802744255-b2dk7y/data/{opencode,cortexkit/magic-context}/`; priced databases were exclusively inside `priced/opencode-e2e-1790802870901-l2hs0d/data/{opencode,cortexkit/magic-context}/`. The priced wrapper asserted that every observed database path began with the isolated artifact root. Full logs are `pure-differential.log` and `priced.log` in that root. No database under the user's `~/.local/share/opencode/`, `~/.local/share/cortexkit/magic-context/`, or configuration under `~/.config/` was used by these hosts.
