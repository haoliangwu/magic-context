# Rust marker byte identity: restart config authority

## Reproduction and mechanism

The regression starts at `ef536a3c0715c7927e2b5468ed2bee8dc2343091`,
the live user `cache_ttl` change. It exposes a shared e2e harness defect,
not a Rust scheduling or byte-identity defect.

Real hermetic stacks were built and run natively on Darwin/arm64 with
Bun 1.4.2, rustc/cargo 1.99.0, and CI-pinned OpenCode 1.18.32.
An archived source tree at `416ca2e6b` passes the 12,900-message test:
control, first host cut, and replay are all `SOFT+`, reason `none`.
The same source-tree experiment at `ef536a3c07` fails its ordinary-decision
assertion: all three are `HARD`, reason `ttl_expiry`. All three wire hashes
are nevertheless equal within each run. The current worker base,
`22e35ce514ce162a60ed3e2f08d9872b0b486a82`, reproduces the same failure.

The exact chain is:

1. The OpenCode runner writes the fold fixture's `cache_ttl: "0"` to
   `$XDG_CONFIG_HOME/opencode/magic-context.jsonc`.
2. First host boot migrates that legacy file to the authoritative
   `$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc`.
3. The fixture requests an ordinary-config restart with `cache_ttl: "5m"`.
   The old runner recreates the **legacy** file with `5m`; the authoritative
   file still contains `0`. Diagnostics directly confirmed `cortexkit=0`
   and `opencode=5m` after restart.
4. Both startup config loading and live snapshots use the same CortexKit-first
   loader. Legacy reading is only a fallback when the authoritative file is
   absent; no divergent product reader was found. Migration deliberately
   refuses to overwrite a conflicting authoritative file.
5. The next host transform resolves the explicit live value `0` from CortexKit,
   replacing the fixture's manual persisted `5m` override. The inspected row
   contained `cache_ttl="0"` and `cacheTtlPolicy` with `value="0"`,
   `source="config"`, and `config="0"`. The host sends this lifetime to Rust.
6. Rust `parse_cache_ttl("0")` returns zero milliseconds. Its idle-expiry
   predicate is `last_response_time > 0 && elapsed > ttl`, so every subsequent
   fixture pass with positive elapsed time is genuinely expired and takes
   `HARD/ttl_expiry` rather than ordinary replay.

The old freeze-any-config policy hid the stale file: it reused the saved
policy, and the fixture explicitly set that saved policy to `5m` before
comparison. Live user settings correctly override that saved value now.
Reverting Rust TTL handling would not correct the host's stale configuration
and would compromise the requirement that user edits apply on the next pass.
Built-in defaults remain frozen per session; product code is unchanged.

## Correction and writer audit

The OpenCode runner now writes Magic Context settings directly to CortexKit
on **every** boot. OpenCode's own global `opencode.json` remains in the
host-specific `opencode` directory. A loader-backed regression test simulates
first-boot migration and verifies that a subsequent `0` to `5m` write is read
from the authoritative file.

Other non-migration legacy writers were corrected in:

- OpenCode 1 side of the OpenCode 2 store-conversion lane;
- reasoning-removal and incomplete-user real-host repro helpers;
- the pure-replay differential helper (removed its legacy-path write fallback);
- the Docker OpenCode session smoke setup, which runs after installation.

The Pi/OMP runner already writes `$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc`.
The Rust module helper already writes `module-config/cortexkit/magic-context.jsonc`.
The OpenCode 2 runner and its direct test fixtures already use CortexKit.
No marker assertion was changed; its compared decisions and reasons are now
printed explicitly.

Deliberate legacy coverage is retained unchanged in the product unit suites:

- `migrateConfigFile (location migration)`, including "moves a single legacy
  source to the target and leaves a .MOVED_READPLEASE marker", "is idempotent:
  a second run finds no legacy source and no-ops", and both conflict-refusal tests;
- OpenCode config loader: "reads an unmigrated legacy project config instead
  of falling to defaults" and "loadPluginConfig (the runtime init path) honors
  read-legacy, not schema defaults";
- Pi config loader: "marks an unmigrated legacy project config as an untrusted
  load" and "reads Pi's own legacy config instead of falling to defaults when
  the base is absent".

## Proof

On the current base plus the corrected runner, the full marker file passes
all four tests. Compared passes are `SOFT+/none`, `SOFT+/none`, `SOFT+/none`;
all three request hashes are
`826da8067416a841270603142edc75fcd08b1e86044e9e50e4fb5a64d6d74cb8`.
The real input cut is `12956 -> 71`; the first cut sends all 71 messages,
and the next ordinary append sends a three-message delta.

Restoring only the runner's legacy `opencode` write destination makes the
loader-backed unit regression fail (`expected 5m, received 0`) and the original
marker test fail again with three `HARD/ttl_expiry` decisions. The wire hashes
are still equal. Both targeted mutant runs report exactly one failure, with
the other tests filtered. The mutant was restored from the staged live state;
the unstaged diff was empty before mutation, non-empty during it, and empty
again after restoration.

Every host run uses a throwaway root under `$TMPDIR/magic-context/bg_33a1b3c567ee8966/`.
Marker test `lsof -p` inventories include only that root's `opencode.db`,
`context.db`, and `store.db`, before and after restarts. Package unit suites
use a throwaway `HOME` without exporting `OPENCODE_DB`.

## Additional verification

All four full manifest Rust hermetic shards ran through the CI wrapper with
the real release module/daemon pair and the separate `drive-fault` binary:

| Shard | Files | Passing tests | Manifest/fixture skips | Result |
| --- | ---: | ---: | ---: | --- |
| 0/4 | 15 | 39 | 60 | pass, including all four marker tests |
| 1/4 | 14 | 23 | 17 | pass |
| 2/4 | 14 | 28 | 65 | pass |
| 3/4 | 14 | 25 | 12 | pass after the wrapper's bounded retry |

Shard 3's first `rust-adapter-perf` run observed five passes instead of four;
its fresh-process retry passed. This retry is reported rather than hidden.
External `lsof -p` observations captured 82, 32, 45, and 51 database-owning
host/module processes respectively, with no database paths outside the
throwaway task root.

`cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`
pass (four workspace crates). The requested `cargo test -p mc-module -p mc-store`
was attempted in full twice. The first run passed all 1,603 module library tests
and preceding integration targets, but hit an asynchronous `store_opening`
response in `hostless_store_init_first_transform_through_real_daemon`; that
test passed immediately in isolation. All remaining integration targets were
then run and passed separately, as did all 229 store library tests. A second
full run hit the pre-existing caveman wall-clock assertion under shared-machine
load: `long_whitespace_runs_and_many_paths_compress_in_linear_time` measured
5.68 seconds. It also passed in isolation. Neither failure is in changed code;
there is no claim that a single full Cargo invocation was clean. Module
documentation tests collect zero tests.

Issue 624's focused, separate-process checks pass: five saved/model-policy
tests, four OpenCode v1/v2 transform tests, two Rust authority-adapter tests,
three Pi context tests, and three Rust module TTL tests. They include live
user edits on the next pass, frozen built-in defaults, and unchanged prompt
bytes. Running broad Pi and OpenCode unit files in one Bun process initially
produced cross-harness state/mock failures; these are not substituted for the
isolated runtime contract checks.

The repository `bun run typecheck` passes (TypeScript 5.9.3, four packages).
The e2e-only `tsc --noEmit` command reports 19 existing errors in unchanged
files and transitive product imports. Fresh authoritative diagnostics cover
all seven changed TypeScript files with zero errors or warnings. Shell syntax
checking passes for the changed Docker setup script; the Docker install/smoke
image itself was not run.

The actual OpenCode 1/OpenCode 2 store-conversion suite passes all 14 tests;
its three observed database-owning processes also stay below the throwaway
root. Pi host version is 0.87.1.

The complete Pi host manifest ran: 49 passed, 246 host-gating skips, and one
failure in the long-session test's `"notes ready"` expectation. That same
expectation fails in isolation and in the archived, unmodified `ef536a3c07`
tree with a freshly built Pi plugin, so it is not caused by this correction.

The real issue 624 OpenCode host test also fails its final `ttl_idle` assertion
both here and in the unmodified `ef536a3c07` archive. Its policy assertions
pass (`13h`, then `1h`), but an asynchronous completion event overwrites the
fixture's artificially backdated response time before the lowering pass.
The retained log directly shows `cacheTtl=13h` with the old timestamp, then
`cacheTtl=1h` with a fresh timestamp and a correct `defer`. This separate fixture
race was not changed or folded into the marker fix.

The complete OpenCode manifest invocation reached its 30-minute command cap
after 71 passing tests and that one known failure, with 34 of 40 files reached.
The six unreached files were then run separately (12 passes), along with the
two final idle-restart cases (both pass, one repeats an already completed case).
This covers all 40 manifest files with 84 distinct passing tests and the
baseline issue 624 fixture failure; it is not a claim of a clean, single full
invocation. The independent cache-analysis oracle passes all ten tests.

The daemon release binary used for the hermetic runs was built from sibling
subconscious revision `d2a2fd7c018aea7faf5914dc3e95ad5781f6b7b2`.
Additional baseline failures and exact commands are recorded in the delivery
declaration.
