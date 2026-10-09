# Host-behavior failures at 53bfd742

## Fleet decision

All three failures are test-side defects. No product change is needed for these
failures. In particular, OpenCode 2.0.22 successfully runs migration 95 off-thread
from both the published union entry and `dist/v2/server.js`; the failed readiness
test built a different, incomplete plugin. These findings do not certify unrelated
fleet behavior or replace the full CI lanes.

Investigation and final reruns completed before 19:00Z on 2026-10-06, in the isolated
task worktree. Bun was 1.4.2; the OpenCode 1 reproduction used CI's exact 1.18.34
release, installed with the repository installer into a throwaway home. OpenCode 2
was the workspace-pinned 2.0.22 binary.

## 1. Live cache TTL: an unfenced telemetry read

The unchanged test reproduced the reported `defer / first_render` result at
53bfd742 on OpenCode 1.18.34. It also reproduced **before** the harness config fix,
at 4ec6c1fc. Thus the every-boot config rewrite is not the cause. There is no
restart in this test, and its live edits already target the authoritative
`$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc` file.

The failed fixture's plugin log records `cacheTtl=13h ... decision=defer`, then
`cacheTtl=1h ... decision=execute`. Its database initially contains only the seed
turn's `first_render` telemetry row. `scheduleOpenCodeTransformDecisionWrite`
binds the decision to the completed assistant and writes it with `setTimeout(0)`;
the HTTP prompt response does not fence that deferred write. Faster 1.18.34 turns
expose the stale-row assertion. The original test passed on the installed 1.18.30
host at both revisions, further distinguishing the timing problem from the
harness merge. An initial 1.18.30 attempt also raced the short host SQLite writer
and failed with `SQLITE_BUSY` while editing the fixture clock.

Fix: keep the original execute/ttl_idle contract, but wait for a decision whose
timestamp belongs to the expired turn before asserting it. Give the fixture
writer a bounded busy timeout. Assert that both live config values remain on disk
after their prompts, alongside the existing persisted TTL, config provenance,
and byte-identical warm-prefix checks. Final exact-host rerun: **1 pass, 0 fail**.

## 2. Source pin: intentional current-schema-only opener

The changed file is `packages/plugin/src/index.ts`, after the test removes its
three exact additive dual-loader fragments. Expected hash:
`48093b2c1481319fee68bcb66a4adf56197438e8c96140b9c1d531fff3bc716e`.
Actual hash:
`73a5c7f324ec6a7c4efba2b3c36683460f2a351175bc5f88ce5dec7050b0f85c`.

Commit ebd7052c03c8e55b653a2175f124ed2c9b1e9fb9 changed just this import in the
pinned file: `openDatabase` became `openCurrentDatabase as openDatabase`. Although
the original commit is labeled reclaimed/unreviewed work, the change was included
in the reviewed v95 merge 4ec6c1fc and implements its documented policy: host paths
must not synchronously migrate after async boot. It is an intentional v1 safety
change, not v2 leakage. At pre-v95 master 545c16ee the pin test passes; at 53bfd742
it fails with precisely these hashes.

Fix: update that one pin and add a history comment explaining the opener change.
Final pin suite: **2 pass, 0 fail**. A source-byte mutation reddened only
`v1_untouched and captured fixture bytes remain sha256 pinned`; the native release
pin agreement test stayed green. The original source was restored from the staged
live state, with a non-empty diff during mutation and empty diff after restoration.

## 3. Healthy storage boot: probe omitted the migration worker

At 53bfd742, the healthy probe log names the exact missing file:
`probe-plugin/migration-worker.js`. The test's `Bun.build` emitted only `server.js`,
not the worker. The new fail-closed client correctly refuses that incomplete
plugin, leaving the isolated schema at 94. The injected two-second async process
probe finishes normally; it is not the cause. At pre-v95 master 545c16ee both
readiness scenarios pass because the old client falls back to main-thread
migrations when the worker is unavailable. Restoring that fallback would undo the
intended health-watchdog protection, so it is deliberately **not** the fix.

Fix: build the probe's worker alongside its server. Keep the generated TypeScript
entry outside the plugin directory: OpenCode prefers `server.ts` over `server.js`
when both exist, which would otherwise bypass the bundle. An omission control
against this compiled-only fixture fails only
`OpenCode 2 registers context tools after a two-second healthy storage open`
(94 instead of 95); the blocked scenario, both real-bundle scenarios and both pin
tests stay green.

Two added real-host checks separately load the production union bundle and the
actual v2 dist via a re-export-only package (without rebundling or overriding its
worker URL). Each starts with the latest migration marker and three new schema
objects removed, then proves the worker loads, main-thread migration-body count
is zero, schema reaches 95, the missing objects are installed, and all four context
tools reach the mock provider. Final OC2 rerun: **6 pass, 0 fail** across readiness
and pins. The two delayed setup durations were 10,064ms and 2,120ms; HTTP and
heartbeat assertions remained green.

## Isolation, commands and limits

Every host run used throwaway data/config/state/runtime/storage under
`$TMPDIR/magic-context/bg_a10620ddbd053376/`. Both runners check host descriptors;
the tests additionally capture `lsof -p <pid>` inventories and assert every open
database lies within that run's root. No live database/config was opened, read,
written or migrated. Builds ran only in the task worktree. No package or lockfile
changed.

Final commands (with `NODE_ENV=''`, `MC_E2E_MODE=ts`, the appropriate
`MC_E2E_HOST`, throwaway `TMPDIR`/`HOME`, and the isolated 1.18.34 bin on PATH):

- `bun run --cwd packages/plugin build`: passed; embedded v2 contract suite 4/4.
- `bun test --timeout 600000 packages/e2e-tests/tests/cache-ttl-live-config.test.ts`:
  passed 1/1 on OpenCode 1.18.34, 18 assertions.
- `bun test --timeout 600000 packages/e2e-tests/tests/opencode2/storage-boot-readiness.test.ts packages/e2e-tests/tests/opencode2/pins.test.ts`:
  passed 6/6 on OpenCode 2.0.22.
- TypeScript 5.9.3 `tsc --noEmit -p packages/e2e-tests/tsconfig.host-triage.tmp.json`:
  passed for the three changed test roots and their imports. The temporary config
  extends the package config, supplies Node types and the plugin's retina-local-fs
  path mappings, and includes only those three roots; it is not committed.
- Biome 2.5.1 format check of storage-boot-readiness: passed, one file checked.
- Scoped TypeScript diagnostics: zero errors/warnings in all three changed tests.
- `git diff --check`: passed.

The broad e2e `tsc --noEmit -p packages/e2e-tests/tsconfig.json` reports 19 unrelated
errors outside changed files (SQLite backend typing, older test API assumptions,
retina path resolution, and a readonly ignore field). Those are not fixed here;
the narrower check above verifies this delivery. Full host suites, Docker and
Rust gates were not rerun: this change is confined to these fixtures and pins.

Raw logs and retained fixture inventories are under the task's throwaway root:
`logs/final-build.log`, `logs/final-ttl.log`, `logs/final-oc2.log`,
`logs/mutation-worker-final.log`, `mutation-pin.log`, and `ci-failed.log`.
An early worker-control attempt was invalidated by the runner-home metadata fence
because its redirected log lived directly in that home. A separate exploratory
fixture also selected source `server.ts`, masking the missing worker. Neither is
counted as proof; both were corrected before the isolated final control (5 green,
1 expected red) and final all-green rerun. No mutation remains in the tree.
