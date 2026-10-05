# Merged cubic-dev-ai review triage

Reviewed against master snapshot `3c0db62ab32b945a4b78a1111ef07a5b0753d7e3`.
The complete cubic-dev-ai comment bodies were fetched with
`gh api repos/cortexkit/magic-context/pulls/<N>/comments?per_page=100`
for PR 462, PR 458, PR 456, and PR 438. The verdicts below follow the code at
that snapshot, not just the comments' “Addressed” annotations.

**Result: all twelve listed findings are already fixed.** No production change,
migration, or renderer refactor is needed. The only additional coverage is a
native SQLite regression test runnable under both Bun and Node: the earlier
remapped-error test synthesized an error, and the authority test did not have a
matching duplicate that could mask the refusal.

## Finding → verdict → evidence / merged commit

Paths below are repository-relative; line numbers refer to the master snapshot.

| Finding | Verdict | Current evidence / merged commit |
| --- | --- | --- |
| [PR 462 P1: stale shadow remains armed](https://github.com/cortexkit/magic-context/pull/462#discussion_r4038144906) | Fixed already | `packages/pi-plugin/src/embedding-bootstrap.ts:123–132` unregisters the shadow when routing has no shadow, leaving primary registration intact. The disabled and unavailable shadow tests in `embedding-bootstrap.test.ts` pass. Commit `c972f50291`. |
| [PR 462 P2: deterministic no-probe routing is not memoized](https://github.com/cortexkit/magic-context/pull/462#discussion_r4038144920) | Fixed already | `embedding-bootstrap.ts:133–156` only declines caching when actual daemon discovery can recover. Provider `off` and missing SubC configuration cannot enter that retryable condition. Tests `does not repeat a missing-SubC warning until configuration changes` and `treats a no-probe outcome as a registry no-op on the next call` pass. Commit `c972f50291`. |
| [PR 462 P2: retired in-flight shadow batch can publish vectors/state](https://github.com/cortexkit/magic-context/pull/462#discussion_r4038837943) | Fixed already | `packages/plugin/src/features/magic-context/project-embedding-registry.ts:2138–2145,2200–2204,2290–2295` checks registration generation after embedding and before memory, commit, and chunk vector writes. `runShadowWorker:2365–2389` also suppresses stale success/error outcomes. All three in-flight retirement vector tests pass. Commits `ff1b7d1206` and `00b9803d26`. The worker-state guard has no dedicated behavioral test; the latter commit explicitly documents that limitation. |
| [PR 462 P3: async disposal timing in the Pi test](https://github.com/cortexkit/magic-context/pull/462#discussion_r4038837954) | Fixed already | `packages/pi-plugin/src/embedding-bootstrap.test.ts:208–215,313–320` now uses a non-async callback that records invocation and returns a resolved promise. It tests that disposal was called, not that asynchronous cleanup completed. Both tests retain cohort-null/primary-intact assertions and pass. Commit `f776bfc5ad`. |
| [PR 458 P3: document clone-preserved source timestamp](https://github.com/cortexkit/magic-context/pull/458#discussion_r4029651433) | Fixed already | `packages/plugin/src/features/magic-context/storage-db.ts:1204` explicitly says “epoch ms; Date.now() on source writes, preserved on session clones.” `storage-clone.ts:603–629` binds the source row's `created_at`. Commit `5b2d8a05ad`. |
| [PR 456 P2: TypeScript dist target bypasses source mapping](https://github.com/cortexkit/magic-context/pull/456#discussion_r4025186180) | Fixed already | `packages/pi-plugin/src/dreamer/pi-session-api.ts:275–292` computes `srcEntry` before the direct TypeScript import and requires `!srcEntry` for that shortcut. Test `maps a TypeScript dist export to its source counterpart before importing` supplies both stale dist and fresh source and passes. Commit `8827f8eae9`. |
| [PR 456 P3: pin Pi-before-OMP bare fallback order](https://github.com/cortexkit/magic-context/pull/456#discussion_r4025043715) | Fixed already | `pi-session-api.test.ts:136–144` asserts the complete ordered loader-name array: running host, Pi bare import, OMP bare import. The full Pi suite passes. Commit `1e7589025c`. |
| [PR 456 P3: OMP module mock leaks](https://github.com/cortexkit/magic-context/pull/456#discussion_r4025186199) | Fixed already | `pi-session-api.test.ts:146–185` exercises the fallback with an on-disk OMP fixture and an isolated resolver copy; it does not call `mock.module` for OMP at all. That test and the full Pi suite pass. Commits `8827f8eae9` and `fef3b9dd4c`. |
| [PR 438 P1: Node's remapped UNIQUE error escapes](https://github.com/cortexkit/magic-context/pull/438#discussion_r3993868902) | Fixed already; native coverage added | `packages/plugin/src/tools/ctx-memory/tools.ts:353–364` accepts the exact Bun UNIQUE code or an explicit UNIQUE-violation message, including Node's `ERR_SQLITE_ERROR`. Commit `b8a8648913`. New `sqlite-backends.test.ts` executes a real violating UPDATE and verifies the exact friendly duplicate response and rollback under Node **22.16.0** and Bun. Removing the message fallback makes only that new test fail under Node 22. |
| [PR 438 P2: non-unique authority abort misreported as duplicate](https://github.com/cortexkit/magic-context/pull/438#discussion_r3993780322) | Fixed already; native coverage added | `tools.ts:358–363` does not accept generic `SQLITE_CONSTRAINT*` codes. Commit `cca8f10fc3`. The new test installs a real `RAISE(ABORT, 'authority is draining')` trigger, leaves a matching duplicate present, and asserts that the original native error is rethrown without a fallback lookup. It passes on Node 22 and Bun; restoring the broad Bun prefix match makes only this test fail. |
| [PR 438 P3: Rust visibility sentinel literal](https://github.com/cortexkit/magic-context/pull/438#discussion_r3993780334) | Fixed already | `crates/mc-module/src/memory_render.rs:19,337` imports and uses the shared `mc_store::MEMORY_VISIBILITY_MUTATION_CATEGORY`; `crates/mc-store/src/lib.rs:77` defines it as `"__mc_visibility__"`. Commit `cca8f10fc3`. No Rust renderer is changed by this triage. Rust test attempt timed out during dependency compilation, before running tests. |
| [PR 438 P3: TypeScript visibility sentinel literal](https://github.com/cortexkit/magic-context/pull/438#discussion_r3993780339) | Fixed already | `packages/plugin/src/hooks/magic-context/inject-compartments.ts:36,2855` imports and uses the exported shared constant from storage; `storage-memory-mutation-log.ts:6` defines `"__mc_visibility__"`. Commit `cca8f10fc3`. The existing interleaved module-delta byte parity test passes. No TypeScript renderer is changed. |

The obsolete sibling ARCHITECTURE.md finding on PR 458 was read but excluded as
requested. Neither ARCHITECTURE.md nor STRUCTURE.md is changed.

## Native regression coverage

`packages/plugin/src/tools/ctx-memory/sqlite-backends.test.ts` uses the real
runtime-selected SQLite adapter and the public `ctx_memory.execute` path.
Only the first duplicate lookup is suppressed, so the UPDATE must reach a
native constraint and the fallback can find the real duplicate after rollback.
The test captures the error thrown by the native statement, checks its runtime
code, and checks that the source row stayed unchanged. No SQLite error is
fabricated. The authority test also checks that the thrown error is the same
object received from the native statement.

Both tests are discovered by the ordinary Bun suite. To exercise Node as well:

```sh
timeout 60s bun build packages/plugin/src/tools/ctx-memory/sqlite-backends.test.ts \
  --target node --format esm --splitting \
  --outdir packages/plugin/tmp/ctx-memory-sqlite --entry-naming '[name].mjs' \
  --external onnxruntime-node --external sharp
timeout 60s npm exec --yes --package=node@22.16.0 -- \
  node --test packages/plugin/tmp/ctx-memory-sqlite/sqlite-backends.test.mjs
```

The package-local output directory lets Node resolve the installed optional
dependencies. Splitting is required with Bun 1.4.2: the single-file build emitted
an undefined `__promiseAll` helper. These intermediate load failures were
corrected before either test was counted as executed. No manifests or lockfiles
are changed.

## Verification

All shell gates used `timeout`.

The five-file plugin regression command (from `packages/plugin`) was:

```sh
timeout 240s bun test --timeout 30000 \
  src/features/magic-context/project-embedding-registry.test.ts \
  src/features/magic-context/shadow-backfill.test.ts \
  src/tools/ctx-memory/tools.test.ts \
  src/hooks/magic-context/inject-compartments.test.ts \
  src/features/magic-context/storage-clone.test.ts
```

| Check | Result |
| --- | --- |
| Full Pi suite: `timeout 240s bun run --cwd packages/pi-plugin test` | Bun 1.4.2: **1,482 pass, 3 intentional child-test skips, 0 fail**, 137 files. Frozen install checked 995 installs / 1,250 packages, no dependency changes. |
| Plugin regression suites: registry, shadow backfill, ctx-memory tools, inject compartments, storage clone | Bun 1.4.2: **238 pass, 0 fail**, five files, 1,018 assertions. |
| New native SQLite tests under Bun | Bun 1.4.2: **2 pass, 0 fail**. |
| New native SQLite tests under real Node | Node 22.16.0: **2 pass, 0 fail**, TAP output confirms `Node.js` adapter. |
| Plugin and Pi `typecheck` scripts | TypeScript 5.9.3: passed (exit 0, silent-on-success compiler); includes plugin script typecheck and retina build typecheck. |
| New test's explicit temporary TypeScript project | TypeScript 5.9.3: passed; adds the test normally excluded by the package config. |
| New test's package-local Biome check | Biome 2.5.1: one file checked, passed. |
| `timeout 180s cargo test -p mc-module memory_render` | Cargo 1.99.0: timed out (124) while compiling dependencies; **no Rust test result claimed**. Cargo refreshed a sibling path-dependency version in Cargo.lock during the attempt; that incidental change was restored. |

No rendered bytes change: both renderers and both constant definitions remain
unchanged. The TS suite also passed `matches the module delta bytes across
interleaved update, archive, and cross-watermark merge` and the recategorization
rendering test. This is not a claim that the timed-out Rust suite passed.

## Non-vacuity controls

The production classifier was staged unchanged before each mutation, the
working-tree diff was confirmed empty, and each temporary break was marked
`NON-VACUITY BREAK`. Each mutation produced a non-empty diff for `tools.ts`,
then was restored from the index (and touched), leaving the working-tree diff
empty again. The live tests were rebuilt and rerun after restoration.

| Temporary control | Expected and observed sole failure | Other test |
| --- | --- | --- |
| Remove UNIQUE-message fallback, keeping the exact Bun code | `ctx_memory returns the friendly duplicate response after a native UNIQUE violation` on Node 22: native `ERR_SQLITE_ERROR`, UNIQUE constraint failed | Authority refusal test stayed green |
| Accept every `SQLITE_CONSTRAINT*` code | `ctx_memory preserves a native authority refusal even when a duplicate exists` on Bun: missing expected rejection | Friendly duplicate test stayed green |
