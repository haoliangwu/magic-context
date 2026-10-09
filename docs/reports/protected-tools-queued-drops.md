# Protected tool queue holds and daemon comparison

## Queue contract

Agent requests and historian publication write the same origin-free pending-drop
queue. The per-tool protected set used by automatic selection also applies when
that queue drains. A held row remains pending across rebuilding passes while its
result is still among the tool's newest active results. Rotation does not itself
price a byte change: the row applies on a later rebuilding pass. A historian's
summary remains publishable; fold/trim retires the covered raw result and its
pending row, and that compacted result stops counting toward the keep count.

The shared `protected-tool-holds.json` fixture checks normalized custom names,
the default `todowrite` and `ctx_reduce` counts, repeated holds, rotation,
no resurrection, and historian retirement in TypeScript, Pi and Rust. Production
pipeline tests additionally exercise the TypeScript 95% pressure case, the Pi
materialization gate, and Rust's durable queue. The existing metadata blob stores
Rust's selected protected ids for `ctx_reduce` acknowledgements; no schema
migration or queue-origin column is needed.

The dashboard keeps the redesigned Config page. Its Context window section now
contains the `protected_tools` object editor, including the shipped-defaults
placeholder, rather than the obsolete Smart Drops toggle. The deprecated-key
guard checks hand-written JSX as well as generic field descriptors.

## Verification

Tools: Bun 1.4.2 (744846f84), TypeScript 5.9.3, Biome 2.5.1,
Cargo 1.99.0 (5f94df478), rustc 1.99.0 (b940084d7).

- Frozen Bun install: 995 existing installs checked; no manifest or Bun lock changes.
- Plugin typecheck and dashboard typecheck: passed.
- Pi's normal typecheck encounters the pre-existing missing `Bun` ambient in
  the imported `storage-permissions.ts`. The same Pi project passes
  `node_modules/.bin/tsc --noEmit --types node,bun`. The untouched CLI's normal
  typecheck encounters the same pre-existing ambient-type error; no unrelated
  source change was made.
- Scoped plugin behavior suites: 274 tests passed in five files.
- Scoped Pi behavior suites: 158 tests passed in three files.
- Dashboard suite: 120 tests passed in 22 files.
- Shared TypeScript/Pi hold fixtures after restoration: eight tests passed.
- Rust protected-tool tests: 13 passed in `mc-module`, one passed in `mc-store`.
- `cargo fmt --check`: passed.
- `cargo clippy --locked -j 1 -p mc-module --all-targets -- -D warnings`: passed.
- Plugin, Pi and dashboard lint: passed (1225, 233 and 70 files respectively).
- `bun run build`: passed for plugin, Pi and CLI, including four v2 loader tests.
- Dashboard production build: passed.
- Mode-manifest validator: six tests passed. The repository contains 170 live e2e
  test files, so the expected inventory count was corrected
  from 169 to 170 without weakening the exact-once coverage checks. Its script
  also passes a scoped TypeScript 5.9.3 check with the e2e project's strict,
  ES2022/bundler and Bun-types settings.

### Mutation controls

Each source was staged before mutation. Each break carried `NON-VACUITY BREAK`,
produced a non-empty unstaged diff, and was restored with `git checkout --` and
`touch`, leaving an empty unstaged diff. No mutant was committed.

| Removed control | Named test that failed | Other tests in that run |
| --- | --- | --- |
| TypeScript queue drain's per-tool set | `ride-only supersession reclaim > queued protected tool drop stays held at 95 until rotation and a rebuilding pass` | `protected tool N+1 rotation never originates a bust` passed |
| Pi queue drain's per-tool set | `Pi scheduler decision observability > Pi pipeline holds a queued protected tool through priced passes and releases after rotation` | `contract Pi explicit protected drop applies at 95 without aging` passed |
| Rust queued-drop protection predicate | `transform::tests::protected_tool_queued_drop_persists_until_rotation_and_a_priced_pass` | `selection::tests::protected_tools_default_todowrite_survives_emergency_95` passed with the same mutant |
| Shared pending-operation protection predicate | `TypeScript held drop: historian queued protected drop holds until fold trim` | Three unrelated fixture cases filtered out; no other failure |
| Same shared predicate, Pi fixture entry | `Pi held drop: historian queued protected drop holds until fold trim` | Three unrelated fixture cases filtered out; no other failure |
| Reintroducing an actual JSX `smart_drops` control | `ConfigEditor ⇄ schema parity > #given schema-deprecated ignored keys #then the form renders no control for them` | All six other parity tests passed |

An initial dashboard mutation invocation from the repository root did not reach
the guard because Bun selected a React JSX runtime. Re-running from the dashboard
package used its Solid configuration and produced exactly the intended failure.

## Daemon comparison

The three integration tests were compared individually between a reference
checkout and the task checkout. The reference is a detached temporary worktree
underneath this task worktree's ignored `target/daemon-comparison/`.
Each invocation has a ten-minute timeout; the two checkouts never run in parallel.
Source and test code in the reference checkout are unchanged.
The background runner uses one subprocess group at a time, captures each log
and duration independently, and terminates the entire group at the timeout before
starting the next invocation. Test-owned temporary roots use an isolated
`TMPDIR` beneath `target/daemon-comparison/tmp`. Both test binaries were built
before launching the comparison; the ten-minute limit still includes each
test's internal `ensure_binary` calls.

Cargo's sibling path packages advanced during verification. Locked checks first
required refreshing `subc-core` 0.20.55→0.20.56, `subc-daemon` 0.31.1→0.32.0,
and `subc-os` 0.1.5→0.1.6. Subsequent comparison setup also encountered
`cortexkit-lease` 0.1.0→0.1.1 and `cortexkit-store` 0.2.1→0.2.2. Both checkouts
use matching current sibling packages. No registry dependency was updated.
During the first comparison, those live sibling sources advanced again to
`subc-core` 0.20.57 and `subc-daemon` 0.32.1. Both lockfiles were refreshed
identically before retrying only the two affected test pairs.

The first cold-cache reference test-binary compile hit a 30-minute build timeout
while still compiling dependencies. Its output repeatedly reported all six
machine-wide compile slots busy. This was a build-queue timeout, not an executed
daemon-test hang. The comparison reuses warm artifacts to avoid duplicating the
registry dependency compile.

### Initial individual runs

| Test | Reference checkout | Task checkout |
| --- | --- | --- |
| `hostless_store_init_first_transform_through_real_daemon` | Passed, 17.0 s total, one test | Passed, 362.7 s total, one test (3.06 s runtime; remainder mostly compile-slot waits) |
| `mc_pipe_only_supervision_through_real_daemon` | Timed out at 600.1 s while the test's `ensure_binary` was still building `mc-module`; the process snapshot shows that nested cargo build, not a daemon request wait | Failed at 305.4 s because the nested `cargo build --locked -p mc-module` encountered the newly advanced sibling versions |
| `mc_transform_spine_through_real_daemon` | Not reached: outer `--locked` prerequisite failed in 0.1 s | Not reached: same prerequisite failed in 0.1 s |

The hostless hang did not reproduce on either checkout. The initial other
results establish build/setup interference, not a branch-specific runtime hang.
The two remaining pairs were retried after aligning the lockfiles.

### Final outcomes

Every test below passed alone, running one test per invocation, with a ten-minute
timeout. The hostless results are the successful initial invocations; the other
two pairs are the prerequisite-repaired invocations. Times include outer cargo
work and the test's nested builds, so they are not daemon latency comparisons.

| Test | Reference elapsed | Task checkout elapsed | Result |
| --- | --- | --- | --- |
| `hostless_store_init_first_transform_through_real_daemon` | 17.0 s | 362.7 s | Both passed; no hang |
| `mc_pipe_only_supervision_through_real_daemon` | 274.4 s | 345.3 s | Both passed; no hang |
| `mc_transform_spine_through_real_daemon` | 48.8 s | 5.4 s | Both passed; no hang |

Thus none of the three runtime hangs reproduced in the reference or task checkout
in the final isolated, sequential runs. The one reproduced timeout in the reference
was inside the test's module-build prerequisite, with compile-slot contention
visible in the captured process tree.

Each invocation used:

```sh
cargo test --locked -j 1 -p mc-module --test real_daemon TEST_NAME -- --exact --nocapture --test-threads=1
```

The background runner, per-run logs, timeout process snapshot, and initial/retry
JSON results remain in the task worktree's ignored `target/daemon-comparison/`.
The reference source and task source used the same final dependency versions and
both had the documented sibling-only lockfile refreshes. After the comparison, the 13
`mc-module` protected-tool tests and the one `mc-store` snapshot test passed
again with the final dependency versions, and `cargo fmt --check` passed.
